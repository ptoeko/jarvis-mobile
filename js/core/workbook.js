// Книга Excel (.xlsx) из нескольких листов — для сводных отчётов, которые
// создаёт ИИ агент. Без сторонних библиотек: XLSX — это ZIP с XML-файлами.
//
// Каждый лист: заголовок и подзаголовок над таблицей, шапка, строки, итоговая
// строка. Числовые столбцы записываются числами (их можно складывать и
// фильтровать), остальные — текстом (отметки «-0,300», оси «3/Б» не
// превращаются в числа и даты). Итоги — формулы ПРОМЕЖУТОЧНЫЕ.ИТОГИ с уже
// посчитанным значением: его видят и просмотрщики, которые не считают формулы.

import { xmlText, columnName, XLSX_MIME } from './xlsx.js';
import { createZip } from './zip.js';

export { XLSX_MIME };

const MAX_SHEETS = 30;
const MAX_ROWS = 5000;
const MAX_COLS = 50;

// Число из текста: «1 234,5», «-12.75», «48%», «1,234.5». Иначе null.
// Значения с ведущим нулём («01», «007») — коды, а не числа.
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { value, percent: false } : null;
  let s = String(value ?? '').trim().replace(/[    ]/g, '').replace(/^[−–]/, '-');
  if (!s) return null;
  const percent = s.endsWith('%');
  if (percent) s = s.slice(0, -1);
  // Запятая — десятичный знак («12,5»); разделитель тысяч — только в записи
  // с точкой («1,234.5»).
  if (/^[-+]?\d{1,3}(,\d{3})+\.\d+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  if (/^[-+]?0\d/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return { value: percent ? n / 100 : n, percent };
}

// Название листа по правилам Excel: до 31 знака, без []:*?/\, без апострофа
// по краям, без повторов (без учёта регистра).
export function sheetNames(names) {
  const used = new Set();
  return names.map((raw, i) => {
    let base = String(raw ?? '').replace(/[[\]:*?/\\\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').trim();
    if (!base) base = `Лист ${i + 1}`;
    base = base.slice(0, 31).trim();
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) {
      const suffix = ` (${k})`;
      name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

// Подготовка листа: какие столбцы числовые, значения ячеек, итоги.
export function prepareSheet(sheet) {
  const headers = (Array.isArray(sheet?.headers) ? sheet.headers : []).slice(0, MAX_COLS).map((h) => String(h ?? ''));
  const cols = headers.length;
  const rows = (Array.isArray(sheet?.rows) ? sheet.rows : []).slice(0, MAX_ROWS)
    .map((r) => Array.from({ length: cols }, (_, i) => String((Array.isArray(r) ? r : [r])[i] ?? '')));
  const valid = (a) => (Array.isArray(a) ? a : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < cols);
  const totals = [...new Set(valid(sheet?.totalColumns))];
  let numeric = new Set([...valid(sheet?.numberColumns), ...totals]);
  if (numeric.size === 0) {
    // Агент не указал числовые столбцы: число — если все непустые значения числа
    // (первый столбец — обычно наименование, его не трогаем).
    for (let c = 1; c < cols; c++) {
      const values = rows.map((r) => r[c]).filter((v) => v.trim() !== '');
      if (values.length && values.every((v) => parseNumber(v))) numeric.add(c);
    }
  }
  const cells = rows.map((r) => r.map((v, c) => {
    if (numeric.has(c)) {
      const n = parseNumber(v);
      if (n) return { number: n.value, percent: n.percent };
    }
    return { text: v };
  }));
  const sums = totals.map((c) => {
    let sum = 0;
    let percent = 0;
    for (const row of cells) {
      if (typeof row[c].number === 'number') {
        sum += row[c].number;
        if (row[c].percent) percent++;
      }
    }
    return { col: c, sum: Math.round(sum * 1e9) / 1e9, percent: percent > 0 && percent * 2 >= cells.length };
  });
  const labelCol = totals.length ? [...Array(cols).keys()].find((c) => !totals.includes(c)) : undefined;
  return {
    title: String(sheet?.title ?? '').trim(),
    subtitle: String(sheet?.subtitle ?? '').trim(),
    headers,
    cells,
    totals: sums,
    totalLabel: String(sheet?.totalLabel ?? '').trim() || 'Итого',
    labelCol,
    landscape: sheet?.landscape !== false,
  };
}

// Стили (номера в cellXfs).
const S = { text: 2, number: 3, percent: 4, header: 1, title: 5, subtitle: 6, totalText: 7, totalNumber: 8, totalPercent: 9 };

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="14"/><name val="Calibri"/></font>'
  + '<font><i/><sz val="11"/><color rgb="FF55606B"/><name val="Calibri"/></font></fonts>'
  + '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE9EEF2"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF4F1E6"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FFC3CFD9"/></left><right style="thin"><color rgb="FFC3CFD9"/></right>'
  + '<top style="thin"><color rgb="FFC3CFD9"/></top><bottom style="thin"><color rgb="FFC3CFD9"/></bottom><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FFC3CFD9"/></left><right style="thin"><color rgb="FFC3CFD9"/></right>'
  + '<top style="medium"><color rgb="FF55606B"/></top><bottom style="thin"><color rgb="FFC3CFD9"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="10">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>'
  + '<xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="49" fontId="1" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>'
  + '<xf numFmtId="10" fontId="1" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

const textCell = (ref, value, style) => `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
const numberCell = (ref, value, style) => `<c r="${ref}" s="${style}"><v>${value}</v></c>`;

function widths(sheet) {
  return sheet.headers.map((h, c) => {
    const lens = [String(h).length * 0.8, ...sheet.cells.map((r) => {
      const cell = r[c];
      if (typeof cell.number === 'number') return String(cell.percent ? `${(cell.number * 100).toFixed(2)}%` : cell.number).length;
      return Math.max(...cell.text.split('\n').map((l) => l.length));
    })];
    return Math.min(60, Math.max(8, Math.ceil(Math.max(...lens)) + 2));
  });
}

// XML листа и сведения для книги (строка шапки, диапазон фильтра).
export function sheetXml(sheet) {
  const cols = sheet.headers.length;
  const last = columnName(cols - 1);
  let r = 0;
  const rows = [];
  const merges = [];
  if (sheet.title) {
    r++;
    rows.push(`<row r="${r}" ht="24" customHeight="1">${textCell(`A${r}`, sheet.title, S.title)}</row>`);
    if (cols > 1) merges.push(`A${r}:${last}${r}`);
  }
  if (sheet.subtitle) {
    r++;
    rows.push(`<row r="${r}">${textCell(`A${r}`, sheet.subtitle, S.subtitle)}</row>`);
    if (cols > 1) merges.push(`A${r}:${last}${r}`);
  }
  if (r > 0) r++; // пустая строка между заголовком и таблицей
  const headerRow = r + 1;
  r = headerRow;
  rows.push(`<row r="${r}">${sheet.headers.map((h, c) => textCell(`${columnName(c)}${r}`, h, S.header)).join('')}</row>`);
  const first = headerRow + 1;
  for (const row of sheet.cells) {
    r++;
    rows.push(`<row r="${r}">${row.map((cell, c) => {
      const ref = `${columnName(c)}${r}`;
      return typeof cell.number === 'number' ? numberCell(ref, cell.number, cell.percent ? S.percent : S.number) : textCell(ref, cell.text, S.text);
    }).join('')}</row>`);
  }
  const lastData = r;
  if (sheet.totals.length) {
    r++;
    const byCol = new Map(sheet.totals.map((t) => [t.col, t]));
    const cells = [];
    for (let c = 0; c < cols; c++) {
      const ref = `${columnName(c)}${r}`;
      const t = byCol.get(c);
      if (t) {
        const formula = lastData >= first ? `SUBTOTAL(9,${columnName(c)}${first}:${columnName(c)}${lastData})` : '0';
        cells.push(`<c r="${ref}" s="${t.percent ? S.totalPercent : S.totalNumber}"><f>${formula}</f><v>${t.sum}</v></c>`);
      } else {
        cells.push(textCell(ref, c === sheet.labelCol ? sheet.totalLabel : '', S.totalText));
      }
    }
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  }
  const colsXml = widths(sheet).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + '<sheetViews><sheetView workbookViewId="0">'
    + `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`
    + `<selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/>`
    + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${colsXml}</cols>`
    + `<sheetData>${rows.join('')}</sheetData>`
    + `<autoFilter ref="A${headerRow}:${last}${Math.max(lastData, headerRow)}"/>`
    + (merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '')
    + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
    + `<pageSetup orientation="${sheet.landscape ? 'landscape' : 'portrait'}" paperSize="9" fitToWidth="1" fitToHeight="0"/>`
    + '</worksheet>';
  return { xml, headerRow, filter: `$A$${headerRow}:$${last}$${Math.max(lastData, headerRow)}` };
}

function workbookXml(names, infos) {
  const sheets = names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const defined = names.map((n, i) => {
    const q = `'${xmlText(n).replace(/'/g, "''")}'`;
    return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${q}!${infos[i].filter}</definedName>`
      + `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${q}!$${infos[i].headerRow}:$${infos[i].headerRow}</definedName>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<bookViews><workbookView/></bookViews>'
    + `<sheets>${sheets}</sheets>`
    + `<definedNames>${defined}</definedNames>`
    + '<calcPr calcId="191029" fullCalcOnLoad="1"/>'
    + '</workbook>';
}

function contentTypes(count) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + Array.from({ length: count }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';
}

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
  + '</Relationships>';

function workbookRels(count) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + Array.from({ length: count }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>';
}

function coreXml(now, title) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
    + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${xmlText(title)}</dc:title><dc:creator>JARVIS Mobile</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}</dcterms:created>`
    + '</cp:coreProperties>';
}

const APP_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
  + '<Application>JARVIS Mobile</Application></Properties>';

// book: { name, sheets: [{ name, title, subtitle, headers, rows, numberColumns, totalColumns, totalLabel, landscape }] }
export async function buildWorkbook(book, now = new Date()) {
  const raw = (Array.isArray(book?.sheets) ? book.sheets : []).slice(0, MAX_SHEETS);
  const prepared = raw.map(prepareSheet).map((sh, i) => ({ sh, name: raw[i]?.name })).filter((x) => x.sh.headers.length > 0);
  if (prepared.length === 0) prepared.push({ sh: prepareSheet({ headers: ['Нет данных'], rows: [] }), name: 'Лист 1' });
  const names = sheetNames(prepared.map((x) => x.name));
  const infos = prepared.map((x) => sheetXml(x.sh));
  const title = String(book?.name || 'Сводный отчёт').replace(/\.xlsx$/i, '');
  const files = [
    { name: '[Content_Types].xml', data: contentTypes(infos.length), date: now },
    { name: '_rels/.rels', data: ROOT_RELS, date: now },
    { name: 'docProps/core.xml', data: coreXml(now, title), date: now },
    { name: 'docProps/app.xml', data: APP_XML, date: now },
    { name: 'xl/workbook.xml', data: workbookXml(names, infos), date: now },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(infos.length), date: now },
    { name: 'xl/styles.xml', data: STYLES, date: now },
    ...infos.map((info, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: info.xml, date: now })),
  ];
  return new Blob([await createZip(files)], { type: XLSX_MIME });
}
