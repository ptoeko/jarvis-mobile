// Разбор инженерной заметки в поля реестра ПО ПРАВИЛАМ (это не ИИ).
// Принцип: поле заполняется только тем, что явно написано в заметке, —
// дословным фрагментом исходного текста. Всё остальное — «Не указано».
// Для каждого заполненного поля возвращаются фрагменты-доказательства
// (evidence), по которым тесты проверяют отсутствие домысла.

import { NOT_SPECIFIED, MAX_NOTES_PER_MESSAGE } from './config.js';

// Граница «не буква и не цифра» (\b в JavaScript не работает с кириллицей).
const NB = '(?<![\\p{L}\\d])';
const NA = '(?![\\p{L}\\d])';

const DATE_SRC = '(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}|\\d{2})(?!\\d|\\.\\d)';
// Не дата, если перед числом стоит «п.», «пункт», «разд.», «табл.»: это номер пункта.
const DATE_RE = new RegExp(`(?<![\\p{L}\\d.,])(?<!(?:п|пп|пункт|разд|раздел|табл)\\.?\\s*)${DATE_SRC}`, 'giu');

// Метки вида «Подрядчик: …». Значение — до «;», «,», конца строки или конца
// предложения (точка, за которой заглавная буква или конец текста).
// Запятые и точки внутри «ёлочек» и кавычек допускаются.
const LABELS = [
  ['description', 'замечание|описание'],
  ['object', 'объект|здание|сооружение'],
  ['workType', 'вид\\s+работ|работы'],
  ['responsible', 'ответственная\\s+организация|ответственный|подрядчик|исполнитель|отв\\.?'],
  ['requirement', 'требование'],
  ['deadline', 'срок\\s+устранения|срок'],
  ['location', 'место'],
  ['date', 'дата'],
  ['status', 'статус'],
];
// MASK — символ, которым закрашиваются уже разобранные фрагменты; значения
// меток через него не переходят.
const MASK = '\u0001';
const LABEL_VALUE = '((?:«[^»\\n\\u0001]*»|"[^"\\n\\u0001]*"|\\.(?!\\s+[А-ЯЁA-Z]|\\s*$)|[^;,\\n«".\\u0001])+)';

// Срок без метки: «срок до 30.10.2026», «устранить до 30.10.2026».
const DEADLINE_RE = new RegExp(
  `${NB}(?:в\\s+)?(?:срок(?:\\s+устранения)?\\s*(?:до|—|–|-)?|устранить\\s+до)\\s*(${DATE_SRC})`,
  'giu',
);

// Нормативные ссылки: «СП 70.13330.2012, п. 5.3.2», «ГОСТ Р 21.101-2020».
const NORM_RE = new RegExp(
  `${NB}(?:СП|ГОСТ(?:\\s*Р)?|СНиП|ВСН|РД|НП|ПБ|ТУ|СТО)\\s*\\d[\\d.\\-–]*\\d` +
    '(?:\\s*,?\\s*(?:п\\.|пп\\.|пункт|разд\\.|раздел|табл\\.)\\s*\\d+(?:\\.\\d+)*)*',
  'gu',
);
// Пункт без названия нормы: «п. 5.3.2», «пункт 4.1».
const CLAUSE_RE = new RegExp(`${NB}(?:[Пп]\\.|[Пп]п\\.|[Пп]ункт)\\s*\\d+(?:\\.\\d+)+(?![\\d.]*\\d)`, 'gu');
// Ссылка на лист проекта: «лист 5», «л. 12».
const SHEET_RE = new RegExp(`${NB}(?:[Лл]ист|[Лл]\\.)\\s*\\d+[а-я]?${NA}`, 'gu');

// Оси: «ось 3/Б», «в осях А–В/1–4». Обозначения осей — заглавные буквы
// или цифры, поэтому выражение чувствительно к регистру.
const AXIS = "(?:[А-ЯЁA-Z]{1,2}|\\d{1,3})'?";
const AXES_RE = new RegExp(
  `${NB}(?:[Вв]\\s+)?(?:[Оо]с(?:ь|и|ях|ей|ям))\\s+${AXIS}(?:\\s*[-–—/]\\s*${AXIS})*${NA}`,
  'gu',
);
// Отметки: «отм. +6.000», «на отметке −0,300», а также «+6.000» без слова.
const ELEV_NUM = '[+\\-−±]?\\s?\\d+[.,]\\d{3}(?![\\d.,])';
const ELEV_RE = new RegExp(`${NB}(?:на\\s+)?[Оо]тм(?:\\.|етк[аеиуой]{1,2})?\\s*${ELEV_NUM}`, 'gu');
const ELEV_BARE_RE = new RegExp(`(?<![\\p{L}\\d.,])[+\\-−±]\\d+[.,]\\d{3}(?![\\d.,])`, 'gu');
// Помещения: «пом. 101», «помещение 2.15».
const ROOM_RE = new RegExp(`${NB}(?:[Пп]ом(?:\\.|ещени[еяи])|[Кк]омн(?:\\.|ата))\\s*№?\\s*[\\p{L}\\d][\\p{L}\\d.\\-/]*`, 'gu');

