// Offline support.
//
// Once loaded this app needs no network at all — it talks to a strap over
// Bluetooth and stores readings locally — so a home-screen install should keep
// working on a plane, in a gym basement, or with the phone in airplane mode.
//
// Strategy is stale-while-revalidate: serve the cached shell immediately, then
// refresh it in the background. Bump CACHE to force a clean re-fetch.

const CACHE = 'strapline-v1';

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'whoop.js',
  'metrics.js',
  'storage.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing file cannot fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      // Cached first so the app opens instantly; the fetch above still runs and
      // updates the cache for next launch.
      return cached || network;
    }),
  );
});
