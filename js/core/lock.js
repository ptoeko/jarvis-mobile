// Код входа: четыре цифры при запуске JARVIS.
//
// Хранится не сам код, а его отпечаток (PBKDF2-SHA-256 с солью), только на
// этом телефоне; в резервную копию не попадает. После 5 неверных попыток
// подряд ввод блокируется на 30 секунд, дальше — вдвое дольше (до часа).
// Блокировка переживает перезапуск приложения.
//
// Код защищает от постороннего, взявшего телефон в руки. Данные на телефоне
// он не шифрует.

export const META_PIN = 'pinLock';
export const PIN_LENGTH = 4;
export const RELOCK_AFTER_MS = 5 * 60 * 1000; // в фоне дольше 5 минут — снова код
const ITERATIONS = 100000;
const FREE_TRIES = 5;
const BASE_WAIT_S = 30;
const MAX_WAIT_S = 3600;

export const validPin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array((String(s).match(/../g) || []).map((h) => parseInt(h, 16)));

export async function pinHash(pin, saltHex, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations }, key, 256);
  return hex(bits);
}

// Сколько секунд ждать после failures неверных попыток подряд.
export function waitSeconds(failures) {
  if (failures < FREE_TRIES || failures % FREE_TRIES !== 0) return 0;
  const round = failures / FREE_TRIES; // 1, 2, 3…
  return Math.min(MAX_WAIT_S, BASE_WAIT_S * 2 ** (round - 1));
}

// meta: { getMeta(key), setMeta(key, value) } — хранилище приложения.
export function createLock(meta, now = () => Date.now()) {
  async function read() {
    const v = await meta.getMeta(META_PIN);
    return v && typeof v === 'object' && typeof v.hash === 'string' && typeof v.salt === 'string' ? v : null;
  }

  return {
    async isSet() {
      return !!(await read());
    },
    async set(pin) {
      if (!validPin(pin)) throw new Error('Код — ровно 4 цифры.');
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await meta.setMeta(META_PIN, { salt, hash: await pinHash(pin, salt), iterations: ITERATIONS, fails: 0, until: 0 });
    },
    // { ok: true } | { ok: false, wait: секунд до следующей попытки, left: попыток до паузы }
    async verify(pin) {
      const v = await read();
      if (!v) return { ok: true };
      const t = now();
      if (v.until && t < v.until) return { ok: false, wait: Math.ceil((v.until - t) / 1000), left: 0 };
      if (validPin(pin) && (await pinHash(pin, v.salt, v.iterations || ITERATIONS)) === v.hash) {
        if (v.fails || v.until) await meta.setMeta(META_PIN, { ...v, fails: 0, until: 0 });
        return { ok: true };
      }
      const fails = (Number(v.fails) || 0) + 1;
      const wait = waitSeconds(fails);
      await meta.setMeta(META_PIN, { ...v, fails, until: wait ? t + wait * 1000 : 0 });
      return { ok: false, wait, left: wait ? 0 : FREE_TRIES - (fails % FREE_TRIES) };
    },
    // Пауза после неверных попыток, сохранённая с прошлого запуска.
    async pause() {
      const v = await read();
      const t = now();
      return v?.until && t < v.until ? Math.ceil((v.until - t) / 1000) : 0;
    },
    async reset() {
      await meta.setMeta(META_PIN, null);
    },
  };
}
