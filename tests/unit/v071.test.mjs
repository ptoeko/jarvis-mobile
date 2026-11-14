// Тесты версии 0.7.1: произношение — словарь и ударения от ИИ агента.
import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { sameExceptAccents } from '../../proxy/worker.js';
import { applyDictionary, acceptAccents, plusToStress, stressToPlus, normalizeDictionary, normalizeEntry, BUILTIN } from '../../js/core/pronounce.js';

const S = '́';
const CODE = 'test-access-code-1234567890';
const ENV = { ACCESS_CODE: CODE, GEMINI_API_KEY: 'gm-test-key', GEMINI_MODEL: 'gemini-test-flash' };
const req = (path, body) => new Request(`https://jarvis-agent.example.workers.dev${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CODE}` }, body: JSON.stringify(body),
});
function mockGemini(text) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('ударение: «+» после гласной → знак ударения; «+» перед числом не трогается', () => {
  assert.equal(plusToStress('Айра+т'), `Айра${S}т`);
  assert.equal(plusToStress('отметка +6,000'), 'отметка +6,000');
  assert.equal(stressToPlus(`ве${S}домость`), 'ве+домость');
});

test('словарь: слова из замечаний пользователя читаются правильно', () => {
  const t = applyDictionary('Я JARVIS, мой разработчик — AYRAT. В осях 3-5 нет ведомостей. Поиск по СМР.');
  assert.equal(t, `Я Джа${S}рвис, мой разработчик — Айра${S}т. В ося${S}х 3-5 нет ве${S}домостей. По${S}иск по эс-эм-э${S}р.`);
});

test('словарь: целое слово, регистр в начале предложения, ё и е, длинные раньше коротких', () => {
  assert.equal(applyDictionary('Ведомость сдана, поисковик и осях.'), `Ве${S}домость сдана, поисковик и ося${S}х.`);
  assert.equal(applyDictionary('125 м³ бетона'), `125 кубоме${S}тров бетона`);
  assert.equal(applyDictionary('ёлка', [{ word: 'елка', reading: 'ё+лочка' }]), `ё${S}лочка`);
  // Своя запись важнее встроенной.
  assert.equal(applyDictionary('JARVIS', [{ word: 'jarvis', reading: 'Джарви+с' }]), `Джарви${S}с`);
  assert.ok(BUILTIN.some(([w]) => w === 'AYRAT'));
});

test('свой словарь: пустые и повторные записи отбрасываются', () => {
  assert.equal(normalizeEntry('  ', 'x'), null);
  assert.equal(normalizeEntry('+', 'x'), null);
  assert.deepEqual(normalizeEntry(' ростверк ', ' ростве+рк '), { word: 'ростверк', reading: 'ростве+рк' });
  assert.deepEqual(normalizeDictionary([{ word: 'А', reading: 'а' }, { word: 'а', reading: 'б' }, null, { word: 'б' }]), [{ word: 'А', reading: 'а' }]);
});

test('ударения агента принимаются, только если текст не изменён', () => {
  assert.equal(acceptAccents('На двери замок.', 'На двери за+мок.'), `На двери за${S}мок.`);
  assert.equal(acceptAccents(`Я Джа${S}рвис`, `Я Джа${S}рвис`), `Я Джа${S}рвис`);
  assert.equal(acceptAccents('замок', 'дворец'), null);
  assert.equal(acceptAccents('замок', ''), null);
  assert.equal(acceptAccents('строка\nвторая', 'стро+ка вторa'), null);
});

test('посредник: ударения расставляет ИИ, изменённый текст не принимается', async () => {
  let m = mockGemini('На двери за+мок, отметка +6,000.');
  try {
    const res = await worker.fetch(req('/v1/accent', { text: 'На двери замок, отметка +6,000.' }), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'На двери за+мок, отметка +6,000.' });
    assert.match(m.calls[0].systemInstruction.parts[0].text, /ударной гласной/);
  } finally { m.restore(); }
  m = mockGemini('Совсем другой текст');
  try {
    const res = await worker.fetch(req('/v1/accent', { text: 'На двери замок.' }), ENV);
    assert.equal(res.status, 502);
  } finally { m.restore(); }
  assert.equal((await worker.fetch(req('/v1/accent', { text: '' }), ENV)).status, 400);
  assert.ok(sameExceptAccents('a  b', 'a b'));
});
