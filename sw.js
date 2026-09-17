/**
 * sw.js — minimal app-shell cache so OMR Magic keeps working offline
 * once loaded (a teacher checking papers at night with unreliable
 * Wi-Fi). Data itself lives in IndexedDB (see js/core/storage.js), not
 * here — this only caches the static files needed to boot the app.
 */
const CACHE_NAME = 'omr-magic-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/core/confidence.js',
  './js/core/document-understanding.js',
  './js/core/grading.js',
  './js/core/storage.js',
  './js/models/question-model.js',
  './js/models/test-model.js',
  './js/models/answer-key.js',
  './js/models/omr-template.js',
  './js/models/sheet-model.js',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Only cache same-origin, successful responses (skip the Google
        // Fonts CDN etc. — those fail gracefully to network-only).
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
