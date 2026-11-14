// Чтение содержимого документов на телефоне, чтобы ИИ агент видел не только
// название файла: Word (.docx, .odt), Excel (.xlsx, .xlsm, .ods), CSV, TXT.
// Старые двоичные форматы (.doc, .xls) и .rtf не читаются — агенту передаётся
// подсказка пересохранить файл. Ничего не отправляется по сети: модуль только
// превращает файл в текст.

export const MAX_DOC_CHARS = 120000; // текста одного документа для агента
const MAX_SHEET_ROWS = 3000;

export class DocReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocReadError';
  }
}

// ---------- ZIP (форматы Office — это ZIP со сжатием deflate) ----------

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') throw new DocReadError('Браузер не умеет распаковывать документы. Обновите Chrome или «Android System WebView».');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Map имя → async () => Uint8Array.
export async function unzip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xFFFF); i--) {
    if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DocReadError('Файл повреждён или это не документ Office.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || view.getUint32(p, true) !== 0x02014B50) throw new DocReadError('Файл повреждён: неверное оглавление архива.');
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, async () => {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new DocReadError('Документ сжат неподдерживаемым способом.');
    });
  }
  return entries;
}

async function readText(entries, name) {
  const get = entries.get(name);
  return get ? new TextDecoder().decode(await get()) : null;
}

// ---------- XML ----------

export function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : null;
}

function tidy(text) {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- Word (.docx) ----------

// Текст документа: абзацы — строками, заголовки — с «#», списки — с «•»,
// таблицы — строками «ячейка | ячейка».
export function docxXmlToText(xml) {
  const out = [];
  let para = '';
  let heading = 0;
  let list = false;
  let inText = false;
  const tables = []; // стек: { rows: [[cells]], row: [], cell: '' }
  const re = /<(\/?)(w:p|w:tbl|w:tr|w:tc|w:t|w:tab|w:br|w:cr|w:pStyle|w:numPr|w:delText)\b([^>]*?)(\/?)>|([^<]+)/g;
  const emitPara = () => {
    const text = para.replace(/[ \t]+/g, ' ').trim();
    const prefix = heading ? `${'#'.repeat(Math.min(heading, 3))} ` : list ? '• ' : '';
    const line = text ? prefix + text : '';
    const t = tables[tables.length - 1];
    if (t) t.cell += (t.cell && line ? '\n' : '') + line;
    else out.push(line);
    para = '';
    heading = 0;
    list = false;
  };
  for (const m of xml.matchAll(re)) {
    const [, close, tag, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (inText) para += decodeXml(text);
      continue;
    }
    if (tag === 'w:t') inText = !close && !selfClose;
    else if (tag === 'w:delText') inText = false;
    else if (tag === 'w:tab' && !close) para += '\t';
    else if ((tag === 'w:br' || tag === 'w:cr') && !close) para += '\n';
    else if (tag === 'w:pStyle' && !close) {
      const v = (attr(attrs, 'w:val') || '').toLowerCase();
      const h = /^(?:heading|заголовок)\s*([1-9])$/.exec(v) || /^heading([1-9])$/.exec(v);
      if (h) heading = Number(h[1]);
      else if (v === 'title' || v === 'название') heading = 1;
      else if (/list/.test(v)) list = true;
    } else if (tag === 'w:numPr' && !close) list = true;
    else if (tag === 'w:p') {
      if (close) emitPara();
      else if (!selfClose) { para = ''; heading = 0; list = false; }
      else emitPara();
    } else if (tag === 'w:tbl') {
      if (!close) tables.push({ rows: [], row: [], cell: '' });
      else {
        const t = tables.pop();
        const lines = t.rows.map((r) => r.map((c) => c.replace(/\n+/g, ' / ')).join(' | '));
        const parent = tables[tables.length - 1];
        if (parent) parent.cell += (parent.cell ? '\n' : '') + lines.join('\n');
        else out.push('', '[Таблица]', ...lines, '');
      }
    } else if (tag === 'w:tr' && tables.length) {
      const t = tables[tables.length - 1];
      if (close) { t.rows.push(t.row); t.row = []; }
    } else if (tag === 'w:tc' && tables.length) {
      const t = tables[tables.length - 1];
      if (close) { t.row.push(t.cell.trim()); t.cell = ''; }
    }
  }
  return tidy(out.join('\n'));
}

async function docxToText(blob) {
  const entries = await unzip(blob);
  const xml = await readText(entries, 'word/document.xml');
  if (xml === null) throw new DocReadError('В файле нет текста документа Word.');
  return docxXmlToText(xml);
}

// ---------- OpenDocument (.odt, .ods) ----------

export function odfXmlToText(xml) {
  const body = xml.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:s(?:\s+text:c="(\d+)")?\/>/g, (m, n) => ' '.repeat(Number(n) || 1))
    .replace(/<\/table:table-cell>/g, ' | ').replace(/<\/table:table-row>/g, '\n')
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return tidy(decodeXml(body).replace(/(?: \| )+\n/g, '\n'));
}

