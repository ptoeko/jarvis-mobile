// Черновики и проверка полей записи реестра.
import { NOT_SPECIFIED, MAX_FIELD_LENGTH, EDITABLE_FIELDS, REGISTRY_FIELDS } from './config.js';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TITLES = Object.fromEntries(REGISTRY_FIELDS.map((f) => [f.key, f.title]));

// Приводит значение поля к виду для хранения: текст, без управляющих символов,
// без пробелов по краям. Пустое значение становится «Не указано».
export function normalizeFieldValue(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .trim();
  return text === '' ? NOT_SPECIFIED : text;
}

// Проверяет редактируемые поля. Возвращает { ok, value } или { ok: false, errors }.
// Неизвестные и нередактируемые ключи (номер, исходный текст) отклоняются.
export function validateFields(input) {
  const errors = {};
  const value = {};
  for (const key of Object.keys(input)) {
    if (!EDITABLE_FIELDS.includes(key)) {
      errors[key] = `Поле «${TITLES[key] || key}» нельзя изменить.`;
    }
  }
  for (const key of EDITABLE_FIELDS) {
    if (!(key in input)) continue;
    const v = normalizeFieldValue(input[key]);
    if (v.length > MAX_FIELD_LENGTH) {
      errors[key] = `Поле «${TITLES[key]}» слишком длинное: ${v.length} символов. Максимум — ${MAX_FIELD_LENGTH}.`;
    }
    value[key] = v;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

let draftCounter = 0;

function newDraftId() {
  const rnd = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `draft-${Date.now().toString(36)}-${++draftCounter}-${rnd}`;
}

// Черновик: ждёт проверки человеком; в реестр попадает только после подтверждения.
export function createDraft({ fields, sourceText, sourceMessageId = null }) {
  const draft = { draftId: newDraftId(), sourceText, sourceMessageId };
  for (const key of EDITABLE_FIELDS) draft[key] = normalizeFieldValue(fields?.[key]);
  return draft;
}

// Восстанавливает черновик, прочитанный из базы. Возвращает null, если данные
// повреждены (нет исходного текста или идентификатора). Поля приводятся к тексту;
// слишком длинные значения не обрезаются — их покажет проверка при подтверждении.
export function restoreDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.draftId !== 'string' || raw.draftId === '') return null;
  if (typeof raw.sourceText !== 'string' || raw.sourceText.trim() === '') return null;
  const draft = {
    draftId: raw.draftId,
    sourceText: raw.sourceText,
    sourceMessageId: typeof raw.sourceMessageId === 'string' ? raw.sourceMessageId : null,
  };
  for (const key of EDITABLE_FIELDS) {
    const v = raw[key];
    draft[key] = typeof v === 'string' ? (v.trim() === '' ? NOT_SPECIFIED : v) : normalizeFieldValue(v);
  }
  return draft;
}
