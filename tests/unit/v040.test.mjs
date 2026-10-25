// Тесты версии 0.4.0: вложения, ZIP, резервная копия и восстановление.
// Запуск: node --test tests/unit/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, createMemoryAdapter, META_NEXT_NUMBER, META_DRAFTS } from '../../js/core/store.js';
import { createDraft } from '../../js/core/records.js';
import { parseNote } from '../../js/core/parse.js';
import { checkFiles, kindOf, mimeOf, formatSize, cleanFileName, attachmentRefs, MAX_FILE_SIZE, MAX_FILES_PER_MESSAGE } from '../../js/core/attachments.js';
import { createZip, readZip, crc32 } from '../../js/core/zip.js';
import { createBackup, inspectBackup, restoreBackup, BackupError, backupFileName } from '../../js/core/backup.js';
import { NOT_SPECIFIED } from '../../js/core/config.js';

const file = (name, content = 'данные', type = '') => new File([content], name, { type });
const photo = (name = 'фото 1.jpg', n = 3000) => new File([new Uint8Array(n).map((_, i) => i % 251)], name, { type: 'image/jpeg' });

// ---------- Правила вложений ----------
test('вложения: виды файлов по расширению', () => {
  assert.equal(kindOf('IMG_001.JPG'), 'photo');
  assert.equal(kindOf('снимок', 'image/heic'), 'photo');
  assert.equal(kindOf('акт.pdf'), 'pdf');
  assert.equal(kindOf('ведомость.docx'), 'word');
  assert.equal(kindOf('график.xlsx'), 'excel');
  assert.equal(kindOf('программа.exe'), null);
  assert.equal(mimeOf('акт.pdf', ''), 'application/pdf');
  assert.equal(mimeOf('a.xlsx', 'application/octet-stream'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('вложения: проверка файлов — тип, пустой, размер, количество', () => {
  assert.equal(checkFiles([file('a.pdf')]).ok, true);
  assert.match(checkFiles([file('a.exe')]).error, /не поддерживается/);
  assert.match(checkFiles([file('пусто.pdf', '')]).error, /пустой/);
  const big = { name: 'большой.pdf', size: MAX_FILE_SIZE + 1, type: 'application/pdf' };
  assert.match(checkFiles([big]).error, /слишком большой/);
  const many = Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, (_, i) => file(`${i}.pdf`));
  assert.match(checkFiles(many).error, /Не больше/);
  assert.match(checkFiles([file('a.pdf')], MAX_FILES_PER_MESSAGE).error, /Не больше/);
});

test('вложения: имя файла без путей и управляющих символов', () => {
  assert.equal(cleanFileName('C:\\Users\\a\\акт\u0007.pdf'), 'акт.pdf');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName(''), 'файл');
  assert.equal(formatSize(500), '500 Б');
  assert.equal(formatSize(2048), '2 КБ');
  assert.equal(formatSize(3 * 1024 * 1024), '3,0 МБ');
});

test('вложения: повреждённые описания отбрасываются', () => {
  const refs = attachmentRefs([null, { id: '' }, { id: 'a', name: 'x.pdf', size: 5 }, { id: 'a', name: 'дубль.pdf', size: 1 }, { id: 'b', name: 'y.jpg', size: -1 }]);
  assert.deepEqual(refs.map((r) => r.id), ['a']);
});

// ---------- Сохранение вложений ----------
test('сообщение с файлами: файлы сохраняются вместе с сообщением', async () => {
  const store = createStore(createMemoryAdapter());
  const m = await store.addMessage({ role: 'user', source: 'user', text: 'трещина', files: [photo(), file('акт.pdf', '%PDF-1.4')] });
  assert.equal(m.attachments.length, 2);
  assert.equal(m.attachments[0].kind, 'photo');
  const saved = await store.getAttachment(m.attachments[1].id);
  assert.equal(saved.name, 'акт.pdf');
  assert.equal(await saved.blob.text(), '%PDF-1.4');
  const c = await store.counts();
  assert.equal(c.attachments, 2);
  assert.equal(c.attachmentsSize, 3000 + 8);
});

test('сообщение только с файлом (без текста) допускается; совсем пустое — нет', async () => {
  const store = createStore(createMemoryAdapter());
  const m = await store.addMessage({ role: 'user', source: 'user', text: '', files: [photo()] });
  assert.equal(m.text, '');
  await assert.rejects(store.addMessage({ role: 'user', source: 'user', text: '' }));
  await assert.rejects(store.addMessage({ role: 'user', source: 'user', text: 'x', files: [file('a.exe')] }), /не поддерживается/);
  assert.equal((await store.counts()).messages, 1);
});

test('файлы заметки переходят в черновик и в запись реестра', async () => {
  const store = createStore(createMemoryAdapter());
  const m = await store.addMessage({ role: 'user', source: 'user', text: 'Ось 1 — скол', files: [photo()] });
  const draft = createDraft({ fields: parseNote(m.text).fields, sourceText: m.text, sourceMessageId: m.id, attachments: m.attachments });
  await store.saveDrafts([draft]);
  const [restored] = await createStore(createMemoryAdapter()).loadDrafts(); // пустая база — нет черновиков
  assert.equal(restored, undefined);
  const rec = await store.confirmRecord(draft);
  assert.equal(rec.attachments.length, 1);
  assert.equal(rec.attachments[0].id, m.attachments[0].id);
});

test('удаление истории удаляет и файлы', async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  const m = await store.addMessage({ role: 'user', source: 'user', text: 'x', files: [photo()] });
  await store.clearHistory();
  assert.equal(await store.getAttachment(m.attachments[0].id), undefined);
  assert.equal((await adapter.getAll('attachments')).length, 0);
});

// ---------- ZIP ----------
test('ZIP: создание и чтение, кириллица в именах, контрольные суммы', async () => {
  const zip = await createZip([
    { name: 'manifest.json', data: '{"a":1}' },
    { name: 'files/001_фото.jpg', data: new Uint8Array([1, 2, 3, 250]) },
  ]);
  const entries = await readZip(zip);
  assert.deepEqual([...entries.keys()], ['manifest.json', 'files/001_фото.jpg']);
  const bytes = new Uint8Array(await (await entries.get('files/001_фото.jpg').read()).arrayBuffer());
  assert.deepEqual([...bytes], [1, 2, 3, 250]);
  assert.equal(entries.get('manifest.json').crc, crc32(new TextEncoder().encode('{"a":1}')));
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926); // эталон CRC-32
});

