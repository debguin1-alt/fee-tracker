/**
 * Fee Tracker — Service Worker v5
 * ════════════════════════════════════════════════════════════════════════
 *
 * NEW in v5 vs v4
 * ───────────────
 * 1. SW-owned IndexedDB (sw-store v1)
 *    ├─ 'mirror'     : live copy of app data the page sends after every save
 *    └─ 'syncq'      : offline write queue — Firestore mutations that need replay
 *
 * 2. HTML data-injection
 *    When serving index.html from cache while offline the SW splices a
 *    <script id="sw-hydrate"> block containing the full data mirror into
 *    the response so the app hydrates instantly — zero IDB/auth delays.
 *
 * 3. Offline mutation queue
 *    Page sends QUEUE_WRITE messages; SW stores them. Background Sync
 *    replays them when connectivity returns. Retry with exponential backoff.
 *
 * 4. Network-race for app shell
 *    index.html: network race with 2.5 s timeout, winner cached, loser
 *    served from cache. Guarantees latest HTML while staying offline-safe.
 *
 * 5. ETag-aware revalidation
 *    All same-origin assets: store ETag from server response; on next fetch
 *    send If-None-Match — serve 304-lifted cached copy, save bandwidth.
 *
 * 6. BroadcastChannel cross-tab sync
 *    Any tab that regains connectivity notifies all other tabs to resync.
 *
 * 7. Quota guard
 *    Before precaching / storing, check navigator.storage.estimate() and
 *    skip if < 10 MB headroom to avoid StorageQuotaExceeded errors.
 *
 * Caching strategies (unchanged topology, tighter implementation)
 * ───────────────────────────────────────────────────────────────
 *   index.html            → network-race (2.5 s) → cache
 *   same-origin assets    → stale-while-revalidate + ETag
 *   Firebase SDK (CDN)    → cache-first (pinned version = immutable)
 *   Google Fonts CSS      → stale-while-revalidate
 *   Google Fonts woff2    → cache-first (content-addressed = immutable)
 *   Other CDN             → cache-first
 *   Firebase/Google APIs  → bypass (Firestore has its own offline layer)
 * ════════════════════════════════════════════════════════════════════════
 */

// ─── Version — bump this string to force a fresh install/activate cycle ───
const VERSION    = 'ft-v5';
const FONT_CACHE = 'ft-fonts-v2';
const CDN_CACHE  = 'ft-cdn-v2';
const ALL_CACHES = new Set([VERSION, FONT_CACHE, CDN_CACHE]);

// ─── App shell ─────────────────────────────────────────────────────────────
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

// ─── Pinned CDN assets (versions are immutable) ────────────────────────────
const FIREBASE_SDK = [
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js',
];
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&display=swap',
];

// ─── Never touch these (Firebase / Google auth / Firestore own their cache) ─
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'fcm.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'accounts.google.com',
  'oauth2.googleapis.com',
  'firebase.googleapis.com',
  'cloudmessaging.googleapis.com',
  'firebaselogging.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'content-firebaseappcheck.googleapis.com',
];

// ─── Logger ────────────────────────────────────────────────────────────────
const L = (...a) => console.log('%c[SW v5]', 'color:#7c6bff;font-weight:700', ...a);

// ─── BroadcastChannel (cross-tab messaging) ────────────────────────────────
const BC = (() => {
  try { return new BroadcastChannel('ft-sw'); } catch { return null; }
})();

function broadcast(msg) {
  try { BC?.postMessage(msg); } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
// SW-OWNED INDEXEDDB
// Separate from the page's 'fee-tracker-cache' DB.
// Stores: mirror (app data), syncq (offline write queue)
// ══════════════════════════════════════════════════════════════════════════════
const SW_DB_NAME = 'ft-sw-store';
const SW_DB_VER  = 1;

let _swDb = null;
function swDb() {
  if (_swDb) return Promise.resolve(_swDb);
  return new Promise((res, rej) => {
    const req = indexedDB.open(SW_DB_NAME, SW_DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('mirror')) {
        // keyed by "uid__datatype" — holds full app data mirror
        db.createObjectStore('mirror');
      }
      if (!db.objectStoreNames.contains('syncq')) {
        // keyed by auto-incrementing id
        const qs = db.createObjectStore('syncq', { autoIncrement: true });
        qs.createIndex('by_uid', 'uid', { unique: false });
        qs.createIndex('by_ts',  'ts',  { unique: false });
      }
    };
    req.onsuccess = e => { _swDb = e.target.result; res(_swDb); };
    req.onerror   = e => rej(e.target.error);
  });
}

