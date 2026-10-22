// Хранилище данных приложения. Работает поверх «адаптера»:
// в браузере — IndexedDB (js/core/idb.js), в тестах и при сбое — память.
// Адаптер обязан реализовать: getAll(store), put(store, item), clear(store),
// getMeta(key), setMeta(key, value).

export const STORES = ['messages', 'records', 'meta'];

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
      return [...data[store].values()].map((item) => ({ ...item }));
    },
    async put(store, item) {
      data[store].set(item.id, { ...item });
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

export function createStore(adapter, now = () => new Date()) {
  async function addMessage({ role, source, text }) {
    if (!ROLES.has(role)) throw new Error(`Неизвестная роль сообщения: ${role}`);
    if (!SOURCES.has(source)) throw new Error(`Неизвестный источник сообщения: ${source}`);
    if (typeof text !== 'string' || text.length === 0) throw new Error('Пустое сообщение не сохраняется.');
    const message = { id: createId(), role, source, text, createdAt: now().toISOString() };
    await adapter.put('messages', message);
    return message;
  }

  async function listMessages() {
    const all = await adapter.getAll('messages');
    return all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async function listRecords() {
    return adapter.getAll('records');
  }

  // Удаляет историю диалога и записи реестра. Настройки (meta) сохраняются,
  // в них нет пользовательских данных.
  async function clearHistory() {
    await adapter.clear('messages');
    await adapter.clear('records');
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
    clearHistory,
    counts,
    getMeta: (key) => adapter.getMeta(key),
    setMeta: (key, value) => adapter.setMeta(key, value),
  };
}
