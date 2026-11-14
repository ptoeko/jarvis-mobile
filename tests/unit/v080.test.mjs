// Тесты версии 0.8.0: код входа.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLock, validPin, waitSeconds, pinHash, META_PIN } from '../../js/core/lock.js';
import { createBackup, inspectBackup } from '../../js/core/backup.js';
import { createStore, createMemoryAdapter } from '../../js/core/store.js';

function memMeta() {
  const m = new Map();
  return { getMeta: async (k) => m.get(k), setMeta: async (k, v) => { m.set(k, v); }, raw: m };
}

test('код: ровно 4 цифры', () => {
  assert.ok(validPin('0507'));
  for (const bad of ['123', '12345', '12a4', '', null, 1234]) assert.equal(validPin(bad), false);
});

test('код хранится отпечатком с солью, не в открытом виде', async () => {
  const meta = memMeta();
  const lock = createLock(meta);
  assert.equal(await lock.isSet(), false);
  await lock.set('2580');
  const v = meta.raw.get(META_PIN);
  assert.ok(!JSON.stringify(v).includes('2580'));
  assert.equal(v.hash, await pinHash('2580', v.salt, v.iterations));
  assert.deepEqual(await lock.verify('2580'), { ok: true });
  await assert.rejects(lock.set('12'), /4 цифры/);
});

test('пауза после 5 неверных попыток, растёт вдвое, переживает перезапуск; верный код сбрасывает счётчик', async () => {
  assert.deepEqual([1, 4, 5, 6, 10, 15, 50].map(waitSeconds), [0, 0, 30, 0, 60, 120, 3600]);
  let t = 1_000_000;
  const meta = memMeta();
  const lock = createLock(meta, () => t);
  await lock.set('2580');
  for (let i = 1; i <= 4; i++) assert.deepEqual(await lock.verify('0000'), { ok: false, wait: 0, left: 5 - i });
  assert.deepEqual(await lock.verify('0000'), { ok: false, wait: 30, left: 0 });
  // Во время паузы даже верный код не принимается.
  assert.equal((await lock.verify('2580')).ok, false);
  const again = createLock(meta, () => t + 10_000); // перезапуск приложения
  assert.equal(await again.pause(), 20);
  t += 31_000;
  assert.deepEqual(await lock.verify('2580'), { ok: true });
  assert.equal(meta.raw.get(META_PIN).fails, 0);
  await lock.reset();
  assert.equal(await lock.isSet(), false);
});

test('код входа не попадает в резервную копию и сохраняется при восстановлении', async () => {
  const store = createStore(createMemoryAdapter());
  await store.setMeta(META_PIN, { salt: 'aa', hash: 'bb', fails: 0, until: 0 });
  await store.setMeta('voicePrefs', { auto: true });
  const backup = await createBackup(store);
  const blob = backup.blob || backup;
  const info = await inspectBackup(blob);
  const metaIds = info.data.meta.map((m) => m.id);
  assert.ok(metaIds.includes('voicePrefs'), metaIds);
  assert.ok(!metaIds.includes(META_PIN), metaIds);
});
