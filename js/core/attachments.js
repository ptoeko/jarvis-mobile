// Вложения к сообщениям: фото, видео, Word, PDF, Excel. Файлы хранятся только на
// телефоне (IndexedDB, хранилище attachments). Без ИИ содержимое файлов не
// читается и не анализируется — файл хранится при заметке и открывается
// приложениями телефона.

export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 МБ — фото и документы
export const MAX_VIDEO_SIZE = 300 * 1024 * 1024; // 300 МБ — видео (около 2–3 минут Full HD)
export const MAX_FILES_PER_MESSAGE = 10;

// Типы по расширению. MIME-тип от телефона бывает пустым или общим
// (application/octet-stream), поэтому главный признак — расширение.
const KINDS = {
  photo: { label: 'Фото', ext: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp'] },
  video: { label: 'Видео', ext: ['mp4', 'mov', '3gp', 'webm', 'mkv', 'm4v', 'avi'] },
  pdf: { label: 'PDF', ext: ['pdf'] },
  word: { label: 'Word', ext: ['doc', 'docx', 'rtf', 'odt'] },
  excel: { label: 'Excel', ext: ['xls', 'xlsx', 'xlsm', 'csv', 'ods'] },
};

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm',
  mkv: 'video/x-matroska', m4v: 'video/x-m4v', avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  csv: 'text/csv', ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

// Значение атрибута accept для выбора файла.
export const ACCEPT = ['image/*', 'video/*', ...Object.values(KINDS).flatMap((k) => k.ext.map((e) => `.${e}`))].join(',');

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

export function kindOf(name, type = '') {
  const ext = extensionOf(name);
  for (const [kind, def] of Object.entries(KINDS)) {
    if (def.ext.includes(ext)) return kind;
  }
  if (String(type).startsWith('image/')) return 'photo';
  if (String(type).startsWith('video/')) return 'video';
  return null;
}

export function kindLabel(kind) {
  return KINDS[kind]?.label || 'Файл';
}

// MIME-тип для открытия файла приложениями телефона.
export function mimeOf(name, type = '') {
  const ext = extensionOf(name);
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (type && type !== 'application/octet-stream') return type;
  return 'application/octet-stream';
}

export function maxSizeFor(kind) {
  return kind === 'video' ? MAX_VIDEO_SIZE : MAX_FILE_SIZE;
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

// Имя файла без управляющих символов и путей; пустое — «файл».
export function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  return (base || 'файл').slice(0, 200);
}

// Проверяет выбранные файлы (File/Blob с полем name). Возвращает
// { ok: true, files } или { ok: false, error } с понятным текстом.
export function checkFiles(files, alreadyAttached = 0) {
  const list = [...(files || [])];
  if (list.length === 0) return { ok: false, error: 'Файлы не выбраны.' };
  if (alreadyAttached + list.length > MAX_FILES_PER_MESSAGE) {
    return { ok: false, error: `Не больше ${MAX_FILES_PER_MESSAGE} файлов в одном сообщении.` };
  }
  for (const f of list) {
    const name = cleanFileName(f.name);
    const kind = kindOf(name, f.type);
    if (!kind) {
      return { ok: false, error: `Файл «${name}» не поддерживается. Можно прикрепить фото, видео, Word, PDF или Excel.` };
    }
    if (!f.size) return { ok: false, error: `Файл «${name}» пустой.` };
    if (f.size > maxSizeFor(kind)) {
      return { ok: false, error: `Файл «${name}» слишком большой: ${formatSize(f.size)}. Максимум для ${kind === 'video' ? 'видео' : 'этого типа'} — ${formatSize(maxSizeFor(kind))}.` };
    }
  }
  return { ok: true, files: list };
}

// Описание вложения, которое хранится в сообщении, черновике и записи
// (без самого файла). Возвращает null, если описание повреждено.
export function attachmentRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  const name = cleanFileName(raw.name);
  const size = Number(raw.size);
  if (!Number.isFinite(size) || size < 0) return null;
  return { id: raw.id, name, type: mimeOf(name, raw.type), size, kind: kindOf(name, raw.type) || 'other' };
}

export function attachmentRefs(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const ref = attachmentRef(item);
    if (ref && !seen.has(ref.id)) {
      seen.add(ref.id);
      out.push(ref);
    }
  }
  return out;
}
