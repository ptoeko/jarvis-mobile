// «Поделиться»: отправка сообщения, записи реестра или файла Excel в
// Telegram, WhatsApp, MAX, на почту или в любое другое приложение телефона.
// Здесь — только подготовка текста; отправку выполняет оболочка Android
// (MainActivity.shareChunked) или браузер (Web Share API).

import { REGISTRY_FIELDS, NOT_SPECIFIED } from './config.js';
import { attachmentRefs } from './attachments.js';

export const SHARE_TARGETS = [
  { id: 'telegram', label: 'Telegram' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'max', label: 'MAX' },
  { id: 'email', label: 'Почта' },
  { id: 'other', label: 'Другое приложение' },
];

export function targetLabel(id) {
  return SHARE_TARGETS.find((t) => t.id === id)?.label || 'приложение';
}

// Сообщение диалога: его текст и, если есть, список файлов.
export function messageShare(message) {
  const refs = attachmentRefs(message.attachments);
  return {
    subject: 'JARVIS: сообщение',
    text: message.text || (refs.length ? `Файлы: ${refs.map((r) => r.name).join(', ')}` : ''),
    attachments: refs,
  };
}

// Запись реестра — в читаемом виде: «Поле: значение», пустые поля пропускаются.
export function recordShare(record) {
  const lines = [`Замечание № ${record.number}`];
  for (const f of REGISTRY_FIELDS) {
    if (f.key === 'number' || f.key === 'sourceText') continue;
    const v = record[f.key];
    if (v === undefined || v === null || v === '' || v === NOT_SPECIFIED) continue;
    lines.push(`${f.title}: ${v}`);
  }
  const refs = attachmentRefs(record.attachments);
  if (refs.length) lines.push(`Файлы: ${refs.map((r) => r.name).join(', ')}`);
  return { subject: `JARVIS: замечание № ${record.number}`, text: lines.join('\n'), attachments: refs };
}

// Файл Excel с реестром.
export function registryShare(count) {
  return { subject: 'JARVIS: реестр замечаний', text: `Реестр замечаний JARVIS, записей: ${count}.`, attachments: [] };
}
