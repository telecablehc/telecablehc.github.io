// Permite usar la app sin conexión (pabellones sin cobertura).
// Cambia la versión al modificar los archivos para que se actualicen.
const CACHE = 'hoquei-v3';
const FILES = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './crest.png', './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Red primero (para recibir cambios), caché si no hay conexión
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
