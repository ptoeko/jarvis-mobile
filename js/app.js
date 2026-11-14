// Связывает интерфейс с логикой. Пользовательский текст выводится только
// через textContent и value — HTML из сообщений и заметок никогда не исполняется.
import { APP_VERSION, APP_STAGE, REGISTRY_FIELDS, EDITABLE_FIELDS, NOT_SPECIFIED } from './core/config.js';
import { validateMessage } from './core/validate.js';
import { demoReply, draftsReply } from './core/demo.js';
import { createStore, createMemoryAdapter, RecordError } from './core/store.js';
import { createIdbAdapter } from './core/idb.js';
import { documentText, canRead } from './core/docread.js';
import { buildDocx, DOCX_MIME } from './core/docx.js';
import { buildWorkbook } from './core/workbook.js';
import { createSpeech, normalizePrefs, speechText, META_VOICE, RATES } from './core/speech.js';
import { createLock, PIN_LENGTH, RELOCK_AFTER_MS } from './core/lock.js';
import { applyDictionary, acceptAccents, normalizeDictionary, normalizeEntry, META_PRONOUNCE } from './core/pronounce.js';
import { createAiClient, AiError, normalizeAgentUrl, validAccessCode, blobToBase64, META_AI_URL, META_AI_CODE, AI_LABEL } from './core/ai.js';
import { computeFeatures, statusSummary, STATE_LABELS } from './core/status.js';
import { parseMessage } from './core/parse.js';
import { createDraft } from './core/records.js';
import { recordsToCsv, exportFileName } from './core/csv.js';
import { recordsToXlsx, xlsxFileName, XLSX_MIME, registryTable, tableToXlsx } from './core/xlsx.js';
import { detectPlatform, installSaveCallback, saveViaBridge, saveBlobViaBridge, openBlobViaBridge, copyText, shareViaBridge, supportsShare } from './core/platform.js';
import { messageShare, recordShare, registryShare, targetLabel } from './core/share.js';
import { ACCEPT, checkFiles, formatSize, kindLabel, attachmentRefs } from './core/attachments.js';
import { createBackup, inspectBackup, restoreBackup, backupFileName, BackupError, META_LAST_BACKUP } from './core/backup.js';

const SCREENS = ['dialog', 'registry', 'settings'];
// Разделы «Настроек»: адрес #settings, #data, #status.
const PANES = { settings: 'main', data: 'data', status: 'status' };
const FIELD = Object.fromEntries(REGISTRY_FIELDS.map((f) => [f.key, f]));
const $ = (id) => document.getElementById(id);

const platform = detectPlatform(window);

const env = {
  platform: platform.kind,
  storage: 'memory',
  persisted: null,
  offlineReady: null,
  standalone: false,
  online: navigator.onLine,
  aiConfigured: false,
};

let store;
// ИИ агент: адрес посредника и код доступа хранятся на телефоне (Настройки).
let ai = createAiClient();
const speech = createSpeech(window);
let voicePrefs = normalizePrefs(null);
let pronunciation = [];
const accentCache = new Map(); // текст → текст с ударениями от агента
env.aiConfigured = false;

async function loadAi() {
  const url = await store.getMeta(META_AI_URL);
  const code = await store.getMeta(META_AI_CODE);
  ai = createAiClient(url && code ? { url, code } : {});
  env.aiConfigured = ai.configured;
  updateModeLine();
}

function updateModeLine() {
  const line = $('mode-line');
  line.dataset.mode = env.aiConfigured ? 'ai' : 'demo';
  line.textContent = env.aiConfigured ? `${AI_LABEL} подключён` : 'Демо-режим: ИИ не подключён';
}

// Черновики ждут подтверждения человеком. Копия хранится в базе (без этого
// Android, закрыв приложение в фоне, стёр бы непроверенные заметки).
let drafts = [];

let draftSaveTimer = null;
function persistDrafts() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  return store.saveDrafts(drafts).catch((error) => {
    console.error(error);
    toast('Не удалось сохранить черновики. Подтвердите их до закрытия приложения.');
  });
}
// Правки в полях сохраняются с небольшой задержкой, чтобы не писать в базу
// на каждую букву; при сворачивании приложения — сразу.
function persistDraftsSoon() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(persistDrafts, 400);
}
function flushDrafts() {
  if (draftSaveTimer) persistDrafts();
}

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
// Регистрация выполняется в index.html; здесь только проверка результата.
async function initServiceWorker() {
  if (platform.kind === 'apk') {
    env.offlineReady = true; // все файлы внутри APK
    return;
  }
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

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

// Модальное окно с подтверждением. Возвращает значение нажатой кнопки.
function ask(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

// ---------- Экраны ----------
function showPane(pane) {
  for (const p of document.querySelectorAll('#screen-settings .pane')) p.hidden = p.dataset.pane !== pane;
  for (const t of document.querySelectorAll('.subtab')) {
    const on = t.dataset.pane === pane;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  }
}

function showScreen(name) {
  const pane = PANES[name];
  const target = pane ? 'settings' : SCREENS.includes(name) ? name : 'dialog';
  if (pane) showPane(pane);
  for (const section of document.querySelectorAll('.screen')) {
    section.hidden = section.dataset.screen !== target;
  }
  $('dialog-menu-btn').hidden = target !== 'dialog';
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.target === target) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('main').scrollTop = target === 'dialog' ? $('main').scrollHeight : 0;
  if (target === 'settings') {
    renderSettings();
    renderStatus();
  }
  if (target === 'registry') renderRegistry();
}

function currentRoute() {
  return location.hash.replace('#', '') || 'dialog';
}

function goTo(name) {
  if (currentRoute() === name) showScreen(name);
  else location.hash = name;
}

// ---------- Вложения ----------
// Ссылки на миниатюры фото (object URL) освобождаются при перерисовке.
const thumbUrls = new Set();
function releaseThumbs() {
  for (const url of thumbUrls) URL.revokeObjectURL(url);
  thumbUrls.clear();
}

function kindBadge(ref) {
  return el('span', { className: 'kind', 'aria-hidden': 'true' }, ref.kind === 'photo' ? 'ФОТО' : kindLabel(ref.kind).toUpperCase());
}

// Кнопка-вложение: миниатюра (для фото) или вид файла, имя и размер.
// Нажатие открывает файл приложением телефона.
function attachmentButton(ref) {
  const badge = kindBadge(ref);
  const button = el('button', { type: 'button', className: 'file-chip', dataset: { attachment: ref.id } },
    badge,
    el('span', { className: 'file-info' },
      el('span', { className: 'file-name' }, ref.name),
      el('span', { className: 'file-size' }, `${ref.kind === 'photo' ? 'Фото' : kindLabel(ref.kind)}, ${formatSize(ref.size)}`)));
  button.setAttribute('aria-label', `Открыть файл ${ref.name}`);
  button.addEventListener('click', () => openAttachment(ref));
  if (ref.kind === 'photo') {
    store.getAttachment(ref.id).then((item) => {
      if (!item?.blob) return;
      const url = URL.createObjectURL(item.blob);
      thumbUrls.add(url);
      const img = el('img', { className: 'thumb', src: url, alt: '' });
      img.addEventListener('error', () => img.replaceWith(kindBadge(ref)), { once: true });
      badge.replaceWith(img);
    }).catch(() => {});
  }
  return button;
}

function attachmentList(refs) {
  const list = el('ul', { className: 'file-list' });
  list.append(...refs.map((ref) => el('li', {}, attachmentButton(ref))));
  return list;
}

let opening = false;
async function openAttachment(ref) {
  if (opening) return;
  opening = true;
  try {
    const item = await store.getAttachment(ref.id);
    if (!item?.blob) {
      toast('Файл не найден на телефоне.');
      return;
    }
    if (platform.kind === 'apk') {
      if (item.blob.size > 10 * 1024 * 1024) toast('Готовлю файл к открытию…');
      const result = await openBlobViaBridge(platform.bridge, item.blob, item.name, item.type);
      if (result.status !== 'opened') toast(result.message);
      return;
    }
    // Браузер: фото, PDF и видео открываются во вкладке, остальное скачивается.
    const url = URL.createObjectURL(new Blob([item.blob], { type: item.type }));
    const opened = window.open(url, '_blank');
    if (opened) opened.opener = null;
    else downloadUrl(url, item.name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    console.error(e);
    toast('Не удалось открыть файл.');
  } finally {
    opening = false;
  }
}

// Файлы, выбранные для следующего сообщения.
let pendingFiles = [];

function renderPendingFiles() {
  const list = $('pending-files');
  list.hidden = pendingFiles.length === 0;
  list.replaceChildren(...pendingFiles.map((file, i) => {
    const remove = el('button', { type: 'button', className: 'file-remove' }, '×');
    remove.setAttribute('aria-label', `Убрать файл ${file.name}`);
    remove.addEventListener('click', () => {
      pendingFiles = pendingFiles.filter((_, j) => j !== i);
      renderPendingFiles();
    });
    const ref = attachmentRefs([{ id: `p${i}`, name: file.name, type: file.type, size: file.size }])[0];
    return el('li', { className: 'file-chip pending-file' },
      kindBadge(ref),
      el('span', { className: 'file-info' },
        el('span', { className: 'file-name' }, ref.name),
        el('span', { className: 'file-size' }, formatSize(file.size))),
      remove);
  }));
}

function handleFilesChosen(event) {
  const input = event.target;
  const files = [...(input.files || [])];
  input.value = '';
  if (files.length === 0) return;
  const checked = checkFiles(files, pendingFiles.length);
  if (!checked.ok) {
    setComposerError(checked.error);
    return;
  }
  setComposerError('');
  pendingFiles.push(...checked.files);
  renderPendingFiles();
}

// Значок «поделиться» (три точки, соединённые линиями).
function shareIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cx, cy] of [[18, 5], [6, 12], [18, 19]]) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', '2.5');
    svg.append(c);
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M8.2 10.9l7.6-4.4M8.2 13.1l7.6 4.4');
  svg.append(path);
  return svg;
}