test('ZIP: не архив и обрезанный архив — понятная ошибка', async () => {
  await assert.rejects(readZip(new Blob(['просто текст, а не архив, достаточно длинный'])), /не ZIP|не является/);
  const zip = await createZip([{ name: 'a.txt', data: 'x'.repeat(100) }]);
  await assert.rejects(readZip(zip.slice(0, zip.size - 10)), /не ZIP|не является|повреждён/);
});

// ---------- Резервная копия ----------
async function filledStore() {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter, () => new Date(Date.UTC(2026, 9, 25, 4, 0, 0)));
  const m1 = await store.addMessage({ role: 'user', source: 'user', text: 'Ось 3/Б — раковины', files: [photo('IMG_1.jpg'), file('акт.pdf', '%PDF')] });
  await store.addMessage({ role: 'assistant', source: 'demo', text: 'ответ' });
  const d1 = createDraft({ fields: parseNote(m1.text).fields, sourceText: m1.text, sourceMessageId: m1.id, attachments: m1.attachments });
  const d2 = createDraft({ fields: parseNote('Пом. 2.15: трещина').fields, sourceText: 'Пом. 2.15: трещина', sourceMessageId: m1.id });
  const d3 = createDraft({ fields: parseNote('Ось 5 — мусор').fields, sourceText: 'Ось 5 — мусор', sourceMessageId: m1.id });
  await store.saveDrafts([d1, d2, d3]);
  await store.confirmRecord(d1);
  const r2 = await store.confirmRecord(d2);
  await store.deleteRecord(r2.id); // счётчик номеров ушёл вперёд: следующий № 3
  await store.updateRecord((await store.listRecords())[0].id, { status: 'устранено' });
  await store.setMeta('lastScreen', 'registry');
  return { store, adapter };
}

