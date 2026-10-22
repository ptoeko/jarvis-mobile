// Экспорт реестра в CSV для Excel (русская версия) и LibreOffice.
// Формат: UTF-8 с BOM, разделитель «;», строки CRLF, каждое значение в кавычках,
// кавычки внутри удваиваются, переносы строк внутри ячейки сохраняются (LF).
import { REGISTRY_FIELDS, NOT_SPECIFIED } from './config.js';

export const CSV_BOM = '\uFEFF';
export const CSV_SEPARATOR = ';';
export const CSV_EOL = '\r\n';

// Символы, которые табличный редактор может отбросить перед началом ячейки:
// пробелы всех видов, управляющие символы, невидимые разделители, BOM.
const IGNORABLE_PREFIX = new RegExp('^[\\s\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u180E\\u200B-\\u200F\\u2028-\\u202F\\u2060-\\u206F\\uFEFF]*', 'u');
// Начальные символы, с которых Excel и LibreOffice начинают формулу
// (включая полноширинные варианты).
const FORMULA_START = new Set(['=', '+', '-', '@', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20']);
// Число со знаком — инженерная отметка или значение: «+6.000», «-0,300», «-5».
// Такое значение оставляется как есть, но только если в ячейке нет ничего,
// кроме самого числа.
const SIGNED_NUMBER = /^[+-]\d+(?:[.,]\d+)?$/;

// Защита от внедрения формул (CSV injection): если ячейка может быть
// воспринята как формула, перед значением ставится апостроф «'».
export function protectCell(value) {
  const text = String(value ?? '');
  if (text === '') return text;
  if (SIGNED_NUMBER.test(text)) return text;
  const first = text.charAt(0);
  if (first === '\t' || first === '\r' || first === '\n') return `'${text}`;
  const rest = text.slice(text.match(IGNORABLE_PREFIX)[0].length);
  if (rest !== '' && FORMULA_START.has(rest.charAt(0))) return `'${text}`;
  return text;
}

export function quoteCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function cellValue(record, key) {
  const v = record[key];
  if (v === undefined || v === null || v === '') return NOT_SPECIFIED;
  return String(v);
}

// Формирует текст CSV: строка заголовков + по строке на запись,
// 11 столбцов в порядке REGISTRY_FIELDS.
export function recordsToCsv(records, fields = REGISTRY_FIELDS) {
  const lines = [fields.map((f) => quoteCell(protectCell(f.title))).join(CSV_SEPARATOR)];
  for (const record of records) {
    lines.push(fields.map((f) => quoteCell(protectCell(cellValue(record, f.key)))).join(CSV_SEPARATOR));
  }
  return CSV_BOM + lines.join(CSV_EOL) + CSV_EOL;
}

export function exportFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `jarvis-reestr-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
}
