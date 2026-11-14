// Тесты версии 0.7.0: «Я JARVIS, мой разработчик — AYRAT», сводные книги
// Excel, черновики реестра от агента, обращение «сэр», голос JARVIS.
import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { fileFromTool, scrubFile, registryItems, IDENTITY_ANSWER, DEVELOPER } from '../../proxy/worker.js';
import { buildWorkbook, parseNumber, sheetNames, prepareSheet } from '../../js/core/workbook.js';
import { documentText, unzip } from '../../js/core/docread.js';
import { speechText, speechChunks, normalizePrefs, createSpeech, DEFAULT_PREFS } from '../../js/core/speech.js';

const CODE = 'test-access-code-1234567890';
const ENV = { ACCESS_CODE: CODE, GEMINI_API_KEY: 'gm-test-key', GEMINI_MODEL: 'gemini-test-flash' };

function req(path, body) {
  return new Request(`https://jarvis-agent.example.workers.dev${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CODE}` },
    body: JSON.stringify(body),
  });
}

function mockGemini(replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const textReply = (text) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] });
const callReply = (name, args) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }] });

// ---------- Личность ----------

test('личность: разработчик AYRAT, ответ «Я JARVIS, мой разработчик — AYRAT», защита от выведывания', async () => {
  assert.equal(DEVELOPER, 'AYRAT');
  assert.equal(IDENTITY_ANSWER, 'Я JARVIS, мой разработчик — AYRAT.');
  const m = mockGemini([textReply('Я JARVIS, мой разработчик — AYRAT.')]);
  try {
    const res = await worker.fetch(req('/v1/chat', { messages: [{ role: 'user', text: 'Кто тебя создал?' }] }), ENV);
    const data = await res.json();
    assert.equal(data.text, 'Я JARVIS, мой разработчик — AYRAT.');
    const system = m.calls[0].body.systemInstruction.parts[0].text;
    assert.match(system, /Я JARVIS, мой разработчик — AYRAT\./);
    assert.match(system, /режим разработчика/);
    assert.match(system, /не говори «я не …»/);
    assert.doesNotMatch(system, /сэр/); // обращение «сэр» — только по переключателю
    assert.ok(!system.includes('https://'));
  } finally { m.restore(); }
});

test('обращение «сэр» включается переключателем в приложении', async () => {
  const m = mockGemini([textReply('Слушаю, сэр.')]);
  try {
    await worker.fetch(req('/v1/chat', { messages: [{ role: 'user', text: 'Привет' }], prefs: { sir: true } }), ENV);
    assert.match(m.calls[0].body.systemInstruction.parts[0].text, /«сэр»/);
  } finally { m.restore(); }
});

test('фильтр: названия модели и компании заменяются на JARVIS и AYRAT', async () => {
  const m = mockGemini([textReply('Я Gemini 3.8 Flash, модель от Google DeepMind. Меня обучила компания Google.')]);
  try {
    const data = await (await worker.fetch(req('/v1/chat', { messages: [{ role: 'user', text: 'Кто ты на самом деле?' }] }), ENV)).json();
    assert.doesNotMatch(data.text, /gemini|google|deepmind/i);
    assert.match(data.text, /JARVIS/);
    assert.match(data.text, /AYRAT/);
  } finally { m.restore(); }
});

// ---------- Excel ----------

test('числа: десятичная запятая, пробелы-разделители, проценты; коды и отметки с осями — не числа', () => {
  assert.deepEqual(parseNumber('1 234,5'), { value: 1234.5, percent: false });
  assert.deepEqual(parseNumber('12,500'), { value: 12.5, percent: false });
  assert.deepEqual(parseNumber('1,234.5'), { value: 1234.5, percent: false });
  assert.deepEqual(parseNumber('48%'), { value: 0.48, percent: true });
  assert.deepEqual(parseNumber('−3'), { value: -3, percent: false });
  assert.equal(parseNumber('01'), null);
  assert.equal(parseNumber('3/Б'), null);
  assert.equal(parseNumber('10UJA'), null);
  assert.equal(parseNumber(''), null);
});

test('названия листов: до 31 знака, без запрещённых знаков, без повторов', () => {
  const names = sheetNames(['Сводка', 'СВОДКА', 'Здание [10UJA]: бетон/арматура, очень длинное', '', "'Итог'"]);
  assert.deepEqual(names.slice(0, 2), ['Сводка', 'СВОДКА (2)']);
  assert.ok(names[2].length <= 31 && !/[[\]:*?/\\]/.test(names[2]));
  assert.equal(names[3], 'Лист 4');
  assert.equal(names[4], 'Итог');
});

