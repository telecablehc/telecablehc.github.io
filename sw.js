// Permite usar la app sin conexión (pabellones sin cobertura).
//
// La app se abre SIEMPRE desde la copia guardada en el dispositivo: es
// instantánea con o sin red. Para publicar cambios hay que subir la versión
// de CACHE: el navegador detecta este archivo nuevo, descarga todo en segundo
// plano y la versión nueva aparece la próxima vez que se abra la app.
const CACHE = 'hoquei-v45';
const FILES = [
  './', './index.html', './styles.css', './app.js', './cloud.js', './calendar.js', './entrenos.js', './video.js', './hls.min.js', './supabase.min.js', './manifest.webmanifest', './manual.html',
  './crest.png', './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' evita copiar versiones antiguas de la caché HTTP
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((cached) => cached || fetch(req)));
});
