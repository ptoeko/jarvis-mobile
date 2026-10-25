// Хранилище данных приложения. Работает поверх «адаптера»:
// в браузере — IndexedDB (js/core/idb.js), в тестах и при сбое — память.
// Адаптер обязан реализовать: getAll(store), get(store, id), put(store, item),
// delete(store, id), clear(store), getMeta(key), setMeta(key, value).
//
// Схема базы: версия 1 (этапы 1–2) — хранилища messages, records, meta;
// версия 2 (0.4.0) — добавлено хранилище attachments (файлы вложений).
// Ключ во всех хранилищах — id. Старые данные при обновлении не меняются.

import { EDITABLE_FIELDS } from './config.js';
import { validateFields, restoreDraft } from './records.js';
import { attachmentRefs, cleanFileName, mimeOf, checkFiles } from './attachments.js';

export const STORES = ['messages', 'records', 'meta', 'attachments'];
export const META_NEXT_NUMBER = 'nextRecordNumber';
// Черновики на проверке. Хранятся в базе, чтобы не пропасть, если Android
// закроет приложение в фоне (например, при переключении на камеру).
// В реестр они не входят, пока человек их не подтвердит.
export const META_DRAFTS = 'pendingDrafts';

export function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMemoryAdapter() {
  const data = { messages: new Map(), records: new Map(), meta: new Map(), attachments: new Map() };
  return {
    kind: 'memory',
    async getAll(store) {
      return [...data[store].values()].map((item) => structuredClone(item));
    },
    async get(store, id) {
      const item = data[store].get(id);
      return item ? structuredClone(item) : undefined;
    },
    async keys(store) {
      return [...data[store].keys()];
    },
    async put(store, item) {
      data[store].set(item.id, structuredClone(item));
    },
    async delete(store, id) {
      data[store].delete(id);
    },
    async clear(store) {
      data[store].clear();
    },
    async getMeta(key) {
      const entry = data.meta.get(key);
      return entry ? entry.value : undefined;
    },
    async setMeta(key, value) {
      data.meta.set(key, { id: key, value });
    },
    async commit(ops) {
      // Сначала проверка всех операций, затем применение: как транзакция.
      for (const op of ops) {
        if (!data[op.store] || !['put', 'delete', 'clear'].includes(op.type)) throw new Error(`Неизвестная операция: ${op.type}`);
      }
      for (const op of ops) {
        if (op.type === 'put') data[op.store].set(op.item.id, structuredClone(op.item));
        else if (op.type === 'delete') data[op.store].delete(op.id);
        else data[op.store].clear();
      }
    },
  };
}

export const ROLES = new Set(['user', 'assistant']);
export const SOURCES = new Set(['user', 'demo', 'ai', 'system']);

export class RecordError extends Error {
  constructor(message, fieldErrors = {}) {
    super(message);
    this.name = 'RecordError';
    this.fieldErrors = fieldErrors;
  }
}

