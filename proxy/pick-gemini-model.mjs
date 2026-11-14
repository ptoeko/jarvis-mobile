// Выбор модели Gemini при публикации посредника (запускается в GitHub Actions).
// Названия моделей Google меняет часто, поэтому модель не вписана в код:
// скрипт берёт список моделей, доступных ключу, и пробует их от новой к старой
// маленьким запросом. Первая ответившая модель и становится моделью агента.
// Также выбирается модель для изображений (без проверки запросом — на
// бесплатном ключе она может быть недоступна; агент тогда объяснит это).
// Печатает JSON { model, imageModel } в stdout. Ключ — из GEMINI_API_KEY.
//
// Запуск: node proxy/pick-gemini-model.mjs

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Версия из имени: gemini-3.8-flash → [3, 8].
function version(name) {
  const m = /^gemini-(\d+)(?:\.(\d+))?-/.exec(name);
  return m ? [Number(m[1]), Number(m[2] || 0)] : [0, 0];
}

// Упорядочивает модели: сначала стабильные «flash» (новые выше), затем
// «flash-lite», затем общий псевдоним. Предварительные, экспериментальные,
// датированные и специальные (изображения, речь, встраивание) не берутся.
export function rankModels(models) {
  const usable = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((n) => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(n));
  const score = (n) => {
    const [a, b] = version(n);
    return (n.endsWith('-lite') ? 0 : 1e6) + a * 1000 + b;
  };
  const ranked = [...new Set(usable)].sort((x, y) => score(y) - score(x));
  if (!ranked.includes('gemini-flash-latest')) ranked.push('gemini-flash-latest');
  return ranked;
}

// Модели изображений: «…-flash-image» выше «…-pro-image», новые выше,
// стабильные выше предварительных.
export function rankImageModels(models) {
  const usable = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((n) => /^gemini-\d+(\.\d+)?-(flash|pro)-image(-preview)?$/.test(n));
  const score = (n) => {
    const [a, b] = version(n);
    return (n.includes('-flash-') ? 2e6 : 0) + (n.endsWith('-preview') ? 0 : 1e6) + a * 1000 + b;
  };
  return [...new Set(usable)].sort((x, y) => score(y) - score(x));
}

async function listModels(key) {
  const out = [];
  let token = '';
  for (let page = 0; page < 10; page++) {
    const r = await fetch(`${BASE}/models?pageSize=1000${token ? `&pageToken=${token}` : ''}`, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) throw new Error(`Список моделей недоступен: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    out.push(...(data.models || []));
    if (!data.nextPageToken) break;
    token = encodeURIComponent(data.nextPageToken);
  }
  return out;
}

async function tryModel(key, name) {
  const r = await fetch(`${BASE}/models/${encodeURIComponent(name)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Ответь одним словом: готов' }] }], generationConfig: { maxOutputTokens: 2048 } }),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, detail: text.slice(0, 200) };
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Не задан GEMINI_API_KEY');
  const all = await listModels(key);
  const imageModel = rankImageModels(all)[0] || '';
  console.error(`Модель изображений: ${imageModel || 'нет'}`);
  const ranked = rankModels(all).slice(0, 6);
  console.error(`Кандидаты: ${ranked.join(', ')}`);
  for (const name of ranked) {
    const r = await tryModel(key, name);
    console.error(`${name}: HTTP ${r.status}${r.ok ? '' : ` ${r.detail}`}`);
    if (r.ok) {
      process.stdout.write(JSON.stringify({ model: name, imageModel }));
      return;
    }
    if (/location is not supported/i.test(r.detail)) throw new Error('Gemini API недоступен из региона сервера сборки.');
    if (r.status === 400 && /API key not valid/i.test(r.detail)) throw new Error('Ключ GEMINI_API_KEY недействителен.');
  }
  // Ни одна модель не ответила (например, исчерпан дневной лимит) — берём первую.
  console.error('Ни одна модель не ответила сейчас; выбрана первая по списку.');
  process.stdout.write(JSON.stringify({ model: ranked[0], imageModel }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
