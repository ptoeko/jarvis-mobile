// Резервная копия всех данных JARVIS и восстановление из неё.
//
// Файл — ZIP без сжатия:
//   manifest.json   — сообщения, записи реестра, черновики, служебные данные
//                     и список вложений с размером и контрольной суммой;
//   files/…         — сами файлы вложений (фото, Word, PDF, Excel).
// Перед восстановлением файл проверяется целиком. Восстановление заменяет
// данные на телефоне одной транзакцией: при сбое остаются прежние данные.

import { REGISTRY_FIELDS, EDITABLE_FIELDS, NOT_SPECIFIED, APP_VERSION } from './config.js';
import { ROLES, SOURCES, META_NEXT_NUMBER, META_DRAFTS } from './store.js';
import { restoreDraft } from './records.js';
import { attachmentRefs, cleanFileName, mimeOf, formatSize } from './attachments.js';
import { createZip, readZip, crc32Blob, ZipError } from './zip.js';
import { META_AI_URL, META_AI_CODE } from './ai.js';

// Настройки ИИ агента (адрес и код доступа) в копию не попадают: копию могут
// переслать, а код доступа — секрет. При восстановлении остаются текущие.
const LOCAL_ONLY_META = new Set([META_AI_URL, META_AI_CODE]);

export const BACKUP_FORMAT = 'jarvis-mobile-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const META_LAST_BACKUP = 'lastBackupAt';

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

export function backupFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `jarvis-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}.zip`;
}

function safeEntryName(index, name) {
  const clean = cleanFileName(name).replace(/[<>:"|?*]/g, '_');
  return `files/${String(index + 1).padStart(3, '0')}_${clean}`;
}

// Собирает резервную копию. Файлы вложений читаются по одному.
// Возвращает { blob, summary }.
export async function createBackup(store, now = new Date()) {
  const snap = await store.snapshot();
  const files = [];
  const attachments = [];
  const seen = new Set();
  for (const message of snap.messages) {
    for (const ref of attachmentRefs(message.attachments)) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const item = await store.getAttachment(ref.id);
      if (!item || !item.blob) throw new BackupError(`Файл «${ref.name}» не найден в памяти телефона. Копия не создана.`);
      // Файл не копируется в память целиком: CRC по частям, в архив — сам Blob.
      const crc = await crc32Blob(item.blob);
      const path = safeEntryName(attachments.length, item.name);
      attachments.push({
        id: item.id, name: item.name, type: item.type, size: item.blob.size,
        messageId: item.messageId ?? message.id, createdAt: item.createdAt ?? message.createdAt,
        path, crc,
      });
      files.push({ name: path, data: item.blob, crc, date: now });
    }
  }
  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    createdAt: now.toISOString(),
    counts: { messages: snap.messages.length, records: snap.records.length, attachments: attachments.length },
    messages: snap.messages,
    records: snap.records,
    meta: snap.meta.filter((m) => m.id !== META_LAST_BACKUP && !LOCAL_ONLY_META.has(m.id)),
    attachments,
  };
  const blob = await createZip([
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 1), date: now },
    ...files,
  ]);
  return { blob, summary: summarize(manifest) };
}

function summarize(manifest) {
  const size = manifest.attachments.reduce((n, a) => n + a.size, 0);
  return {
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    messages: manifest.messages.length,
    records: manifest.records.length,
    drafts: (manifest.meta.find((m) => m.id === META_DRAFTS)?.value || []).length,
    attachments: manifest.attachments.length,
    attachmentsSize: size,
    attachmentsSizeText: formatSize(size),
  };
}

const isStr = (v) => typeof v === 'string';
const isTime = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

function fail(message) {
  throw new BackupError(message);
}

