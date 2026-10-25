// Посредник «ИИ агент» для JARVIS Mobile (Cloudflare Worker).
//
// Зачем: ключ доступа к ИИ нельзя хранить в приложении — его можно извлечь из
// APK. Ключ хранится здесь как секрет; приложение предъявляет только свой код
// доступа. Посредник:
//   • пускает только запросы с верным кодом доступа (ACCESS_CODE);
//   • ограничивает размер запроса и длину истории;
//   • задаёт ИИ роль «ИИ агент JARVIS» и запрещает называть модель и поставщика;
//   • не пересылает в приложение тексты ошибок поставщика (в них есть его название);
//   • возвращает ответ и файлы, которые агент создал (таблицы Excel, тексты).
//
// Конечные точки:
//   GET  /v1/health — проверка кода доступа;
//   POST /v1/chat   — переписка: { messages: [{ role, text, files: [{ name, type, data }] }] }
//                     → { text, files: [{ kind: 'table'|'text', name, … }] };
//   POST /v1/parse  — заметки → поля реестра: { notes: [текст] } → { items: [{ поля }] }.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_BODY = 30 * 1024 * 1024; // предел запроса к ИИ — около 32 МБ
const MAX_MESSAGES = 30;
const MAX_TOOL_ROUNDS = 3;

const FIELDS = ['date', 'object', 'location', 'workType', 'description', 'requirement', 'responsible', 'deadline', 'status'];
const NOT_SPECIFIED = 'Не указано';

const IDENTITY = [
  'Ты — «ИИ агент JARVIS», помощник инженера-строителя на площадке (энергетика, АЭС, промышленное и гражданское строительство).',
  'Никогда не называй модель, её версию, компанию-разработчика или поставщика. На вопрос «кто ты» или «какая ты модель» отвечай: «Я ИИ агент JARVIS».',
  'Отвечай по-русски, коротко и по делу, как опытный коллега-инженер.',
].join('\n');

const CHAT_SYSTEM = [
  IDENTITY,
  'Помогаешь с замечаниями при обходе, исполнительной документацией, сравнением факта с проектом, нормами, письмами и отчётами.',
  'Не выдумывай номера норм, пунктов и значения допусков. Если не уверен — так и скажи и предложи проверить по действующей редакции документа.',
  'Если пользователь просит таблицу, ведомость, реестр или перечень — создай файл инструментом create_table. Если просит документ, письмо, акт, отчёт или текстовый файл — используй create_text_file. Файл появится во вложении к твоему ответу; в тексте кратко скажи, что в нём.',
  'Фото и PDF из сообщений тебе видны. Word, Excel и видео видны только по названию — если нужно их содержание, попроси пересказать или прислать PDF или фото.',
].join('\n');

const PARSE_SYSTEM = [
  IDENTITY,
  'Задача: разобрать заметки инженера в поля реестра замечаний.',
  'Заполняй поле ТОЛЬКО тем, что явно написано в заметке. Ничего не придумывай и не дополняй. Если в заметке нет сведений для поля — пиши ровно «Не указано».',
  'Поля: date (дата замечания, как написано), object (объект/здание), location (оси, отметки, помещения — дословно), workType (вид работ), description (суть замечания своими словами из текста заметки, кратко), requirement (проект, норма, пункт, лист — дословно), responsible (организация-исполнитель), deadline (срок устранения), status (статус — только если написан явно, иначе «Не указано»).',
  'Ответь ТОЛЬКО JSON без пояснений: {"items":[{"date":"…","object":"…","location":"…","workType":"…","description":"…","requirement":"…","responsible":"…","deadline":"…","status":"…"}]} — по одному элементу на каждую заметку, в том же порядке.',
].join('\n');

const TOOLS = [
  {
    name: 'create_table',
    description: 'Создать таблицу Excel (.xlsx) и приложить к ответу. Для ведомостей, реестров, перечней, графиков.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Имя файла по-русски, без расширения' },
        headers: { type: 'array', items: { type: 'string' }, description: 'Заголовки столбцов' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Строки таблицы; каждая — массив значений по столбцам' },
      },
      required: ['file_name', 'headers', 'rows'],
    },
  },
  {
    name: 'create_text_file',
    description: 'Создать текстовый документ (.txt) и приложить к ответу. Для писем, актов, отчётов, заметок.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Имя файла по-русски, без расширения' },
        content: { type: 'string', description: 'Полный текст документа' },
      },
      required: ['file_name', 'content'],
    },
  },
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

// Сравнение кода доступа за постоянное время (без подсказки по времени ответа).
export function sameCode(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function checkAccess(request, env) {
  if (!env.ACCESS_CODE || String(env.ACCESS_CODE).length < 16) throw new HttpError(503, 'Посредник не настроен: не задан код доступа.');
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'Посредник не настроен: не задан ключ ИИ.');
  const auth = request.headers.get('Authorization') || '';
  const code = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!code || !sameCode(code, env.ACCESS_CODE)) throw new HttpError(401, 'Неверный код доступа.');
}

