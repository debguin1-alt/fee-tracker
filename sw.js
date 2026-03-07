const CACHE = 'fee-tracker-v1';
const ASSETS = [
  '/fee-tracker/',
  '/fee-tracker/index.html',
  '/fee-tracker/manifest.json',
  '/fee-tracker/icon-192.png',
  '/fee-tracker/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Let Firebase/Google requests go straight to network
  if (
    e.request.url.includes('firebasejs') ||
    e.request.url.includes('googleapis') ||
    e.request.url.includes('firebaseapp') ||
    e.request.url.includes('firestore') ||
    e.request.url.includes('gstatic')
  ) return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => caches.match('/fee-tracker/')))
  );
});
