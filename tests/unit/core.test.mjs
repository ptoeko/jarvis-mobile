// Модульные тесты логики. Запуск: node --test tests/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateMessage } from '../../js/core/validate.js';
import { demoReply, DEMO_HELP_TEXT } from '../../js/core/demo.js';
import { createStore, createMemoryAdapter } from '../../js/core/store.js';
import { createAiClient, AiNotConfiguredError } from '../../js/core/ai.js';
import { computeFeatures, statusSummary } from '../../js/core/status.js';
import { emptyRecord, REGISTRY_FIELDS, NOT_SPECIFIED, MAX_MESSAGE_LENGTH } from '../../js/core/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- Проверка ввода ----------
test('пустое сообщение отклоняется с понятным текстом', () => {
  for (const input of ['', '   ', '\n\t ']) {
    const r = validateMessage(input);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Введите текст сообщения.');
  }
});

test('не текст отклоняется', () => {
  assert.equal(validateMessage(null).ok, false);
  assert.equal(validateMessage(42).ok, false);
});

test('слишком длинное сообщение отклоняется, граница — ровно максимум', () => {
  assert.equal(validateMessage('а'.repeat(MAX_MESSAGE_LENGTH)).ok, true);
  const r = validateMessage('а'.repeat(MAX_MESSAGE_LENGTH + 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /слишком длинное/);
});

test('управляющие символы удаляются, переводы строк сохраняются', () => {
  const r = validateMessage('  Ось А\u0007-1\r\nотм. +3.600  ');
  assert.deepEqual(r, { ok: true, value: 'Ось А-1\nотм. +3.600' });
});

// ---------- Демо-ответы ----------
test('демо-ответ всегда помечен источником demo', () => {
  for (const text of ['помощь', 'Статус', 'бетон В25, ось 3, раковины']) {
    assert.equal(demoReply(text).source, 'demo');
  }
});

test('команда «помощь» возвращает справку, регистр и точка не важны', () => {
  assert.equal(demoReply('Помощь.').text, DEMO_HELP_TEXT);
  assert.match(DEMO_HELP_TEXT, /ИИ не подключён/);
});

test('обычное сообщение не анализируется и не выдаётся за ИИ', () => {
  const r = demoReply('Трещина в стене по оси Б, отметка +6.000');
  assert.match(r.text, /ИИ не подключён/);
  assert.doesNotMatch(r.text, /Трещина|оси Б/); // ответ не пересказывает и не «понимает» заметку
});

test('команда «статус» включает переданную сводку', () => {
  const r = demoReply('статус', 'Диалог: демо');
  assert.match(r.text, /Диалог: демо/);
});

// ---------- Хранилище ----------
test('сообщения сохраняются и возвращаются по времени', async () => {
  let t = 0;
  const store = createStore(createMemoryAdapter(), () => new Date(Date.UTC(2026, 9, 22, 10, 0, t++)));
  await store.addMessage({ role: 'user', source: 'user', text: 'первое' });
  await store.addMessage({ role: 'assistant', source: 'demo', text: 'второе' });
  const list = await store.listMessages();
  assert.deepEqual(list.map((m) => m.text), ['первое', 'второе']);
  assert.ok(list.every((m) => typeof m.id === 'string' && m.id.length > 0));
});

test('неверная роль, источник или пустой текст не сохраняются', async () => {
  const store = createStore(createMemoryAdapter());
  await assert.rejects(store.addMessage({ role: 'admin', source: 'user', text: 'x' }));
  await assert.rejects(store.addMessage({ role: 'user', source: 'hacker', text: 'x' }));
  await assert.rejects(store.addMessage({ role: 'user', source: 'user', text: '' }));
  assert.equal((await store.counts()).messages, 0);
});

test('удаление истории очищает сообщения и записи, но не настройки', async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.addMessage({ role: 'user', source: 'user', text: 'заметка' });
  await adapter.put('records', { id: 'r1', ...emptyRecord() });
  await store.setMeta('lastScreen', 'status');
  assert.deepEqual(await store.counts(), { messages: 1, records: 1 });
  await store.clearHistory();
  assert.deepEqual(await store.counts(), { messages: 0, records: 0 });
  assert.equal(await store.getMeta('lastScreen'), 'status');
});

test('возвращаемые объекты — копии, их изменение не портит хранилище', async () => {
  const store = createStore(createMemoryAdapter());
  await store.addMessage({ role: 'user', source: 'user', text: 'исходный' });
  const [m] = await store.listMessages();
  m.text = 'изменённый';
  const [again] = await store.listMessages();
  assert.equal(again.text, 'исходный');
});

