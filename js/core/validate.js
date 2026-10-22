import { MAX_MESSAGE_LENGTH } from './config.js';

// Управляющие символы, кроме перевода строки и табуляции.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Проверяет текст сообщения перед сохранением.
// Возвращает { ok: true, value } или { ok: false, error } с понятным текстом.
export function validateMessage(input) {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Сообщение должно быть текстом.' };
  }
  const value = input.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  if (value.length === 0) {
    return { ok: false, error: 'Введите текст сообщения.' };
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: `Сообщение слишком длинное: ${value.length} символов. Максимум — ${MAX_MESSAGE_LENGTH}.`,
    };
  }
  return { ok: true, value };
}
