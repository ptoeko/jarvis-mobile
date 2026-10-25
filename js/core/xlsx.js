// Экспорт реестра в настоящий файл Excel (.xlsx) без сторонних библиотек.
// XLSX — это ZIP-архив с XML-файлами (стандарт Office Open XML). Архив
// собирается тем же модулем zip.js, что и резервная копия.
//
// Все значения записываются как текст («встроенная строка»), поэтому Excel
// не превращает отметки (-0,300), оси (3/Б) и даты в числа или даты, и ни одна
// ячейка не может стать формулой. Только «№ п/п» — число, чтобы сортировалось.

import { REGISTRY_FIELDS, NOT_SPECIFIED } from './config.js';
import { attachmentRefs } from './attachments.js';
import { createZip } from './zip.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const FILES_COLUMN_TITLE = 'Файлы (вложения)';

// Ширина столбцов в символах (примерно), по порядку REGISTRY_FIELDS + «Файлы».
const WIDTHS = {
  number: 7, date: 12, object: 22, location: 26, workType: 20, description: 48,
  requirement: 28, responsible: 26, deadline: 14, status: 16, sourceText: 48,
};
const FILES_WIDTH = 32;

// Символы, недопустимые в XML 1.0 (управляющие, кроме табуляции и переводов строки).
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const MAX_CELL = 32767; // предел Excel на длину текста в ячейке

export function xmlText(value) {
  return String(value ?? '')
    .replace(INVALID_XML, '')
    .slice(0, MAX_CELL)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Имя столбца Excel по номеру с нуля: 0 → A, 25 → Z, 26 → AA.
export function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function textCell(ref, value, style) {
  // xml:space="preserve" — сохранить пробелы в начале и конце, переносы строк.
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function cellValue(record, key) {
  const v = record[key];
  return v === undefined || v === null || v === '' ? NOT_SPECIFIED : String(v);
}

function filesText(record) {
  const refs = attachmentRefs(record.attachments);
  return refs.length ? refs.map((r) => r.name).join('\n') : '';
}

// Таблица: заголовки + строки реестра. Возвращает { headers, rows } — то, что
// попадёт в файл; используется и для предварительного итога, и в тестах.
export function registryTable(records) {
  const headers = [...REGISTRY_FIELDS.map((f) => f.title), FILES_COLUMN_TITLE];
  const rows = records.map((r) => [
    ...REGISTRY_FIELDS.map((f) => (f.key === 'number' ? Number(r.number) : cellValue(r, f.key))),
    filesText(r),
  ]);
  return { headers, rows };
}

function sheetXml({ headers, rows, widths }) {
  const last = columnName(headers.length - 1);
  const cols = (widths || [...REGISTRY_FIELDS.map((f) => WIDTHS[f.key] || 18), FILES_WIDTH])
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const head = `<row r="1">${headers.map((h, i) => textCell(`${columnName(i)}1`, h, 1)).join('')}</row>`;
  const body = rows.map((row, ri) => {
    const r = ri + 2;
    const cells = row.map((v, ci) => {
      const ref = `${columnName(ci)}${r}`;
      return typeof v === 'number' && Number.isFinite(v)
        ? `<c r="${ref}" s="3"><v>${v}</v></c>`
        : textCell(ref, v, 2);
    });
    return `<row r="${r}">${cells.join('')}</row>`;
  }).join('');
  const lastRow = rows.length + 1;
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheetViews><sheetView workbookViewId="0">'
    + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${cols}</cols>`
    + `<sheetData>${head}${body}</sheetData>`
    + `<autoFilter ref="A1:${last}${lastRow}"/>`
    + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
    + '<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>'
    + '</worksheet>';
}

// Стили: 0 — обычный; 1 — шапка (жирный, заливка, рамка, перенос);
// 2 — текст (формат «Текст», перенос, по верхнему краю, рамка); 3 — номер.
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE9EEF2"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left style="thin"><color rgb="FFC3CFD9"/></left><right style="thin"><color rgb="FFC3CFD9"/></right>'
  + '<top style="thin"><color rgb="FFC3CFD9"/></top><bottom style="thin"><color rgb="FFC3CFD9"/></bottom><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
  + '</Relationships>';

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

function workbookXml(rowCount, colCount, sheetName = 'Реестр') {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<bookViews><workbookView/></bookViews>'
    + `<sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
    + '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'
    + `'${xmlText(sheetName)}'!$A$1:$${columnName(colCount - 1)}$${rowCount + 1}</definedName>`
    + `<definedName name="_xlnm.Print_Titles" localSheetId="0">'${xmlText(sheetName)}'!$1:$1</definedName></definedNames>`
    + '</workbook>';
}

function coreXml(now, title = 'Реестр замечаний') {
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

async function buildXlsx(table, { sheetName, title, now }) {
  const zip = await createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES, date: now },
    { name: '_rels/.rels', data: ROOT_RELS, date: now },
    { name: 'docProps/core.xml', data: coreXml(now, title), date: now },
    { name: 'docProps/app.xml', data: APP_XML, date: now },
    { name: 'xl/workbook.xml', data: workbookXml(table.rows.length, table.headers.length, sheetName), date: now },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS, date: now },
    { name: 'xl/styles.xml', data: STYLES, date: now },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(table), date: now },
  ]);
  return new Blob([zip], { type: XLSX_MIME });
}

// Собирает файл .xlsx с реестром. Возвращает Blob.
export async function recordsToXlsx(records, now = new Date()) {
  return buildXlsx(registryTable(records), { sheetName: 'Реестр', title: 'Реестр замечаний', now });
}

// Любая таблица (например, созданная ИИ агентом): все значения — текст,
// ширина столбцов — по содержимому.
export async function tableToXlsx(headers, rows, { title = 'Таблица', now = new Date() } = {}) {
  const cols = headers.length;
  const norm = rows.map((r) => Array.from({ length: cols }, (_, i) => String(r?.[i] ?? '')));
  const widths = headers.map((h, i) => {
    const longest = Math.max(String(h).length, ...norm.map((r) => Math.max(...r[i].split('\n').map((l) => l.length))));
    return Math.min(60, Math.max(8, longest + 2));
  });
  return buildXlsx({ headers: headers.map(String), rows: norm, widths }, { sheetName: 'Лист1', title, now });
}

export function xlsxFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `jarvis-reestr-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.xlsx`;
}
