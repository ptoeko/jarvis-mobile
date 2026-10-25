// Связывает интерфейс с логикой. Пользовательский текст выводится только
// через textContent и value — HTML из сообщений и заметок никогда не исполняется.
import { APP_VERSION, APP_STAGE, REGISTRY_FIELDS, EDITABLE_FIELDS, NOT_SPECIFIED } from './core/config.js';
import { validateMessage } from './core/validate.js';
import { demoReply, draftsReply } from './core/demo.js';
import { createStore, createMemoryAdapter, RecordError } from './core/store.js';
import { createIdbAdapter } from './core/idb.js';
import { createAiClient } from './core/ai.js';
import { computeFeatures, statusSummary, STATE_LABELS } from './core/status.js';
import { parseMessage } from './core/parse.js';
import { createDraft } from './core/records.js';
import { recordsToCsv, exportFileName } from './core/csv.js';
import { detectPlatform, installSaveCallback, saveViaBridge, saveBlobViaBridge, openBlobViaBridge, copyText } from './core/platform.js';
import { ACCEPT, checkFiles, formatSize, kindLabel, attachmentRefs } from './core/attachments.js';
import { createBackup, inspectBackup, restoreBackup, backupFileName, BackupError, META_LAST_BACKUP } from './core/backup.js';

const SCREENS = ['dialog', 'registry', 'settings', 'status'];
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
const ai = createAiClient();
env.aiConfigured = ai.configured;

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

// ---------- Диалог ----------
function messageElement(message) {
  const meta = el('div', { className: 'msg-meta' });
  const who = el('span', {});
  if (message.role === 'assistant') {
    meta.append(el('span', { className: 'badge' }, message.source === 'ai' ? 'ИИ' : 'Демо'));
    who.append(message.source === 'ai' ? 'Ответ ИИ' : 'Демо-ответ, не ИИ');
  } else {
    who.append('Вы');
  }
  const time = formatTime(message.createdAt);
  if (time) who.append(`, ${time}`);
  meta.append(who);
  if (message.text) {
    const copy = el('button', { type: 'button', className: 'copy-btn', title: 'Копировать текст' });
    copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>';
    copy.setAttribute('aria-label', 'Копировать текст сообщения');
    copy.addEventListener('click', async () => {
      const ok = await copyText(window, message.text);
      toast(ok ? 'Текст скопирован' : 'Не удалось скопировать. Выделите текст долгим нажатием.');
    });
    meta.append(copy);
  }
  const item = el('li', { className: `msg msg-${message.role}`, dataset: { source: message.source, id: message.id } }, meta);
  if (message.text) item.append(el('div', { className: 'msg-text' }, message.text));
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

async function handleSubmit(event) {
  event.preventDefault();
  await withComposer(async (text) => {
    try {
      await store.addMessage({ role: 'user', source: 'user', text, files: pendingFiles });
      const withFiles = pendingFiles.length;
      clearComposer();
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
      // Файлы заметки прикладываются к каждому черновику из этого сообщения.
      const created = parsed.notes.map((n) => createDraft({ fields: n.fields, sourceText: n.note, sourceMessageId: message.id, attachments: message.attachments }));
      drafts.push(...created);
      await persistDrafts();
      const reply = draftsReply(created.length);
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
      el('h4', {}, `Черновик ${i + 1} из ${drafts.length}`),
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

// ---------- Настройки ----------
async function renderSettings() {
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
    if (!(e instanceof BackupError)) console.error(e);
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

// ---------- Запуск ----------
// Enter отправляет только на компьютере (мышь и клавиатура). На телефоне
// Enter переносит строку, чтобы можно было разделять заметки пустой строкой.
const desktopEnter = window.matchMedia('(hover: hover) and (pointer: fine)');

// Кнопка «Назад» в APK: сначала закрывает открытое окно. Возвращает true,
// если нажатие обработано; иначе оболочка возвращает к предыдущему экрану.
function handleBack() {
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
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => goTo(tab.dataset.target));
  }
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
  $('attach-input').accept = ACCEPT;
  $('attach').addEventListener('click', () => $('attach-input').click());
  $('attach-input').addEventListener('change', handleFilesChosen);
  $('backup-save').addEventListener('click', handleBackupSave);
  $('backup-restore').addEventListener('click', () => $('restore-input').click());
  $('restore-input').addEventListener('change', handleRestoreChosen);
  $('export').addEventListener('click', handleExport);
  $('record-save').addEventListener('click', saveRecord);
  $('record-delete').addEventListener('click', deleteOpenRecord);
  $('record-dialog').addEventListener('close', () => { openRecordId = null; });

  store = await initStore();
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
