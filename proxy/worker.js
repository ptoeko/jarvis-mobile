// Посредник «ИИ агент» для JARVIS Mobile (Cloudflare Worker).
//
// Поставщик ИИ выбирается на посреднике, приложение об этом не знает:
//   • Gemini — если задан секрет GEMINI_API_KEY (или PROVIDER = "gemini");
//   • Anthropic — если задан ANTHROPIC_API_KEY (или PROVIDER = "anthropic").
// Внутри посредника переписка хранится в одном формате; для Gemini запрос и
// ответ переводятся переходником (toGeminiRequest / fromGeminiResponse).
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
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';
const API_VERSION = '2023-06-01';
const MAX_BODY = 30 * 1024 * 1024; // предел запроса к ИИ — около 32 МБ
const MAX_MESSAGES = 30;
const MAX_TOOL_ROUNDS = 6;
const MAX_SOURCES = 8;

const FIELDS = ['date', 'object', 'location', 'workType', 'description', 'requirement', 'responsible', 'deadline', 'status'];
const NOT_SPECIFIED = 'Не указано';

const IDENTITY = [
  'Ты — «ИИ агент JARVIS», помощник инженера-строителя на площадке (энергетика, АЭС, промышленное и гражданское строительство).',
  'Никогда не называй модель, её версию, компанию-разработчика или поставщика. На вопрос «кто ты» или «какая ты модель» отвечай: «Я ИИ агент JARVIS».',
  'Отвечай по-русски, коротко и по делу, как опытный коллега-инженер.',
  'Пиши простым текстом: без разметки Markdown (без звёздочек, решёток, [текст](ссылка)). Ссылки пиши полным адресом страницы.',
].join('\n');

const CHAT_SYSTEM = [
  IDENTITY,
  'Помогаешь с замечаниями при обходе, исполнительной документацией, сравнением факта с проектом, нормами, письмами и отчётами.',
  'Не выдумывай номера норм, пунктов и значения допусков. Если не уверен — так и скажи и предложи проверить по действующей редакции документа.',
  'Файлы создавай инструментами, они появятся во вложении к ответу; в тексте кратко скажи, что в файле:',
  '• таблица, ведомость, реестр, перечень, график — create_table (Excel);',
  '• отчёт, сводный отчёт, письмо, акт, протокол, служебная записка, любой документ Word — create_word_document. Используй заголовки, абзацы, списки и таблицы; для широких таблиц — альбомная ориентация;',
  '• простой текстовый файл (.txt) — create_text_file, только если пользователь просит именно текстовый файл.',
  'Сводный отчёт из нескольких присланных отчётов: возьми данные из каждого документа, сгруппируй по объектам (зданиям) и разделам, сохрани все числа, даты и единицы измерения как в исходниках, ничего не придумывай; если данные расходятся — укажи это в документе. Не сокращай содержание без просьбы.',
  'Поиск в интернете — web_search: когда спрашивают про актуальное (новости, цены, курсы, действующие редакции норм, контакты, события) или просят «найди». После поиска отвечай по найденному и в конце перечисли источники со ссылками. Если не нашёл — так и скажи.',
  'Изображение (схема, эскиз, иллюстрация, картинка) — create_image с подробным описанием на английском языке. Это иллюстрация, а не рабочий чертёж: размеры на ней не точны — предупреди об этом, если просят чертёж.',
  'Тебе видны: фото из последнего сообщения, PDF и текст документов Word и Excel из последних сообщений (документ приходит между метками [Документ: …] и [Конец документа: …]). Видео видно только по названию. Если содержимое файла не передано — в скобках указана причина; объясни её пользователю.',
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

const BLOCK_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['heading', 'paragraph', 'bullets', 'numbered', 'table', 'page_break'], description: 'Вид блока' },
    text: { type: 'string', description: 'Текст заголовка или абзаца' },
    level: { type: 'integer', description: 'Уровень заголовка: 1, 2 или 3' },
    bold: { type: 'boolean', description: 'Жирный абзац' },
    items: { type: 'array', items: { type: 'string' }, description: 'Пункты списка' },
    headers: { type: 'array', items: { type: 'string' }, description: 'Заголовки столбцов таблицы' },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Строки таблицы' },
  },
  required: ['type'],
};

