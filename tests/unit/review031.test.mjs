// Тесты исправлений по ревью 0.3.1: черновики в базе, атомарное подтверждение,
// неизменность исходного текста, статус «Не указано», нумерация.
// Запуск: node --test tests/unit/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNote } from '../../js/core/parse.js';
import { createDraft, restoreDraft } from '../../js/core/records.js';
import { createStore, createMemoryAdapter, META_NEXT_NUMBER, META_DRAFTS } from '../../js/core/store.js';
import { NOT_SPECIFIED, EDITABLE_FIELDS } from '../../js/core/config.js';

function draftOf(text) {
  const { fields } = parseNote(text);
  return createDraft({ fields, sourceText: text, sourceMessageId: 'msg' });
}

// Адаптер, у которого можно «уронить» следующую транзакцию — имитация сбоя
// (приложение закрыто системой посреди записи).
function flakyAdapter() {
  const inner = createMemoryAdapter();
  let failNext = false;
  return {
    ...inner,
    failNextCommit() { failNext = true; },
    async commit(ops) {
      if (failNext) {
        failNext = false;
        throw new Error('сбой транзакции');
      }
      return inner.commit(ops);
    },
  };
}

test('черновики сохраняются в базе и восстанавливаются после перезапуска', async () => {
  const adapter = createMemoryAdapter();
  const first = createStore(adapter);
  const drafts = [draftOf('Ось 1/А — скол'), draftOf('Пом. 2.15: трещина')];
  drafts[0].object = 'корпус 7'; // правка человека до подтверждения
  await first.saveDrafts(drafts);

  const second = createStore(adapter); // «перезапуск»: новый экземпляр хранилища
  const restored = await second.loadDrafts();
  assert.equal(restored.length, 2);
  assert.equal(restored[0].object, 'корпус 7');
  assert.equal(restored[1].sourceText, 'Пом. 2.15: трещина');
  assert.equal((await second.counts()).records, 0, 'черновики не попадают в реестр без подтверждения');
});

test('подтверждение убирает черновик из базы той же транзакцией', async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  const drafts = [draftOf('первая'), draftOf('вторая')];
  await store.saveDrafts(drafts);
  const rec = await store.confirmRecord(drafts[0]);
  assert.equal(rec.number, 1);
  const left = await createStore(adapter).loadDrafts();
  assert.deepEqual(left.map((d) => d.sourceText), ['вторая']);
});

test('сбой при подтверждении: ни записи, ни сдвига номера, черновик на месте', async () => {
  const adapter = flakyAdapter();
  const store = createStore(adapter);
  const drafts = [draftOf('первая')];
  await store.saveDrafts(drafts);
  adapter.failNextCommit();
  await assert.rejects(store.confirmRecord(drafts[0]));
  assert.equal((await store.counts()).records, 0);
  assert.equal(await store.getMeta(META_NEXT_NUMBER), undefined);
  assert.equal((await store.loadDrafts()).length, 1);
  // Повтор после сбоя работает и выдаёт № 1.
  assert.equal((await store.confirmRecord(drafts[0])).number, 1);
  assert.equal((await store.loadDrafts()).length, 0);
});

test('отложенное сохранение черновиков не возвращает уже подтверждённый черновик', async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  const drafts = [draftOf('первая'), draftOf('вторая')];
  await store.saveDrafts(drafts);
  // Подтверждение и «запоздавшее» сохранение старого списка — в одной очереди.
  const confirming = store.confirmRecord(drafts[0]);
  const lateSave = store.saveDrafts(drafts);
  await Promise.all([confirming, lateSave]);
  const left = await createStore(adapter).loadDrafts();
  assert.deepEqual(left.map((d) => d.sourceText), ['вторая'], 'подтверждённый черновик не должен вернуться');
});

test('повреждённые черновики в базе пропускаются, приложение запускается', async () => {
  const adapter = createMemoryAdapter();
  const good = draftOf('нормальная');
  await adapter.setMeta(META_DRAFTS, [null, 42, { draftId: 'x' }, { draftId: 'y', sourceText: '   ' }, good, 'строка']);
  const restored = await createStore(adapter).loadDrafts();
  assert.deepEqual(restored.map((d) => d.sourceText), ['нормальная']);
  await adapter.setMeta(META_DRAFTS, 'не массив');
  assert.deepEqual(await createStore(adapter).loadDrafts(), []);
});

test('восстановленный черновик: пустые и нетекстовые поля — «Не указано»', () => {
  const d = restoreDraft({ draftId: 'd1', sourceText: 'текст', status: '', object: 5, location: null });
  assert.equal(d.status, NOT_SPECIFIED);
  assert.equal(d.object, '5');
  assert.equal(d.location, NOT_SPECIFIED);
  for (const key of EDITABLE_FIELDS) assert.equal(typeof d[key], 'string');
});

test('статус без метки «Статус:» — «Не указано» в черновике и в записи', async () => {
  for (const note of ['Ось 1/А — скол бетона', 'Устранено частично, ось 2', 'Пом. 2.15: трещина, принято']) {
    const draft = draftOf(note);
    assert.equal(draft.status, NOT_SPECIFIED, note);
    const rec = await createStore(createMemoryAdapter()).confirmRecord(draft);
    assert.equal(rec.status, NOT_SPECIFIED, note);
  }
  assert.equal(draftOf('Ось 1/А — скол. Статус: устранено').status, 'устранено');
});

test('исходный текст хранится дословно и не меняется при правке черновика', async () => {
  const source = '  Ось 3/Б — "раковины"\nвторая строка; =СУММ(A1)  ';
  const draft = createDraft({ fields: parseNote(source).fields, sourceText: source, sourceMessageId: 'm' });
  draft.sourceText = source; // как его хранит приложение
  draft.description = 'исправлено человеком';
  const store = createStore(createMemoryAdapter());
  const rec = await store.confirmRecord(draft);
  assert.equal(rec.sourceText, source);
  const [stored] = await store.listRecords();
  assert.equal(stored.sourceText, source);
});

test('удаление истории очищает и черновики', async () => {
  const adapter = createMemoryAdapter();
  const store = createStore(adapter);
  await store.saveDrafts([draftOf('a')]);
  await store.confirmRecord(draftOf('b'));
  await store.clearHistory();
  assert.deepEqual(await createStore(adapter).loadDrafts(), []);
  assert.equal(await store.getMeta(META_NEXT_NUMBER), 1);
});

test('нумерация сохраняется после перезапуска', async () => {
  const adapter = createMemoryAdapter();
  const a = createStore(adapter);
  await a.confirmRecord(draftOf('1'));
  const r2 = await a.confirmRecord(draftOf('2'));
  await a.deleteRecord(r2.id);
  const b = createStore(adapter);
  assert.equal((await b.confirmRecord(draftOf('3'))).number, 3);
});
