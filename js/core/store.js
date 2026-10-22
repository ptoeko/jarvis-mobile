// Хранилище данных приложения. Работает поверх «адаптера»:
// в браузере — IndexedDB (js/core/idb.js), в тестах и при сбое — память.
// Адаптер обязан реализовать: getAll(store), get(store, id), put(store, item),
// delete(store, id), clear(store), getMeta(key), setMeta(key, value).
//
// Схема базы не менялась с этапа 1 (версия 1): хранилища messages, records, meta
// с ключом id. Записи реестра впервые пишутся на этапе 2.

import { EDITABLE_FIELDS } from './config.js';
import { validateFields } from './records.js';

export const STORES = ['messages', 'records', 'meta'];
export const META_NEXT_NUMBER = 'nextRecordNumber';

export function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMemoryAdapter() {
  const data = { messages: new Map(), records: new Map(), meta: new Map() };
  return {
    kind: 'memory',
    async getAll(store) {
      return [...data[store].values()].map((item) => structuredClone(item));
    },
    async get(store, id) {
      const item = data[store].get(id);
      return item ? structuredClone(item) : undefined;
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
  };
}

const ROLES = new Set(['user', 'assistant']);
const SOURCES = new Set(['user', 'demo', 'ai', 'system']);

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

  // Операции с записями выполняются по очереди, чтобы номера не совпадали.
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function addMessage({ role, source, text }) {
    if (!ROLES.has(role)) throw new Error(`Неизвестная роль сообщения: ${role}`);
    if (!SOURCES.has(source)) throw new Error(`Неизвестный источник сообщения: ${source}`);
    if (typeof text !== 'string' || text.length === 0) throw new Error('Пустое сообщение не сохраняется.');
    const message = { id: createId(), role, source, text, createdAt: stamp() };
    await adapter.put('messages', message);
    return message;
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
        createdAt: time,
        updatedAt: time,
      };
      await adapter.put('records', record);
      await adapter.setMeta(META_NEXT_NUMBER, number + 1);
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
      await adapter.clear('messages');
      await adapter.clear('records');
      await adapter.setMeta(META_NEXT_NUMBER, 1);
    });
  }

  async function counts() {
    const [messages, records] = await Promise.all([adapter.getAll('messages'), adapter.getAll('records')]);
    return { messages: messages.length, records: records.length };
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
    counts,
    getMeta: (key) => adapter.getMeta(key),
    setMeta: (key, value) => adapter.setMeta(key, value),
  };
}
