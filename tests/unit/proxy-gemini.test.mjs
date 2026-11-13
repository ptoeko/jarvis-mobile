// Тесты посредника с поставщиком Gemini (имитация ответов Gemini API).
import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { providerOf, toGeminiRequest, fromGeminiResponse } from '../../proxy/worker.js';

const CODE = 'test-access-code-1234567890';
const ENV = { ACCESS_CODE: CODE, GEMINI_API_KEY: 'gm-test-key', GEMINI_MODEL: 'gemini-test-flash', ALLOWED_ORIGINS: 'https://appassets.androidplatform.net' };
const ORIGIN = 'https://appassets.androidplatform.net';

function req(path, { method = 'POST', body, code = CODE } = {}) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${code}` };
  return new Request(`https://jarvis-agent.example.workers.dev${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function mockGemini(replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = replies.shift();
    if (r && r.status) return new Response(JSON.stringify(r.body), { status: r.status });
    return new Response(JSON.stringify(r), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const textReply = (text) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });

test('выбор поставщика: Gemini при наличии ключа Gemini, явный PROVIDER важнее', () => {
  assert.equal(providerOf({ GEMINI_API_KEY: 'x' }), 'gemini');
  assert.equal(providerOf({ ANTHROPIC_API_KEY: 'x' }), 'anthropic');
  assert.equal(providerOf({ GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }), 'gemini');
  assert.equal(providerOf({ GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', PROVIDER: 'anthropic' }), 'anthropic');
  assert.equal(providerOf({ PROVIDER: ' Gemini ' }), 'gemini');
});

test('Gemini без ключа — 503 с понятным текстом', async () => {
  const res = await worker.fetch(req('/v1/health', { method: 'GET' }), { ...ENV, GEMINI_API_KEY: '', PROVIDER: 'gemini' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /не задан ключ/);
});

test('переписка через Gemini: адрес модели, ключ в заголовке, роль агента, ответ без названия поставщика', async () => {
  const m = mockGemini([textReply('Я ИИ агент JARVIS.')]);
  try {
    const res = await worker.fetch(req('/v1/chat', { body: { messages: [{ role: 'user', text: 'Кто ты?' }] } }), ENV);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(data, { text: 'Я ИИ агент JARVIS.', files: [] });
    const c = m.calls[0];
    assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-flash:generateContent');
    assert.equal(c.headers['x-goog-api-key'], 'gm-test-key');
    assert.match(c.body.systemInstruction.parts[0].text, /Никогда не называй модель/);
    assert.deepEqual(c.body.contents, [{ role: 'user', parts: [{ text: 'Кто ты?' }] }]);
    assert.equal(c.body.tools[0].functionDeclarations.map((f) => f.name).join(','), 'create_table,create_text_file');
    assert.ok(!JSON.stringify(data).includes('gm-test-key'));
  } finally { m.restore(); }
});

test('Gemini создаёт таблицу: вызов функции с подписью рассуждения возвращается без изменений', async () => {
  const call = { functionCall: { name: 'create_table', args: { file_name: 'Ведомость', headers: ['№', 'Замечание'], rows: [['1', 'скол']] } }, thoughtSignature: 'SIG123' };
  const m = mockGemini([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'думаю', thought: true }, { text: 'Готовлю ведомость.' }, call] } }] },
    textReply('Ведомость во вложении.'),
  ]);
  try {
    const res = await worker.fetch(req('/v1/chat', { body: { messages: [{ role: 'user', text: 'Сделай ведомость' }] } }), ENV);
    const data = await res.json();
    assert.equal(data.text, 'Готовлю ведомость.\n\nВедомость во вложении.', 'рассуждение не показывается');
    assert.deepEqual(data.files, [{ kind: 'table', name: 'Ведомость.xlsx', headers: ['№', 'Замечание'], rows: [['1', 'скол']] }]);
    const second = m.calls[1].body.contents;
    assert.equal(second.length, 3);
    assert.equal(second[1].role, 'model');
    assert.deepEqual(second[1].parts.at(-1), call, 'подпись рассуждения сохранена');
    assert.deepEqual(second[2], { role: 'user', parts: [{ functionResponse: { name: 'create_table', response: { result: 'Файл «Ведомость.xlsx» создан и будет приложен к ответу.' } } }] });
  } finally { m.restore(); }
});

