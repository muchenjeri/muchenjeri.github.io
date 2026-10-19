// Caches the app itself so the journal opens offline. Journal data lives in IndexedDB, not here,
// and Google API requests are never cached. Bump VERSION whenever app files change.
const VERSION = 'mj-v2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/archive.js', 'js/auth.js', 'js/codec.js', 'js/config.js', 'js/drive.js', 'js/engine.js',
  'js/icons.js', 'js/local.js', 'js/markup.js', 'js/md5.js', 'js/store.js', 'js/util.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google APIs go straight to the network
  // Network first (so updates arrive), falling back to the cached copy when offline.
  e.respondWith(
    fetch(e.request).then((resp) => {
      if (resp.ok) { const copy = resp.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return resp;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r ?? caches.match('index.html'))),
  );
});