TOOLS.push(
  {
    name: 'create_word_document',
    description: 'Создать документ Word (.docx) и приложить к ответу. Для отчётов, сводных отчётов, писем, актов, протоколов.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Имя файла по-русски, без расширения' },
        title: { type: 'string', description: 'Заголовок документа' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: 'Ориентация страницы: landscape — для широких таблиц' },
        blocks: { type: 'array', items: BLOCK_SCHEMA, description: 'Содержимое документа по порядку' },
      },
      required: ['file_name', 'blocks'],
    },
  },
  {
    name: 'web_search',
    description: 'Найти актуальные сведения в интернете. Возвращает краткую сводку найденного и источники.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Поисковый запрос' } },
      required: ['query'],
    },
  },
  {
    name: 'create_image',
    description: 'Создать изображение (иллюстрацию, эскиз, схему) и приложить к ответу.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Имя файла по-русски, без расширения' },
        prompt: { type: 'string', description: 'Подробное описание изображения на английском языке' },
        aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '3:4', '16:9', '9:16'], description: 'Соотношение сторон' },
      },
      required: ['file_name', 'prompt'],
    },
  },
);

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

// Какой поставщик ИИ используется.
export function providerOf(env) {
  const p = String(env.PROVIDER || '').trim().toLowerCase();
  if (p === 'gemini' || p === 'anthropic') return p;
  return env.GEMINI_API_KEY ? 'gemini' : 'anthropic';
}

function apiKeyOf(env) {
  return providerOf(env) === 'gemini' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;
}

