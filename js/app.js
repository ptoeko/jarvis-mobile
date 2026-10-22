// Связывает интерфейс с логикой. Пользовательский текст выводится только
// через textContent — HTML из сообщений никогда не исполняется.
import { APP_VERSION, APP_STAGE, REGISTRY_FIELDS } from './core/config.js';
import { validateMessage } from './core/validate.js';
import { demoReply } from './core/demo.js';
import { createStore, createMemoryAdapter } from './core/store.js';
import { createIdbAdapter } from './core/idb.js';
import { createAiClient } from './core/ai.js';
import { computeFeatures, statusSummary, STATE_LABELS } from './core/status.js';

const SCREENS = ['dialog', 'registry', 'settings', 'status'];
const $ = (id) => document.getElementById(id);

const env = {
  storage: 'memory',
  persisted: null,
  offlineReady: null,
  standalone: false,
  online: navigator.onLine,
  aiConfigured: false,
};

let store;
const ai = createAiClient();
env.aiConfigured = ai.configured;

// ---------- Хранилище ----------
async function initStore() {
  try {
    const adapter = await createIdbAdapter();
    env.storage = 'indexeddb';
    return createStore(adapter);
  } catch (error) {
    console.error(error);
    env.storage = 'memory';
    showBanner('Хранилище браузера недоступно. История не сохранится после закрытия приложения. Откройте приложение в Chrome без режима инкогнито.');
    return createStore(createMemoryAdapter());
  }
}

async function initPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return;
    let persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage.persist) persisted = await navigator.storage.persist();
    env.persisted = persisted;
  } catch {
    env.persisted = null;
  }
}

// ---------- Офлайн-режим ----------
async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    env.offlineReady = false;
    return;
  }
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    env.offlineReady = keys.some((k) => k.startsWith('jarvis-shell-'));
  } catch (error) {
    console.error(error);
    env.offlineReady = false;
  }
}

// ---------- Общие элементы ----------
function showBanner(text) {
  const banner = $('storage-banner');
  banner.textContent = text;
  banner.hidden = false;
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ---------- Экраны ----------
function showScreen(name) {
  const target = SCREENS.includes(name) ? name : 'dialog';
  for (const section of document.querySelectorAll('.screen')) {
    section.hidden = section.dataset.screen !== target;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.target === target) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('main').scrollTop = target === 'dialog' ? $('main').scrollHeight : 0;
  if (target === 'status') renderStatus();
  if (target === 'settings') renderSettings();
  if (target === 'registry') renderRegistry();
}

function currentRoute() {
  return location.hash.replace('#', '') || 'dialog';
}

// ---------- Диалог ----------
function messageElement(message) {
  const li = document.createElement('li');
  li.className = `msg msg-${message.role}`;
  li.dataset.source = message.source;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  if (message.role === 'assistant') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = message.source === 'ai' ? 'ИИ' : 'Демо';
    meta.append(badge);
    meta.append(message.source === 'ai' ? 'Ответ ИИ' : 'Демо-ответ, не ИИ');
  } else {
    meta.append('Вы');
  }
  const time = formatTime(message.createdAt);
  if (time) meta.append(`, ${time}`);

  const text = document.createElement('div');
  text.className = 'msg-text';
  text.textContent = message.text;

  li.append(meta, text);
  return li;
}

async function renderMessages() {
  const list = $('messages');
  const messages = await store.listMessages();
  list.replaceChildren(...messages.map(messageElement));
  $('messages-empty').hidden = messages.length > 0;
  $('main').scrollTop = $('main').scrollHeight;
}