function byTime(a, b) {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

export function createStore(adapter, now = () => new Date()) {
  // Время строго растёт: два сообщения в одну миллисекунду не меняются местами.
  let lastTime = 0;
  function stamp() {
    const t = Math.max(now().getTime(), lastTime + 1);
    lastTime = t;
    return new Date(t).toISOString();
  }

  // Черновики, уже ставшие записями: повторное сохранение списка черновиков
  // (например, отложенное после правки) не должно вернуть их обратно.
  const confirmedDrafts = new Set();

  // Операции с записями выполняются по очереди, чтобы номера не совпадали.
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  // Сообщение и его файлы сохраняются одной транзакцией: не бывает
  // сообщения со ссылкой на несохранённый файл и файла без сообщения.
  async function addMessage({ role, source, text, files = [] }) {
    if (!ROLES.has(role)) throw new Error(`Неизвестная роль сообщения: ${role}`);
    if (!SOURCES.has(source)) throw new Error(`Неизвестный источник сообщения: ${source}`);
    if (typeof text !== 'string') throw new Error('Сообщение должно быть текстом.');
    const list = [...(files || [])];
    if (text.length === 0 && list.length === 0) throw new Error('Пустое сообщение не сохраняется.');
    if (list.length) {
      const checked = checkFiles(list);
      if (!checked.ok) throw new Error(checked.error);
    }
    const id = createId();
    const createdAt = stamp();
    const items = list.map((f) => {
      const name = cleanFileName(f.name);
      return { id: createId(), name, type: mimeOf(name, f.type), size: f.size, blob: f, messageId: id, createdAt };
    });
    const message = { id, role, source, text, createdAt };
    if (items.length) message.attachments = attachmentRefs(items);
    await adapter.commit([
      ...items.map((item) => ({ type: 'put', store: 'attachments', item })),
      { type: 'put', store: 'messages', item: message },
    ]);
    return message;
  }

  // Файл вложения: { id, name, type, size, blob } или undefined.
  async function getAttachment(id) {
    return adapter.get('attachments', id);
  }

  async function listMessages() {
    return (await adapter.getAll('messages')).sort(byTime);
  }

  async function listRecords() {
    const all = await adapter.getAll('records');
    return all.sort((a, b) => a.number - b.number);
  }

  // Подтверждение черновика человеком. Номер присваивается здесь один раз:
  // следующий после наибольшего когда-либо выданного (счётчик в meta), поэтому
  // номера удалённых записей не используются повторно.
  function confirmRecord(draft) {
    return serial(async () => {
      if (typeof draft?.sourceText !== 'string' || draft.sourceText.trim() === '') {
        throw new RecordError('У записи нет исходного текста заметки.');
      }
      const input = {};
      for (const key of EDITABLE_FIELDS) input[key] = draft[key];
      const checked = validateFields(input);
      if (!checked.ok) throw new RecordError('Исправьте поля записи.', checked.errors);

      const existing = await adapter.getAll('records');
      const maxExisting = existing.reduce((max, r) => Math.max(max, Number(r.number) || 0), 0);
      const counter = Number(await adapter.getMeta(META_NEXT_NUMBER)) || 1;
      const number = Math.max(counter, maxExisting + 1);
      const time = stamp();
      const record = {
        id: createId(),
        number,
        ...checked.value,
        sourceText: draft.sourceText,
        sourceMessageId: draft.sourceMessageId ?? null,
        attachments: attachmentRefs(draft.attachments),
        createdAt: time,
        updatedAt: time,
      };
      // Запись, счётчик и удаление черновика — одной транзакцией: после сбоя
      // не останется ни записи без счётчика, ни подтверждённого черновика.
      const pending = await readDrafts();
      const ops = [
        { type: 'put', store: 'records', item: record },
        { type: 'put', store: 'meta', item: { id: META_NEXT_NUMBER, value: number + 1 } },
      ];
      if (draft.draftId && pending.some((d) => d.draftId === draft.draftId)) {
        ops.push({ type: 'put', store: 'meta', item: { id: META_DRAFTS, value: pending.filter((d) => d.draftId !== draft.draftId) } });
      }
      await adapter.commit(ops);
      if (draft.draftId) confirmedDrafts.add(draft.draftId);
      return record;
    });
  }

  // Изменяет только редактируемые поля. Номер, исходный текст и служебные
  // поля изменить нельзя — попытка отклоняется с ошибкой.
  function updateRecord(id, changes) {
    return serial(async () => {
      const current = await adapter.get('records', id);
      if (!current) throw new RecordError('Запись не найдена. Возможно, она уже удалена.');
      const checked = validateFields(changes);
      if (!checked.ok) throw new RecordError('Исправьте поля записи.', checked.errors);
      const updated = { ...current, ...checked.value, updatedAt: stamp() };
      await adapter.put('records', updated);
      return updated;
    });
  }

  // Удаляет одну запись. Остальные записи не перенумеровываются.
  function deleteRecord(id) {
    return serial(async () => {
      const current = await adapter.get('records', id);
      if (!current) throw new RecordError('Запись не найдена. Возможно, она уже удалена.');
      await adapter.delete('records', id);
    });
  }

  // Удаляет историю диалога и весь реестр. Нумерация реестра начинается
  // заново, так как записей не остаётся.
  function clearHistory() {
    return serial(async () => {
      await adapter.commit([
        { type: 'clear', store: 'messages' },
        { type: 'clear', store: 'records' },
        { type: 'clear', store: 'attachments' },
        { type: 'put', store: 'meta', item: { id: META_NEXT_NUMBER, value: 1 } },
        { type: 'put', store: 'meta', item: { id: META_DRAFTS, value: [] } },
      ]);
    });
  }

  // Черновики из базы. Повреждённые элементы пропускаются, а не ломают запуск.
  async function readDrafts() {
    const raw = await adapter.getMeta(META_DRAFTS);
    if (!Array.isArray(raw)) return [];
    return raw.map(restoreDraft).filter(Boolean);
  }

  function loadDrafts() {
    return serial(readDrafts);
  }

  // Сохраняет текущий список черновиков (после разбора, правки, отклонения).
  function saveDrafts(list) {
    const value = list.map(restoreDraft).filter(Boolean);
    return serial(() => adapter.setMeta(META_DRAFTS, value.filter((d) => !confirmedDrafts.has(d.draftId))));
  }

  // Счётчики без чтения самих файлов: размеры берутся из описаний в сообщениях.
  async function counts() {
    const [messages, records] = await Promise.all([adapter.getAll('messages'), adapter.getAll('records')]);
    const refs = messages.flatMap((m) => attachmentRefs(m.attachments));
    return {
      messages: messages.length,
      records: records.length,
      attachments: refs.length,
      attachmentsSize: refs.reduce((sum, r) => sum + r.size, 0),
    };
  }

  // Всё, кроме файлов вложений, — для резервной копии. Файлы читаются по одному
  // (getAttachment), чтобы не держать их все в памяти телефона.
  function snapshot() {
    return serial(async () => {
      const [messages, records, meta] = await Promise.all([
        adapter.getAll('messages'), adapter.getAll('records'), adapter.getAll('meta'),
      ]);
      return { messages: messages.sort(byTime), records: records.sort((a, b) => a.number - b.number), meta };
    });
  }

  // Файлы вложений по одному (восстановление из копии: сначала файлы,
  // затем одна транзакция с остальными данными).
  async function attachmentIds() {
    return adapter.keys('attachments');
  }

  function putAttachment(item) {
    return serial(() => adapter.put('attachments', item));
  }

  function deleteAttachments(ids) {
    return serial(() => adapter.commit(ids.map((id) => ({ type: 'delete', store: 'attachments', id }))));
  }

  // Полная замена данных одной транзакцией: сообщения, записи и служебные
  // данные заменяются, файлы — остаются только перечисленные в keepAttachmentIds
  // (они уже записаны). При сбое на телефоне остаются прежние данные целиком.
  function replaceAll({ messages, records, meta, keepAttachmentIds }) {
    return serial(async () => {
      const keep = new Set(keepAttachmentIds);
      const stale = (await adapter.keys('attachments')).filter((id) => !keep.has(id));
      await adapter.commit([
        { type: 'clear', store: 'messages' },
        { type: 'clear', store: 'records' },
        { type: 'clear', store: 'meta' },
        ...stale.map((id) => ({ type: 'delete', store: 'attachments', id })),
        ...messages.map((item) => ({ type: 'put', store: 'messages', item })),
        ...records.map((item) => ({ type: 'put', store: 'records', item })),
        ...meta.map((item) => ({ type: 'put', store: 'meta', item })),
      ]);
      confirmedDrafts.clear();
    });
  }

  return {
    storageKind: adapter.kind,
    addMessage,
    listMessages,
    listRecords,
    confirmRecord,
    updateRecord,
    deleteRecord,
    clearHistory,
    loadDrafts,
    saveDrafts,
    counts,
    getAttachment,
    snapshot,
    replaceAll,
    attachmentIds,
    putAttachment,
    deleteAttachments,
    getMeta: (key) => adapter.getMeta(key),
    setMeta: (key, value) => adapter.setMeta(key, value),
  };
}