// Проверяет файл копии полностью (включая контрольные суммы файлов).
// Возвращает { summary, data } — data передаётся в restoreBackup.
export async function inspectBackup(blob) {
  let entries;
  try {
    entries = await readZip(blob);
  } catch (e) {
    if (e instanceof ZipError) throw new BackupError(e.message);
    throw e;
  }
  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry) fail('Это не резервная копия JARVIS: в архиве нет manifest.json.');
  let manifest;
  try {
    manifest = JSON.parse(await (await manifestEntry.read()).text());
  } catch {
    fail('Резервная копия повреждена: manifest.json не читается.');
  }
  if (!manifest || manifest.format !== BACKUP_FORMAT) fail('Это не резервная копия JARVIS.');
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    fail('Копия создана более новой версией JARVIS. Обновите приложение и повторите.');
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) fail('Неизвестная версия формата резервной копии.');
  for (const key of ['messages', 'records', 'meta', 'attachments']) {
    if (!Array.isArray(manifest[key])) fail(`Резервная копия повреждена: нет раздела «${key}».`);
  }

  // Вложения: каждый файл есть в архиве, размер и контрольная сумма совпадают.
  const attachments = [];
  const attachmentIds = new Set();
  for (const a of manifest.attachments) {
    if (!a || !isStr(a.id) || !a.id || attachmentIds.has(a.id) || !isStr(a.path)) fail('Резервная копия повреждена: неверный список вложений.');
    const entry = entries.get(a.path);
    if (!entry) fail(`В копии нет файла «${a.name}».`);
    if (entry.size !== a.size || entry.crc !== a.crc) fail(`Файл «${a.name}» в копии повреждён.`);
    const blobPart = await entry.read();
    if (await crc32Blob(blobPart) !== a.crc) fail(`Файл «${a.name}» в копии повреждён (контрольная сумма).`);
    const name = cleanFileName(a.name);
    const type = mimeOf(name, a.type);
    attachmentIds.add(a.id);
    attachments.push({
      id: a.id, name, type, size: a.size,
      blob: new Blob([blobPart], { type }),
      messageId: isStr(a.messageId) ? a.messageId : null,
      createdAt: isTime(a.createdAt) ? a.createdAt : manifest.createdAt,
    });
  }
  const checkRefs = (list, where) => {
    const refs = attachmentRefs(list);
    for (const r of refs) if (!attachmentIds.has(r.id)) fail(`Резервная копия повреждена: ${where} ссылается на отсутствующий файл «${r.name}».`);
    return refs;
  };

  // Сообщения.
  const messageIds = new Set();
  const messages = manifest.messages.map((m, i) => {
    if (!m || !isStr(m.id) || !m.id || messageIds.has(m.id)) fail(`Резервная копия повреждена: сообщение № ${i + 1}.`);
    if (!ROLES.has(m.role) || !SOURCES.has(m.source) || !isStr(m.text) || !isTime(m.createdAt)) fail(`Резервная копия повреждена: сообщение № ${i + 1}.`);
    messageIds.add(m.id);
    const out = { id: m.id, role: m.role, source: m.source, text: m.text, createdAt: m.createdAt };
    const refs = checkRefs(m.attachments, `сообщение № ${i + 1}`);
    if (refs.length) out.attachments = refs;
    if (!out.text && !refs.length) fail(`Резервная копия повреждена: пустое сообщение № ${i + 1}.`);
    return out;
  });

  // Записи реестра: номера целые, положительные, без повторов; исходный текст есть.
  const recordIds = new Set();
  const numbers = new Set();
  const records = manifest.records.map((r, i) => {
    const where = `запись № ${r?.number ?? i + 1}`;
    if (!r || !isStr(r.id) || !r.id || recordIds.has(r.id)) fail(`Резервная копия повреждена: ${where}.`);
    if (!Number.isInteger(r.number) || r.number < 1 || numbers.has(r.number)) fail(`Резервная копия повреждена: неверный номер (${where}).`);
    if (!isStr(r.sourceText) || r.sourceText.trim() === '') fail(`Резервная копия повреждена: нет исходного текста (${where}).`);
    recordIds.add(r.id);
    numbers.add(r.number);
    const out = { id: r.id, number: r.number };
    for (const key of EDITABLE_FIELDS) {
      const v = r[key];
      if (v !== undefined && v !== null && !isStr(v)) fail(`Резервная копия повреждена: поле «${key}» (${where}).`);
      out[key] = isStr(v) && v.trim() !== '' ? v : NOT_SPECIFIED;
    }
    out.sourceText = r.sourceText;
    out.sourceMessageId = isStr(r.sourceMessageId) ? r.sourceMessageId : null;
    out.attachments = checkRefs(r.attachments, where);
    out.createdAt = isTime(r.createdAt) ? r.createdAt : manifest.createdAt;
    out.updatedAt = isTime(r.updatedAt) ? r.updatedAt : out.createdAt;
    return out;
  });
  if (REGISTRY_FIELDS.length !== EDITABLE_FIELDS.length + 2) fail('Внутренняя ошибка схемы реестра.');

  // Служебные данные: счётчик номеров не меньше наибольшего номера + 1,
  // черновики проверяются так же, как при запуске приложения.
  const meta = [];
  const maxNumber = records.reduce((m, r) => Math.max(m, r.number), 0);
  let nextNumber = maxNumber + 1;
  for (const m of manifest.meta) {
    if (!m || !isStr(m.id) || !m.id) continue;
    if (m.id === META_NEXT_NUMBER) {
      if (Number.isInteger(m.value) && m.value > nextNumber) nextNumber = m.value;
      continue;
    }
    if (m.id === META_DRAFTS) {
      const drafts = (Array.isArray(m.value) ? m.value : []).map(restoreDraft).filter(Boolean);
      for (const d of drafts) checkRefs(d.attachments, 'черновик');
      meta.push({ id: META_DRAFTS, value: drafts });
      continue;
    }
    if (m.id === META_LAST_BACKUP || LOCAL_ONLY_META.has(m.id)) continue;
    meta.push({ id: m.id, value: m.value });
  }
  meta.push({ id: META_NEXT_NUMBER, value: nextNumber });

  const data = { messages, records, meta, attachments };
  const summary = summarize({ ...manifest, messages, records, meta, attachments });
  return { summary, data };
}