function setComposerError(text) {
  const el = $('composer-error');
  el.textContent = text || '';
  el.hidden = !text;
  $('input').setAttribute('aria-invalid', text ? 'true' : 'false');
}

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight + 2}px`;
}

let sending = false;
async function handleSubmit(event) {
  event.preventDefault();
  if (sending) return;
  const input = $('input');
  const result = validateMessage(input.value);
  if (!result.ok) {
    setComposerError(result.error);
    return;
  }
  setComposerError('');
  sending = true;
  $('send').disabled = true;
  try {
    await store.addMessage({ role: 'user', source: 'user', text: result.value });
    input.value = '';
    autosize();
    const reply = demoReply(result.value, statusSummary(computeFeatures(env)));
    await store.addMessage({ role: 'assistant', source: reply.source, text: reply.text });
    pulseCore();
    await renderMessages();
  } catch (error) {
    console.error(error);
    setComposerError('Не удалось сохранить сообщение. Попробуйте ещё раз. Если ошибка повторяется, перезапустите приложение.');
  } finally {
    sending = false;
    $('send').disabled = false;
  }
}

function pulseCore() {
  const core = document.querySelector('.core');
  core.classList.remove('busy');
  void core.getBoundingClientRect();
  core.classList.add('busy');
}

// ---------- Реестр ----------
async function renderRegistry() {
  const head = $('registry-head');
  if (!head.childElementCount) {
    head.append(...REGISTRY_FIELDS.map((f) => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = f.title;
      return th;
    }));
  }
  const records = await store.listRecords();
  $('records-count').textContent = `Записей: ${records.length}`;
  const body = $('registry-body');
  if (records.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = REGISTRY_FIELDS.length;
    td.className = 'empty-row';
    td.textContent = 'Записей пока нет.';
    tr.append(td);
    body.replaceChildren(tr);
    return;
  }
  body.replaceChildren(...records.map((r) => {
    const tr = document.createElement('tr');
    tr.append(...REGISTRY_FIELDS.map((f) => {
      const td = document.createElement('td');
      td.textContent = r[f.key] ?? '';
      return td;
    }));
    return tr;
  }));
}

// ---------- Настройки ----------
async function renderSettings() {
  const counts = await store.counts();
  $('count-messages').textContent = String(counts.messages);
  $('count-records').textContent = String(counts.records);
  $('storage-kind').textContent = env.storage === 'indexeddb' ? 'В браузере телефона' : 'Только в памяти (не сохраняется)';
  $('app-version').textContent = APP_VERSION;
  $('app-stage').textContent = `Этап ${APP_STAGE} из 5`;
}

function askDelete() {
  const dialog = $('confirm-delete');
  dialog.returnValue = '';
  dialog.showModal();
}

async function handleDeleteClose() {
  if ($('confirm-delete').returnValue !== 'delete') return;
  try {
    await store.clearHistory();
    await Promise.all([renderMessages(), renderSettings(), renderRegistry()]);
    toast('История удалена');
  } catch (error) {
    console.error(error);
    toast('Не удалось удалить историю. Перезапустите приложение и повторите.');
  }
}

// ---------- Статус ----------
function renderStatus() {
  env.online = navigator.onLine;
  env.standalone = window.matchMedia('(display-mode: standalone)').matches;
  const items = computeFeatures(env).map((f) => {
    const li = document.createElement('li');
    li.className = 'feature';
    li.dataset.feature = f.id;
    const name = document.createElement('span');
    name.className = 'feature-name';
    name.textContent = f.name;
    const state = document.createElement('span');
    state.className = `state state-${f.state}`;
    state.textContent = f.label || (f.stage && f.state === 'planned' ? `Этап ${f.stage}` : STATE_LABELS[f.state]);
    const note = document.createElement('span');
    note.className = 'feature-note';
    note.textContent = f.note;
    li.append(name, state, note);
    return li;
  });
  $('features').replaceChildren(...items);
}

// ---------- Запуск ----------
async function start() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      const target = tab.dataset.target;
      if (currentRoute() === target) showScreen(target);
      else location.hash = target;
    });
  }
  window.addEventListener('hashchange', () => showScreen(currentRoute()));
  window.addEventListener('online', renderStatus);
  window.addEventListener('offline', renderStatus);

  const input = $('input');
  $('composer').addEventListener('submit', handleSubmit);
  input.addEventListener('input', () => { autosize(); setComposerError(''); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('delete-history').addEventListener('click', askDelete);
  $('confirm-delete').addEventListener('close', handleDeleteClose);

  store = await initStore();
  await renderMessages();
  showScreen(currentRoute());
  document.documentElement.dataset.ready = 'true';

  // Не блокируют запуск интерфейса.
  initPersistence().then(renderStatus);
  initServiceWorker().then(renderStatus);
}

start().catch((error) => {
  console.error(error);
  showBanner('Приложение не запустилось. Обновите страницу. Если ошибка повторяется, сообщите разработчику.');
});