async function readBody(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос: уменьшите число или размер файлов.');
  const text = await request.text();
  if (text.length > MAX_BODY * 1.4) throw new HttpError(413, 'Слишком большой запрос: уменьшите число или размер файлов.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Запрос повреждён.');
  }
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Сообщения приложения → формат ИИ. Фото и PDF передаются содержимым,
// остальные файлы — только названием.
export function toModelMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new HttpError(400, 'Нет сообщений.');
  const out = [];
  for (const m of messages.slice(-MAX_MESSAGES)) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = [];
    for (const f of Array.isArray(m?.files) ? m.files : []) {
      const name = String(f?.name || 'файл').slice(0, 200);
      if (role === 'user' && IMAGE_TYPES.has(f?.type) && typeof f?.data === 'string') {
        content.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } });
        content.push({ type: 'text', text: `[Фото: ${name}]` });
      } else if (role === 'user' && f?.type === 'application/pdf' && typeof f?.data === 'string') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: name });
      } else {
        content.push({ type: 'text', text: `[Файл: ${name} — содержимое не передано]` });
      }
    }
    const text = typeof m?.text === 'string' ? m.text.slice(0, 20000) : '';
    if (text) content.push({ type: 'text', text });
    if (content.length === 0) continue;
    // ИИ требует чередования ролей: подряд идущие сообщения одной роли объединяются.
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...content);
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (out.length === 0) throw new HttpError(400, 'Нет сообщений пользователя.');
  return out;
}

async function callModel(env, body) {
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({ model: env.MODEL || 'claude-sonnet-5-5', ...body }),
    });
  } catch {
    throw new HttpError(502, 'ИИ агент недоступен. Повторите позже.');
  }
  if (!response.ok) {
    // Текст ошибки поставщика не пересылается: в нём его название.
    const s = response.status;
    if (s === 401 || s === 403) throw new HttpError(502, 'Посредник: ключ ИИ недействителен или не оплачен. Проверьте баланс и ключ.');
    if (s === 429) throw new HttpError(429, 'Слишком много запросов или исчерпан лимит расходов. Повторите позже.');
    if (s === 400 || s === 413) throw new HttpError(400, 'ИИ агент не принял запрос: возможно, файл слишком большой или неподдерживаемый.');
    throw new HttpError(502, 'ИИ агент временно перегружен. Повторите через минуту.');
  }
  return response.json();
}

function textOf(content) {
  return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

const safeName = (s, ext) => {
  const base = String(s || 'файл').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim().slice(0, 80) || 'файл';
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
};

// Файл, созданный агентом инструментом. Таблица собирается в Excel в приложении.
export function fileFromTool(block) {
  const input = block.input || {};
  if (block.name === 'create_table') {
    const headers = (Array.isArray(input.headers) ? input.headers : []).map((h) => String(h ?? '')).slice(0, 50);
    const rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, 5000)
      .map((r) => (Array.isArray(r) ? r : [r]).map((v) => String(v ?? '')).slice(0, 50));
    if (headers.length === 0) return null;
    return { kind: 'table', name: safeName(input.file_name, '.xlsx'), headers, rows };
  }
  if (block.name === 'create_text_file') {
    const content = String(input.content ?? '');
    if (!content) return null;
    return { kind: 'text', name: safeName(input.file_name, '.txt'), content: content.slice(0, 500000) };
  }
  return null;
}

async function handleChat(env, data) {
  const messages = toModelMessages(data?.messages);
  const files = [];
  const texts = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callModel(env, { max_tokens: 8000, system: CHAT_SYSTEM, tools: TOOLS, messages });
    const t = textOf(result.content);
    if (t) texts.push(t);
    const uses = (result.content || []).filter((b) => b.type === 'tool_use');
    if (result.stop_reason !== 'tool_use' || uses.length === 0) break;
    const toolResults = uses.map((u) => {
      const file = fileFromTool(u);
      if (file) files.push(file);
      return {
        type: 'tool_result',
        tool_use_id: u.id,
        content: file ? `Файл «${file.name}» создан и будет приложен к ответу.` : 'Файл не создан: неверные данные.',
        ...(file ? {} : { is_error: true }),
      };
    });
    messages.push({ role: 'assistant', content: result.content });
    messages.push({ role: 'user', content: toolResults });
  }
  const text = texts.join('\n\n') || (files.length ? 'Готово, файл во вложении.' : 'ИИ агент не дал ответа. Повторите вопрос.');
  return { text, files };
}

// Из ответа ИИ берётся первый JSON-объект; каждое поле — строка, пустое — «Не указано».
export function parseItems(text, count) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new HttpError(502, 'ИИ агент вернул ответ в неверном формате.');
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new HttpError(502, 'ИИ агент вернул ответ в неверном формате.');
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length !== count) throw new HttpError(502, 'ИИ агент разобрал не все заметки.');
  return items.map((it) => {
    const out = {};
    for (const key of FIELDS) {
      const v = typeof it?.[key] === 'string' ? it[key].trim() : '';
      out[key] = v ? v.slice(0, 4000) : NOT_SPECIFIED;
    }
    return out;
  });
}

async function handleParse(env, data) {
  const notes = Array.isArray(data?.notes) ? data.notes.map((n) => String(n ?? '')).filter(Boolean) : [];
  if (notes.length === 0 || notes.length > 20) throw new HttpError(400, 'Нужно от 1 до 20 заметок.');
  const list = notes.map((n, i) => `Заметка ${i + 1}:\n${n.slice(0, 4000)}`).join('\n\n');
  const result = await callModel(env, {
    max_tokens: 4000,
    system: PARSE_SYSTEM,
    messages: [{ role: 'user', content: list }],
  });
  return { items: parseItems(textOf(result.content), notes.length) };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const { pathname } = new URL(request.url);
      checkAccess(request, env);
      if (request.method === 'GET' && pathname === '/v1/health') return json({ ok: true, agent: 'ИИ агент' }, 200, cors);
      if (request.method === 'POST' && pathname === '/v1/chat') return json(await handleChat(env, await readBody(request)), 200, cors);
      if (request.method === 'POST' && pathname === '/v1/parse') return json(await handleParse(env, await readBody(request)), 200, cors);
      throw new HttpError(404, 'Нет такого адреса.');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : 'Ошибка посредника.';
      return json({ error: message }, status, cors);
    }
  },
};
