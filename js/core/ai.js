// Клиент «ИИ агента». Приложение обращается только к своему посреднику
// (адрес и код доступа задаются в Настройках); ключей ИИ в приложении нет.
// Название модели и поставщика в приложении не показывается нигде.

export const AI_LABEL = 'ИИ агент';
export const META_AI_URL = 'aiUrl';
export const META_AI_CODE = 'aiCode';
const TIMEOUT_MS = 120000;

export class AiError extends Error {
  constructor(message, kind = 'error') {
    super(message);
    this.name = 'AiError';
    this.kind = kind; // 'config' | 'auth' | 'network' | 'error'
  }
}

// Адрес посредника: только https, без пути, запросов и паролей в адресе.
export function normalizeAgentUrl(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!/^[a-z0-9.-]+\.workers\.dev$/i.test(url.hostname)) return null;
  return url.origin;
}

export function validAccessCode(code) {
  return typeof code === 'string' && code.trim().length >= 16 && code.trim().length <= 200;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function blobToBase64(blob) {
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function createAiClient({ url = null, code = null, fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  const configured = !!(url && code);

  async function request(path, { method = 'POST', body } = {}) {
    if (!configured) throw new AiError('ИИ агент не подключён. Настройки → «ИИ агент».', 'config');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(`${url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${code}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw new AiError(e?.name === 'AbortError'
        ? 'ИИ агент не ответил вовремя. Повторите.'
        : 'Нет связи с ИИ агентом. Проверьте интернет.', 'network');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      if (response.status === 401) throw new AiError('Неверный код доступа ИИ агента.', 'auth');
      throw new AiError(data?.error || 'ИИ агент временно недоступен. Повторите позже.');
    }
    return data || {};
  }

  return {
    configured,
    label: AI_LABEL,
    // Проверка адреса и кода доступа.
    async check() {
      const data = await request('/v1/health', { method: 'GET' });
      if (!data.ok) throw new AiError('Посредник ответил неверно.');
      return true;
    },
    // history: [{ role: 'user'|'assistant', text, files: [{ name, type, data(base64) }] }]
    // → { text, files: [{ kind: 'table'|'text', name, … }] }
    async chat(history) {
      const data = await request('/v1/chat', { body: { messages: history } });
      return {
        text: typeof data.text === 'string' ? data.text : '',
        files: Array.isArray(data.files) ? data.files : [],
      };
    },
    // notes: [текст] → [{ поля реестра }]
    async parse(notes) {
      const data = await request('/v1/parse', { body: { notes } });
      if (!Array.isArray(data.items) || data.items.length !== notes.length) throw new AiError('ИИ агент разобрал не все заметки.');
      return data.items;
    },
  };
}