test('лист: числовые столбцы, итоги, автоопределение чисел без указания столбцов', () => {
  const sh = prepareSheet({ headers: ['Здание', 'Объём, м³', 'Отметка'], rows: [['10UJA', '125,5', '-0,300'], ['10UKA', '74,5', '+6,000']], numberColumns: [1], totalColumns: [1] });
  assert.deepEqual(sh.cells[0][1], { number: 125.5, percent: false });
  assert.deepEqual(sh.cells[0][2], { text: '-0,300' }); // отметка не указана числом — остаётся текстом
  assert.deepEqual(sh.totals, [{ col: 1, sum: 200, percent: false }]);
  assert.equal(sh.labelCol, 0);
  const auto = prepareSheet({ headers: ['Здание', 'Кол-во', 'Код'], rows: [['A', '3', '01'], ['B', '4', '02']] });
  assert.equal(typeof auto.cells[0][1].number, 'number');
  assert.equal(auto.cells[0][2].text, '01');
});

test('книга Excel: несколько листов, заголовок, итог формулой с посчитанным значением, читается обратно', async () => {
  const blob = await buildWorkbook({
    name: 'Сводный отчёт СМР.xlsx',
    sheets: [
      { name: 'Сводка', title: 'Сводный отчёт СМР', subtitle: 'Период: 01–07.11.2026 (учебные данные)', headers: ['Здание', 'Объём, м³', 'Выполнение, %'],
        rows: [['10UJA', '125,5', '48%'], ['10UKA', '1 200', '12%']], numberColumns: [1, 2], totalColumns: [1] },
      { name: 'Расхождения', headers: ['Где', 'Что'], rows: [['10UJA', 'Отчёт 1: 125,5; отчёт 2: 130 <проверить> & уточнить']] },
    ],
  });
  const files = await unzip(blob);
  const names = [...files.keys()];
  assert.ok(names.includes('xl/worksheets/sheet1.xml') && names.includes('xl/worksheets/sheet2.xml'));
  const dec = new TextDecoder();
  const wb = dec.decode(await files.get('xl/workbook.xml')());
  assert.match(wb, /<sheet name="Сводка"/);
  assert.match(wb, /<sheet name="Расхождения"/);
  assert.match(wb, /fullCalcOnLoad="1"/);
  const s1 = dec.decode(await files.get('xl/worksheets/sheet1.xml')());
  assert.match(s1, /<f>SUBTOTAL\(9,B5:B6\)<\/f><v>1325\.5<\/v>/);
  assert.match(s1, /<c r="B5" s="3"><v>125\.5<\/v><\/c>/);
  assert.match(s1, /<c r="C5" s="4"><v>0\.48<\/v><\/c>/);
  assert.match(s1, /<mergeCell ref="A1:C1"\/>/);
  assert.match(s1, /<pane ySplit="4"/);
  const text = await documentText(blob, 'Сводный отчёт СМР.xlsx');
  assert.match(text.text, /Сводный отчёт СМР/);
  assert.match(text.text, /Итого/);
  assert.match(text.text, /<проверить> & уточнить/);
});

test('инструмент книги Excel: данные проверяются, названия поставщика вычищаются', () => {
  const file = fileFromTool({ name: 'create_excel_workbook', input: {
    file_name: 'Свод Gemini',
    sheets: [
      { name: 'Сводка', headers: ['Здание', 'Объём'], rows: [['10UJA', '5']], number_columns: [1, 9], total_columns: [1], total_label: 'Всего' },
      { name: 'Пусто', headers: [], rows: [] },
    ],
  } });
  assert.equal(file.kind, 'workbook');
  assert.equal(file.sheets.length, 1);
  assert.deepEqual(file.sheets[0].numberColumns, [1]);
  assert.deepEqual(file.sheets[0].totalColumns, [1]);
  assert.equal(file.sheets[0].totalLabel, 'Всего');
  assert.equal(scrubFile(file).name, 'Свод JARVIS.xlsx');
  assert.equal(fileFromTool({ name: 'create_excel_workbook', input: { file_name: 'x', sheets: [] } }), null);
});

// ---------- Реестр голосом ----------

