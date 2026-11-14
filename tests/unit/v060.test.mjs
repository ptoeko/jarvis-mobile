// Тесты версии 0.6.0: архив переписок, чтение Word/Excel, документы Word,
// поиск в интернете и изображения в посреднике. Все данные вымышленные.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore, createMemoryAdapter, RecordError } from '../../js/core/store.js';
import { createDraft } from '../../js/core/records.js';
import { documentText, docxXmlToText, sheetXmlToRows, dateStyles, excelDate, columnIndex, canRead } from '../../js/core/docread.js';
import { buildDocx, documentXml, normalizeDocument } from '../../js/core/docx.js';
import { createZip } from '../../js/core/zip.js';
import worker, { webSearch, createImage, scrubVendor, fileFromTool, scrubFile } from '../../proxy/worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- Архив переписок ----------
async function storeWithDialog() {
  const store = createStore(createMemoryAdapter());
  await store.addMessage({ role: 'user', source: 'user', text: 'Собери сводный отчёт по СМР за неделю', files: [new File(['a'], 'отчёт1.docx')] });
  await store.addMessage({ role: 'assistant', source: 'ai', text: 'Готово' });
  return store;
}

test('новый диалог: переписка уходит в архив целиком, текущая пуста, файлы сохранены', async () => {
  const store = await storeWithDialog();
  const entry = await store.archiveDialog();
  assert.equal(entry.count, 2);
  assert.equal(entry.title, 'Собери сводный отчёт по СМР за неделю');
  assert.deepEqual(await store.listMessages(), []);
  const archived = await store.listArchiveMessages(entry.id);
  assert.deepEqual(archived.map((m) => m.text), ['Собери сводный отчёт по СМР за неделю', 'Готово']);
  assert.ok(await store.getAttachment(archived[0].attachments[0].id), 'файл переписки сохранён');
  assert.deepEqual((await store.listArchives()).map((a) => a.id), [entry.id]);
  await store.addMessage({ role: 'user', source: 'user', text: 'новый вопрос' });
  assert.deepEqual((await store.listMessages()).map((m) => m.text), ['новый вопрос']);
});

test('пустую переписку архивировать нельзя', async () => {
  const store = createStore(createMemoryAdapter());
  await assert.rejects(store.archiveDialog(), RecordError);
});

test('длинное название архива обрезается', async () => {
  const store = createStore(createMemoryAdapter());
  await store.addMessage({ role: 'user', source: 'user', text: 'я'.repeat(100) });
  const e = await store.archiveDialog();
  assert.equal(e.title.length, 58);
  assert.ok(e.title.endsWith('…'));
});

test('удаление переписки: сообщения и их файлы удаляются, реестр, черновики и файлы записей — нет, архив не трогается', async () => {
  const store = createStore(createMemoryAdapter());
  await store.addMessage({ role: 'user', source: 'user', text: 'старое' });
  const archive = await store.archiveDialog();
  const m1 = await store.addMessage({ role: 'user', source: 'user', text: 'Ось 1/А — скол', files: [new File(['p'], 'фото.jpg')] });
  const m2 = await store.addMessage({ role: 'user', source: 'user', text: 'Ось 2/Б — трещина', files: [new File(['q'], 'фото2.jpg')] });
  const m3 = await store.addMessage({ role: 'user', source: 'user', text: 'просто вопрос', files: [new File(['r'], 'лишнее.pdf')] });
  const rec = await store.confirmRecord(createDraft({ fields: {}, sourceText: m1.text, sourceMessageId: m1.id, attachments: m1.attachments }));
  await store.saveDrafts([createDraft({ fields: {}, sourceText: m2.text, attachments: m2.attachments })]);
  assert.equal(await store.deleteDialog(), 3);
  assert.deepEqual(await store.listMessages(), []);
  assert.ok(await store.getAttachment(m1.attachments[0].id), 'файл записи реестра сохранён');
  assert.ok(await store.getAttachment(m2.attachments[0].id), 'файл черновика сохранён');
  assert.equal(await store.getAttachment(m3.attachments[0].id), undefined, 'файл переписки удалён');
  assert.equal((await store.listRecords())[0].id, rec.id);
  assert.equal((await store.loadDrafts()).length, 1);
  assert.equal((await store.listArchiveMessages(archive.id)).length, 1);
  assert.equal(await store.deleteDialog(), 0, 'повторное удаление — ничего не делает');
});