// Заменяет все данные на телефоне данными из проверенной копии.
//
// Шаг 1: файлы копируются в базу по одному. Каждый файл сначала читается в
// память: Android WebView не может записать в базу часть файла, выбранного
// в окне выбора (ошибка «Failed to write blobs»). По одному — чтобы большие
// видео не занимали память все сразу. Файл с тем же идентификатором уже есть
// на телефоне — он не перезаписывается (идентификатор файла не меняется).
// Шаг 2: одна транзакция заменяет сообщения, записи, черновики и удаляет
// файлы, которых нет в копии.
// При сбое на шаге 1 или 2 добавленные файлы удаляются, прежние данные целы.
export async function restoreBackup(store, inspected) {
  const { data } = inspected;
  const before = new Set(await store.attachmentIds());
  const added = [];
  try {
    for (const a of data.attachments) {
      if (before.has(a.id)) continue;
      const blob = new Blob([await a.blob.arrayBuffer()], { type: a.type });
      if (blob.size !== a.size) throw new BackupError(`Файл «${a.name}» прочитан не полностью.`);
      await store.putAttachment({ ...a, blob });
      added.push(a.id);
    }
    const keep = [];
    for (const id of LOCAL_ONLY_META) {
      const value = await store.getMeta(id);
      if (value !== undefined) keep.push({ id, value });
    }
    await store.replaceAll({
      messages: data.messages,
      records: data.records,
      meta: [...data.meta, ...keep],
      keepAttachmentIds: data.attachments.map((a) => a.id),
    });
  } catch (error) {
    await store.deleteAttachments(added).catch(() => {});
    throw error;
  }
  return inspected.summary;
}