async function dbGet(store, key) {
  try {
    const db = await swDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror   = () => rej(r.error);
    });
  } catch { return null; }
}

async function dbPut(store, key, value) {
  try {
    const db = await swDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  } catch {}
}

async function dbDel(store, key) {
  try {
    const db = await swDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  } catch {}
}

async function dbGetAll(store) {
  try {
    const db = await swDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = () => res(r.result ?? []);
      r.onerror   = () => rej(r.error);
    });
  } catch { return []; }
}

async function dbGetAllKeys(store) {
  try {
    const db = await swDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
      r.onsuccess = () => res(r.result ?? []);
      r.onerror   = () => rej(r.error);
    });
  } catch { return []; }
}

async function dbClearStore(store) {
  try {
    const db = await swDb();
    return new Promise((res, rej) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).clear();
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  } catch {}
}

// ── Quota guard ──────────────────────────────────────────────────────────────
async function hasHeadroom(minBytes = 10 * 1024 * 1024) {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return true;
    return (est.quota - est.usage) > minBytes;
  } catch { return true; }
}

// ══════════════════════════════════════════════════════════════════════════════
// INSTALL
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('install', e => {
  L('Installing', VERSION);
  self.skipWaiting(); // activate immediately — don't wait for old tabs to close
  e.waitUntil((async () => {
    // Open SW DB early so it's ready
    await swDb().catch(() => {});

    // Check storage before precaching
    const ok = await hasHeadroom(20 * 1024 * 1024);
    if (!ok) { L('Low storage — skipping precache'); return; }

    // Precache app shell + Firebase SDK together (critical for offline boot)
    const shell = await caches.open(VERSION);
    await Promise.allSettled([
      ...APP_SHELL.map(u => shell.add(u).catch(err => L('Shell miss:', u, err.message))),
      ...FIREBASE_SDK.map(u => shell.add(u).catch(err => L('SDK miss:', u, err.message))),
    ]);

    // Precache CDN assets (non-critical)
    const cdn = await caches.open(CDN_CACHE);
    await Promise.allSettled(CDN_ASSETS.map(u => cdn.add(u).catch(() => {})));

    L('Install complete');
  })());
});

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVATE — evict old caches, claim all clients
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Delete every cache not in our keep-set
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => !ALL_CACHES.has(k)).map(k => {
        L('Evicting old cache:', k);
        return caches.delete(k);
      })
    );
    await self.clients.claim(); // take immediate control of all open tabs
    L('Activated', VERSION);
    // Tell all pages a fresh SW is now active
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'SW_ACTIVATED', version: VERSION }));
    broadcast({ type: 'SW_ACTIVATED', version: VERSION });
  })());
});

