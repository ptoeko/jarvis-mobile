// Тесты этапа 2: разбор заметок, записи, нумерация, CSV.
// Запуск: node --test tests/unit/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNote, parseMessage, splitNotes } from '../../js/core/parse.js';
import { createDraft, validateFields, normalizeFieldValue } from '../../js/core/records.js';
import { createStore, createMemoryAdapter, RecordError, META_NEXT_NUMBER } from '../../js/core/store.js';
import { protectCell, recordsToCsv, quoteCell, exportFileName, CSV_BOM } from '../../js/core/csv.js';
import { NOT_SPECIFIED, REGISTRY_FIELDS, EDITABLE_FIELDS, MAX_FIELD_LENGTH, MAX_NOTES_PER_MESSAGE } from '../../js/core/config.js';
import { NOTES, MULTI_NOTE_MESSAGE } from '../fixtures/notes.mjs';

// ---------- Разбор заметок ----------
for (const { name, note, expect } of NOTES) {
  test(`разбор: ${name}`, () => {
    const { fields } = parseNote(note);
    for (const key of EDITABLE_FIELDS) {
      const expected = key in expect ? expect[key] : key === 'description' ? note : NOT_SPECIFIED;
      assert.equal(fields[key], expected, `поле ${key}`);
    }
  });
}

test('разбор не домысливает: каждый заполненный фрагмент дословно есть в заметке', () => {
  for (const { note } of NOTES) {
    const { fields, evidence } = parseNote(note);
    for (const key of EDITABLE_FIELDS) {
      if (fields[key] === NOT_SPECIFIED) continue;
      assert.ok(evidence[key]?.length, `${key}: нет доказательства в «${note}»`);
      const flat = (t) => t.replace(/\s+/g, ' ');
      for (const piece of evidence[key]) {
        assert.ok(flat(note).includes(flat(piece)), `${key}: «${piece}» нет в «${note}»`);
      }
      // И само значение поля составлено только из этих фрагментов.
      const joined = evidence[key].join(key === 'location' ? ', ' : key === 'requirement' ? '; ' : ' ');
      assert.equal(fields[key], joined, `${key}: значение не совпадает с фрагментами`);
    }
  }
});

test('статус без метки «Статус:» всегда «Не указано»', () => {
  for (const note of ['Трещина устранена', 'Замечание закрыто', 'открыто: ось 3']) {
    assert.equal(parseNote(note).fields.status, NOT_SPECIFIED, note);
  }
});

test('несколько заметок разделяются пустой строкой (в том числе со пробелами)', () => {
  const parsed = parseMessage(MULTI_NOTE_MESSAGE);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.notes.map((n) => n.fields.location), ['Ось 1/А', 'Ось 2/Б', 'Ось 3/В']);
});

test('ограничение числа заметок в одном сообщении', () => {
  const ok = Array.from({ length: MAX_NOTES_PER_MESSAGE }, (_, i) => `заметка ${i}`).join('\n\n');
  assert.equal(parseMessage(ok).ok, true);
  const tooMany = `${ok}\n\nещё одна`;
  const r = parseMessage(tooMany);
  assert.equal(r.ok, false);
  assert.match(r.error, /Слишком много заметок/);
});

test('пустое сообщение не разбирается', () => {
  assert.equal(parseMessage('  \n\n ').ok, false);
  assert.deepEqual(splitNotes('\r\n\r\n'), []);
});

// ---------- Поля записи ----------
test('пустое поле становится «Не указано», пробелы по краям и управляющие символы убираются', () => {
  assert.equal(normalizeFieldValue('   '), NOT_SPECIFIED);
  assert.equal(normalizeFieldValue(undefined), NOT_SPECIFIED);
  assert.equal(normalizeFieldValue('  ось\u0007 3\r\nотм.  '), 'ось 3\nотм.');
});