// Значок «копировать» собирается из элементов SVG, без вставки HTML-строк.
function copyIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: 8, y: 8, width: 12, height: 12, rx: 2 })) rect.setAttribute(k, String(v));
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3');
  svg.append(rect, path);
  return svg;
}

// Ссылки в тексте становятся нажимаемыми; остальной текст — только текстом.
// В APK ссылка открывается во внешнем браузере (оболочка Android).
const URL_RE = /https?:\/\/[^\s<>"«»]+/g;
function linkify(text) {
  const nodes = [];
  let last = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    let url = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = m.index + url.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// ---------- Голос JARVIS ----------
function speakerIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12');
  svg.append(path);
  return svg;
}

let speakingMessageId = null;
function markSpeaking(id) {
  speakingMessageId = id;
  for (const b of document.querySelectorAll('.speak-btn')) {
    const on = b.dataset.speak === id;
    b.classList.toggle('active', on);
    b.title = on ? 'Остановить' : 'Озвучить';
    b.setAttribute('aria-label', on ? 'Остановить озвучку' : 'Озвучить ответ');
  }
}

// Текст для синтезатора: словарь произношения и, если включено, ударения от
// ИИ агента (по смыслу: за́мок/замо́к). Без связи или при ошибке агента —
// только словарь.
const ACCENT_TIMEOUT = 10000;
async function prepareSpeech(text) {
  const base = applyDictionary(speechText(text), pronunciation);
  if (!voicePrefs.accents || !ai.configured || navigator.onLine === false || base.length > 6000) return base;
  if (accentCache.has(base)) return accentCache.get(base);
  try {
    const accented = await Promise.race([
      ai.accent(base),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ACCENT_TIMEOUT)),
    ]);
    const ok = acceptAccents(base, accented);
    if (ok) {
      accentCache.set(base, ok);
      return ok;
    }
  } catch {
    // озвучка продолжается со словарём
  }
  return base;
}

let speakSeq = 0;
async function speakText(text, id) {
  const status = speech.status();
  if (status === 'loading') {
    toast('Голос JARVIS загружается. Нажмите ещё раз через пару секунд.');
    return false;
  }
  if (status === 'no-russian') {
    toast('На телефоне нет русского голоса. Настройки телефона → Синтез речи → установите русский язык.');
    return false;
  }
  if (status === 'unavailable') {
    toast('Озвучка недоступна на этом телефоне.');
    return false;
  }
  const seq = ++speakSeq;
  speech.stop();
  markSpeaking(id);
  const prepared = await prepareSpeech(text);
  if (seq !== speakSeq) return false; // за это время нажали другую кнопку или «стоп»
  if (!speech.speak(prepared, voicePrefs)) {
    markSpeaking(null);
    toast('Озвучка недоступна на этом телефоне.');
    return false;
  }
  markSpeaking(id);
  return true;
}

function toggleSpeak(message) {
  if (speakingMessageId === message.id) {
    speakSeq++;
    speech.stop();
    markSpeaking(null);
    return;
  }
  speakText(message.text, message.id);
}

async function loadVoicePrefs() {
  try {
    voicePrefs = normalizePrefs(await store.getMeta(META_VOICE));
    pronunciation = normalizeDictionary(await store.getMeta(META_PRONOUNCE));
  } catch {
    voicePrefs = normalizePrefs(null);
    pronunciation = [];
  }
}

// ---------- Словарь произношения ----------
function renderPronunciation() {
  $('pron-empty').hidden = pronunciation.length > 0;
  $('pron-list').replaceChildren(...pronunciation.map((e) => {
    const listen = el('button', { type: 'button', className: 'copy-btn', title: 'Прослушать' }, 'Прослушать');
    listen.addEventListener('click', () => speakText(e.word, `pron-${e.word}`));
    const remove = el('button', { type: 'button', className: 'copy-btn', title: 'Удалить' }, 'Удалить');
    remove.setAttribute('aria-label', `Удалить «${e.word}» из словаря`);
    remove.addEventListener('click', async () => {
      pronunciation = pronunciation.filter((x) => x !== e);
      await savePronunciation();
      renderPronunciation();
    });
    return el('li', { className: 'pron-item', dataset: { word: e.word } },
      el('span', { className: 'pron-text' }, `${e.word} → ${e.reading}`), listen, remove);
  }));
}

async function savePronunciation() {
  try {
    await store.setMeta(META_PRONOUNCE, pronunciation);
    accentCache.clear();
  } catch (e) {
    console.error(e);
    toast('Не удалось сохранить словарь.');
  }
}

async function addPronunciation(event) {
  event.preventDefault();
  const entry = normalizeEntry($('pron-word').value, $('pron-reading').value);
  if (!entry) {
    toast('Заполните оба поля: слово и как его читать.');
    return;
  }
  pronunciation = normalizeDictionary([entry, ...pronunciation.filter((e) => e.word.toLowerCase() !== entry.word.toLowerCase())]);
  await savePronunciation();
  $('pron-word').value = '';
  $('pron-reading').value = '';
  renderPronunciation();
  toast(`В словаре: ${entry.word} → ${entry.reading}`);
}

async function saveVoicePrefs(patch) {
  voicePrefs = normalizePrefs({ ...voicePrefs, ...patch });
  try {
    await store.setMeta(META_VOICE, voicePrefs);
  } catch (e) {
    console.error(e);
    toast('Не удалось сохранить настройку.');
  }
}

function voiceLabel(v, i) {
  return `Голос ${i + 1}${v.local ? '' : ' (нужен интернет)'}`;
}

let voiceRetry = 0;
function renderVoiceSettings() {
  const status = speech.status();
  const ready = status === 'ready';
  $('voice-state').textContent = {
    ready: 'Готов',
    loading: 'Загружается…',
    'no-russian': 'Нет русского голоса на телефоне',
    unavailable: 'Недоступен на этом телефоне',
  }[status] || 'Недоступен';
  $('voice-note').textContent = status === 'no-russian'
    ? 'Установите русский голос: Настройки телефона → Специальные возможности (или Общие настройки) → Синтез речи (Преобразование текста в речь) → Язык: русский.'
    : 'Ответы читает встроенный синтезатор речи телефона — без интернета и бесплатно. Голос JARVIS — низкий тон и спокойный темп; голос и скорость можно поменять.';
  const voices = ready ? speech.voices() : [];
  const select = $('voice-select');
  select.replaceChildren(...(voices.length
    ? voices.map((v, i) => el('option', { value: v.id }, voiceLabel(v, i)))
    : [el('option', { value: '' }, 'Голос телефона')]));
  if (voices.some((v) => v.id === voicePrefs.voice)) select.value = voicePrefs.voice;
  select.disabled = voices.length < 2;
  const rate = $('voice-rate');
  if (!rate.childElementCount) rate.append(...RATES.map((r) => el('option', { value: String(r.value) }, r.label)));
  rate.value = String(RATES.reduce((best, r) => (Math.abs(r.value - voicePrefs.rate) < Math.abs(best.value - voicePrefs.rate) ? r : best)).value);
  $('voice-auto').checked = voicePrefs.auto;
  $('voice-sir').checked = voicePrefs.sir;
  $('voice-accents').checked = voicePrefs.accents;
  renderPronunciation();
  $('voice-test').disabled = !speech.canSpeak || status === 'unavailable' || status === 'no-russian';
  // Синтезатор запускается не сразу: обновить настройки, когда он будет готов.
  if (status === 'loading' && voiceRetry < 40) {
    voiceRetry++;
    setTimeout(() => { if (currentRoute() === 'settings') renderVoiceSettings(); }, 700);
  } else if (status !== 'loading') {
    voiceRetry = 0;
  }
}