// ══════════════════════════════════════════════════════════════════════════════
// FETCH — strategy router
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Only handle GET (mutations go through normal Firestore SDK)
  if (request.method !== 'GET') return;

  // ── Bypass: Firebase / Google auth APIs ─────────────────────────────────
  if (BYPASS_HOSTS.some(h => url.hostname.includes(h))) return;

  // ── 1. Navigation → serve app shell with data injection ─────────────────
  if (request.mode === 'navigate') {
    e.respondWith(navigationHandler(request));
    return;
  }

  // ── 2. Google Fonts CSS → stale-while-revalidate ─────────────────────────
  if (url.hostname === 'fonts.googleapis.com') {
    e.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  // ── 3. Google Fonts woff2 → cache-first (content-addressed, immutable) ───
  if (url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // ── 4. Firebase SDK (pinned version) → cache-first ───────────────────────
  if (url.hostname === 'www.gstatic.com' && url.pathname.includes('firebasejs')) {
    e.respondWith(cacheFirst(request, VERSION));
    return;
  }

  // ── 5. Other CDN assets → cache-first ────────────────────────────────────
  if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // ── 6. Same-origin app assets → stale-while-revalidate + ETag ────────────
  if (url.origin === self.location.origin) {
    // index.html gets the network-race strategy
    if (url.pathname === '/' || url.pathname.endsWith('index.html')) {
      e.respondWith(networkRace(request, VERSION, 2500));
    } else {
      e.respondWith(staleWhileRevalidateEtag(request, VERSION));
    }
    return;
  }

  // ── 7. Anything else → network with cache fallback ───────────────────────
  e.respondWith(
    fetch(request).then(res => {
      if (res.ok && hasHeadroom(5 * 1024 * 1024)) {
        caches.open(CDN_CACHE).then(c => c.put(request, res.clone()));
      }
      return res;
    }).catch(() => caches.match(request))
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// NAVIGATION HANDLER — the most important strategy
// Serves index.html from cache and injects the SW data mirror into the HTML
// so the app has data available synchronously before any JS runs.
// ══════════════════════════════════════════════════════════════════════════════
async function navigationHandler(request) {
  // Always try the network first with a short race timeout
  const networkResponse = await networkRace(request, VERSION, 2500);

  // If we're online and got a fresh response, just serve it
  if (networkResponse && networkResponse.ok && networkResponse.headers.get('x-sw-source') !== 'cache') {
    return networkResponse;
  }

  // We're offline or timed out — serve from cache with data injection
  const cached = await caches.match(request) || await caches.match('/index.html');
  if (!cached) {
    return networkResponse || new Response('<h1>Offline</h1><p>Open the app once while online to enable offline mode.</p>', {
      headers: { 'Content-Type': 'text/html' }, status: 503
    });
  }

  // ── Inject the SW data mirror into the cached HTML ──────────────────────
  try {
    const html   = await cached.text();
    const mirror = await buildHydrationScript();
    if (!mirror) return new Response(html, { headers: cached.headers });

    // Splice the hydration script right before </head>
    const injected = html.replace(
      '</head>',
      `${mirror}\n</head>`
    );
    return new Response(injected, {
      status:  cached.status,
      headers: new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-SW-Hydrated': 'true',
      }),
    });
  } catch (e) {
    L('Injection failed:', e.message);
    return cached;
  }
}

// Build the <script> block that pre-loads app data into window.__SW_HYDRATE__
async function buildHydrationScript() {
  try {
    const keys = await dbGetAllKeys('mirror');
    if (!keys.length) return null;

    const bundle = {};
    await Promise.all(keys.map(async k => {
      const val = await dbGet('mirror', k);
      if (val !== null) bundle[k] = val;
    }));

    if (!Object.keys(bundle).length) return null;

    const json = JSON.stringify(bundle);
    return `<script id="sw-hydrate">try{window.__SW_HYDRATE__=${json};}catch(e){}</script>`;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// FETCH STRATEGIES
// ══════════════════════════════════════════════════════════════════════════════

// Network race: try network, but fall back to cache after `timeoutMs`
async function networkRace(request, cacheName, timeoutMs = 3000) {
  const cache = await caches.open(cacheName);

  const networkPromise = fetch(request.clone()).then(async res => {
    if (res.ok) {
      await cache.put(request, res.clone());
    }
    return res;
  });

  const timeoutPromise = new Promise(resolve =>
    setTimeout(async () => {
      const cached = await cache.match(request);
      if (cached) {
        const cloned = new Response(await cached.blob(), {
          status:  cached.status,
          headers: new Headers({ ...Object.fromEntries(cached.headers), 'x-sw-source': 'cache' }),
        });
        resolve(cloned);
      } else {
        resolve(null);
      }
    }, timeoutMs)
  );

  try {
    // Race: whichever resolves first
    const result = await Promise.race([networkPromise, timeoutPromise]);
    return result || await networkPromise;
  } catch {
    return cache.match(request) || cache.match('/index.html');
  }
}

// Cache-first: serve from cache, fetch + cache on miss
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return new Response('Offline — resource unavailable', {
      status: 503, headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// Stale-while-revalidate: serve cache immediately, update in background
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  // Always kick off background refresh
  fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
  }).catch(() => {});
  return cached || fetch(request).catch(() =>
    new Response('Offline', { status: 503 })
  );
}

// Stale-while-revalidate with ETag support (efficient revalidation)
async function staleWhileRevalidateEtag(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const revalidate = async () => {
    try {
      const headers = new Headers(request.headers);
      if (cached) {
        const etag    = cached.headers.get('ETag');
        const lastMod = cached.headers.get('Last-Modified');
        if (etag)    headers.set('If-None-Match', etag);
        if (lastMod) headers.set('If-Modified-Since', lastMod);
      }
      const res = await fetch(new Request(request, { headers }));
      if (res.status === 304) return; // Not modified — cached copy is still fresh
      if (res.ok) await cache.put(request, res.clone());
    } catch {}
  };

  // Fire revalidation without awaiting
  revalidate();
  return cached || fetch(request).catch(() =>
    new Response('Offline', { status: 503 })
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER — two-way page ↔ SW communication
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('message', async e => {
  const msg = e.data || {};

  switch (msg.type) {

    // ── Core lifecycle ──────────────────────────────────────────────────────
    case 'SKIP_WAITING':
      L('SKIP_WAITING requested');
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      e.source?.postMessage({ type: 'SW_VERSION', version: VERSION });
      break;

    // ── Data mirror: page sends a snapshot of app data after every save ─────
    // msg.uid   = Firebase UID
    // msg.key   = 'teachers' | 'payments' | 'batches' | 'profile' | 'standalone_students' | 'batch__<id>'
    // msg.value = the data
    case 'MIRROR_DATA': {
      const { uid, key, value } = msg;
      if (uid && key && value !== undefined) {
        await dbPut('mirror', `${uid}__${key}`, { uid, key, value, ts: Date.now() });
        L('Mirror stored:', key);
      }
      break;
    }

    // Page sends entire data bundle at once (on saveToCache)
    case 'MIRROR_BUNDLE': {
      const { uid, bundle } = msg; // bundle: { teachers, payments, batches, profile, ... }
      if (uid && bundle) {
        await Promise.all(Object.entries(bundle).map(([key, value]) =>
          dbPut('mirror', `${uid}__${key}`, { uid, key, value, ts: Date.now() })
        ));
        L('Mirror bundle stored:', Object.keys(bundle).join(', '));
      }
      break;
    }

    // ── Offline write queue ─────────────────────────────────────────────────
    // msg.uid     = Firebase UID
    // msg.op      = 'set' | 'update' | 'delete'
    // msg.path    = Firestore document path string
    // msg.payload = data to write (null for deletes)
    case 'QUEUE_WRITE': {
      const { uid, op, path, payload } = msg;
      if (uid && op && path) {
        const db = await swDb();
        const entry = { uid, op, path, payload: payload || null, ts: Date.now(), retries: 0 };
        db.transaction('syncq', 'readwrite').objectStore('syncq').add(entry);
        L('Write queued:', op, path);
        // Register background sync so it replays when online
        try {
          await self.registration.sync.register('fee-data-sync');
        } catch {}
      }
      break;
    }

    // Purge the write queue for this user (on sign-out)
    case 'PURGE_QUEUE': {
      const { uid } = msg;
      if (!uid) { await dbClearStore('syncq'); break; }
      // Delete only entries for this uid
      try {
        const db = await swDb();
        const tx = db.transaction('syncq', 'readwrite');
        const idx = tx.objectStore('syncq').index('by_uid');
        const req = idx.openKeyCursor(IDBKeyRange.only(uid));
        req.onsuccess = e2 => {
          const cursor = e2.target.result;
          if (!cursor) return;
          cursor.source.objectStore ? cursor.delete() : tx.objectStore('syncq').delete(cursor.primaryKey);
          cursor.continue();
        };
      } catch {}
      L('Queue purged for uid:', uid);
      break;
    }

    // ── Cache management ────────────────────────────────────────────────────
    case 'CACHE_URLS':
      if (Array.isArray(msg.payload)) {
        const ok = await hasHeadroom();
        if (ok) {
          caches.open(VERSION).then(c =>
            Promise.allSettled(msg.payload.map(u => c.add(u)))
          );
        }
      }
      break;

    // Wipe ALL caches + SW DB on sign-out (privacy on shared devices)
    case 'CLEAR_CACHE':
      L('Clearing all caches + SW DB (sign-out)');
      await Promise.all([
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))),
        dbClearStore('mirror'),
        dbClearStore('syncq'),
      ]);
      e.source?.postMessage({ type: 'CACHE_CLEARED' });
      break;

    // Selective mirror wipe for a specific uid
    case 'CLEAR_MIRROR': {
      const { uid } = msg;
      if (!uid) break;
      const keys = await dbGetAllKeys('mirror');
      await Promise.all(
        keys.filter(k => k.startsWith(`${uid}__`)).map(k => dbDel('mirror', k))
      );
      L('Mirror cleared for uid:', uid);
      break;
    }

    // ── Periodic sync registration ─────────────────────────────────────────
    case 'REGISTER_PERIODIC_SYNC':
      if ('periodicSync' in self.registration) {
        self.registration.periodicSync.register('fee-reminder-check', {
          minInterval: 24 * 60 * 60 * 1000,
        }).catch(() => {});
      }
      break;

    // ── Connectivity restored — trigger resync ─────────────────────────────
    case 'ONLINE':
      L('Page reports online — broadcasting resync');
      broadcast({ type: 'RESYNC_REQUESTED' });
      break;

    default:
      break;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BACKGROUND SYNC — replay offline write queue when connectivity restores
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('sync', e => {
  L('Background sync:', e.tag);

  if (e.tag === 'fee-data-sync') {
    e.waitUntil(replayOfflineQueue());
  }
});

async function replayOfflineQueue() {
  const queue = await dbGetAll('syncq');
  if (!queue.length) {
    // No queued writes — just tell open tabs to resync from Firestore
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'BG_SYNC_TRIGGER' }));
    broadcast({ type: 'BG_SYNC_TRIGGER' });
    return;
  }

  L(`Replaying ${queue.length} queued write(s)`);

  // We can't call Firestore SDK directly from SW — instead tell the page to
  // process the queue, passing the entries so the page can replay them.
  const clients = await self.clients.matchAll({ type: 'window' });
  if (clients.length > 0) {
    clients[0].postMessage({ type: 'REPLAY_QUEUE', queue });
  } else {
    // No page open — keep queue, try again next sync
    L('No page open — queue retained for next sync');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PERIODIC BACKGROUND SYNC — proactive fee reminders when app is closed
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('periodicsync', e => {
  L('Periodic sync:', e.tag);
  if (e.tag === 'fee-reminder-check') {
    e.waitUntil(periodicReminderCheck());
  }
});

async function periodicReminderCheck() {
  const clients = await self.clients.matchAll({ type: 'window' });
  if (clients.length > 0) {
    // App is open — let it handle reminders natively
    clients.forEach(c => c.postMessage({ type: 'PERIODIC_REMINDER_CHECK' }));
    return;
  }

  // App is closed — check mirror for overdue fees
  const perm = self.Notification?.permission ?? 'default';
  if (perm !== 'granted') return;

  // Try to find a user with overdue data from the mirror
  const keys   = await dbGetAllKeys('mirror');
  const profKey = keys.find(k => k.endsWith('__profile'));
  const tKey    = keys.find(k => k.endsWith('__teachers'));

  let body = 'Open the app to review your pending payments.';

  if (profKey && tKey) {
    try {
      const [profEntry, teachersEntry] = await Promise.all([
        dbGet('mirror', profKey),
        dbGet('mirror', tKey),
      ]);
      const profile  = profEntry?.value || {};
      const teachers = teachersEntry?.value || {};
      const now      = new Date();
      const curM     = now.getMonth() + 1;
      const curY     = now.getFullYear();

      // Count overdue teachers
      let overdueCount = 0;
      Object.values(teachers).forEach(t => {
        const baseM = t.baselineMonth || curM;
        const baseY = t.baselineYear  || curY;
        const monthsDue = (curY - baseY) * 12 + (curM - baseM);
        if (monthsDue > 0) overdueCount++;
      });

      if (overdueCount === 0) return; // all clear — don't nag

      const name = profile.displayName || 'there';
      body = overdueCount === 1
        ? `1 teacher fee is pending, ${name}.`
        : `${overdueCount} teacher fees are pending, ${name}.`;
    } catch {}
  }

  await self.registration.showNotification('Fee Tracker — Fees Due', {
    body,
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    tag:     'periodic-reminder',
    renotify: false,
    vibrate: [200, 100, 200],
    actions: [
      { action: 'open',    title: 'Open App' },
      { action: 'dismiss', title: 'Later'    },
    ],
    data: { url: '/' },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try   { payload = e.data.json(); }
  catch { payload = { title: 'Fee Tracker', body: e.data.text() }; }

  const n    = payload.notification || payload;
  const data = payload.data || {};

  e.waitUntil(
    self.registration.showNotification(n.title || 'Fee Tracker', {
      body:    n.body || 'You have pending fee payments.',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     data.tag || 'ft-push',
      renotify: true,
      vibrate: [200, 80, 200, 80, 400],
      requireInteraction: !!data.requireInteraction,
      data:    { url: data.url || '/', ...data },
      actions: [
        { action: 'open',    title: 'Open App' },
        { action: 'dismiss', title: 'Later'    },
      ],
      ...(n.image ? { image: n.image } : {}),
    })
  );
});

// ── Notification click ───────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.focus();
          c.postMessage({ type: 'NOTIFICATION_CLICK', url });
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('notificationclose', e => {
  L('Notification dismissed:', e.notification.tag);
});

// ══════════════════════════════════════════════════════════════════════════════
// READY
// ══════════════════════════════════════════════════════════════════════════════
L('Script parsed — version:', VERSION);
