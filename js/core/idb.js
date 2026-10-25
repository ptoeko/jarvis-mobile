// Адаптер хранилища на IndexedDB: данные лежат только в браузере телефона.
import { STORES } from './store.js';

const DB_NAME = 'jarvis-mobile';
const DB_VERSION = 1;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('База данных занята другой вкладкой приложения.'));
  });
}

export async function createIdbAdapter(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) throw new Error('IndexedDB недоступна в этом браузере.');
  const db = await openDb(indexedDB);

  function tx(store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }

  function done(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Операция с базой данных прервана.'));
    });
  }

  return {
    kind: 'indexeddb',
    async getAll(store) {
      return promisify(tx(store, 'readonly').getAll());
    },
    async get(store, id) {
      return promisify(tx(store, 'readonly').get(id));
    },
    async put(store, item) {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).put(item);
      await done(t);
    },
    async delete(store, id) {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).delete(id);
      await done(t);
    },
    async clear(store) {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).clear();
      await done(t);
    },
    async getMeta(key) {
      const entry = await promisify(tx('meta', 'readonly').get(key));
      return entry ? entry.value : undefined;
    },
    async setMeta(key, value) {
      const t = db.transaction('meta', 'readwrite');
      t.objectStore('meta').put({ id: key, value });
      await done(t);
    },
    // Несколько изменений одной транзакцией: либо выполняются все, либо ни одно
    // (например, запись реестра + счётчик номеров + список черновиков).
    async commit(ops) {
      const names = [...new Set(ops.map((op) => op.store))];
      const t = db.transaction(names, 'readwrite');
      for (const op of ops) {
        const os = t.objectStore(op.store);
        if (op.type === 'put') os.put(op.item);
        else if (op.type === 'delete') os.delete(op.id);
        else if (op.type === 'clear') os.clear();
        else throw new Error(`Неизвестная операция: ${op.type}`);
      }
      await done(t);
    },
  };
}