function checkAccess(request, env) {
  if (!env.ACCESS_CODE || String(env.ACCESS_CODE).length < 16) throw new HttpError(503, 'Посредник не настроен: не задан код доступа.');
  if (!apiKeyOf(env)) throw new HttpError(503, 'Посредник не настроен: не задан ключ ИИ.');
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
      } else if (role === 'user' && typeof f?.text === 'string' && f.text) {
        content.push({ type: 'text', text: `[Документ: ${name}]\n${f.text.slice(0, 150000)}\n[Конец документа: ${name}]` });
      } else if (role === 'user' && typeof f?.note === 'string' && f.note) {
        content.push({ type: 'text', text: `[Файл: ${name} — содержимое не передано: ${f.note.slice(0, 300)}]` });
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

// ---------- Переходник Gemini ----------

// Внутренний запрос { system, tools, messages, max_tokens, json } → запрос Gemini.
export function toGeminiRequest(body) {
  const names = new Map(); // id вызова инструмента → его имя
  const contents = [];
  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    const parts = [];
    for (const b of blocks) {
      if (b.geminiPart) {
        // Часть ответа Gemini возвращается без изменений (с подписью рассуждения).
        if (b.type === 'tool_use') names.set(b.id, b.name);
        parts.push(b.geminiPart);
      } else if (b.type === 'text') {
        if (b.text) parts.push({ text: b.text });
      } else if (b.type === 'image' || b.type === 'document') {
        parts.push({ inlineData: { mimeType: b.source?.media_type, data: b.source?.data } });
        if (b.type === 'document' && b.title) parts.push({ text: `[Документ: ${b.title}]` });
      } else if (b.type === 'tool_use') {
        names.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      } else if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : textOf(b.content);
        parts.push({ functionResponse: { name: names.get(b.tool_use_id) || 'tool', response: { result: content, ...(b.is_error ? { error: true } : {}) } } });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  const request = {
    contents,
    // Модели с рассуждением тратят часть лимита на рассуждение — запас сверху.
    generationConfig: { maxOutputTokens: (body.max_tokens || 4000) + 8192 },
  };
  if (body.system) request.systemInstruction = { parts: [{ text: body.system }] };
  if (body.json) request.generationConfig.responseMimeType = 'application/json';
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = [{ functionDeclarations: body.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
  }
  return request;
}

// Ответ Gemini → внутренний ответ { content: [блоки], stop_reason }.
export function fromGeminiResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = [];
  let calls = 0;
  for (const part of parts) {
    if (part.thought) continue; // служебное рассуждение не показывается
    if (part.functionCall) {
      calls++;
      content.push({ type: 'tool_use', id: `call-${calls}`, name: part.functionCall.name, input: part.functionCall.args || {}, geminiPart: part });
    } else if (typeof part.text === 'string' && part.text) {
      content.push({ type: 'text', text: part.text, geminiPart: part });
    }
  }
  return { content, stop_reason: calls ? 'tool_use' : 'end_turn' };
}

async function geminiError(response) {
  const s = response.status;
  let detail = '';
  try {
    const e = (await response.json())?.error || {};
    detail = `${e.status || ''} ${e.message || ''}`;
  } catch {
    detail = '';
  }
  // Текст ошибки поставщика не пересылается: в нём его название.
  if (/location is not supported|not available in your (country|region)/i.test(detail)) {
    return new HttpError(502, 'ИИ агент недоступен из региона, где сейчас работает посредник. Повторите позже; если ошибка повторяется — сообщите разработчику.');
  }
  if (/api key|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(detail) || s === 401 || s === 403) {
    return new HttpError(502, 'Посредник: ключ ИИ недействителен. Проверьте ключ.');
  }
  if (s === 429 || /RESOURCE_EXHAUSTED|quota/i.test(detail)) {
    return new HttpError(429, 'Исчерпан лимит запросов ИИ агента (бесплатный лимит в минуту или в день). Повторите позже.');
  }
  if (s === 404) return new HttpError(502, 'Посредник: модель ИИ недоступна. Запустите публикацию посредника ещё раз.');
  if (s === 400 || s === 413) return new HttpError(400, 'ИИ агент не принял запрос: возможно, файл слишком большой или неподдерживаемый.');
  return new HttpError(502, 'ИИ агент временно перегружен. Повторите через минуту.');
}

// Модели по порядку: основная, затем запасные. На бесплатном ключе у каждой
// модели свой лимит запросов, поэтому при «лимит исчерпан» (429) или
// «перегружена» (503) запрос повторяется на следующей модели.
export function geminiModels(env) {
  const list = [env.GEMINI_MODEL, ...String(env.GEMINI_FALLBACK_MODELS || '').split(',')]
    .map((m) => String(m || '').trim().replace(/^models\//, ''))
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [GEMINI_DEFAULT_MODEL];
}

// Запрос к Gemini с переходом на запасные модели. Возвращает { response, model }.
export async function geminiFetch(env, payload, models = geminiModels(env)) {
  let lastError = null;
  for (const model of models) {
    let response;
    try {
      response = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(payload),
      });
    } catch {
      lastError = new HttpError(502, 'ИИ агент недоступен. Повторите позже.');
      continue;
    }
    if (response.ok) return { response, model };
    lastError = await geminiError(response);
    if (![404, 429, 500, 502, 503, 504].includes(response.status) && lastError.status !== 429) throw lastError;
  }
  throw lastError || new HttpError(502, 'ИИ агент недоступен. Повторите позже.');
}

async function callGemini(env, body) {
  // В пределах одного ответа с инструментами используется одна модель
  // (подписи рассуждения действительны только для неё).
  const models = body.pinModel ? [body.pinModel] : geminiModels(env);
  const { response, model } = await geminiFetch(env, toGeminiRequest(body), models);
  return { ...fromGeminiResponse(await response.json()), model };
}

// ---------- Вызов ИИ ----------

async function callModel(env, body) {
  if (providerOf(env) === 'gemini') return callGemini(env, body);
  const { json: _json, pinModel: _pin, ...anthropicBody } = body; // подсказки только для Gemini
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({ model: env.MODEL || 'claude-sonnet-5-5', ...anthropicBody }),
    });
  } catch {
    throw new HttpError(502, 'ИИ агент недоступен. Повторите позже.');
  }
  if (!response.ok) {
    // Текст ошибки поставщика не пересылается: в нём его название. Читается
    // только признак «баланс не пополнен», чтобы дать понятное сообщение.
    const s = response.status;
    let detail = '';
    try {
      detail = String((await response.json())?.error?.message || '');
    } catch {
      detail = '';
    }
    if (/credit balance|billing|purchase credits|insufficient/i.test(detail)) {
      throw new HttpError(402, 'Баланс ИИ агента не пополнен. Приложение работает без ИИ; агент заработает после пополнения.');
    }
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
  if (block.name === 'create_word_document') {
    const blocks = (Array.isArray(input.blocks) ? input.blocks : []).slice(0, 2000);
    if (blocks.length === 0 && !input.title) return null;
    return {
      kind: 'word',
      name: safeName(input.file_name, '.docx'),
      title: String(input.title ?? '').slice(0, 500),
      orientation: input.orientation === 'landscape' ? 'landscape' : 'portrait',
      blocks: blocks.map((b) => ({
        type: String(b?.type || 'paragraph'),
        text: String(b?.text ?? '').slice(0, 50000),
        level: Number(b?.level) || 1,
        bold: !!b?.bold,
        items: (Array.isArray(b?.items) ? b.items : []).slice(0, 1000).map((x) => String(x ?? '').slice(0, 10000)),
        headers: (Array.isArray(b?.headers) ? b.headers : []).slice(0, 30).map((x) => String(x ?? '')),
        rows: (Array.isArray(b?.rows) ? b.rows : []).slice(0, 3000).map((r) => (Array.isArray(r) ? r : [r]).slice(0, 30).map((x) => String(x ?? '').slice(0, 5000))),
      })),
    };
  }
  if (block.name === 'create_text_file') {
    const content = String(input.content ?? '');
    if (!content) return null;
    return { kind: 'text', name: safeName(input.file_name, '.txt'), content: content.slice(0, 500000) };
  }
  return null;
}

