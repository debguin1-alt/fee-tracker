// ═══════════════════════════════════════════════════
//  FEE TRACKER — Service Worker  v3.0
//  Domain: fee.tracker1.workers.dev
// ═══════════════════════════════════════════════════

const APP_VERSION   = 'v3.0';
const CACHE_STATIC  = `ft-static-${APP_VERSION}`;   // app shell — never changes mid-session
const CACHE_FONTS   = `ft-fonts-${APP_VERSION}`;    // Google Fonts — long-lived
const CACHE_DYNAMIC = `ft-dynamic-${APP_VERSION}`;  // runtime fetches — rolling LRU

const MAX_DYNAMIC_ENTRIES = 40;
const MAX_DYNAMIC_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

// App shell — precached on install
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Never touch these — let them go straight to network
const BYPASS_PATTERNS = [
  /firebaseio\.com/,
  /firestore\.googleapis\.com/,
  /identitytoolkit\.googleapis\.com/,
  /securetoken\.googleapis\.com/,
  /firebaseapp\.com\/(__\/auth)/,
  /accounts\.google\.com/,
  /oauth2\.googleapis\.com/,
];

// ═══════════════════════════════════════════════════
//  INSTALL — precache app shell
// ═══════════════════════════════════════════════════
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => {
        console.log(`[SW] Installed ${APP_VERSION}`);
        return self.skipWaiting(); // activate immediately, don't wait for old SW to die
      })
  );
});

// ═══════════════════════════════════════════════════
//  ACTIVATE — clean up old caches, claim clients
// ═══════════════════════════════════════════════════
self.addEventListener('activate', e => {
  const currentCaches = new Set([CACHE_STATIC, CACHE_FONTS, CACHE_DYNAMIC]);

  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !currentCaches.has(k))
          .map(k => {
            console.log(`[SW] Deleting old cache: ${k}`);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim()) // take control of all open tabs immediately
  );
});

// ═══════════════════════════════════════════════════
//  FETCH — route each request to the right strategy
// ═══════════════════════════════════════════════════
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // 1. Non-GET — always network (POST to Firestore etc.)
  if (request.method !== 'GET') return;

  // 2. Chrome extensions / devtools — ignore
  if (!url.protocol.startsWith('http')) return;

  // 3. Firebase / Google auth — bypass completely
  if (BYPASS_PATTERNS.some(re => re.test(request.url))) return;

  // 4. Google Fonts CSS — stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(staleWhileRevalidate(request, CACHE_FONTS));
    return;
  }

  // 5. Google Fonts files (woff2 etc.) — cache-first, they never change
  if (url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(request, CACHE_FONTS));
    return;
  }

  // 6. App shell (our own origin) — cache-first with network fallback
  if (url.origin === self.location.origin) {
    e.respondWith(appShellStrategy(request));
    return;
  }

  // 7. Everything else — network-first with dynamic cache fallback
  e.respondWith(networkFirst(request, CACHE_DYNAMIC));
});

// ═══════════════════════════════════════════════════
//  STRATEGIES
// ═══════════════════════════════════════════════════

// Cache-first: serve from cache, only hit network if not cached
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const res = await fetch(request);
    if (res.ok) await putInCache(cacheName, request, res.clone());
    return res;
  } catch {
    return offlineFallback(request);
  }
}

// Network-first: try network, fall back to cache, then offline page
async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res.ok) await putInCache(cacheName, request, res.clone());
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineFallback(request);
  }
}

// Stale-while-revalidate: serve cache instantly, update in background
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  return cached || fetchPromise;
}

// App shell strategy: cache-first for shell files, network-first for HTML
// so users always get the latest index.html when online
async function appShellStrategy(request) {
  const url = new URL(request.url);

  // Navigation requests (page loads) — network-first so updates land immediately
  if (request.mode === 'navigate') {
    try {
      const res = await fetch(request);
      if (res.ok) {
        const cache = await caches.open(CACHE_STATIC);
        await cache.put(request, res.clone());
      }
      return res;
    } catch {
      // Offline — serve cached shell
      const cached = await caches.match(request)
                  || await caches.match('/index.html')
                  || await caches.match('/');
      return cached || offlineFallback(request);
    }
  }

  // Static assets (icons, manifest, js, css) — cache-first
  return cacheFirst(request, CACHE_STATIC);
}

// ═══════════════════════════════════════════════════
//  CACHE HELPERS
// ═══════════════════════════════════════════════════

async function putInCache(cacheName, request, response) {
  if (!response || !response.ok) return;

  const cache = await caches.open(cacheName);

  // For dynamic cache: enforce max entry count (LRU eviction)
  if (cacheName === CACHE_DYNAMIC) {
    await evictDynamicCache(cache);
  }

  await cache.put(request, response);
}

// Evict oldest entries from dynamic cache when over limit
async function evictDynamicCache(cache) {
  const keys = await cache.keys();
  if (keys.length < MAX_DYNAMIC_ENTRIES) return;

  // Delete oldest entries (FIFO — cache.keys() returns in insertion order)
  const toDelete = keys.slice(0, keys.length - MAX_DYNAMIC_ENTRIES + 1);
  await Promise.all(toDelete.map(k => cache.delete(k)));
}

// Offline fallback — return cached index.html for navigations
async function offlineFallback(request) {
  if (request.mode === 'navigate') {
    return (
      (await caches.match('/index.html')) ||
      (await caches.match('/')) ||
      new Response('<h1>Offline</h1><p>Fee Tracker needs a connection on first load.</p>', {
        headers: { 'Content-Type': 'text/html' }
      })
    );
  }
  // For non-navigation offline failures, just let it fail silently
  return new Response('', { status: 408, statusText: 'Offline' });
}

// ═══════════════════════════════════════════════════
//  MESSAGE — handle skip-waiting from app UI
// ═══════════════════════════════════════════════════
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    console.log('[SW] Skip waiting — activating new version');
    self.skipWaiting();
  }

  // App can ask SW to report its version
  if (e.data?.type === 'GET_VERSION') {
    e.source?.postMessage({ type: 'SW_VERSION', version: APP_VERSION });
  }
});

// ═══════════════════════════════════════════════════
//  PUSH NOTIFICATIONS (future-ready stub)
// ═══════════════════════════════════════════════════
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title || 'Fee Tracker', {
      body:    data.body    || 'You have a fee reminder.',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     data.tag     || 'fee-reminder',
      data:    data.url     || '/',
      actions: [
        { action: 'open',    title: 'Open App' },
        { action: 'dismiss', title: 'Dismiss'  },
      ],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(wins => {
        const target = e.notification.data || '/';
        const existing = wins.find(w => w.url.includes(self.location.origin));
        if (existing) { existing.focus(); existing.navigate(target); }
        else clients.openWindow(target);
      })
  );
});