function testVoice() {
  const sir = voicePrefs.sir ? ', сэр' : '';
  speakText(`Слушаю${sir}. Я JARVIS, мой разработчик — AYRAT. Готов к работе на площадке.`, 'voice-test');
}

// ---------- Диктовка ----------
let dictating = false;
async function handleDictation() {
  if (dictating) return;
  dictating = true;
  $('mic').classList.add('active');
  speech.stop();
  try {
    const text = (await speech.dictate()).trim();
    if (text) {
      const input = $('input');
      const before = input.value.replace(/\s+$/, '');
      const next = before ? text.charAt(0).toUpperCase() + text.slice(1) : text;
      input.value = before ? `${before}${/[.!?]$/.test(before) ? ' ' : '. '}${next}` : next;
      autosize();
      setComposerError('');
      input.focus();
    }
  } catch (e) {
    toast(e?.message || 'Не удалось распознать речь.');
  } finally {
    dictating = false;
    $('mic').classList.remove('active');
  }
}

// ---------- Диалог ----------
function messageElement(message) {
  const meta = el('div', { className: 'msg-meta' });
  const who = el('span', {});
  if (message.role === 'assistant') {
    meta.append(el('span', { className: 'badge' }, message.source === 'ai' ? AI_LABEL : 'Демо'));
    if (message.source !== 'ai') who.append('Демо-ответ, не ИИ');
  } else {
    who.append('Вы');
  }
  const time = formatTime(message.createdAt);
  if (time) who.append(who.textContent ? `, ${time}` : time);
  meta.append(who);
  if (message.text) {
    const copy = el('button', { type: 'button', className: 'copy-btn', title: 'Копировать текст' });
    copy.append(copyIcon());
    copy.setAttribute('aria-label', 'Копировать текст сообщения');
    copy.addEventListener('click', async () => {
      const ok = await copyText(window, message.text);
      toast(ok ? 'Текст скопирован' : 'Не удалось скопировать. Выделите текст долгим нажатием.');
    });
    meta.append(copy);
  }
  if (message.text || attachmentRefs(message.attachments).length) {
    const share = el('button', { type: 'button', className: 'copy-btn share-btn', title: 'Поделиться' });
    share.setAttribute('aria-label', 'Поделиться сообщением');
    share.append(shareIcon());
    share.addEventListener('click', () => shareContent(messageShare(message)));
    meta.append(share);
  }
  if (message.role === 'assistant' && message.text && speech.canSpeak) {
    const speak = el('button', { type: 'button', className: 'copy-btn speak-btn', title: 'Озвучить', dataset: { speak: message.id } });
    speak.setAttribute('aria-label', 'Озвучить ответ');
    speak.append(speakerIcon());
    speak.addEventListener('click', () => toggleSpeak(message));
    meta.append(speak);
  }
  const item = el('li', { className: `msg msg-${message.role}`, dataset: { source: message.source, id: message.id } }, meta);
  if (message.text) item.append(el('div', { className: 'msg-text' }, ...linkify(message.text)));
  const refs = attachmentRefs(message.attachments);
  if (refs.length) item.append(attachmentList(refs));
  return item;
}

async function renderMessages() {
  const messages = await store.listMessages();
  releaseThumbs();
  $('messages').replaceChildren(...messages.map(messageElement));
  $('messages-empty').hidden = messages.length > 0;
  $('main').scrollTop = $('main').scrollHeight;
}

// ---------- Переписка: новый диалог, архив, удаление ----------
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

async function openDialogMenu() {
  const archives = await store.listArchives();
  $('dialog-menu-list').textContent = archives.length ? `Архив переписок (${archives.length})` : 'Архив переписок';
  const choice = await ask($('dialog-menu'));
  if (choice === 'archive') await archiveCurrentDialog();
  else if (choice === 'list') await openArchiveList();
  else if (choice === 'delete') await deleteCurrentDialog();
}

async function archiveCurrentDialog() {
  try {
    const entry = await store.archiveDialog();
    await renderMessages();
    toast(`Переписка сохранена в архив: ${entry.count} ${plural(entry.count, 'сообщение', 'сообщения', 'сообщений')}. Начат новый диалог.`);
  } catch (e) {
    toast(e instanceof RecordError ? e.message : 'Не удалось сохранить переписку в архив. Повторите.');
  }
}

