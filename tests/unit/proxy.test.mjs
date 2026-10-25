// Тесты посредника «ИИ агент» (proxy/worker.js) с имитацией ИИ.
import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { sameCode, toModelMessages, parseItems, fileFromTool } from '../../proxy/worker.js';

const CODE = 'test-access-code-1234567890';
const ENV = { ACCESS_CODE: CODE, ANTHROPIC_API_KEY: 'sk-test', MODEL: 'test-model', ALLOWED_ORIGINS: 'https://appassets.androidplatform.net' };
const ORIGIN = 'https://appassets.androidplatform.net';

function req(path, { method = 'POST', body, code = CODE, origin = ORIGIN } = {}) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  if (code) headers.Authorization = `Bearer ${code}`;
  return new Request(`https://jarvis-agent.example.workers.dev${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Имитация ИИ: очередь ответов; запоминает запросы.
function mockModel(replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = replies.shift();
    if (typeof r === 'number') return new Response(JSON.stringify({ error: { message: 'anthropic internal detail' } }), { status: r });
    return new Response(JSON.stringify(r), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const textReply = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

test('без кода или с неверным кодом — 401, ИИ не вызывается', async () => {
  const m = mockModel([]);
  try {
    for (const code of [null, 'wrong-code-000000000']) {
      const res = await worker.fetch(req('/v1/health', { method: 'GET', code }), ENV);
      assert.equal(res.status, 401);
    }
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('посредник без ключа или кода — 503 с понятным текстом', async () => {
  const res = await worker.fetch(req('/v1/health', { method: 'GET' }), { ...ENV, ANTHROPIC_API_KEY: '' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /не задан ключ/);
});

test('проверка связи и CORS только для приложения', async () => {
  const ok = await worker.fetch(req('/v1/health', { method: 'GET' }), ENV);
  assert.deepEqual(await ok.json(), { ok: true, agent: 'ИИ агент' });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const other = await worker.fetch(req('/v1/health', { method: 'GET', origin: 'https://evil.example' }), ENV);
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
});

test('переписка: роль «ИИ агент», модель из настроек, ключ не уходит в ответ', async () => {
  const m = mockModel([textReply('Здравствуйте! Я ИИ агент JARVIS.')]);
  try {
    const res = await worker.fetch(req('/v1/chat', { body: { messages: [{ role: 'user', text: 'Кто ты?' }] } }), ENV);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.text, 'Здравствуйте! Я ИИ агент JARVIS.');
    assert.deepEqual(data.files, []);
    const sent = m.calls[0];
    assert.equal(sent.body.model, 'test-model');
    assert.match(sent.body.system, /Никогда не называй модель/);
    assert.equal(sent.headers['x-api-key'], 'sk-test');
    assert.ok(!JSON.stringify(data).includes('sk-test'));
  } finally { m.restore(); }
});

test('агент создаёт таблицу и текст: файлы приходят в ответе, затем итоговый текст', async () => {
  const m = mockModel([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Готовлю ведомость.' },
        { type: 'tool_use', id: 't1', name: 'create_table', input: { file_name: 'Ведомость корпус 7', headers: ['№', 'Замечание'], rows: [['1', 'скол'], ['2', 'трещина']] } },
        { type: 'tool_use', id: 't2', name: 'create_text_file', input: { file_name: 'письмо.txt', content: 'Уважаемые коллеги…' } },
      ],
    },
    textReply('Ведомость и письмо во вложении.'),
  ]);
  try {
    const res = await worker.fetch(req('/v1/chat', { body: { messages: [{ role: 'user', text: 'Сделай ведомость' }] } }), ENV);
    const data = await res.json();
    assert.equal(data.files.length, 2);
    assert.deepEqual(data.files[0], { kind: 'table', name: 'Ведомость корпус 7.xlsx', headers: ['№', 'Замечание'], rows: [['1', 'скол'], ['2', 'трещина']] });
    assert.equal(data.files[1].name, 'письмо.txt');
    assert.equal(data.text, 'Готовлю ведомость.\n\nВедомость и письмо во вложении.');
    // Второй запрос содержит результаты инструментов.
    const last = m.calls[1].body.messages.at(-1);
    assert.equal(last.content[0].type, 'tool_result');
  } finally { m.restore(); }
});

test('ошибки поставщика: понятный текст без его названия', async () => {
  for (const [status, re] of [[401, /ключ ИИ/], [429, /лимит/], [400, /не принял/], [529, /перегружен/]]) {
    const m = mockModel([status]);
    try {
      const res = await worker.fetch(req('/v1/chat', { body: { messages: [{ role: 'user', text: 'x' }] } }), ENV);
      const { error } = await res.json();
      assert.match(error, re);
      assert.doesNotMatch(error, /anthropic|claude/i);
    } finally { m.restore(); }
  }
});

test('сообщения: фото и PDF — содержимым, остальные файлы — названием; роли чередуются', () => {
  const out = toModelMessages([
    { role: 'assistant', text: 'приветствие без вопроса' },
    { role: 'user', text: 'смотри', files: [{ name: 'a.jpg', type: 'image/jpeg', data: 'AAA' }, { name: 'акт.pdf', type: 'application/pdf', data: 'BBB' }, { name: 'в.docx', type: 'application/msword' }] },
    { role: 'user', text: 'ещё' },
    { role: 'assistant', text: 'ответ' },
  ]);
  assert.equal(out[0].role, 'user', 'история начинается с пользователя');
  assert.equal(out.length, 2);
  const types = out[0].content.map((c) => c.type);
  assert.deepEqual(types, ['image', 'text', 'document', 'text', 'text', 'text']);
  assert.match(out[0].content[3].text, /в\.docx — содержимое не передано/);
});

test('разбор заметок: только JSON, пустое — «Не указано», число совпадает', async () => {
  const m = mockModel([textReply('```json\n{"items":[{"date":"23.10.2026","object":"корпус 7","location":"","status":"  "}]}\n```')]);
  try {
    const res = await worker.fetch(req('/v1/parse', { body: { notes: ['23.10.2026 корпус 7 — скол'] } }), ENV);
    const { items } = await res.json();
    assert.equal(items[0].date, '23.10.2026');
    assert.equal(items[0].location, 'Не указано');
    assert.equal(items[0].status, 'Не указано');
    assert.equal(items[0].responsible, 'Не указано');
  } finally { m.restore(); }
  assert.throws(() => parseItems('{"items":[]}', 1));
  assert.throws(() => parseItems('не json', 1));
});

test('прочее: сравнение кода, имя файла, слишком много заметок, неизвестный адрес', async () => {
  assert.equal(sameCode('abc', 'abc'), true);
  assert.equal(sameCode('abc', 'abd'), false);
  assert.equal(sameCode('abc', 'abcd'), false);
  assert.equal(fileFromTool({ name: 'create_table', input: { file_name: 'a/b', headers: [] } }), null);
  assert.equal(fileFromTool({ name: 'create_text_file', input: { file_name: 'x:y', content: 't' } }).name, 'x_y.txt');
  const many = await worker.fetch(req('/v1/parse', { body: { notes: Array(21).fill('x') } }), ENV);
  assert.equal(many.status, 400);
  const nf = await worker.fetch(req('/v1/nothing', { method: 'GET' }), ENV);
  assert.equal(nf.status, 404);
});