test('удаление переписки из архива', async () => {
  const store = await storeWithDialog();
  const a = await store.archiveDialog();
  const fileId = (await store.listArchiveMessages(a.id))[0].attachments[0].id;
  await store.deleteArchive(a.id);
  assert.deepEqual(await store.listArchives(), []);
  assert.deepEqual(await store.listArchiveMessages(a.id), []);
  assert.equal(await store.getAttachment(fileId), undefined);
  await assert.rejects(store.deleteArchive(a.id), RecordError);
});

test('удаление всей истории очищает и архив', async () => {
  const store = await storeWithDialog();
  await store.archiveDialog();
  await store.clearHistory();
  assert.deepEqual(await store.listArchives(), []);
  assert.equal((await store.counts()).messages, 0);
});

// ---------- Чтение документов ----------
async function zipOf(files) {
  return new Blob([await createZip(Object.entries(files).map(([name, data]) => ({ name, data, date: new Date(2026, 10, 14) })))]);
}

test('Word: заголовки, списки, таблицы, спецсимволы, удалённый текст правок не берётся', () => {
  const xml = '<w:document><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Здание 10UJA</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Бетон &amp; арматура </w:t></w:r><w:r><w:t>&lt;отм. +6.000&gt;</w:t></w:r><w:del><w:r><w:delText>удалено</w:delText></w:r></w:del></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>пункт</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>План</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Факт</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>118</w:t></w:r><w:r><w:br/><w:t>м³</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>';
  assert.equal(docxXmlToText(xml), '# Здание 10UJA\nБетон & арматура <отм. +6.000>\n• пункт\n\n[Таблица]\nПлан | Факт\n120 | 118 / м³');
});

test('Excel: общие строки, даты, числа, пропуски столбцов', () => {
  const styles = '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="165"/></cellXfs></styleSheet>';
  const dates = dateStyles(styles);
  assert.deepEqual([...dates].sort(), [1, 2]);
  const sheet = '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Дата</t></is></c></row>'
    + '<row r="2"><c r="A2"><v>12.5</v></c><c r="C2" s="1"><v>46318</v></c><c r="D2" s="3"><v>-0.3</v></c></row></sheetData>';
  assert.deepEqual(sheetXmlToRows(sheet, ['Объём'], dates), ['Объём |  | Дата', '12,5 |  | 23.10.2026 | -0,3']);
  assert.equal(excelDate(46318), '23.10.2026');
  assert.equal(columnIndex('AB12'), 27);
});