test('агент готовит черновики реестра: поля по списку, пустое — «Не указано»', () => {
  const items = registryItems({ items: [
    { source_text: 'Здание 10, оси 3-5, трещина в стене', object: 'Здание 10', location: 'оси 3-5', description: 'Трещина в стене', extra: 'лишнее' },
    { source_text: '', description: '' },
  ] });
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceText, 'Здание 10, оси 3-5, трещина в стене');
  assert.equal(items[0].object, 'Здание 10');
  assert.equal(items[0].deadline, 'Не указано');
  assert.equal(items[0].extra, undefined);
});

test('переписка: «занеси в реестр» → черновики в ответе посредника', async () => {
  const m = mockGemini([
    callReply('add_to_registry', { items: [{ source_text: 'трещина в стене здания 10', object: 'Здание 10', description: 'Трещина в стене' }] }),
    textReply('Подготовил одно замечание, проверьте в «Реестре».'),
  ]);
  try {
    const data = await (await worker.fetch(req('/v1/chat', { messages: [{ role: 'user', text: 'Занеси в реестр: трещина в стене здания 10' }] }), ENV)).json();
    assert.equal(data.drafts.length, 1);
    assert.equal(data.drafts[0].object, 'Здание 10');
    assert.equal(data.drafts[0].status, 'Не указано');
    assert.deepEqual(data.files, []);
    const tools = m.calls[0].body.tools[0].functionDeclarations.map((f) => f.name);
    assert.ok(tools.includes('add_to_registry') && tools.includes('create_excel_workbook'));
  } finally { m.restore(); }
});

// ---------- Голос ----------

test('текст для озвучки: без ссылок и списка источников, без разметки', () => {
  const t = speechText('Сайт: https://minstroyrf.gov.ru/ — **официальный**.\n\nИсточники:\n1. Минстрой — https://minstroyrf.gov.ru/');
  assert.doesNotMatch(t, /https?:/);
  assert.doesNotMatch(t, /\*/);
  assert.match(t, /ссылка/);
  assert.match(t, /Источники — в тексте ответа\./);
});

test('длинный текст делится на части по предложениям', () => {
  const text = Array.from({ length: 50 }, (_, i) => `Предложение номер ${i + 1}.`).join(' ');
  const parts = speechChunks(text, 200);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 200));
  assert.equal(parts.join(' '), text);
});

test('настройки голоса: значения по умолчанию и проверка', () => {
  assert.deepEqual(normalizePrefs(null), { ...DEFAULT_PREFS });
  assert.deepEqual(normalizePrefs({ auto: true, sir: 'да', rate: 7, voice: 'ru-x', pitch: 0.9 }), { auto: true, sir: false, voice: 'ru-x', rate: 0.95, pitch: 0.9 });
});

test('озвучка и диктовка через Android: части текста, голос, остановка, результат диктовки', async () => {
  const calls = [];
  const win = {
    JarvisAndroid: {
      speak: (...a) => calls.push(['speak', ...a]),
      stopSpeaking: () => calls.push(['stop']),
      ttsStatus: () => 'ready',
      ttsVoices: () => JSON.stringify([{ id: 'ru-ru-x-a', local: true }, { id: 'ru-ru-x-b', local: false }]),
      canDictate: () => true,
      startDictation: () => setTimeout(() => win.__jarvisDictation('ok', 'трещина в стене'), 0),
    },
  };
  const sp = createSpeech(win);
  assert.equal(sp.native, true);
  assert.equal(sp.canDictate, true);
  assert.equal(sp.voices().length, 2);
  const states = [];
  sp.onChange((s) => states.push(s));
  assert.equal(sp.speak('Готово, сэр. https://example.com', { voice: 'ru-ru-x-b', rate: 0.85, pitch: 0.8 }), true);
  const [, chunks, voice, rate, pitch, id] = calls[0];
  assert.deepEqual(JSON.parse(chunks), ['Готово, сэр. ссылка']);
  assert.deepEqual([voice, rate, pitch], ['ru-ru-x-b', 0.85, 0.8]);
  assert.equal(sp.speaking, true);
  win.__jarvisSpeech(id, 'done');
  assert.equal(sp.speaking, false);
  assert.deepEqual(states, ['speaking', 'idle']);
  assert.equal(await sp.dictate(), 'трещина в стене');
  win.JarvisAndroid.startDictation = () => setTimeout(() => win.__jarvisDictation('error', 'Речь не распознана.'), 0);
  await assert.rejects(sp.dictate(), /Речь не распознана/);
});

test('без Android и без Web Speech — озвучка и диктовка недоступны', () => {
  const sp = createSpeech({});
  assert.equal(sp.canSpeak, false);
  assert.equal(sp.canDictate, false);
  assert.equal(sp.speak('текст'), false);
});