test('резервная копия → восстановление на «новом телефоне»: всё на месте', async () => {
  const { store } = await filledStore();
  const { blob, summary } = await createBackup(store, new Date(Date.UTC(2026, 9, 25, 5, 0, 0)));
  assert.deepEqual([summary.messages, summary.records, summary.drafts, summary.attachments], [2, 1, 1, 2]);

  const inspected = await inspectBackup(blob);
  const fresh = createStore(createMemoryAdapter());
  await restoreBackup(fresh, inspected);

  const [msgs, recs, drafts] = await Promise.all([fresh.listMessages(), fresh.listRecords(), fresh.loadDrafts()]);
  assert.deepEqual(msgs.map((m) => m.text), ['Ось 3/Б — раковины', 'ответ']);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].number, 1);
  assert.equal(recs[0].status, 'устранено');
  assert.equal(recs[0].sourceText, 'Ось 3/Б — раковины');
  assert.equal(recs[0].attachments.length, 2);
  assert.equal(drafts.length, 1);
  const pdf = await fresh.getAttachment(msgs[0].attachments[1].id);
  assert.equal(await pdf.blob.text(), '%PDF');
  const img = await fresh.getAttachment(msgs[0].attachments[0].id);
  assert.equal(img.blob.size, 3000);
  assert.equal(await fresh.getMeta('lastScreen'), 'registry');
  // Нумерация продолжается с того же места: № 2 был удалён и не повторяется.
  const next = await fresh.confirmRecord(drafts[0]);
  assert.equal(next.number, 3);
});

test('восстановление заменяет текущие данные полностью', async () => {
  const { store } = await filledStore();
  const { blob } = await createBackup(store);
  const other = createStore(createMemoryAdapter());
  await other.addMessage({ role: 'user', source: 'user', text: 'чужое', files: [photo('чужое.jpg')] });
  await restoreBackup(other, await inspectBackup(blob));
  const texts = (await other.listMessages()).map((m) => m.text);
  assert.ok(!texts.includes('чужое'));
  assert.equal((await other.counts()).attachments, 2);
});

test('копия пустого телефона создаётся и восстанавливается', async () => {
  const store = createStore(createMemoryAdapter());
  const { blob, summary } = await createBackup(store);
  assert.equal(summary.messages, 0);
  const inspected = await inspectBackup(blob);
  assert.equal(inspected.summary.records, 0);
});

test('некорректные файлы копии: понятная ошибка, данные на телефоне не меняются', async () => {
  const { store } = await filledStore();
  const { blob } = await createBackup(store);
  const target = createStore(createMemoryAdapter());
  await target.addMessage({ role: 'user', source: 'user', text: 'моё' });

  const bad = [
    ['не архив', new Blob(['это обычный текстовый файл, не резервная копия'])],
    ['чужой ZIP', await createZip([{ name: 'readme.txt', data: 'hello' }])],
    ['не JSON', await createZip([{ name: 'manifest.json', data: '{не json' }])],
    ['чужой формат', await createZip([{ name: 'manifest.json', data: JSON.stringify({ format: 'other' }) }])],
    ['новая версия', await createZip([{ name: 'manifest.json', data: JSON.stringify({ format: 'jarvis-mobile-backup', formatVersion: 99 }) }])],
    ['обрезанный', blob.slice(0, Math.floor(blob.size / 2))],
  ];
  for (const [name, b] of bad) {
    await assert.rejects(inspectBackup(b), BackupError, name);
  }
  assert.deepEqual((await target.listMessages()).map((m) => m.text), ['моё']);
});

async function tamper(blob, change) {
  const entries = await readZip(blob);
  const manifest = JSON.parse(await (await entries.get('manifest.json').read()).text());
  const files = [];
  for (const [name, e] of entries) if (name !== 'manifest.json') files.push({ name, data: await e.read() });
  const out = change(manifest, files) || files;
  return createZip([{ name: 'manifest.json', data: JSON.stringify(manifest) }, ...out]);
}

test('подделанная копия отклоняется: повтор номера, нет исходного текста, нет файла, испорчен файл', async () => {
  const { store } = await filledStore();
  const { blob } = await createBackup(store);
  const cases = {
    'повтор номера': (m) => { m.records.push({ ...m.records[0], id: 'другой' }); },
    'дробный номер': (m) => { m.records[0].number = 1.5; },
    'нет исходного текста': (m) => { m.records[0].sourceText = ' '; },
    'поле не текст': (m) => { m.records[0].status = 5; },
    'неизвестная роль': (m) => { m.messages[0].role = 'admin'; },
    'нет файла': (m, files) => files.slice(1),
    'испорчен файл': (m, files) => [{ name: files[0].name, data: new Blob([new Uint8Array(3000)]) }, ...files.slice(1)],
    'ссылка на несуществующий файл': (m) => { m.records[0].attachments.push({ id: 'нет', name: 'x.jpg', size: 1 }); },
  };
  for (const [name, change] of Object.entries(cases)) {
    await assert.rejects(inspectBackup(await tamper(blob, change)), BackupError, name);
  }
});