// ---------- Фильтр названий ----------
// Инструкция запрещает агенту называть модель, но модель можно «разговорить».
// Поэтому каждый ответ агента и созданные им файлы проходят через фильтр:
// названия моделей и компаний-разработчиков ИИ заменяются. Само слово «Google»
// без связи с разработкой ИИ не трогается (Google Диск, Google Карты).
const L = '(?<![\\p{L}\\d])';
const R = '(?![\\p{L}\\d])';
// Компании-разработчики ИИ. «Google» отдельно не заменяется (Google Диск и т. п.),
// только в связке с разработкой: «разработан Google», «от Google», «Google AI».
const VENDOR = '(?:Google(?:[\\s-]+(?:DeepMind|AI|ИИ|Brain))?|Гугл[а-я]*|Alphabet|Anthropic|Антропик[а-я]*|OpenAI|ОпенЭйАй|DeepMind|Дипмайнд[а-я]*)';
const SCRUB_RULES = [
  // «разработанная Google», «создан компанией Anthropic» → «… для JARVIS».
  [new RegExp(`${L}((?:раз|вы)работ[а-я]*|созда[а-я]*|обуч[а-я]*|сделан[а-я]*|выпущен[а-я]*)\\s+(?:в\\s+)?(?:компани[а-я]+\\s+)?${VENDOR}${R}`, 'giu'), '$1 для JARVIS'],
  [new RegExp(`${L}(developed|trained|created|built|made)\\s+by\\s+${VENDOR}${R}`, 'giu'), '$1 for JARVIS'],
  // «от Google», «от компании Anthropic» → «от команды JARVIS».
  [new RegExp(`${L}от\\s+(?:компании\\s+)?${VENDOR}${R}`, 'giu'), 'от команды JARVIS'],
  [new RegExp(`${L}(?:by|from)\\s+${VENDOR}${R}`, 'giu'), 'from the JARVIS team'],
  // Остальные упоминания разработчиков ИИ (кроме одиночного «Google»).
  [new RegExp(`${L}(?:компани[а-я]+\\s+)?(?:Google[\\s-]+(?:DeepMind|AI|ИИ|Brain)|Alphabet|Anthropic|Антропик[а-я]*|OpenAI|ОпенЭйАй|DeepMind|Дипмайнд[а-я]*)${R}`, 'giu'), 'команда JARVIS'],
  // Названия моделей с версиями: «Gemini 3.6 Flash», «Claude Sonnet 5.5», «GPT-5»…
  [new RegExp(`${L}(?:Gemini|Gemma|Bard|Claude|ChatGPT|GPT|Гемини|Джемини|Джеминай|Гемма|Клод[а-я]*|ЧатГПТ|Бард)(?:[\\s-]*(?:\\d+(?:\\.\\d+)*|Pro|Flash|Lite|Ultra|Nano|Opus|Sonnet|Haiku|Fable|Mythos|Turbo|mini|Про|Флэш|Флеш|Опус|Сонет|Хайку)${R})*`, 'giu'), 'ИИ агент JARVIS'],
  // Идентификаторы моделей: gemini-3.6-flash, claude-sonnet-5-5.
  [/(?:gemini|gemma|claude)-[a-z0-9.-]+/gi, 'ИИ агент JARVIS'],
];