test('нельзя изменить номер и исходный текст через проверку полей', () => {
  const r = validateFields({ number: 5, sourceText: 'другое', status: 'устранено' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.number && r.errors.sourceText);
});

test('слишком длинное поле отклоняется, граница — ровно максимум', () => {
  assert.equal(validateFields({ description: 'я'.repeat(MAX_FIELD_LENGTH) }).ok, true);
  const r = validateFields({ description: 'я'.repeat(MAX_FIELD_LENGTH + 1) });
  assert.equal(r.ok, false);
  assert.match(r.errors.description, /слишком длинное/);
});

test('черновик содержит все редактируемые поля и исходный текст', () => {
  const draft = createDraft({ fields: { location: 'ось 1' }, sourceText: 'ось 1 скол', sourceMessageId: 'm1' });
  assert.equal(draft.location, 'ось 1');
  assert.equal(draft.status, NOT_SPECIFIED);
  assert.equal(draft.sourceText, 'ось 1 скол');
  assert.ok(draft.draftId);
  assert.equal(draft.number, undefined, 'номер у черновика не присваивается');
});

// ---------- Подтверждение, нумерация, редактирование, удаление ----------
function draftOf(text) {
  const { fields } = parseNote(text);
  return createDraft({ fields, sourceText: text, sourceMessageId: 'msg' });
}

test('номера присваиваются по порядку подтверждения', async () => {
  const store = createStore(createMemoryAdapter());
  const a = await store.confirmRecord(draftOf('Ось 1/А — скол'));
  const b = await store.confirmRecord(draftOf('Ось 2/Б — трещина'));
  assert.deepEqual([a.number, b.number], [1, 2]);
  assert.deepEqual((await store.listRecords()).map((r) => r.number), [1, 2]);
});

test('одновременные подтверждения не получают одинаковый номер', async () => {
  const store = createStore(createMemoryAdapter());
  const records = await Promise.all(Array.from({ length: 10 }, (_, i) => store.confirmRecord(draftOf(`ось ${i + 1} — скол`))));
  assert.deepEqual(records.map((r) => r.number).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('удаление не перенумеровывает записи, номер удалённой не используется повторно', async () => {
  const store = createStore(createMemoryAdapter());
  const recs = [];
  for (const t of ['первая', 'вторая', 'третья']) recs.push(await store.confirmRecord(draftOf(t)));
  await store.deleteRecord(recs[1].id);
  assert.deepEqual((await store.listRecords()).map((r) => r.number), [1, 3]);
  await store.deleteRecord(recs[2].id); // удалили последнюю
  const next = await store.confirmRecord(draftOf('четвёртая'));
  assert.equal(next.number, 4, 'номер 3 не должен выдаваться повторно');
  assert.deepEqual((await store.listRecords()).map((r) => r.number), [1, 4]);
});

test('редактирование меняет поля, но не номер и не исходный текст', async () => {
  const store = createStore(createMemoryAdapter());
  const source = 'Ось 3/Б, отм. +6.000 — раковины';
  const rec = await store.confirmRecord(draftOf(source));
  const updated = await store.updateRecord(rec.id, { status: 'устранено', description: 'раковины заделаны' });
  assert.equal(updated.number, rec.number);
  assert.equal(updated.sourceText, source);
  assert.equal(updated.status, 'устранено');
  assert.equal(updated.location, 'Ось 3/Б, отм. +6.000');
  assert.notEqual(updated.updatedAt, rec.updatedAt);
  assert.equal(updated.createdAt, rec.createdAt);

  await assert.rejects(store.updateRecord(rec.id, { number: 99 }), RecordError);
  await assert.rejects(store.updateRecord(rec.id, { sourceText: 'подмена' }), RecordError);
  const [stored] = await store.listRecords();
  assert.equal(stored.number, rec.number);
  assert.equal(stored.sourceText, source);
});

test('подтверждение черновика использует исправленные человеком поля', async () => {
  const store = createStore(createMemoryAdapter());
  const draft = draftOf('Мусор на перекрытии');
  draft.object = 'корпус 7';
  draft.status = '';
  const rec = await store.confirmRecord(draft);
  assert.equal(rec.object, 'корпус 7');
  assert.equal(rec.status, NOT_SPECIFIED);
  assert.equal(rec.sourceText, 'Мусор на перекрытии');
});

test('ошибки: нет исходного текста, слишком длинное поле, запись не найдена', async () => {
  const store = createStore(createMemoryAdapter());
  await assert.rejects(store.confirmRecord({ ...draftOf('x'), sourceText: '  ' }), RecordError);
  await assert.rejects(store.confirmRecord({ ...draftOf('x'), description: 'я'.repeat(MAX_FIELD_LENGTH + 1) }), (e) => e instanceof RecordError && !!e.fieldErrors.description);
  await assert.rejects(store.updateRecord('нет-такой', { status: 'x' }), RecordError);
  await assert.rejects(store.deleteRecord('нет-такой'), RecordError);
  assert.equal((await store.counts()).records, 0);
});

test('удаление всей истории очищает реестр и начинает нумерацию с 1', async () => {
  const store = createStore(createMemoryAdapter());
  await store.confirmRecord(draftOf('a'));
  await store.confirmRecord(draftOf('b'));
  await store.clearHistory();
  assert.equal((await store.counts()).records, 0);
  assert.equal((await store.confirmRecord(draftOf('c'))).number, 1);
});

test('совместимость с данными этапа 1: сообщения сохраняются, счётчика нет — нумерация с 1', async () => {
  const adapter = createMemoryAdapter();
  // Так данные выглядят после этапа 1: сообщения есть, records и meta пусты.
  await adapter.put('messages', { id: 'old-1', role: 'user', source: 'user', text: 'старое', createdAt: '2026-10-22T10:00:00.000Z' });
  await adapter.put('messages', { id: 'old-2', role: 'assistant', source: 'demo', text: 'ответ', createdAt: '2026-10-22T10:00:00.001Z' });
  const store = createStore(adapter);
  assert.equal(await store.getMeta(META_NEXT_NUMBER), undefined);
  const rec = await store.confirmRecord(draftOf('новая'));
  assert.equal(rec.number, 1);
  assert.deepEqual((await store.listMessages()).map((m) => m.id), ['old-1', 'old-2']);
});

test('повреждённый счётчик не приводит к повторному номеру', async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.confirmRecord(draftOf('a'));
  await store.confirmRecord(draftOf('b'));
  await adapter.setMeta(META_NEXT_NUMBER, 1); // как будто счётчик сбросился
  assert.equal((await store.confirmRecord(draftOf('c'))).number, 3);
});

test('сообщения, сохранённые в одну миллисекунду, не меняются местами', async () => {
  const fixed = new Date('2026-10-23T00:00:00.000Z');
  const store = createStore(createMemoryAdapter(), () => fixed);
  for (let i = 0; i < 20; i++) await store.addMessage({ role: i % 2 ? 'assistant' : 'user', source: i % 2 ? 'demo' : 'user', text: `m${i}` });
  assert.deepEqual((await store.listMessages()).map((m) => m.text), Array.from({ length: 20 }, (_, i) => `m${i}`));
});

// ---------- CSV: защита от формул ----------
const MUST_PROTECT = [
  '=1+1', '+1+1', '-1+1', '@SUM(A1)', '=СУММ(A1:A3)',
  ' =1+1', '  +cmd', '\u00A0=1', '\u200B=1', '\uFEFF=1', '\u0000=1', '\u001F-1',
  '\t=1', '\r=1', '\n=1', '\tобычный текст', '\rтекст',
  '\uFF1D1+1', '\uFF0B1', '\uFF0D1', '\uFF20x',
  '+6.000=1', '-0.300+1', '+ 6.000', '+6.000 ', ' +6.000', '+6.000\n=1', '-', '+', '=',
  '-трещина', '- нет обмазки', '+A1',
];
const MUST_KEEP = [
  '+6.000', '-0.300', '-0,300', '+12.450', '-5', '+0', '0.000', '6.000', '12',
  'Ось 3/Б, отм. +6.000', 'отм. -0.300', 'текст = формула внутри', 'e-mail@test', '',
  'Не указано', '−0,300', '±0.000', 'лист 4а',
];

for (const v of MUST_PROTECT) {
  test(`CSV: защищается ${JSON.stringify(v)}`, () => {
    assert.equal(protectCell(v), `'${v}`);
  });
}
for (const v of MUST_KEEP) {
  test(`CSV: не изменяется ${JSON.stringify(v)}`, () => {
    assert.equal(protectCell(v), v);
  });
}

// ---------- CSV: формат ----------
// Простой разборщик CSV по RFC 4180 для проверки результата.
function parseCsv(text) {
  assert.ok(text.startsWith(CSV_BOM), 'нет BOM');
  const s = text.slice(1);
  const rows = [];
  let row = [];
  let i = 0;
  while (i < s.length) {
    assert.equal(s[i], '"', `ячейка без кавычек на позиции ${i}`);
    let value = '';
    i++;
    for (;;) {
      if (s[i] === '"' && s[i + 1] === '"') { value += '"'; i += 2; continue; }
      if (s[i] === '"') { i++; break; }
      assert.ok(i < s.length, 'незакрытая кавычка');
      value += s[i++];
    }
    row.push(value);
    if (s[i] === ';') { i++; continue; }
    assert.equal(s.slice(i, i + 2), '\r\n', `после ячейки ожидался CRLF на позиции ${i}`);
    i += 2;
    rows.push(row);
    row = [];
  }
  return rows;
}

const SAMPLE_RECORDS = [
  {
    number: 1, date: '23.10.2026', object: 'корпус 7', location: 'Ось 3/Б, отм. +6.000', workType: NOT_SPECIFIED,
    description: 'Раковины "до 5 мм"; см. фото\nвторая строка', requirement: 'СП 70.13330.2012, п. 5.18.4',
    responsible: 'ООО «Альфа, Бета и К»', deadline: '30.10.2026', status: NOT_SPECIFIED,
    sourceText: 'Исходник с "кавычками";\r\nи переносом',
  },
  {
    number: 4, date: NOT_SPECIFIED, object: NOT_SPECIFIED, location: '-0,300', workType: '=СУММ(A1)',
    description: 'ёЁ щЩ ъЪ — «»', requirement: NOT_SPECIFIED, responsible: '', deadline: undefined, status: 'открыто',
    sourceText: 'x',
  },
];

test('CSV: BOM, «;», CRLF, все значения в кавычках, 11 столбцов в утверждённом порядке', () => {
  const rows = parseCsv(recordsToCsv(SAMPLE_RECORDS));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], REGISTRY_FIELDS.map((f) => f.title));
  for (const r of rows) assert.equal(r.length, 11);
});

test('CSV: значения каждой ячейки — кириллица, кавычки, переносы, пустые поля', () => {
  const rows = parseCsv(recordsToCsv(SAMPLE_RECORDS));
  assert.deepEqual(rows[1], [
    '1', '23.10.2026', 'корпус 7', 'Ось 3/Б, отм. +6.000', NOT_SPECIFIED,
    'Раковины "до 5 мм"; см. фото\nвторая строка', 'СП 70.13330.2012, п. 5.18.4',
    'ООО «Альфа, Бета и К»', '30.10.2026', NOT_SPECIFIED, 'Исходник с "кавычками";\r\nи переносом',
  ]);
  assert.deepEqual(rows[2], [
    '4', NOT_SPECIFIED, NOT_SPECIFIED, '-0,300', "'=СУММ(A1)",
    'ёЁ щЩ ъЪ — «»', NOT_SPECIFIED, NOT_SPECIFIED, NOT_SPECIFIED, 'открыто', 'x',
  ]);
});

test('CSV: пустой реестр — только строка заголовков', () => {
  const rows = parseCsv(recordsToCsv([]));
  assert.equal(rows.length, 1);
});

test('CSV: кавычки удваиваются', () => {
  assert.equal(quoteCell('a"b""c'), '"a""b""""c"');
});

test('CSV: имя файла по местной дате', () => {
  assert.equal(exportFileName(new Date(2026, 0, 5, 23, 59)), 'jarvis-reestr-2026-01-05.csv');
});