// ---------- Реестр ----------
test('пустая запись реестра: все поля «Не указано»', () => {
  const r = emptyRecord();
  assert.equal(Object.keys(r).length, REGISTRY_FIELDS.length);
  assert.ok(Object.values(r).every((v) => v === NOT_SPECIFIED));
  assert.ok(REGISTRY_FIELDS.some((f) => f.key === 'sourceText'), 'поле «Исходный текст» обязательно');
});

// ---------- ИИ не подключён ----------
test('клиент ИИ по умолчанию не подключён и не делает запросов', async () => {
  const client = createAiClient();
  assert.equal(client.configured, false);
  await assert.rejects(client.send('привет'), AiNotConfiguredError);
});

// ---------- Статус ----------
const BASE_ENV = { storage: 'indexeddb', persisted: true, offlineReady: true, standalone: false, online: true, aiConfigured: false };

test('без ИИ диалог показан как демо, ИИ — как запланированный этап 4', () => {
  const f = Object.fromEntries(computeFeatures(BASE_ENV).map((x) => [x.id, x]));
  assert.equal(f.dialog.state, 'demo');
  assert.equal(f.ai.state, 'planned');
  assert.equal(f.ai.stage, 4);
  assert.equal(f['voice-app'].stage, 3);
});

test('без IndexedDB сохранение показано как недоступное', () => {
  const f = computeFeatures({ ...BASE_ENV, storage: 'memory' }).find((x) => x.id === 'storage');
  assert.equal(f.state, 'unavailable');
});

test('без сети и без офлайн-кеша состояние честно «недоступно»', () => {
  const list = computeFeatures({ ...BASE_ENV, online: false, offlineReady: false });
  assert.equal(list.find((x) => x.id === 'network').state, 'unavailable');
  assert.equal(list.find((x) => x.id === 'offline').state, 'unavailable');
});

test('этап 2: разбор — демо по правилам, CSV работает, XLSX не подключён; этапы 3–4 не работают', () => {
  const f = Object.fromEntries(computeFeatures(BASE_ENV).map((x) => [x.id, x]));
  assert.equal(f.registry.state, 'demo');
  assert.equal(f.registry.label, 'По правилам');
  assert.match(f.registry.note, /не ИИ/);
  assert.equal(f.export.state, 'works');
  assert.equal(f.xlsx.state, 'off');
  for (const id of ['voice-app', 'ai']) assert.notEqual(f[id].state, 'works', id);
});

test('краткая сводка статуса содержит демо-режим', () => {
  assert.match(statusSummary(computeFeatures(BASE_ENV)), /Диалог: демо/);
});

// ---------- Проверки проекта ----------
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'tests' || name.startsWith('.')) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('в коде приложения нет ключей API и секретов', () => {
  const patterns = [/sk-ant-[A-Za-z0-9_-]{10,}/, /sk-[A-Za-z0-9]{20,}/, /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i, /Bearer\s+[A-Za-z0-9._-]{20,}/];
  const files = walk(ROOT).filter((p) => /\.(js|html|json|webmanifest|css)$/.test(p));
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) assert.doesNotMatch(text, re, `${file}: похоже на секрет`);
  }
});

test('приложение не обращается к внешним серверам', () => {
  const files = walk(ROOT).filter((p) => /\.(js|html|css)$/.test(p));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org)/, `${file}: внешний адрес`);
  }
});

test('все файлы из списка офлайн-кеша существуют, и все модули в нём перечислены', () => {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  for (const path of shell) assert.ok(existsSync(join(ROOT, path)), `нет файла ${path}`);
  const jsFiles = walk(join(ROOT, 'js')).map((p) => p.slice(ROOT.length + 1));
  for (const js of jsFiles) assert.ok(shell.includes(js), `${js} не добавлен в офлайн-кеш`);
});

test('версия в service worker совпадает с версией приложения', async () => {
  const { APP_VERSION } = await import('../../js/core/config.js');
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, new RegExp(`const VERSION = '${APP_VERSION.replace(/\./g, '\\.')}'`));
});

test('пользовательский текст не выводится через innerHTML', () => {
  const app = readFileSync(join(ROOT, 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|document\.write/);
});

test('неустановленное приложение и выключенная защита данных — предупреждение, а не ошибка', () => {
  const list = computeFeatures({ ...BASE_ENV, persisted: false, standalone: false });
  assert.equal(list.find((x) => x.id === 'persist').state, 'off');
  const install = list.find((x) => x.id === 'install');
  assert.equal(install.state, 'off');
  assert.equal(install.label, 'Не установлено');
});