test('фото и PDF уходят в Gemini содержимым, ответ агента — роль model', () => {
  const r = toGeminiRequest({
    system: 'S', max_tokens: 100,
    messages: [
      { role: 'user', content: [{ type: 'image', source: { media_type: 'image/jpeg', data: 'AAA' } }, { type: 'document', source: { media_type: 'application/pdf', data: 'BBB' }, title: 'акт.pdf' }, { type: 'text', text: 'смотри' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'вижу' }] },
      { role: 'user', content: 'ещё' },
    ],
  });
  assert.deepEqual(r.contents[0].parts, [
    { inlineData: { mimeType: 'image/jpeg', data: 'AAA' } },
    { inlineData: { mimeType: 'application/pdf', data: 'BBB' } },
    { text: '[Документ: акт.pdf]' },
    { text: 'смотри' },
  ]);
  assert.deepEqual(r.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(r.tools, undefined);
  assert.ok(r.generationConfig.maxOutputTokens > 100);
});

test('разбор заметок через Gemini: ответ в формате JSON', async () => {
  const m = mockGemini([textReply('{"items":[{"date":"23.10.2026","object":"корпус 7","location":""}]}')]);
  try {
    const res = await worker.fetch(req('/v1/parse', { body: { notes: ['23.10.2026 корпус 7 — скол'] } }), ENV);
    const { items } = await res.json();
    assert.equal(items[0].object, 'корпус 7');
    assert.equal(items[0].location, 'Не указано');
    assert.equal(m.calls[0].body.generationConfig.responseMimeType, 'application/json');
  } finally { m.restore(); }
});

test('пустой или заблокированный ответ Gemini — понятный текст', async () => {
  const m = mockGemini([{ promptFeedback: { blockReason: 'SAFETY' } }]);
  try {
    const res = await worker.fetch(req('/v1/chat', { body: { messages: [{ role: 'user', text: 'x' }] } }), ENV);
    assert.equal((await res.json()).text, 'ИИ агент не дал ответа. Повторите вопрос.');
  } finally { m.restore(); }
  assert.deepEqual(fromGeminiResponse({}), { content: [], stop_reason: 'end_turn' });
});

test('ошибки Gemini: понятный текст без названия поставщика', async () => {
  const cases = [
    [{ status: 400, body: { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } } }, 502, /региона/],
    [{ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } } }, 502, /ключ ИИ недействителен/],
    [{ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google denied' } } }, 502, /ключ ИИ недействителен/],
    [{ status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for gemini' } } }, 429, /лимит/],
    [{ status: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: 'models/x is not found' } } }, 502, /модель ИИ недоступна/],
    [{ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request payload size exceeds the limit' } } }, 400, /не принял/],
    [{ status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded' } } }, 502, /перегружен/],
  ];
  for (const [reply, status, re] of cases) {
    const m = mockGemini([reply]);
    try {
      const res = await worker.fetch(req('/v1/chat', { body: { messages: [{ role: 'user', text: 'x' }] } }), ENV);
      assert.equal(res.status, status, re.source);
      const { error } = await res.json();
      assert.match(error, re);
      assert.doesNotMatch(error, /google|gemini/i);
    } finally { m.restore(); }
  }
});

test('выбор модели при публикации: новые стабильные flash выше, предварительные и специальные отбрасываются', async () => {
  const { rankModels } = await import('../../proxy/pick-gemini-model.mjs');
  const gen = ['generateContent'];
  const models = [
    { name: 'models/gemini-3.6-flash', supportedGenerationMethods: gen },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: gen },
    { name: 'models/gemini-3.8-flash-preview-09-2026', supportedGenerationMethods: gen },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: gen },
    { name: 'models/gemini-3.8-pro', supportedGenerationMethods: gen },
    { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: gen },
    { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-10.0-flash', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: gen },
  ];
  assert.deepEqual(rankModels(models), ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest']);
  assert.deepEqual(rankModels([]), ['gemini-flash-latest']);
});