test('Word и Excel целиком из архива; старые форматы и повреждённые файлы — понятное объяснение', async () => {
  const docx = await zipOf({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Текст отчёта</w:t></w:r></w:p></w:body></w:document>' });
  assert.deepEqual(await documentText(docx, 'отчёт.docx'), { text: 'Текст отчёта', truncated: false });
  const xlsx = await zipOf({
    'xl/workbook.xml': '<workbook><sheets><sheet name="СМР" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Здание</t></is></c></row></sheetData></worksheet>',
  });
  assert.equal((await documentText(xlsx, 'смр.xlsx')).text, '## Лист «СМР»\nЗдание');
  assert.match((await documentText(new Blob(['x']), 'старый.doc')).error, /Пересохраните/);
  assert.match((await documentText(new Blob(['x'.repeat(100)]), 'битый.docx')).error, /повреждён/);
  assert.match((await documentText(new Blob(['   ']), 'пусто.txt')).error, /пуст/);
  assert.equal((await documentText(new Blob(['﻿а;б']), 'т.csv')).text, 'а;б');
  assert.ok(canRead('a.DOCX') && canRead('b.xlsx') && !canRead('c.doc') && !canRead('d.mp4'));
});

test('настоящие файлы Word и Excel из учебных образцов (сжатые deflate)', async () => {
  const dir = join(ROOT, 'tests', 'fixtures');
  const docx = await documentText(new Blob([readFileSync(join(dir, 'report-sample.docx'))]), 'report-sample.docx');
  assert.match(docx.text, /# Отчёт о СМР за неделю/);
  assert.match(docx.text, /Бетон, м³ \| 120 \| 118/);
  const xlsx = await documentText(new Blob([readFileSync(join(dir, 'smr-sample.xlsx'))]), 'smr-sample.xlsx');
  assert.match(xlsx.text, /1 \| Здание 10UJA \| Бетонирование \/ плиты \| 23\.10\.2026 \| 12,5/);
});

// ---------- Документ Word от агента ----------
test('документ Word: структура, экранирование, альбомная ориентация, читается обратно', async () => {
  const doc = {
    title: 'Сводный отчёт',
    orientation: 'landscape',
    blocks: [
      { type: 'heading', text: 'Здание <10UJA> & K', level: 5 },
      { type: 'paragraph', text: 'строка 1\nстрока 2', bold: true },
      { type: 'bullets', items: ['раз', 'два'] },
      { type: 'table', headers: ['№', 'Работа'], rows: [['1', 'Бетон'], ['2']] },
      { type: 'странный', text: 'как абзац' },
    ],
  };
  const n = normalizeDocument(doc);
  assert.equal(n.blocks[0].level, 3);
  assert.equal(n.blocks[4].type, 'paragraph');
  const xml = documentXml(doc);
  assert.match(xml, /w:orient="landscape"/);
  assert.match(xml, /Здание &lt;10UJA&gt; &amp; K/);
  assert.doesNotMatch(xml, /<10UJA>/);
  const blob = await buildDocx(doc);
  const text = (await documentText(blob, 'x.docx')).text;
  assert.equal(text, '# Сводный отчёт\n### Здание <10UJA> & K\nстрока 1\nстрока 2\n• раз\n• два\n\n[Таблица]\n№ | Работа\n1 | Бетон\n2 |\n\nкак абзац');
});

test('посредник: инструмент Word превращается в файл, названия поставщика вычищаются', () => {
  const file = fileFromTool({ name: 'create_word_document', input: { file_name: 'Сводка Gemini', title: 'Отчёт от Google AI', orientation: 'landscape', blocks: [{ type: 'paragraph', text: 'Составил Claude' }, { type: 'table', headers: ['A'], rows: [['GPT-5']] }] } });
  assert.equal(file.kind, 'word');
  assert.equal(file.name, 'Сводка Gemini.docx');
  const clean = scrubFile(file);
  assert.doesNotMatch(JSON.stringify(clean), /gemini|google|claude|gpt/i);
  assert.equal(fileFromTool({ name: 'create_word_document', input: { file_name: 'x', blocks: [] } }), null);
});

// ---------- Поиск и изображения ----------
const ENV = { ACCESS_CODE: 'test-access-code-1234567890', GEMINI_API_KEY: 'gm-key', GEMINI_MODEL: 'gemini-test-flash', GEMINI_IMAGE_MODEL: 'gemini-test-flash-image' };

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return handler(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('поиск: встроенный поиск, настоящие адреса вместо ссылок-перенаправлений', async () => {
  const m = mockFetch(async (url, init) => {
    if (init.method === 'HEAD') return new Response(null, { status: 302, headers: { location: 'https://minstroyrf.gov.ru/docs/123/' } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'СП 70.13330.2012 действует в редакции изм. 5.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'minstroyrf.gov.ru' } }, { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/def', title: 'Справочник' } }] } }] }), { status: 200 });
  });
  try {
    const r = await webSearch(ENV, 'действующая редакция СП 70');
    assert.equal(r.text, 'СП 70.13330.2012 действует в редакции изм. 5.');
    assert.deepEqual(r.sources[0], { title: 'minstroyrf.gov.ru', url: 'https://minstroyrf.gov.ru/docs/123/' });
    assert.ok(m.calls[0].body.tools[0].google_search);
    assert.ok(r.sources.every((x) => !/vertexaisearch|google/.test(x.url)));
  } finally { m.restore(); }
});

