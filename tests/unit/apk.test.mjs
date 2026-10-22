// Тесты режима APK: определение варианта, мост сохранения файла, статус.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectPlatform, installSaveCallback, saveViaBridge } from '../../js/core/platform.js';
import { computeFeatures } from '../../js/core/status.js';
import { APP_VERSION } from '../../js/core/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('без моста — веб-приложение, с мостом — APK', () => {
  assert.equal(detectPlatform({}).kind, 'web');
  assert.equal(detectPlatform({ JarvisAndroid: {} }).kind, 'web', 'мост без saveTextFile не считается');
  assert.equal(detectPlatform({ JarvisAndroid: { saveTextFile() {} } }).kind, 'apk');
});

function fakeWindow(status) {
  const win = { calls: [] };
  win.JarvisAndroid = {
    saveTextFile(name, mime, content, id) {
      win.calls.push({ name, mime, content, id });
      setTimeout(() => win.__jarvisSaveResult(id, status, `msg-${status}`), 1);
    },
  };
  installSaveCallback(win);
  return win;
}

for (const status of ['saved', 'cancelled', 'error']) {
  test(`сохранение через мост: результат «${status}» доходит до приложения`, async () => {
    const win = fakeWindow(status);
    const result = await saveViaBridge(win.JarvisAndroid, 'r.csv', 'text/csv', '﻿данные');
    assert.deepEqual(result, { status, message: `msg-${status}` });
    assert.equal(win.calls.length, 1);
    assert.equal(win.calls[0].content, '﻿данные');
  });
}

test('исключение в мосте превращается в понятную ошибку', async () => {
  const bridge = { saveTextFile() { throw new Error('boom'); } };
  const r = await saveViaBridge(bridge, 'r.csv', 'text/csv', 'x');
  assert.equal(r.status, 'error');
  assert.match(r.message, /окно сохранения/);
});

test('посторонний вызов результата с неизвестным номером игнорируется', () => {
  const win = {};
  installSaveCallback(win);
  assert.doesNotThrow(() => win.__jarvisSaveResult('нет-такого', 'saved', ''));
});

test('статус в APK: установлено, офлайн и защита данных работают', () => {
  const f = Object.fromEntries(computeFeatures({ platform: 'apk', storage: 'indexeddb', persisted: null, offlineReady: true, online: true }).map((x) => [x.id, x]));
  assert.equal(f.install.label, 'APK');
  assert.equal(f.install.state, 'works');
  assert.equal(f.offline.state, 'works');
  assert.equal(f.persist.state, 'works');
  assert.match(f.storage.note, /памяти приложения/);
  assert.match(f.export.note, /Сохранить/);
  assert.equal(f.dialog.state, 'demo');
});

test('версия APK берётся из той же APP_VERSION, что и веб-версия', () => {
  const gradle = readFileSync(join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
  assert.match(gradle, /js\/core\/config\.js/);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});

test('оболочка Android: файлы только изнутри APK, внешние адреса блокируются, без резервного копирования в облако', () => {
  const java = readFileSync(join(ROOT, 'android/app/src/main/java/ru/jarvis/mobile/MainActivity.java'), 'utf8');
  assert.match(java, /return emptyResponse\(403/);
  assert.match(java, /setAllowFileAccess\(false\)/);
  assert.match(java, /Content-Security-Policy/);
  const manifest = readFileSync(join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:allowBackup="false"/);
  const permissions = [...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(permissions, ['android.permission.INTERNET']);
});