function scrubPlain(text) {
  let out = text;
  for (const [re, to] of SCRUB_RULES) out = out.replace(re, to);
  return out.replace(/ИИ агент JARVIS(?:[\s,]+ИИ агент JARVIS)+/g, 'ИИ агент JARVIS');
}

// Ссылки не меняются: фильтр применяется только к тексту между ними.
export function scrubVendor(text) {
  const s = String(text ?? '');
  const parts = s.split(/(https?:\/\/[^\s<>"«»]+)/g);
  return parts.map((p, i) => (i % 2 ? p : scrubPlain(p))).join('');
}

export function scrubFile(file) {
  if (file.kind === 'table') {
    return { ...file, name: scrubVendor(file.name), headers: file.headers.map(scrubVendor), rows: file.rows.map((r) => r.map(scrubVendor)) };
  }
  if (file.kind === 'text') return { ...file, name: scrubVendor(file.name), content: scrubVendor(file.content) };
  if (file.kind === 'word') {
    return {
      ...file,
      name: scrubVendor(file.name),
      title: scrubVendor(file.title),
      blocks: file.blocks.map((b) => ({
        ...b, text: scrubVendor(b.text), items: b.items.map(scrubVendor), headers: b.headers.map(scrubVendor), rows: b.rows.map((r) => r.map(scrubVendor)),
      })),
    };
  }
  if (file.kind === 'image') return { ...file, name: scrubVendor(file.name) };
  return file;
}

// ---------- Поиск в интернете ----------

// Ссылка-перенаправление поисковой системы → настоящий адрес страницы.
async function resolveLink(url) {
  if (!/^https:\/\/vertexaisearch\.cloud\.google\.com\//.test(url)) return url;
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const loc = r.headers.get('location');
    return loc && /^https?:\/\//.test(loc) ? loc : null;
  } catch {
    return null;
  }
}

async function searchGemini(env, query) {
  const { response } = await geminiFetch(env, {
    contents: [{ role: 'user', parts: [{ text: `Найди в интернете и кратко изложи факты с датами и цифрами: ${query}` }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 6000 },
  });
  const data = await response.json();
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('\n').trim();
  const chunks = (cand?.groundingMetadata?.groundingChunks || []).map((c) => c.web).filter(Boolean).slice(0, MAX_SOURCES);
  const sources = (await Promise.all(chunks.map(async (w) => {
    const url = (await resolveLink(String(w.uri || ''))) || (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(w.title || '') ? `https://${w.title}` : null);
    return url ? { title: String(w.title || url), url } : null;
  }))).filter(Boolean);
  return { text, sources };
}

async function searchAnthropic(env, query) {
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': API_VERSION },
      body: JSON.stringify({
        model: env.MODEL || 'claude-sonnet-5-5',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: `Найди в интернете и кратко изложи факты с датами и цифрами: ${query}` }],
      }),
    });
  } catch {
    throw new HttpError(502, 'Поиск недоступен.');
  }
  if (!response.ok) throw new HttpError(502, 'Поиск недоступен.');
  const data = await response.json();
  const content = Array.isArray(data?.content) ? data.content : [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const sources = content.filter((b) => b.type === 'web_search_tool_result' && Array.isArray(b.content))
    .flatMap((b) => b.content).filter((r) => r?.url).slice(0, MAX_SOURCES).map((r) => ({ title: String(r.title || r.url), url: String(r.url) }));
  return { text, sources };
}

export async function webSearch(env, query) {
  const q = String(query || '').trim().slice(0, 500);
  if (!q) return { text: '', sources: [], error: 'Пустой поисковый запрос.' };
  try {
    const r = providerOf(env) === 'gemini' ? await searchGemini(env, q) : await searchAnthropic(env, q);
    if (!r.text && r.sources.length === 0) return { ...r, error: 'Ничего не найдено.' };
    return r;
  } catch (e) {
    return { text: '', sources: [], error: e instanceof HttpError ? e.message : 'Поиск недоступен.' };
  }
}

// ---------- Изображения ----------

export async function createImage(env, input) {
  const name = safeName(input?.file_name, '.png');
  const prompt = String(input?.prompt || '').trim().slice(0, 4000);
  if (!prompt) return { error: 'Нет описания изображения.' };
  const model = String(env.GEMINI_IMAGE_MODEL || '').replace(/^models\//, '');
  if (providerOf(env) !== 'gemini' || !model) return { error: 'Создание изображений не подключено для текущего ключа ИИ.' };
  const aspect = ['1:1', '4:3', '3:4', '16:9', '9:16'].includes(input?.aspect_ratio) ? input.aspect_ratio : null;
  let response;
  try {
    response = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}) },
      }),
    });
  } catch {
    return { error: 'Сервис изображений недоступен. Повторите позже.' };
  }
  if (!response.ok) {
    const e = await geminiError(response);
    if (e.status === 429) return { error: 'Создание изображений недоступно на бесплатном ключе или исчерпан лимит. Включите оплату в AI Studio или повторите позже.' };
    return { error: e.message };
  }
  const data = await response.json();
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!part) return { error: 'Изображение не создано: запрос отклонён или пуст. Измените описание.' };
  const type = part.inlineData.mimeType || 'image/png';
  const ext = type === 'image/jpeg' ? '.jpg' : type === 'image/webp' ? '.webp' : '.png';
  return { file: { kind: 'image', name: name.replace(/\.png$/, ext), type, data: part.inlineData.data } };
}

