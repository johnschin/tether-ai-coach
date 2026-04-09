// Tether AI Coach — Service Worker
// Minimal service worker for PWA install support.
// Caches the app shell for offline loading.

const CACHE_NAME = 'tether-v1';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/auth.js',
  '/memory.js',
  '/coaching.js',
  '/app.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_FILES).catch((err) => {
        console.warn('Cache addAll failed (non-blocking):', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only cache GET requests for app shell files
  if (event.request.method !== 'GET') return;

  // Don't cache API calls to the worker
  if (event.request.url.includes('tether-proxy') || event.request.url.includes('supabase')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for shell files
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Fall back to cache if network fails
        return caches.match(event.request);
      })
  );
});