test('переписка с поиском: агент вызывает поиск, источники добавляются в ответ', async () => {
  let n = 0;
  const m = mockFetch(async (url, init) => {
    if (init.method === 'HEAD') return new Response(null, { status: 302, headers: { location: 'https://cbr.ru/currency/' } });
    const body = JSON.parse(init.body);
    if (body.tools?.[0]?.google_search) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Курс 95 руб.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x', title: 'cbr.ru' } }] } }] }), { status: 200 });
    }
    n++;
    if (n === 1) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { query: 'курс доллара' } } }] } }] }), { status: 200 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'По данным поиска курс 95 руб.' }] } }] }), { status: 200 });
  });
  try {
    const req = new Request('https://x.workers.dev/v1/chat', { method: 'POST', headers: { Authorization: `Bearer ${ENV.ACCESS_CODE}` }, body: JSON.stringify({ messages: [{ role: 'user', text: 'Найди курс доллара' }] }) });
    const data = await (await worker.fetch(req, ENV)).json();
    assert.equal(data.text, 'По данным поиска курс 95 руб.\n\nИсточники:\n1. cbr.ru — https://cbr.ru/currency/');
  } finally { m.restore(); }
});

test('поиск не удался — агент получает объяснение, а не сбой', async () => {
  const m = mockFetch(async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }), { status: 429 }));
  try {
    const r = await webSearch(ENV, 'что-то');
    assert.match(r.error, /лимит/);
    assert.match((await webSearch(ENV, '  ')).error, /Пустой/);
  } finally { m.restore(); }
});

test('изображение: создаётся отдельной моделью, приходит файлом', async () => {
  const m = mockFetch(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'вот' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] } }] }), { status: 200 }));
  try {
    const r = await createImage(ENV, { file_name: 'Эскиз узла', prompt: 'concrete column joint sketch', aspect_ratio: '16:9' });
    assert.deepEqual(r.file, { kind: 'image', name: 'Эскиз узла.png', type: 'image/png', data: 'iVBORw0KGgo=' });
    assert.ok(m.calls[0].url.includes('/gemini-test-flash-image:generateContent'));
    assert.deepEqual(m.calls[0].body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } });
  } finally { m.restore(); }
});

test('изображение: недоступно на бесплатном ключе, не подключено, отклонено — понятные причины', async () => {
  let m = mockFetch(async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'limit: 0' } }), { status: 429 }));
  try {
    assert.match((await createImage(ENV, { file_name: 'x', prompt: 'p' })).error, /бесплатном ключе/);
  } finally { m.restore(); }
  assert.match((await createImage({ ...ENV, GEMINI_IMAGE_MODEL: '' }, { file_name: 'x', prompt: 'p' })).error, /не подключено/);
  assert.match((await createImage({ ...ENV, PROVIDER: 'anthropic' }, { file_name: 'x', prompt: 'p' })).error, /не подключено/);
  m = mockFetch(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'не могу' }] } }] }), { status: 200 }));
  try {
    assert.match((await createImage(ENV, { file_name: 'x', prompt: 'p' })).error, /не создано/);
  } finally { m.restore(); }
});

test('фильтр названий не портит ссылки', () => {
  assert.equal(scrubVendor('Модель Gemini, см. https://example.com/gemini-3-release и https://cloud.google.com/x'), 'Модель ИИ агент JARVIS, см. https://example.com/gemini-3-release и https://cloud.google.com/x');
});

test('документы Word и Excel передаются агенту текстом между метками', async () => {
  const { toModelMessages } = await import('../../proxy/worker.js');
  const out = toModelMessages([{ role: 'user', text: 'объедини', files: [{ name: 'а.docx', text: 'Отчёт А' }, { name: 'б.doc', note: 'Формат не читается.' }, { name: 'в.mp4' }] }]);
  assert.deepEqual(out[0].content.map((c) => c.text), [
    '[Документ: а.docx]\nОтчёт А\n[Конец документа: а.docx]',
    '[Файл: б.doc — содержимое не передано: Формат не читается.]',
    '[Файл: в.mp4 — содержимое не передано]',
    'объедини',
  ]);
});