// ---------- Переписка ----------

async function runTool(env, use, files, sources) {
  if (use.name === 'web_search') {
    const r = await webSearch(env, use.input?.query);
    sources.push(...r.sources);
    if (r.error) return { content: `Поиск не выполнен: ${r.error}`, is_error: true };
    const list = r.sources.map((x, i) => `${i + 1}. ${x.title} — ${x.url}`).join('\n');
    return { content: `${r.text}\n\nИсточники:\n${list || '(не указаны)'}` };
  }
  if (use.name === 'create_image') {
    const r = await createImage(env, use.input);
    if (r.error) return { content: `Изображение не создано: ${r.error}`, is_error: true };
    files.push(r.file);
    return { content: `Изображение «${r.file.name}» создано и будет приложено к ответу.` };
  }
  const file = fileFromTool(use);
  if (!file) return { content: 'Файл не создан: неверные данные.', is_error: true };
  files.push(file);
  return { content: `Файл «${file.name}» создан и будет приложен к ответу.` };
}

async function handleChat(env, data) {
  const messages = toModelMessages(data?.messages);
  const files = [];
  const texts = [];
  const sources = [];
  let pinModel = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callModel(env, { max_tokens: 16000, system: CHAT_SYSTEM, tools: TOOLS, messages, ...(pinModel ? { pinModel } : {}) });
    if (result.model) pinModel = result.model;
    const t = textOf(result.content);
    if (t) texts.push(t);
    const uses = (result.content || []).filter((b) => b.type === 'tool_use');
    if (result.stop_reason !== 'tool_use' || uses.length === 0) break;
    const toolResults = [];
    for (const u of uses) {
      const r = await runTool(env, u, files, sources);
      toolResults.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'assistant', content: result.content });
    messages.push({ role: 'user', content: toolResults });
  }
  let text = texts.join('\n\n') || (files.length ? 'Готово, файл во вложении.' : 'ИИ агент не дал ответа. Повторите вопрос.');
  // Источники поиска добавляются, если агент не привёл ссылки сам.
  const unique = [...new Map(sources.map((x) => [x.url, x])).values()];
  if (unique.length && !/https?:\/\//.test(text)) {
    text += `\n\nИсточники:\n${unique.map((x, i) => `${i + 1}. ${x.title} — ${x.url}`).join('\n')}`;
  }
  return { text: scrubVendor(text), files: files.map(scrubFile) };
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
    json: true,
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
