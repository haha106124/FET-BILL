/* Service Worker：讓網站裝到手機主畫面後可以離線查詢。
 *
 * 名冊與介面在安裝時就快取；OCR 引擎（vendor/，約 9 MB）改成用到才快取，
 * 避免第一次開啟就下載一大包。
 */
const VERSION = 'fet-bill-v3';
const SHELL = [
  './',
  'index.html',
  'assets/styles.css',
  'assets/data.js',
  'assets/matcher.js',
  'assets/ocr.js',
  'assets/app.js',
  'assets/icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // CDN 備援交給瀏覽器自己處理

  // 名冊隨時可能更新：優先拿新的，拿不到再用快取
  if (url.pathname.endsWith('/data/directory.enc.json')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 其餘（含 vendor/ 的引擎檔）：快取優先，第一次抓到就存起來
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
