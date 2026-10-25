// Тесты версии 0.4.2: «Поделиться».
import test from 'node:test';
import assert from 'node:assert/strict';

import { messageShare, recordShare, registryShare, SHARE_TARGETS, targetLabel } from '../../js/core/share.js';
import { shareViaBridge, supportsShare } from '../../js/core/platform.js';
import { NOT_SPECIFIED } from '../../js/core/config.js';

test('варианты: Telegram, WhatsApp, MAX, Почта, Другое', () => {
  assert.deepEqual(SHARE_TARGETS.map((t) => t.id), ['telegram', 'whatsapp', 'max', 'email', 'other']);
  assert.equal(targetLabel('max'), 'MAX');
});

test('запись реестра: читаемый текст без пустых полей и без «Не указано»', () => {
  const s = recordShare({
    number: 7, date: '23.10.2026', object: 'корпус 7', location: 'Ось 3/Б', workType: NOT_SPECIFIED,
    description: 'трещина', requirement: '', responsible: 'ООО «Альфа»', deadline: NOT_SPECIFIED, status: 'устранено',
    sourceText: 'исходник', attachments: [{ id: 'a', name: 'фото.jpg', size: 1 }],
  });
  assert.equal(s.subject, 'JARVIS: замечание № 7');
  assert.equal(s.text, ['Замечание № 7', 'Дата: 23.10.2026', 'Объект / здание: корпус 7', 'Место (ось, отметка, помещение): Ось 3/Б',
    'Описание замечания: трещина', 'Ответственная организация: ООО «Альфа»', 'Статус: устранено', 'Файлы: фото.jpg'].join('\n'));
  assert.equal(s.attachments.length, 1);
});

test('сообщение: текст, а без текста — список файлов', () => {
  assert.equal(messageShare({ text: 'привет' }).text, 'привет');
  assert.equal(messageShare({ text: '', attachments: [{ id: 'a', name: 'акт.pdf', size: 3 }] }).text, 'Файлы: акт.pdf');
  assert.match(registryShare(5).text, /записей: 5/);
});

test('мост Android: файлы передаются частями, запрос — JSON', async () => {
  const chunks = {};
  let request;
  const bridge = {
    writeChunk(token, b64, first) { chunks[token] = (first ? '' : chunks[token] || '') + atob(b64); return true; },
    shareChunked(json) { request = JSON.parse(json); return 'ok'; },
  };
  assert.equal(supportsShare(bridge), true);
  const blob = new Blob([new Uint8Array(700 * 1024).map((_, i) => i % 256)]);
  const r = await shareViaBridge(bridge, { target: 'telegram', subject: 'S', text: 'T', files: [{ blob, name: 'фото.jpg', type: 'image/jpeg' }] });
  assert.deepEqual(r, { status: 'shared' });
  assert.equal(request.target, 'telegram');
  assert.equal(request.files[0].name, 'фото.jpg');
  assert.equal(chunks[request.files[0].token].length, 700 * 1024);
});

test('мост Android: ошибка приложения доходит до пользователя', async () => {
  const bridge = { writeChunk: () => true, shareChunked: () => 'MAX не установлен на телефоне.' };
  assert.deepEqual(await shareViaBridge(bridge, { target: 'max', text: 'x' }), { status: 'error', message: 'MAX не установлен на телефоне.' });
});
