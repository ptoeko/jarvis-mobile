// Тесты версии 0.4.1: экспорт реестра в Excel (.xlsx).
import test from 'node:test';
import assert from 'node:assert/strict';

import { recordsToXlsx, registryTable, xmlText, columnName, xlsxFileName, XLSX_MIME, FILES_COLUMN_TITLE } from '../../js/core/xlsx.js';
import { readZip } from '../../js/core/zip.js';
import { REGISTRY_FIELDS, NOT_SPECIFIED } from '../../js/core/config.js';

const rec = (over = {}) => ({
  number: 1, date: '23.10.2026', object: 'корпус 7', location: 'Ось 3/Б, отм. -0,300', workType: NOT_SPECIFIED,
  description: 'раковины', requirement: NOT_SPECIFIED, responsible: 'ООО «Альфа»', deadline: '30.10.2026',
  status: NOT_SPECIFIED, sourceText: 'исходный', ...over,
});

async function sheet(records) {
  const blob = await recordsToXlsx(records);
  const entries = await readZip(blob);
  return { blob, entries, xml: await (await entries.get('xl/worksheets/sheet1.xml').read()).text() };
}

test('XLSX: состав файла и тип', async () => {
  const { blob, entries } = await sheet([rec()]);
  assert.equal(blob.type, XLSX_MIME);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'docProps/core.xml', 'docProps/app.xml']) {
    assert.ok(entries.has(name), name);
  }
});

test('XLSX: 12 столбцов — 11 полей реестра и «Файлы», порядок не изменён', () => {
  const { headers } = registryTable([]);
  assert.deepEqual(headers, [...REGISTRY_FIELDS.map((f) => f.title), FILES_COLUMN_TITLE]);
});

test('XLSX: все значения — текст, кроме номера; формула не создаётся', async () => {
  const { xml } = await sheet([rec({ description: '=СУММ(A1:A9)', location: '-0,300', date: '23.10.2026' })]);
  assert.doesNotMatch(xml, /<f>|<f /, 'нет формул');
  assert.match(xml, /<c r="A2" s="3"><v>1<\/v><\/c>/, 'номер — число');
  assert.match(xml, /<c r="F2" t="inlineStr" s="2"><is><t xml:space="preserve">=СУММ\(A1:A9\)<\/t>/);
  assert.match(xml, /<c r="D2" t="inlineStr"[^>]*><is><t xml:space="preserve">-0,300<\/t>/);
});

test('XLSX: спецсимволы экранируются, недопустимые для XML символы удаляются', () => {
  assert.equal(xmlText('a & b < c > "d"'), 'a &amp; b &lt; c &gt; &quot;d&quot;');
  assert.equal(xmlText('x\u0007y\u0000z'), 'xyz');
  assert.equal(xmlText('строка1\nстрока2\tтаб'), 'строка1\nстрока2\tтаб');
  assert.equal(xmlText('я'.repeat(40000)).length, 32767);
});

test('XLSX: пустое значение — «Не указано», имена файлов — в последнем столбце', () => {
  const { rows } = registryTable([rec({ status: '', attachments: [{ id: 'a', name: 'фото.jpg', size: 1 }, { id: 'b', name: 'акт.pdf', size: 2 }] })]);
  assert.equal(rows[0][REGISTRY_FIELDS.findIndex((f) => f.key === 'status')], NOT_SPECIFIED);
  assert.equal(rows[0].at(-1), 'фото.jpg\nакт.pdf');
});

test('XLSX: закреплённая шапка, фильтр, ширина столбцов, лист «Реестр»', async () => {
  const { xml, entries } = await sheet([rec(), rec({ number: 3 })]);
  assert.match(xml, /<pane ySplit="1"[^>]*state="frozen"\/>/);
  assert.match(xml, /<autoFilter ref="A1:L3"\/>/);
  assert.match(xml, /<col min="6" max="6" width="48"/);
  const wb = await (await entries.get('xl/workbook.xml').read()).text();
  assert.match(wb, /<sheet name="Реестр"/);
});

test('XLSX: имена столбцов и файла', () => {
  assert.deepEqual([0, 11, 25, 26, 27, 701].map(columnName), ['A', 'L', 'Z', 'AA', 'AB', 'ZZ']);
  assert.equal(xlsxFileName(new Date(2026, 9, 25)), 'jarvis-reestr-2026-10-25.xlsx');
});
