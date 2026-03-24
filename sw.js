const CACHE = 'samvsmatt-v3';
const BASE = '/Matt-vs-Sam';
const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Never cache Apps Script API calls
  if (e.request.url.includes('script.google.com')) return;
  // Network first for HTML so updates are always fresh
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(BASE + '/index.html'))
    );
    return;
  }
  // Cache first for other assets
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
