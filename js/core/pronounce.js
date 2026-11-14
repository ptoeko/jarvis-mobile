// Произношение для голоса JARVIS: словарь (встроенный и свой) и ударения.
//
// Ударение передаётся синтезатору знаком U+0301 после ударной гласной
// («Айра́т»). В словаре и в ответе ИИ агента ударение пишется знаком «+»
// после гласной («Айра+т») — так его удобно набирать на телефоне.

export const META_PRONOUNCE = 'pronunciation';
const STRESS = '́';
const VOWELS = 'аеёиоуыэюяАЕЁИОУЫЭЮЯ';
const MAX_ENTRIES = 300;

// «Айра+т» → «Айра́т». «+» не после гласной («+6,000») не трогается.
export function plusToStress(text) {
  return String(text ?? '').replace(new RegExp(`([${VOWELS}])\\+`, 'g'), `$1${STRESS}`);
}

export function stressToPlus(text) {
  return String(text ?? '').replace(new RegExp(STRESS, 'g'), '+');
}

export function stripStress(text) {
  return String(text ?? '').replace(new RegExp(STRESS, 'g'), '');
}

// Встроенный словарь: имена, сокращения стройки и энергетики, слова, в которых
// синтезатор ошибается. Формы слов перечислены отдельно.
const forms = (reading, ...words) => words.map((w) => [w, reading(w)]);
const stressAt = (vowelIndex) => (word) => {
  // Ударение на гласную с номером vowelIndex (с нуля) в слове.
  let n = -1;
  let out = '';
  for (const ch of word) {
    out += ch;
    if (VOWELS.includes(ch) && ++n === vowelIndex) out += '+';
  }
  return out;
};

export const BUILTIN = [
  ['AYRAT', 'Айра+т'],
  ['Айрат', 'Айра+т'],
  ['JARVIS', 'Джа+рвис'],
  ['Джарвис', 'Джа+рвис'],
  ['Jarvis', 'Джа+рвис'],
  ...forms(stressAt(0), 'ведомость', 'ведомости', 'ведомостей', 'ведомостям', 'ведомостями', 'ведомостях'),
  ...forms(stressAt(1), 'осей', 'осям', 'осями', 'осях'),
  ...forms(stressAt(0), 'поиск', 'поиска', 'поиску', 'поиском', 'поиске', 'поиски', 'поисков', 'поискам', 'поисками', 'поисках'),
  ...forms(stressAt(2), 'договор', 'договора', 'договору', 'договором', 'договоре', 'договоры', 'договоров'),
  ...forms(stressAt(2), 'обеспечение', 'обеспечения', 'обеспечению', 'обеспечением', 'обеспечении'),
  ...forms(stressAt(2), 'каталог', 'каталога', 'каталоге'),
  ...forms(stressAt(1), 'отметка', 'отметки', 'отметке', 'отметку', 'отметкой', 'отметок'),
  ['СМР', 'эс-эм-э+р'],
  ['ПНР', 'пэ-эн-э+р'],
  ['АЭС', 'а-э+с'],
  ['ППР', 'пэ-пэ-э+р'],
  ['ПОС', 'по+с'],
  ['ПТО', 'пэ-тэ-о+'],
  ['ИД', 'и-дэ+'],
  ['РД', 'эр-дэ+'],
  ['ВИК', 'ви+к'],
  ['ВК', 'вэ-ка+'],
  ['ОТК', 'о-тэ-ка+'],
  ['ГОСТ', 'го+ст'],
  ['СП', 'эс-пэ+'],
  ['м³', 'кубоме+тров'],
  ['м3', 'кубоме+тров'],
  ['м²', 'квадра+тных ме+тров'],
  ['м2', 'квадра+тных ме+тров'],
];

// Проверка и приведение записи словаря.
export function normalizeEntry(word, reading) {
  const w = String(word ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const r = String(reading ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!w || !r) return null;
  if (!/[\p{L}\d]/u.test(w)) return null;
  return { word: w, reading: r };
}

export function normalizeDictionary(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const n = normalizeEntry(e?.word, e?.reading);
    if (!n || seen.has(n.word.toLowerCase())) continue;
    seen.add(n.word.toLowerCase());
    out.push(n);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// «е» в слове словаря совпадает и с «ё» в тексте, и наоборот.
const pattern = (word) => escape(word).replace(/[её]/gi, (c) => (c === c.toLowerCase() ? '[её]' : '[ЕЁ]'));

// «Ведомостей» в начале предложения → «Ве́домостей». Сокращения целиком
// заглавными («СМР») читаются по словарю как есть.
function matchCase(found, reading) {
  const first = found.charAt(0);
  const capital = first !== first.toLowerCase();
  if (capital && (found.length === 1 || found !== found.toUpperCase())) return reading.charAt(0).toUpperCase() + reading.slice(1);
  return reading;
}

// Замена слов по словарю. Свои записи важнее встроенных; длинные — раньше
// коротких (сначала «м³», потом «м»). Возвращает текст с ударениями U+0301.
export function applyDictionary(text, own = []) {
  const map = new Map();
  for (const [w, r] of BUILTIN) map.set(w.toLowerCase(), { word: w, reading: r });
  for (const e of normalizeDictionary(own)) map.set(e.word.toLowerCase(), e);
  const entries = [...map.values()].sort((a, b) => b.word.length - a.word.length);
  if (!entries.length) return String(text ?? '');
  const byKey = new Map(entries.map((e) => [e.word.toLowerCase().replace(/ё/g, 'е'), e]));
  const re = new RegExp(`(?<![\\p{L}\\d])(?:${entries.map((e) => pattern(e.word)).join('|')})(?![\\p{L}\\d])`, 'giu');
  const out = String(text ?? '').replace(re, (found) => {
    const e = byKey.get(found.toLowerCase().replace(/ё/g, 'е'));
    return e ? plusToStress(matchCase(found, e.reading)) : found;
  });
  return out;
}

// Ответ ИИ агента с ударениями «+» принимается, только если, кроме знаков
// ударения, текст не изменился (пробелы и переносы строк не считаются).
export function acceptAccents(original, accented) {
  const plain = (s) => stripStress(String(s ?? '')).replace(new RegExp(`([${VOWELS}])\\+`, 'g'), '$1').replace(/\s+/g, ' ').trim();
  if (!accented || plain(original) !== plain(accented)) return null;
  return plusToStress(accented);
}