async function odfToText(blob) {
  const entries = await unzip(blob);
  const xml = await readText(entries, 'content.xml');
  if (xml === null) throw new DocReadError('В файле нет содержимого документа.');
  return odfXmlToText(xml);
}

// ---------- Excel (.xlsx) ----------

export function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref || '')?.[1] || '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

// Номера стилей ячеек, у которых формат — дата.
export function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    custom.set(Number(attr(m[1], 'numFmtId')), attr(m[1], 'formatCode') || '');
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] || '';
  const result = new Set();
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b([^>]*?)(\/>|>)/g)) {
    const id = Number(attr(m[1], 'numFmtId') || 0);
    const code = (custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
    if (DATE_FORMAT_IDS.has(id) || (custom.has(id) && /[dy]|m{1,2}(?![^;]*[hs])/.test(code) && !/^[#0.,%\s]*$/.test(code))) result.add(i);
    i++;
  }
  return result;
}

export function excelDate(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  const hm = d.getUTCHours() || d.getUTCMinutes() ? ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : '';
  return date + hm;
}

function formatNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return String(Math.round(n * 1e10) / 1e10).replace('.', ',');
}

// Лист Excel → строки текста «ячейка | ячейка».
export function sheetXmlToRows(xml, shared, dates) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_SHEET_ROWS) break;
    const cells = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1];
      const inner = cm[2] || '';
      const type = attr(a, 't');
      const style = Number(attr(a, 's') || 0);
      let value = '';
      if (type === 'inlineStr') value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('');
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) {
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'b') value = v === '1' ? 'ИСТИНА' : 'ЛОЖЬ';
          else if (type === 'str' || type === 'e') value = decodeXml(v);
          else value = dates.has(style) ? excelDate(Number(v)) : formatNumber(v);
        }
      }
      const col = columnIndex(attr(a, 'r')) >= 0 ? columnIndex(attr(a, 'r')) : cells.length;
      while (cells.length < col) cells.push('');
      cells[col] = value.replace(/\s*\n\s*/g, ' / ').trim();
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (cells.length) rows.push(cells.join(' | '));
  }
  return rows;
}

async function xlsxToText(blob) {
  const entries = await unzip(blob);
  const workbook = await readText(entries, 'xl/workbook.xml');
  if (workbook === null) throw new DocReadError('В файле нет листов Excel.');
  const rels = (await readText(entries, 'xl/_rels/workbook.xml.rels')) || '';
  const targets = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const sharedXml = (await readText(entries, 'xl/sharedStrings.xml')) || '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join(''));
  const dates = dateStyles(await readText(entries, 'xl/styles.xml'));
  const parts = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], 'name') || 'Лист';
    let target = targets.get(attr(m[1], 'r:id')) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = await readText(entries, target);
    if (xml === null) continue;
    const rows = sheetXmlToRows(xml, shared, dates);
    parts.push(`## Лист «${name}»`, ...(rows.length ? rows : ['(пустой лист)']), '');
  }
  return tidy(parts.join('\n'));
}

// ---------- Общий вход ----------

const READERS = {
  docx: docxToText,
  docm: docxToText,
  odt: odfToText,
  xlsx: xlsxToText,
  xlsm: xlsxToText,
  ods: odfToText,
  csv: async (blob) => (await blob.text()).replace(/^﻿/, ''),
  txt: async (blob) => (await blob.text()).replace(/^﻿/, ''),
  md: async (blob) => (await blob.text()).replace(/^﻿/, ''),
};

const OLD_FORMATS = { doc: 'Word 97–2003 (.doc)', xls: 'Excel 97–2003 (.xls)', rtf: 'RTF' };

export function canRead(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return ext in READERS;
}

// Возвращает { text, truncated } или { error } — понятное объяснение для агента
// и пользователя. Никогда не бросает исключение.
export async function documentText(blob, name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (OLD_FORMATS[ext]) {
    return { error: `Формат ${OLD_FORMATS[ext]} не читается. Пересохраните файл как .docx или .xlsx (в Word/Excel: «Сохранить как»).` };
  }
  const reader = READERS[ext];
  if (!reader) return { error: 'Содержимое этого типа файла не читается.' };
  try {
    let text = await reader(blob);
    const truncated = text.length > MAX_DOC_CHARS;
    if (truncated) text = `${text.slice(0, MAX_DOC_CHARS)}\n…[документ обрезан: передано ${MAX_DOC_CHARS} символов]`;
    if (!text.trim()) return { error: 'Документ пуст или содержит только картинки.' };
    return { text, truncated };
  } catch (e) {
    return { error: e instanceof DocReadError ? e.message : 'Не удалось прочитать файл: возможно, он повреждён или защищён паролем.' };
  }
}