function isRealDate(d, m, y) {
  const day = Number(d);
  const month = Number(m);
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days;
}

// Рабочая копия текста: найденные фрагменты «закрашиваются» символом MASK той же
// длины, чтобы следующие правила не извлекали их повторно.
class Masked {
  constructor(text) {
    this.text = text;
    this.work = text;
  }
  take(re, group = 0) {
    const found = [];
    re.lastIndex = 0;
    for (const m of this.work.matchAll(re)) {
      const full = m[0];
      const start = m.index;
      const value = group ? m[group] : full;
      const vStart = group ? start + full.lastIndexOf(m[group]) : start;
      found.push({ value: this.text.slice(vStart, vStart + value.length), index: vStart, full, start });
    }
    for (const f of found) this.mask(f.start, f.full.length);
    return found;
  }
  mask(start, length) {
    this.work = this.work.slice(0, start) + MASK.repeat(length) + this.work.slice(start + length);
  }
}

function cleanValue(value) {
  // Точка в конце значения метки — конец предложения, а не часть значения.
  return value.replace(/\s+/g, ' ').trim().replace(/\.$/, '').trim();
}

export function splitNotes(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Разбирает одну заметку. Возвращает { fields, evidence }:
// fields — значения редактируемых полей (строки, «Не указано» по умолчанию),
// evidence — для каждого заполненного поля список дословных фрагментов.
export function parseNote(note) {
  const text = String(note).replace(/\r\n?/g, '\n').trim();
  const m = new Masked(text);
  const found = {};
  const add = (key, items) => {
    if (!items.length) return;
    (found[key] ||= []).push(...items);
  };

  // 1. Явные метки.
  for (const [key, label] of LABELS) {
    if (found[key]) continue;
    const re = new RegExp(`${NB}(?:${label})\\s*:\\s*${LABEL_VALUE}`, 'giu');
    const items = m.take(re, 1).map((f) => ({ ...f, value: cleanValue(f.value) })).filter((f) => f.value);
    add(key, items.slice(0, 1));
  }
  // 2. Срок без метки.
  if (!found.deadline) add('deadline', m.take(DEADLINE_RE, 1).slice(0, 1));
  // 3. Нормы и листы проекта.
  if (!found.requirement) {
    const items = [...m.take(NORM_RE), ...m.take(CLAUSE_RE), ...m.take(SHEET_RE)].sort((a, b) => a.index - b.index);
    add('requirement', items.map((f) => ({ ...f, value: cleanValue(f.value) })));
  }
  // 4. Место: оси, отметки, помещения — в порядке появления в тексте.
  if (!found.location) {
    const axes = m.take(AXES_RE);
    const elevations = m.take(ELEV_RE);
    // Отметка без слова «отм.» берётся, только если отметки со словом нет,
    // и только первая: вторая обычно проектное значение для сравнения.
    const bare = elevations.length ? [] : m.take(ELEV_BARE_RE).slice(0, 1);
    const items = [...axes, ...elevations, ...bare, ...m.take(ROOM_RE)].sort((a, b) => a.index - b.index);
    add('location', items.map((f) => ({ ...f, value: cleanValue(f.value) })));
  }
  // 5. Дата — первая настоящая дата среди оставшегося текста.
  if (!found.date) {
    const dates = m.take(DATE_RE).filter((f) => {
      const [d, mo, y] = f.value.split('.');
      return isRealDate(d, mo, y);
    });
    add('date', dates.slice(0, 1));
  }

  const fields = {
    date: NOT_SPECIFIED,
    object: NOT_SPECIFIED,
    location: NOT_SPECIFIED,
    workType: NOT_SPECIFIED,
    description: text || NOT_SPECIFIED,
    requirement: NOT_SPECIFIED,
    responsible: NOT_SPECIFIED,
    deadline: NOT_SPECIFIED,
    status: NOT_SPECIFIED,
  };
  const evidence = { description: found.description ? [found.description[0].value] : [text] };
  const joiners = { location: ', ', requirement: '; ' };
  for (const [key, items] of Object.entries(found)) {
    const values = [...new Set(items.map((i) => i.value))];
    fields[key] = values.join(joiners[key] || ' ');
    evidence[key] = values;
  }
  return { fields, evidence };
}

// Разбирает сообщение, в котором заметки разделены пустой строкой.
export function parseMessage(text) {
  const notes = splitNotes(text);
  if (notes.length === 0) {
    return { ok: false, error: 'В сообщении нет текста заметки.' };
  }
  if (notes.length > MAX_NOTES_PER_MESSAGE) {
    return {
      ok: false,
      error: `Слишком много заметок в одном сообщении: ${notes.length}. Максимум — ${MAX_NOTES_PER_MESSAGE}. Разделите сообщение на части.`,
    };
  }
  return { ok: true, notes: notes.map((note) => ({ note, ...parseNote(note) })) };
}