test('копия без поля статуса: при восстановлении — «Не указано»; счётчик номеров не меньше наибольшего', async () => {
  const { store } = await filledStore();
  const { blob } = await createBackup(store);
  const fixed = await tamper(blob, (m) => {
    delete m.records[0].status;
    m.meta = m.meta.filter((x) => x.id !== META_NEXT_NUMBER);
    m.records[0].number = 7;
  });
  const inspected = await inspectBackup(fixed);
  assert.equal(inspected.data.records[0].status, NOT_SPECIFIED);
  assert.equal(inspected.data.meta.find((x) => x.id === META_NEXT_NUMBER).value, 8);
  assert.ok(inspected.data.meta.some((x) => x.id === META_DRAFTS));
});

test('имя файла копии содержит дату и время', () => {
  assert.equal(backupFileName(new Date(2026, 9, 25, 9, 5)), 'jarvis-backup-2026-10-25_09-05.zip');
});

// ---------- Видео ----------
import { crc32Blob } from '../../js/core/zip.js';
import { MAX_VIDEO_SIZE } from '../../js/core/attachments.js';

test('видео: виды, MIME, отдельный лимит 300 МБ', () => {
  assert.equal(kindOf('обход.MP4'), 'video');
  assert.equal(kindOf('clip', 'video/3gpp'), 'video');
  assert.equal(mimeOf('a.mov'), 'video/quicktime');
  assert.equal(checkFiles([{ name: 'обход.mp4', size: 200 * 1024 * 1024, type: 'video/mp4' }]).ok, true);
  assert.match(checkFiles([{ name: 'обход.mp4', size: MAX_VIDEO_SIZE + 1, type: 'video/mp4' }]).error, /300,0 МБ/);
  assert.match(checkFiles([{ name: 'фото.jpg', size: 30 * 1024 * 1024 }]).error, /слишком большой/);
});

test('CRC по частям совпадает с CRC целиком', async () => {
  const data = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 31) % 256);
  assert.equal(await crc32Blob(new Blob([data]), 1024 * 1024), crc32(data));
  assert.equal(await crc32Blob(new Blob([])), 0);
});

test('копия с видео: файл в архиве совпадает байт в байт', async () => {
  const video = new File([new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 199)], 'обход.mp4', { type: 'video/mp4' });
  const store = createStore(createMemoryAdapter());
  const m = await store.addMessage({ role: 'user', source: 'user', text: 'видео обхода', files: [video] });
  assert.equal(m.attachments[0].kind, 'video');
  const { blob } = await createBackup(store);
  const fresh = createStore(createMemoryAdapter());
  await restoreBackup(fresh, await inspectBackup(blob));
  const got = await fresh.getAttachment(m.attachments[0].id);
  assert.equal(got.type, 'video/mp4');
  assert.equal(await crc32Blob(got.blob), await crc32Blob(video));
  assert.equal(got.blob.size, video.size);
});

// ---------- Восстановление по шагам (исправление для Android WebView) ----------
test('сбой при восстановлении: добавленные файлы удаляются, прежние данные целы', async () => {
  const { store: source } = await filledStore();
  const { blob } = await createBackup(source);
  const inspected = await inspectBackup(blob);

  const adapter = createMemoryAdapter();
  const target = createStore(adapter);
  const mine = await target.addMessage({ role: 'user', source: 'user', text: 'моё', files: [photo('моё.jpg')] });
  const realCommit = adapter.commit;
  adapter.commit = async (ops) => {
    if (ops.some((o) => o.store === 'messages' && o.type === 'clear')) throw new Error('сбой записи');
    return realCommit(ops);
  };
  await assert.rejects(restoreBackup(target, inspected), /сбой записи/);
  adapter.commit = realCommit;
  assert.deepEqual((await target.listMessages()).map((m) => m.text), ['моё']);
  assert.deepEqual(await target.attachmentIds(), [mine.attachments[0].id], 'временные файлы удалены');
});

test('восстановление: лишние файлы удаляются, файлы копии записываются', async () => {
  const { store: source } = await filledStore();
  const { blob } = await createBackup(source);
  const target = createStore(createMemoryAdapter());
  await target.addMessage({ role: 'user', source: 'user', text: 'чужое', files: [photo('чужое.jpg')] });
  await restoreBackup(target, await inspectBackup(blob));
  const ids = await target.attachmentIds();
  const expected = (await source.listMessages()).flatMap((m) => (m.attachments || []).map((a) => a.id));
  assert.deepEqual(ids.sort(), expected.sort());
  // Повторное восстановление той же копии поверх — без ошибок и дублей.
  await restoreBackup(target, await inspectBackup(blob));
  assert.equal((await target.attachmentIds()).length, expected.length);
});
