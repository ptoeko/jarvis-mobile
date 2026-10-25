// Service worker: сохраняет файлы приложения на телефоне, чтобы оно
// открывалось без интернета. Пользовательские данные сюда не попадают.
// При изменении любого файла приложения увеличивайте VERSION.
const VERSION = '0.4.2';
const CACHE = `jarvis-shell-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/core/config.js',
  './js/core/validate.js',
  './js/core/demo.js',
  './js/core/store.js',
  './js/core/idb.js',
  './js/core/ai.js',
  './js/core/status.js',
  './js/core/parse.js',
  './js/core/records.js',
  './js/core/csv.js',
  './js/core/platform.js',
  './js/core/attachments.js',
  './js/core/zip.js',
  './js/core/backup.js',
  './js/core/xlsx.js',
  './js/core/share.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// cache: 'reload' — берём файлы с сервера, а не из кеша браузера, чтобы
// новая версия не сохранила старые копии файлов.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jarvis-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Страница: сначала сеть (чтобы получать обновления), при отсутствии
// сети или ответа за 4 секунды — сохранённая копия.
// Остальные файлы: сохранённая копия, обновляемая в фоне.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, event));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ]);
    if (response.ok) cache.put('./index.html', response.clone());
    return response;
  } catch {
    return (await cache.match('./index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}