async function deleteCurrentDialog() {
  const count = (await store.listMessages()).length;
  if (count === 0) {
    toast('Переписка пуста — удалять нечего.');
    return;
  }
  $('confirm-dialog-delete-title').textContent = 'Удалить переписку?';
  $('confirm-dialog-delete-text').textContent = `Будут удалены ${count} ${plural(count, 'сообщение', 'сообщения', 'сообщений')} текущего диалога и их файлы. Восстановить их будет нельзя. Реестр, черновики и файлы, приложенные к записям реестра, останутся. Архив не затрагивается.`;
  if ((await ask($('confirm-dialog-delete'))) !== 'delete') return;
  try {
    await store.deleteDialog();
    await renderMessages();
    toast('Переписка удалена');
  } catch (e) {
    console.error(e);
    toast('Не удалось удалить переписку. Повторите.');
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function renderArchiveList() {
  const archives = await store.listArchives();
  $('archive-empty').hidden = archives.length > 0;
  $('archive-items').replaceChildren(...archives.map((a) => {
    const button = el('button', { type: 'button', className: 'archive-item', dataset: { archive: a.id } },
      el('span', { className: 'archive-item-title' }, a.title),
      el('span', { className: 'archive-item-meta' }, `${formatDate(a.createdAt)} · ${a.count} ${plural(a.count, 'сообщение', 'сообщения', 'сообщений')}`));
    button.addEventListener('click', () => openArchive(a));
    return el('li', {}, button);
  }));
}

async function openArchiveList() {
  await renderArchiveList();
  $('archive-list').showModal();
}

let openArchiveId = null;
async function openArchive(entry) {
  openArchiveId = entry.id;
  const messages = await store.listArchiveMessages(entry.id);
  $('archive-view-title').textContent = entry.title;
  $('archive-view-meta').textContent = `Сохранено в архив ${formatDate(entry.archivedAt)}. Только просмотр: агент эту переписку не видит.`;
  $('archive-messages').replaceChildren(...messages.map(messageElement));
  $('archive-view').showModal();
}

async function deleteOpenArchive() {
  if (!openArchiveId) return;
  $('confirm-dialog-delete-title').textContent = 'Удалить переписку из архива?';
  $('confirm-dialog-delete-text').textContent = 'Сообщения этой переписки и их файлы будут удалены с телефона. Восстановить их будет нельзя. Реестр и файлы, приложенные к записям реестра, останутся.';
  if ((await ask($('confirm-dialog-delete'))) !== 'delete') return;
  try {
    await store.deleteArchive(openArchiveId);
    $('archive-view').close('deleted');
    await renderArchiveList();
    toast('Переписка удалена из архива');
  } catch (e) {
    toast(e instanceof RecordError ? e.message : 'Не удалось удалить переписку. Повторите.');
  }
}

function setComposerError(text) {
  const box = $('composer-error');
  box.textContent = text || '';
  box.hidden = !text;
  $('input').setAttribute('aria-invalid', text ? 'true' : 'false');
}

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight + 2}px`;
}

function setComposerBusy(busy) {
  $('send').disabled = busy;
  $('parse').disabled = busy;
  $('attach').disabled = busy;
}

let sending = false;
async function withComposer(action) {
  if (sending) return;
  const input = $('input');
  // Сообщение может состоять только из файлов, без текста.
  const onlyFiles = pendingFiles.length > 0 && input.value.trim() === '';
  const checked = onlyFiles ? { ok: true, value: '' } : validateMessage(input.value);
  if (!checked.ok) {
    setComposerError(checked.error);
    return;
  }
  setComposerError('');
  sending = true;
  setComposerBusy(true);
  try {
    await action(checked.value);
  } finally {
    sending = false;
    setComposerBusy(false);
  }
}

function clearComposer() {
  $('input').value = '';
  pendingFiles = [];
  renderPendingFiles();
  autosize();
}

// ---------- ИИ агент: переписка ----------
const HISTORY_LIMIT = 20; // сколько последних сообщений видит агент
const MAX_IMAGE_SIDE = 1568; // фото уменьшается до такого размера стороны
const MAX_PDF = 10 * 1024 * 1024;
// Сколько всего передаётся агенту за один запрос: текст документов Word/Excel
// и PDF из последних сообщений (новые — в первую очередь).
const DOC_TEXT_BUDGET = 400000; // символов
const PDF_BUDGET = 14 * 1024 * 1024; // байт

// Текст документов кешируется на время работы приложения (файлы не меняются).
const docTextCache = new Map();
async function cachedDocumentText(ref) {
  if (docTextCache.has(ref.id)) return docTextCache.get(ref.id);
  const item = await store.getAttachment(ref.id);
  const result = item?.blob ? await documentText(item.blob, ref.name) : { error: 'Файл не найден на телефоне.' };
  docTextCache.set(ref.id, result);
  return result;
}

// Фото уменьшается перед отправкой агенту (меньше трафика и расходов).
// Если браузер не может открыть формат (например, HEIC) — передаётся только название.
async function imageForAgent(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return jpeg ? { type: 'image/jpeg', data: await blobToBase64(jpeg) } : null;
  } catch {
    return null;
  }
}

// Что агент получает из файлов:
// • фото — только из последнего сообщения пользователя (уменьшенное);
// • PDF — из последних сообщений, пока не исчерпан общий объём PDF_BUDGET;
// • Word, Excel, CSV, TXT — текстом из последних сообщений, пока не исчерпан
//   DOC_TEXT_BUDGET (чтобы агент мог объединить несколько отчётов, присланных
//   разными сообщениями);
// • видео и остальное — только название.
async function agentFiles(refs, isLastUser, budget) {
  const out = [];
  for (const ref of refs) {
    const file = { name: ref.name, type: ref.type };
    if (ref.kind === 'photo' && isLastUser) {
      const item = await store.getAttachment(ref.id);
      if (item?.blob) Object.assign(file, (await imageForAgent(item.blob)) || {});
    } else if (ref.type === 'application/pdf' && ref.size <= MAX_PDF && ref.size <= budget.pdf) {
      const item = await store.getAttachment(ref.id);
      if (item?.blob) {
        file.data = await blobToBase64(item.blob);
        budget.pdf -= ref.size;
      }
    } else if (canRead(ref.name) || /\.(doc|xls|rtf)$/i.test(ref.name)) {
      const r = await cachedDocumentText(ref);
      if (r.text && r.text.length <= budget.text) {
        file.text = r.text;
        budget.text -= r.text.length;
      } else if (r.text) {
        file.note = 'Файл не передан: превышен объём документов в одном запросе. Попросите прислать его отдельно в новом сообщении.';
      } else {
        file.note = r.error;
      }
    }
    out.push(file);
  }
  return out;
}

async function agentHistory() {
  const messages = (await store.listMessages()).slice(-HISTORY_LIMIT);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const budget = { text: DOC_TEXT_BUDGET, pdf: PDF_BUDGET };
  // Файлы читаются от новых сообщений к старым: новым — приоритет в объёме.
  const filesByMessage = new Map();
  for (const m of [...messages].reverse()) {
    filesByMessage.set(m.id, await agentFiles(m.role === 'user' ? attachmentRefs(m.attachments) : [], m === lastUser, budget));
  }
  return messages.map((m) => ({
    role: m.role,
    text: m.text,
    files: m.role === 'user' ? filesByMessage.get(m.id) : attachmentRefs(m.attachments).map((r) => ({ name: r.name, type: r.type })),
  }));
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const IMAGE_REPLY_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Файлы, созданные агентом: таблица → Excel, документ → Word, изображение,
// текст → .txt.
async function agentReplyFiles(files) {
  const out = [];
  for (const f of files.slice(0, 5)) {
    if (f?.kind === 'word' && Array.isArray(f.blocks)) {
      const blob = await buildDocx(f);
      out.push(new File([blob], String(f.name || 'документ.docx'), { type: DOCX_MIME }));
    } else if (f?.kind === 'image' && typeof f.data === 'string' && IMAGE_REPLY_TYPES.has(f.type)) {
      try {
        out.push(new File([base64ToBytes(f.data)], String(f.name || 'изображение.png'), { type: f.type }));
      } catch {
        // повреждённые данные изображения пропускаются
      }
    } else if (f?.kind === 'workbook' && Array.isArray(f.sheets)) {
      const blob = await buildWorkbook(f);
      out.push(new File([blob], String(f.name || 'сводный отчёт.xlsx'), { type: XLSX_MIME }));
    } else if (f?.kind === 'table' && Array.isArray(f.headers)) {
      const blob = await tableToXlsx(f.headers, Array.isArray(f.rows) ? f.rows : [], { title: f.name });
      out.push(new File([blob], String(f.name || 'таблица.xlsx'), { type: XLSX_MIME }));
    } else if (f?.kind === 'text' && typeof f.content === 'string' && f.content) {
      out.push(new File([f.content], String(f.name || 'документ.txt'), { type: 'text/plain' }));
    }
  }
  return out;
}

function setTyping(on) {
  const existing = $('agent-typing');
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) return;
  $('messages').append(el('li', { id: 'agent-typing', className: 'msg msg-assistant typing' },
    el('div', { className: 'msg-meta' }, el('span', { className: 'badge' }, AI_LABEL)),
    el('div', { className: 'msg-text' }, 'ИИ агент печатает…')));
  $('main').scrollTop = $('main').scrollHeight;
}

// Замечания, которые агент подготовил для реестра, → черновики на проверку.
// Исходный текст черновика — слова пользователя из его сообщения (не меняется).
async function agentDrafts(items, userMessage) {
  if (!items.length || !userMessage) return 0;
  const said = String(userMessage.text || '');
  const created = items.slice(0, 20).map((item) => {
    const own = typeof item.sourceText === 'string' ? item.sourceText.trim() : '';
    const sourceText = own && said.toLowerCase().includes(own.toLowerCase()) ? own : said || own || 'Замечание из диалога';
    return createDraft({
      fields: item, sourceText, sourceMessageId: userMessage.id, attachments: userMessage.attachments, filledBy: 'ai',
    });
  });
  drafts.push(...created);
  await persistDrafts();
  renderDrafts();
  return created.length;
}

async function askAgent() {
  setTyping(true);
  let message;
  let added = 0;
  try {
    const reply = await ai.chat(await agentHistory(), { sir: voicePrefs.sir });
    const files = await agentReplyFiles(reply.files);
    const lastUser = (await store.listMessages()).filter((m) => m.role === 'user').pop();
    added = await agentDrafts(reply.drafts, lastUser);
    message = await store.addMessage({ role: 'assistant', source: 'ai', text: reply.text || (files.length ? 'Файл во вложении.' : '…'), files });
  } finally {
    setTyping(false);
  }
  if (added) toast(`На проверке в «Реестре»: ${added}. Проверьте поля и нажмите «Добавить в реестр».`);
  if (voicePrefs.auto && message?.text && speech.canSpeak) speakText(message.text, message.id);
}

async function handleSubmit(event) {
  event.preventDefault();
  speakSeq++;
  speech.stop();
  await withComposer(async (text) => {
    try {
      await store.addMessage({ role: 'user', source: 'user', text, files: pendingFiles });
      const withFiles = pendingFiles.length;
      clearComposer();
      if (ai.configured) {
        await renderMessages();
        try {
          await askAgent();
          pulseCore();
        } catch (e) {
          if (!(e instanceof AiError)) console.error(e);
          setComposerError(`${e instanceof AiError ? e.message : 'ИИ агент не ответил.'} Ваше сообщение сохранено — отправьте вопрос ещё раз позже.`);
        }
        await renderMessages();
        return;
      }
      const reply = text
        ? demoReply(text, statusSummary(computeFeatures(env)))
        : { source: 'demo', text: `Файлов сохранено: ${withFiles}. ИИ не подключён, поэтому содержимое файлов не анализируется. Чтобы приложить файлы к замечанию, напишите заметку и нажмите «В реестр».` };
      await store.addMessage({ role: 'assistant', source: reply.source, text: reply.text });
      pulseCore();
      await renderMessages();
    } catch (error) {
      console.error(error);
      setComposerError('Не удалось сохранить сообщение. Попробуйте ещё раз. Если ошибка повторяется, перезапустите приложение.');
    }
  });
}

// «В реестр»: заметка сохраняется в диалоге, по ней создаются черновики.
async function handleParse() {
  await withComposer(async (text) => {
    if (!text) {
      setComposerError('Напишите текст заметки: по нему заполняется запись реестра. Файлы будут приложены к записи.');
      return;
    }
    const parsed = parseMessage(text);
    if (!parsed.ok) {
      setComposerError(parsed.error);
      return;
    }
    try {
      const message = await store.addMessage({ role: 'user', source: 'user', text, files: pendingFiles });
      clearComposer();
      // Поля заполняет ИИ агент; если он не подключён или недоступен — правила.
      let filledBy = 'rules';
      let fieldsList = parsed.notes.map((n) => n.fields);
      if (ai.configured) {
        await renderMessages();
        setTyping(true);
        try {
          fieldsList = await ai.parse(parsed.notes.map((n) => n.note));
          filledBy = 'ai';
        } catch (e) {
          if (!(e instanceof AiError)) console.error(e);
          toast(`${e instanceof AiError ? e.message : 'ИИ агент недоступен.'} Поля заполнены по правилам.`);
        } finally {
          setTyping(false);
        }
      }
      // Файлы заметки прикладываются к каждому черновику из этого сообщения.
      const created = parsed.notes.map((n, i) => createDraft({
        fields: fieldsList[i], sourceText: n.note, sourceMessageId: message.id, attachments: message.attachments, filledBy,
      }));
      drafts.push(...created);
      await persistDrafts();
      const reply = { ...draftsReply(created.length, filledBy), source: filledBy === 'ai' ? 'ai' : 'demo' };
      await store.addMessage({ role: 'assistant', source: reply.source, text: reply.text });
      pulseCore();
      await renderMessages();
      goTo('registry');
    } catch (error) {
      console.error(error);
      setComposerError('Не удалось сохранить заметку. Попробуйте ещё раз. Если ошибка повторяется, перезапустите приложение.');
    }
  });
}

function pulseCore() {
  const core = document.querySelector('.core');
  core.classList.remove('busy');
  void core.getBoundingClientRect();
  core.classList.add('busy');
}

// ---------- Поля записи (черновик и редактирование) ----------
function fieldInputs(values, idPrefix) {
  const wrap = el('div', { className: 'fields' });
  for (const key of EDITABLE_FIELDS) {
    const f = FIELD[key];
    const id = `${idPrefix}-${key}`;
    // «Не указано» показывается подсказкой в пустом поле: чтобы заполнить поле,
    // не нужно стирать текст. Пустое поле сохраняется как «Не указано».
    const value = values[key] === NOT_SPECIFIED ? '' : values[key] ?? '';
    const control = f.multiline
      ? el('textarea', { id, name: key, rows: 3, value, placeholder: NOT_SPECIFIED })
      : el('input', { id, name: key, type: 'text', value, placeholder: NOT_SPECIFIED, autocomplete: 'off' });
    control.dataset.field = key;
    const error = el('p', { className: 'field-error', id: `${id}-error`, hidden: true });
    control.setAttribute('aria-describedby', error.id);
    wrap.append(el('div', { className: 'field', dataset: { field: key } }, el('label', { htmlFor: id }, f.title), control, error));
  }
  return wrap;
}

function sourceBlock(text) {
  return el('div', { className: 'source' },
    el('p', { className: 'source-title' }, 'Исходный текст заметки — не изменяется'),
    el('p', { className: 'source-text' }, text));
}

function readFields(container) {
  const values = {};
  for (const control of container.querySelectorAll('[data-field]:is(input, textarea)')) {
    values[control.dataset.field] = control.value;
  }
  return values;
}

function showFieldErrors(container, errors = {}) {
  for (const box of container.querySelectorAll('.field-error')) {
    const key = box.parentElement.dataset.field;
    box.textContent = errors[key] || '';
    box.hidden = !errors[key];
    box.parentElement.querySelector('[data-field]').setAttribute('aria-invalid', errors[key] ? 'true' : 'false');
  }
}

// ---------- Черновики ----------
function renderDrafts() {
  const section = $('drafts');
  section.hidden = drafts.length === 0;
  $('drafts-title').textContent = `На проверке: ${drafts.length}`;
  $('draft-list').replaceChildren(...drafts.map((draft, i) => {
    const fields = fieldInputs(draft, draft.draftId);
    const error = el('p', { className: 'form-error', role: 'alert', hidden: true });
    const reject = el('button', { type: 'button', className: 'secondary' }, 'Отклонить');
    const accept = el('button', { type: 'button', className: 'send' }, 'Добавить в реестр');
    const refs = attachmentRefs(draft.attachments);
    const card = el('li', { className: 'draft', dataset: { draft: draft.draftId } },
      el('h4', {}, `Черновик ${i + 1} из ${drafts.length} · ${draft.filledBy === 'ai' ? `поля заполнил ${AI_LABEL}` : 'по правилам, не ИИ'}`),
      sourceBlock(draft.sourceText),
      ...(refs.length ? [el('p', { className: 'attachments-title' }, `Файлы (${refs.length})`), attachmentList(refs)] : []),
      fields,
      error,
      el('div', { className: 'draft-actions' }, reject, accept));

    // Правки в полях сохраняются в черновике, пока он на экране.
    fields.addEventListener('input', () => {
      Object.assign(draft, readFields(fields));
      persistDraftsSoon();
    });

    reject.addEventListener('click', async () => {
      drafts = drafts.filter((d) => d !== draft);
      renderDrafts();
      await persistDrafts(); // сообщение — только после записи в базу
      toast('Черновик отклонён');
    });

    accept.addEventListener('click', async () => {
      accept.disabled = true;
      Object.assign(draft, readFields(fields));
      try {
        const record = await store.confirmRecord(draft);
        drafts = drafts.filter((d) => d !== draft);
        renderDrafts();
        await renderRecords();
        toast(`Запись № ${record.number} добавлена в реестр`);
      } catch (e) {
        accept.disabled = false;
        if (e instanceof RecordError) {
          showFieldErrors(fields, e.fieldErrors);
          error.textContent = e.message;
        } else {
          console.error(e);
          error.textContent = 'Не удалось сохранить запись. Черновик остался на экране — попробуйте ещё раз.';
        }
        error.hidden = false;
      }
    });
    return card;
  }));
}

// ---------- Реестр ----------
async function renderRecords() {
  const head = $('registry-head');
  if (!head.childElementCount) {
    head.append(...REGISTRY_FIELDS.map((f) => el('th', { scope: 'col' }, f.title)));
  }
  const records = await store.listRecords();
  $('records-count').textContent = `Записей: ${records.length}`;
  $('export').disabled = records.length === 0;
  $('export-xlsx').disabled = records.length === 0;
  $('registry-hint').textContent = records.length
    ? 'Нажмите на строку, чтобы изменить или удалить запись.'
    : 'Чтобы добавить запись, напишите заметку в «Диалоге» и нажмите «В реестр». Экспорт станет доступен после первой записи.';
  const body = $('registry-body');
  if (records.length === 0) {
    body.replaceChildren(el('tr', {}, el('td', { colSpan: REGISTRY_FIELDS.length, className: 'empty-row' }, 'Записей пока нет.')));
    return;
  }
  body.replaceChildren(...records.map((r) => {
    const tr = el('tr', { className: 'record-row', tabIndex: 0, dataset: { id: r.id, number: String(r.number) } },
      ...REGISTRY_FIELDS.map((f) => el('td', { dataset: { field: f.key } }, String(r[f.key] ?? ''))));
    tr.setAttribute('aria-label', `Запись № ${r.number}. Открыть для изменения`);
    tr.addEventListener('click', () => openRecord(r.id));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openRecord(r.id);
      }
    });
    return tr;
  }));
}

async function renderRegistry() {
  renderDrafts();
  await renderRecords();
}

let openRecordId = null;
async function openRecord(id) {
  const record = (await store.listRecords()).find((r) => r.id === id);
  if (!record) {
    toast('Запись не найдена. Возможно, она уже удалена.');
    await renderRecords();
    return;
  }
  openRecordId = id;
  $('record-title').textContent = `Запись № ${record.number}`;
  const refs = attachmentRefs(record.attachments);
  $('record-fields').replaceChildren(
    sourceBlock(record.sourceText),
    ...(refs.length ? [el('p', { className: 'attachments-title' }, `Файлы (${refs.length})`), attachmentList(refs)] : []),
    fieldInputs(record, 'edit'));
  $('record-error').hidden = true;
  $('record-dialog').showModal();
}

async function saveRecord() {
  const container = $('record-fields');
  try {
    const updated = await store.updateRecord(openRecordId, readFields(container));
    $('record-dialog').close('saved');
    await renderRecords();
    toast(`Запись № ${updated.number} сохранена`);
  } catch (e) {
    const box = $('record-error');
    if (e instanceof RecordError) {
      showFieldErrors(container, e.fieldErrors);
      box.textContent = e.message;
    } else {
      console.error(e);
      box.textContent = 'Не удалось сохранить изменения. Попробуйте ещё раз.';
    }
    box.hidden = false;
  }
}

async function shareOpenRecord() {
  const record = (await store.listRecords()).find((r) => r.id === openRecordId);
  if (!record) return;
  await shareContent(recordShare(record), `Запись № ${record.number}`);
}

async function deleteOpenRecord() {
  const number = $('record-title').textContent.replace('Запись ', '');
  $('confirm-record-title').textContent = `Удалить запись ${number}?`;
  if ((await ask($('confirm-record-delete'))) !== 'delete') return;
  try {
    await store.deleteRecord(openRecordId);
    $('record-dialog').close('deleted');
    await renderRecords();
    toast(`Запись ${number} удалена`);
  } catch (e) {
    console.error(e);
    const box = $('record-error');
    box.textContent = e instanceof RecordError ? e.message : 'Не удалось удалить запись. Попробуйте ещё раз.';
    box.hidden = false;
  }
}

// ---------- Экспорт ----------
function downloadUrl(url, filename) {
  const link = el('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadText(text, filename, type) {
  downloadBlob(new Blob([text], { type }), filename);
}

function notice(title, text) {
  $('notice-title').textContent = title;
  $('notice-text').textContent = text;
  return ask($('notice'));
}

async function handleExport() {
  let records;
  try {
    records = await store.listRecords();
  } catch (e) {
    console.error(e);
    toast('Не удалось прочитать реестр. Перезапустите приложение и повторите.');
    return;
  }
  if (records.length === 0) {
    toast('Реестр пуст: экспортировать нечего.');
    return;
  }
  const filename = exportFileName();
  $('export-summary').textContent = `Будет выгружено записей: ${records.length}, столбцов: ${REGISTRY_FIELDS.length}. Файл: ${filename}.`;
  if ((await ask($('confirm-export'))) !== 'export') return;
  const csv = recordsToCsv(records);
  if (platform.kind === 'apk') {
    // Android показывает окно «Сохранить»: пользователь выбирает папку.
    const result = await saveViaBridge(platform.bridge, filename, 'text/csv', csv);
    if (result.status === 'saved') toast(`Файл ${filename} сохранён`);
    else if (result.status === 'cancelled') toast('Сохранение отменено');
    else toast(result.message || 'Не удалось сохранить файл.');
    return;
  }
  try {
    downloadText(csv, filename, 'text/csv;charset=utf-8');
    toast(`Файл ${filename} сохранён в «Загрузки»`);
  } catch (e) {
    console.error(e);
    toast('Не удалось сохранить файл. Проверьте, разрешены ли загрузки в Chrome, и повторите.');
  }
}

// ---------- Поделиться ----------
// content: { subject, text, attachments: [ссылки на файлы], files?: [{ blob, name, type }] }
let sharing = false;
async function shareContent(content, what = '') {
  if (sharing) return;
  $('share-what').textContent = what || (content.attachments?.length ? `Текст и файлов: ${content.attachments.length}` : 'Текст');
  const target = await ask($('share-menu'));
  if (!target || target === 'cancel') return;
  sharing = true;
  try {
    const files = [...(content.files || [])];
    for (const ref of content.attachments || []) {
      const item = await store.getAttachment(ref.id);
      if (item?.blob) files.push({ blob: item.blob, name: item.name, type: item.type });
    }
    const total = files.reduce((n, f) => n + f.blob.size, 0);
    if (total > 10 * 1024 * 1024) toast('Готовлю файлы…');

    if (platform.kind === 'apk' && supportsShare(platform.bridge)) {
      const result = await shareViaBridge(platform.bridge, { target, subject: content.subject, text: content.text, files });
      if (result.status !== 'shared') {
        sharing = false; // после закрытия сообщения можно сразу выбрать другое приложение
        await notice('Не отправлено', result.message);
      }
      return;
    }
    // Браузер: письмо — через почтовую программу (только текст), остальное —
    // системное окно «Поделиться», где выбирается мессенджер.
    if (target === 'email' && files.length === 0) {
      location.href = `mailto:?subject=${encodeURIComponent(content.subject || '')}&body=${encodeURIComponent(content.text || '')}`;
      return;
    }
    const asFiles = files.map((f) => new File([f.blob], f.name, { type: f.type }));
    const data = { title: content.subject, text: content.text };
    if (asFiles.length && navigator.canShare?.({ files: asFiles })) data.files = asFiles;
    if (navigator.share) {
      try {
        await navigator.share(data);
      } catch (e) {
        if (e?.name !== 'AbortError') throw e;
      }
      return;
    }
    const ok = await copyText(window, content.text || '');
    sharing = false;
    await notice('Поделиться', `В этом браузере нельзя открыть ${targetLabel(target)} напрямую.${ok ? ' Текст скопирован — вставьте его в чат.' : ''}`);
  } catch (e) {
    console.error(e);
    toast('Не удалось поделиться.');
  } finally {
    sharing = false;
  }
}

let exportingXlsx = false;
async function handleExportXlsx() {
  if (exportingXlsx) return;
  let records;
  try {
    records = await store.listRecords();
  } catch (e) {
    console.error(e);
    toast('Не удалось прочитать реестр. Перезапустите приложение и повторите.');
    return;
  }
  if (records.length === 0) {
    toast('Реестр пуст: экспортировать нечего.');
    return;
  }
  const filename = xlsxFileName();
  const columns = registryTable([]).headers.length;
  $('export-xlsx-summary').textContent = `Будет выгружено записей: ${records.length}, столбцов: ${columns}. Файл: ${filename}.`;
  const choice = await ask($('confirm-export-xlsx'));
  if (choice !== 'export' && choice !== 'share') return;
  exportingXlsx = true;
  try {
    const blob = await recordsToXlsx(records);
    if (choice === 'share') {
      exportingXlsx = false;
      await shareContent({ ...registryShare(records.length), files: [{ blob, name: filename, type: XLSX_MIME }] }, `Файл ${filename}`);
      return;
    }
    if (platform.kind === 'apk') {
      const result = await saveBlobViaBridge(platform.bridge, blob, filename, XLSX_MIME);
      if (result.status === 'saved') toast(`Файл ${filename} сохранён`);
      else if (result.status === 'cancelled') toast('Сохранение отменено');
      else toast(result.message || 'Не удалось сохранить файл.');
      return;
    }
    downloadBlob(blob, filename);
    toast(`Файл ${filename} сохранён в «Загрузки»`);
  } catch (e) {
    console.error(e);
    toast('Не удалось создать файл Excel. Повторите. Как запасной вариант есть «Экспорт CSV».');
  } finally {
    exportingXlsx = false;
  }
}

// ---------- Настройки ----------
function renderAiSettings() {
  $('ai-state').textContent = env.aiConfigured ? 'Подключён' : 'Не подключён';
  $('ai-state').dataset.state = env.aiConfigured ? 'on' : 'off';
  $('ai-note').textContent = env.aiConfigured
    ? 'Сообщения, файлы и заметки, которые вы отправляете агенту, обрабатываются внешним ИИ-сервисом. Не отправляйте сведения, которые нельзя передавать за пределы телефона.'
    : 'Подключение — через ваш посредник. Введите его адрес и код доступа из инструкции. Ключей ИИ в приложении нет.';
  $('ai-connect').textContent = env.aiConfigured ? 'Проверить и сохранить' : 'Подключить';
  $('ai-disconnect').hidden = !env.aiConfigured;
}

function setAiError(text) {
  $('ai-error').textContent = text || '';
  $('ai-error').hidden = !text;
}

async function handleAiConnect(event) {
  event.preventDefault();
  setAiError('');
  const url = normalizeAgentUrl($('ai-url').value);
  const code = $('ai-code').value.trim();
  if (!url) {
    setAiError('Неверный адрес. Нужен адрес вида jarvis-agent.<имя>.workers.dev из инструкции.');
    return;
  }
  if (!validAccessCode(code)) {
    setAiError('Код доступа — не короче 16 символов, как в инструкции.');
    return;
  }
  const button = $('ai-connect');
  button.disabled = true;
  try {
    await createAiClient({ url, code }).check();
    await store.setMeta(META_AI_URL, url);
    await store.setMeta(META_AI_CODE, code);
    await loadAi();
    $('ai-url').value = url;
    $('ai-code').value = '';
    renderAiSettings();
    renderStatus();
    toast(`${AI_LABEL} подключён`);
  } catch (e) {
    if (!(e instanceof AiError)) console.error(e);
    setAiError(e instanceof AiError ? e.message : 'Не удалось подключиться.');
  } finally {
    button.disabled = false;
  }
}

async function handleAiDisconnect() {
  await store.setMeta(META_AI_URL, null);
  await store.setMeta(META_AI_CODE, null);
  await loadAi();
  $('ai-code').value = '';
  renderAiSettings();
  renderStatus();
  toast(`${AI_LABEL} отключён`);
}

async function renderSettings() {
  renderAiSettings();
  renderVoiceSettings();
  const savedUrl = await store.getMeta(META_AI_URL);
  if (savedUrl && !$('ai-url').value) $('ai-url').value = savedUrl;
  const counts = await store.counts();
  $('count-messages').textContent = String(counts.messages);
  $('count-records').textContent = String(counts.records);
  $('count-attachments').textContent = counts.attachments ? `${counts.attachments} (${formatSize(counts.attachmentsSize)})` : '0';
  const apk = platform.kind === 'apk';
  $('storage-kind').textContent = env.storage !== 'indexeddb'
    ? 'Только в памяти (не сохраняется)'
    : apk ? 'В памяти приложения' : 'В браузере телефона';
  $('storage-note').textContent = apk
    ? 'Данные никуда не отправляются. Они хранятся во внутренней памяти приложения на этом телефоне.'
    : 'Данные никуда не отправляются. Они хранятся только в браузере этого телефона.';
  const last = await store.getMeta(META_LAST_BACKUP);
  $('last-backup').textContent = last ? formatTime(last) : 'Не создавалась';
  $('app-version').textContent = APP_VERSION;
  $('app-platform').textContent = platform.kind === 'apk' ? 'Приложение Android (APK)' : 'Веб-приложение';
  $('app-stage').textContent = `Этап ${APP_STAGE} из 5`;
}

async function handleDeleteHistory() {
  if ((await ask($('confirm-delete'))) !== 'delete') return;
  try {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    await store.clearHistory();
    drafts = [];
    await Promise.all([renderMessages(), renderSettings(), renderRegistry()]);
    toast('История удалена');
  } catch (error) {
    console.error(error);
    toast('Не удалось удалить историю. Перезапустите приложение и повторите.');
  }
}

// ---------- Резервная копия ----------
let backupBusy = false;
async function handleBackupSave() {
  if (backupBusy) return;
  backupBusy = true;
  $('backup-save').disabled = true;
  toast('Готовлю резервную копию…');
  try {
    flushDrafts();
    const { blob, summary } = await createBackup(store);
    const filename = backupFileName();
    let saved;
    if (platform.kind === 'apk') {
      const result = await saveBlobViaBridge(platform.bridge, blob, filename, 'application/zip');
      saved = result.status === 'saved';
      if (result.status === 'cancelled') toast('Сохранение отменено');
      else if (!saved) await notice('Копия не сохранена', result.message || 'Не удалось сохранить файл.');
    } else {
      downloadBlob(blob, filename);
      saved = true;
    }
    if (saved) {
      await store.setMeta(META_LAST_BACKUP, new Date().toISOString());
      toast(`Копия сохранена: записей ${summary.records}, файлов ${summary.attachments}`);
      await renderSettings();
    }
  } catch (e) {
    if (!(e instanceof BackupError)) console.error(e);
    await notice('Копия не создана', e instanceof BackupError ? e.message : 'Не удалось создать резервную копию. Перезапустите приложение и повторите.');
  } finally {
    backupBusy = false;
    $('backup-save').disabled = false;
  }
}

async function handleRestoreChosen(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file || backupBusy) return;
  backupBusy = true;
  try {
    const inspected = await inspectBackup(file);
    const s = inspected.summary;
    $('restore-summary').textContent =
      `Копия от ${formatTime(s.createdAt) || 'неизвестной даты'} (версия ${s.appVersion || '—'}): сообщений ${s.messages}, ` +
      `записей реестра ${s.records}, черновиков ${s.drafts}, файлов ${s.attachments}${s.attachments ? ` (${s.attachmentsSizeText})` : ''}.`;
    if ((await ask($('confirm-restore'))) !== 'restore') return;
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    await restoreBackup(store, inspected);
    drafts = await store.loadDrafts();
    await Promise.all([renderMessages(), renderSettings(), renderRegistry()]);
    toast(`Данные восстановлены: записей ${s.records}, файлов ${s.attachments}`);
  } catch (e) {
    if (!(e instanceof BackupError)) console.error('restore failed:', e?.name, e?.message, e);
    backupBusy = false; // можно сразу выбрать другой файл
    await notice('Восстановление не выполнено',
      e instanceof BackupError
        ? `${e.message} Данные на телефоне не изменены.`
        : 'Не удалось прочитать или записать данные. Данные на телефоне не изменены.');
  } finally {
    backupBusy = false;
  }
}

// ---------- Статус ----------
function renderStatus() {
  env.online = navigator.onLine;
  env.standalone = window.matchMedia('(display-mode: standalone)').matches;
  const items = computeFeatures(env).map((f) => el('li', { className: 'feature', dataset: { feature: f.id } },
    el('span', { className: 'feature-name' }, f.name),
    el('span', { className: `state state-${f.state}` },
      f.label || (f.stage && f.state === 'planned' ? `Этап ${f.stage}` : STATE_LABELS[f.state])),
    el('span', { className: 'feature-note' }, f.note)));
  $('features').replaceChildren(...items);
}

// ---------- Код входа ----------
// Режимы окна: setup → setup2 (придумать и повторить), unlock (вход),
// old → setup → setup2 (смена кода в Настройках).
let lock;
const lockState = { mode: null, digits: '', first: '', busy: false, resolve: null, timer: null };
const LOCK_TITLES = {
  setup: 'Придумайте код из 4 цифр',
  setup2: 'Повторите код',
  unlock: 'Введите код',
  old: 'Введите текущий код',
};

function renderLock() {
  $('lock-title').textContent = LOCK_TITLES[lockState.mode] || '';
  const dots = $('lock-dots').children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < lockState.digits.length);
  $('lock-forgot').hidden = lockState.mode !== 'unlock';
  const changing = lockState.change === true;
  $('lock-cancel').hidden = !changing;
  $('lock-gap').hidden = changing;
}

function lockMessage(text, error = false) {
  $('lock-message').textContent = text || '';
  $('lock-message').classList.toggle('error', !!error);
}

function setLockKeys(enabled) {
  for (const b of document.querySelectorAll('#lock-keys button')) b.disabled = !enabled;
}

// Пауза после неверных попыток: кнопки недоступны, идёт обратный отсчёт.
function lockPause(seconds) {
  clearInterval(lockState.timer);
  let left = seconds;
  setLockKeys(false);
  const tick = () => {
    if (left <= 0) {
      clearInterval(lockState.timer);
      setLockKeys(true);
      lockMessage('');
      return;
    }
    lockMessage(`Много неверных попыток. Повторите через ${left} с.`, true);
    left--;
  };
  tick();
  lockState.timer = setInterval(tick, 1000);
}

function showLock(mode, { change = false } = {}) {
  lockState.mode = mode;
  lockState.change = change;
  lockState.digits = '';
  lockState.first = '';
  lockMessage(mode === 'setup' && !change ? 'Код будет спрашиваться при каждом запуске JARVIS.' : '');
  renderLock();
  $('lock').hidden = false;
  document.querySelector('.app').inert = true;
  document.documentElement.dataset.locked = 'true';
  return new Promise((resolve) => { lockState.resolve = resolve; });
}

function hideLock(result) {
  clearInterval(lockState.timer);
  setLockKeys(true);
  $('lock').hidden = true;
  document.querySelector('.app').inert = false;
  delete document.documentElement.dataset.locked;
  lockState.mode = null;
  const resolve = lockState.resolve;
  lockState.resolve = null;
  resolve?.(result);
}

async function lockDigit(key) {
  if (lockState.busy || !lockState.mode) return;
  if (key === 'back') {
    lockState.digits = lockState.digits.slice(0, -1);
    renderLock();
    return;
  }
  if (lockState.digits.length >= PIN_LENGTH) return;
  lockState.digits += key;
  renderLock();
  if (lockState.digits.length < PIN_LENGTH) return;
  const pin = lockState.digits;
  lockState.busy = true;
  try {
    await lockSubmit(pin);
  } finally {
    lockState.busy = false;
  }
}

async function lockSubmit(pin) {
  const mode = lockState.mode;
  if (mode === 'setup') {
    if (/^(\d)\1{3}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
      lockState.digits = '';
      renderLock();
      lockMessage('Слишком простой код (1111, 1234). Придумайте другой.', true);
      return;
    }
    lockState.first = pin;
    lockState.mode = 'setup2';
    lockState.digits = '';
    lockMessage('');
    renderLock();
    return;
  }
  if (mode === 'setup2') {
    if (pin !== lockState.first) {
      lockState.mode = 'setup';
      lockState.digits = '';
      lockState.first = '';
      renderLock();
      lockMessage('Коды не совпали. Придумайте код ещё раз.', true);
      return;
    }
    await lock.set(pin);
    hideLock('set');
    toast(lockState.change ? 'Код входа изменён' : 'Код входа сохранён');
    return;
  }
  // unlock и old: проверка кода.
  const r = await lock.verify(pin);
  lockState.digits = '';
  if (r.ok) {
    if (mode === 'old') {
      lockState.mode = 'setup';
      lockMessage('');
      renderLock();
      return;
    }
    hideLock('ok');
    return;
  }
  renderLock();
  $('lock-dots').classList.remove('shake');
  void $('lock-dots').offsetWidth;
  $('lock-dots').classList.add('shake');
  if (r.wait) lockPause(r.wait);
  else lockMessage(`Неверный код. Осталось попыток до паузы: ${r.left}.`, true);
}

async function requireUnlock() {
  if (!(await lock.isSet())) {
    await showLock('setup');
    return;
  }
  const pending = showLock('unlock');
  const pause = await lock.pause();
  if (pause) lockPause(pause);
  await pending;
}

// При запуске окно кода показывается сразу, до чтения переписки.
async function requireUnlockStart() {
  if (!(await lock.isSet())) {
    showLock('setup');
    return;
  }
  showLock('unlock');
  const pause = await lock.pause();
  if (pause) lockPause(pause);
}

async function changePin() {
  await showLock('old', { change: true });
}

async function forgotPin() {
  if ((await ask($('confirm-pin-reset'))) !== 'reset') return;
  try {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    await store.clearHistory();
    drafts = [];
    for (const key of [META_AI_URL, META_AI_CODE, META_VOICE, META_PRONOUNCE]) await store.setMeta(key, null);
    await lock.reset();
    await loadAi();
    await loadVoicePrefs();
    await renderMessages();
    renderDrafts();
    clearInterval(lockState.timer);
    setLockKeys(true);
    lockState.mode = 'setup';
    lockState.change = false;
    lockState.digits = '';
    renderLock();
    lockMessage('Данные удалены. Придумайте новый код.');
  } catch (e) {
    console.error(e);
    lockMessage('Не удалось сбросить. Перезапустите приложение и повторите.', true);
  }
}

// После 5 минут в фоне — снова код.
let hiddenAt = 0;
function watchBackground() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_MS && !lockState.mode) {
      speech.stop();
      for (const d of document.querySelectorAll('dialog[open]')) d.close('cancel');
      requireUnlock();
    }
    hiddenAt = 0;
  });
}

function initLockUi() {
  for (const b of document.querySelectorAll('#lock-keys button[data-key]')) {
    b.addEventListener('click', () => lockDigit(b.dataset.key));
  }
  $('lock-cancel').addEventListener('click', () => hideLock('cancel'));
  $('lock-forgot').addEventListener('click', forgotPin);
  // Цифры с клавиатуры (компьютер, внешняя клавиатура).
  document.addEventListener('keydown', (e) => {
    if ($('lock').hidden || document.querySelector('dialog[open]')) return;
    if (/^\d$/.test(e.key)) lockDigit(e.key);
    else if (e.key === 'Backspace') lockDigit('back');
  });
  $('pin-change').addEventListener('click', changePin);
}

// ---------- Запуск ----------
// Enter отправляет только на компьютере (мышь и клавиатура). На телефоне
// Enter переносит строку, чтобы можно было разделять заметки пустой строкой.
const desktopEnter = window.matchMedia('(hover: hover) and (pointer: fine)');

// Кнопка «Назад» в APK: сначала закрывает открытое окно. Возвращает true,
// если нажатие обработано; иначе оболочка возвращает к предыдущему экрану.
function handleBack() {
  // Окно кода не закрывается кнопкой «Назад»: Android сворачивает приложение.
  if (!$('lock').hidden && !document.querySelector('dialog[open]')) {
    if (lockState.change) {
      hideLock('cancel');
      return true;
    }
    return false;
  }
  const open = [...document.querySelectorAll('dialog[open]')].pop();
  if (open) {
    open.close('cancel');
    return true;
  }
  return false;
}

async function start() {
  window.__jarvisBack = handleBack;
  if (platform.kind === 'apk') {
    installSaveCallback(window);
    $('export-confirm').textContent = 'Сохранить CSV';
    $('export-xlsx-confirm').textContent = 'Сохранить Excel';
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => goTo(tab.dataset.target));
  }
  for (const sub of document.querySelectorAll('.subtab')) {
    sub.addEventListener('click', () => goTo(sub.dataset.pane === 'main' ? 'settings' : sub.dataset.pane));
  }
  initLockUi();
  window.addEventListener('hashchange', () => showScreen(currentRoute()));
  window.addEventListener('online', renderStatus);
  window.addEventListener('offline', renderStatus);

  const input = $('input');
  $('composer').addEventListener('submit', handleSubmit);
  $('parse').addEventListener('click', handleParse);
  input.addEventListener('input', () => { autosize(); setComposerError(''); });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
    if (e.ctrlKey || e.metaKey || desktopEnter.matches) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('delete-history').addEventListener('click', handleDeleteHistory);
  $('mic').hidden = !speech.canDictate;
  $('mic').addEventListener('click', handleDictation);
  speech.onChange((state) => {
    if (state !== 'speaking') markSpeaking(null);
    if (state === 'error') toast('Не удалось озвучить ответ.');
  });
  $('voice-select').addEventListener('change', (e) => saveVoicePrefs({ voice: e.target.value }));
  $('voice-rate').addEventListener('change', (e) => saveVoicePrefs({ rate: Number(e.target.value) }));
  $('voice-auto').addEventListener('change', (e) => saveVoicePrefs({ auto: e.target.checked }));
  $('voice-sir').addEventListener('change', (e) => saveVoicePrefs({ sir: e.target.checked }));
  $('voice-accents').addEventListener('change', (e) => saveVoicePrefs({ accents: e.target.checked }));
  $('pron-form').addEventListener('submit', addPronunciation);
  $('voice-test').addEventListener('click', testVoice);
  $('dialog-menu-btn').addEventListener('click', openDialogMenu);
  $('archive-delete').addEventListener('click', deleteOpenArchive);
  $('archive-view').addEventListener('close', () => {
    openArchiveId = null;
    $('archive-messages').replaceChildren();
  });
  $('attach-input').accept = ACCEPT;
  // Скрепка: меню «Снять фото / Снять видео / Выбрать файл». Окно выбора
  // открывается прямо в обработчике нажатия — иначе Android его не покажет.
  const menu = $('attach-menu');
  $('attach').addEventListener('click', () => menu.showModal());
  for (const button of menu.querySelectorAll('button')) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      menu.close();
      const target = { photo: 'photo-input', video: 'video-input', file: 'attach-input' }[button.value];
      if (target) $(target).click();
    });
  }
  for (const id of ['attach-input', 'photo-input', 'video-input']) {
    $(id).addEventListener('change', handleFilesChosen);
  }
  $('backup-save').addEventListener('click', handleBackupSave);
  $('backup-restore').addEventListener('click', () => $('restore-input').click());
  $('restore-input').addEventListener('change', handleRestoreChosen);
  $('export').addEventListener('click', handleExport);
  $('export-xlsx').addEventListener('click', handleExportXlsx);
  $('record-save').addEventListener('click', saveRecord);
  $('record-delete').addEventListener('click', deleteOpenRecord);
  $('record-share').addEventListener('click', shareOpenRecord);
  $('record-dialog').addEventListener('close', () => { openRecordId = null; });

  store = await initStore();
  lock = createLock(store);
  // Код входа — до показа переписки. Экран кода закрывает приложение целиком.
  await requireUnlockStart();
  watchBackground();
  await loadAi();
  await loadVoicePrefs();
  speech.status(); // синтезатор начинает загружаться заранее
  $('ai-form').addEventListener('submit', handleAiConnect);
  $('ai-disconnect').addEventListener('click', handleAiDisconnect);
  try {
    drafts = await store.loadDrafts();
  } catch (error) {
    console.error(error);
    drafts = [];
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDrafts();
  });
  window.addEventListener('pagehide', flushDrafts);
  await renderMessages();
  showScreen(currentRoute());
  document.documentElement.dataset.version = APP_VERSION;
  document.documentElement.dataset.ready = 'true';

  // Не блокируют запуск интерфейса.
  initPersistence().then(renderStatus);
  initServiceWorker().then(renderStatus);
}

start().catch((error) => {
  console.error(error);
  showBanner('Приложение не запустилось. Обновите страницу. Если ошибка повторяется, сообщите разработчику.');
});
