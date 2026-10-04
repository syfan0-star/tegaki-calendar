// Service worker for 手書きカレンダー (app shell only).
//
// - Precaches every app file so the app opens offline (ink lives in IndexedDB, not here).
// - Same-origin GET requests: network-first with cache fallback, so a new deploy shows up on the next
//   load while offline use still works. A slow network falls back to the cache after a few seconds, and
//   so does a server error (5xx / 404) when a cached copy exists.
// - One decision per page load: when the page itself had to come from the cache, its modules come from
//   the cache too (cache-first for a short while), so one launch never mixes old and new modules and a
//   slow network costs one timeout instead of one per import level.
// - Cross-origin requests (googleapis.com, accounts.google.com, oauth2.googleapis.com) are NEVER
//   intercepted: no respondWith → the browser handles them exactly as without a service worker.
// - Updates: the new worker waits until the page asks for it (postMessage 'skipWaiting', sent from the
//   「新しいバージョンがあります」 toast); activate claims clients and deletes old caches. An incomplete
//   precache fails the install, so the old worker and its complete cache stay until a later retry.

const VERSION = '1.0.5'; // keep in sync with APP_VERSION in js/config.js
const CACHE_PREFIX = 'tegaki-v';
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const NETWORK_TIMEOUT_MS = 4000;
const CACHE_FIRST_WINDOW_MS = 30 * 1000; // after a navigation answered from the cache

/** Every file of the app shell, relative to this worker's location (the app root). */
const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'js/boot-watchdog.js',
  'styles/app.css',
  'styles/views.css',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/main.js',
  'js/state.js',
  'js/config.js',
  'js/util/date.js',
  'js/util/holidays-jp.js',
  'js/util/idb.js',
  'js/views/page-geometry.js',
  'js/views/event-layout.js',
  'js/views/view-common.js',
  'js/views/day-view.js',
  'js/views/week-view.js',
  'js/views/month-view.js',
  'js/views/year-view.js',
  'js/google/http.js',
  'js/google/auth.js',
  'js/google/calendar.js',
  'js/google/drive.js',
  'js/data/calendar-source.js',
  'js/data/ink-store.js',
  'js/ink/model.js',
  'js/ink/geometry.js',
  'js/ink/render.js',
  'js/ink/surface.js',
  'js/ink/legacy-week-start.js',
  'js/ui/dom.js',
  'js/ui/header.js',
  'js/ui/toolbar.js',
  'js/ui/event-dialog.js',
  'js/ui/settings.js',
  'js/ui/selection-menu.js',
  'js/ui/toast.js',
  'js/ui/gestures.js',
];

const TIMEOUT = Symbol('timeout');

// Page loads whose navigation was answered from the cache (see preferCache). Kept in memory only: a page
// load takes seconds, and a worker that was stopped meanwhile simply goes network-first again.
let cacheNavigationAt = 0;
const cacheClients = new Set();

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'skipWaiting' || (data && data.type === 'skipWaiting')) self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // never touch Google (or any other origin)
  if (request.headers.has('range')) return;          // media range requests: leave to the browser
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(handleFetch(event, request));
});

async function handleFetch(event, request) {
  const navigation = isNavigation(request);
  if (!navigation && preferCache(event)) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
  }
  const { response, fromCache } = await networkFirst(event, request, navigation);
  if (navigation) noteNavigation(event, fromCache);
  return response;
}

/** The newest navigation decides: from the cache → its subresources cache-first for a short while. */
function noteNavigation(event, fromCache) {
  if (!fromCache) {
    cacheNavigationAt = 0;
    return;
  }
  cacheNavigationAt = Date.now();
  const id = event.resultingClientId;
  if (id) {
    cacheClients.add(id);
    if (cacheClients.size > 20) cacheClients.delete(cacheClients.values().next().value);
  }
}

function preferCache(event) {
  if (event.clientId && cacheClients.has(event.clientId)) return true;
  return cacheNavigationAt > 0 && Date.now() - cacheNavigationAt < CACHE_FIRST_WINDOW_MS;
}

/**
 * Caches every app file (cache: 'reload' bypasses the HTTP cache so the precache matches this deploy).
 * All files are tried; if any failed, the install fails: activate would otherwise delete the previous
 * COMPLETE cache, and an offline start could then miss a module. The browser retries the update later.
 * (tests/app-shell.test.mjs checks that APP_FILES lists exactly the app's files.)
 */
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.allSettled(APP_FILES.map(async (path) => {
    const request = new Request(new URL(path, self.location.href), { cache: 'reload' });
    const response = await fetch(request);
    if (!isCacheable(response)) throw new Error(`${path}: HTTP ${response.status}`);
    await cache.put(request, response);
  }));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    const reasons = failed.map((r) => String(r.reason && r.reason.message));
    console.warn('[sw] precache incomplete:', reasons);
    throw new Error(`precache incomplete (${failed.length} file(s))`);
  }
}

/** Only complete, same-origin, non-redirected 200 responses are cached (Safari rejects redirected ones for navigations). */
function isCacheable(response) {
  return !!response && response.ok && response.status === 200 && response.type === 'basic' && !response.redirected;
}

function isNavigation(request) {
  return request.mode === 'navigate' || (request.destination === 'document');
}

async function matchCache(cache, request, navigation) {
  const hit = await cache.match(request, navigation ? { ignoreSearch: true } : undefined);
  if (hit) return hit;
  if (!navigation) return null;
  return (await cache.match(new URL('./', self.location.href).href))
    || (await cache.match(new URL('index.html', self.location.href).href))
    || null;
}

/** A server answer that is worse than a cached copy (GitHub Pages outage, 'Site not found' during a deploy). */
function isServerFailure(response) {
  if (!response || response.type === 'opaqueredirect') return false; // a real redirect (navigations: manual)
  return response.status >= 500 || response.status === 404 || response.status === 410;
}

/** → { response, fromCache } */
async function networkFirst(event, request, navigation) {
  const cache = await caches.open(CACHE_NAME);

  // Subresources revalidate with the server (ETag → cheap 304), so right after a deploy the HTTP cache
  // (GitHub Pages: max-age=600) cannot mix old and new modules. Navigations are sent unchanged on purpose:
  // re-creating them would change the request mode and its redirect handling (and Safari is picky there).
  const networkRequest = navigation ? request : new Request(request, { cache: 'no-cache' });
  const fromNetwork = fetch(networkRequest);
  // Refresh the cache in the background. waitUntil must be called now, while respondWith is pending (a
  // later call throws InvalidStateError); the clone happens before the page can read the body.
  event.waitUntil(fromNetwork
    .then((response) => (isCacheable(response) ? cache.put(request, response.clone()) : undefined))
    .catch(() => {}));

  // Only the page itself may fall back to the cache on a slow network. Modules and styles always wait
  // for the network while it answers at all: a cached copy of one module next to fresh copies of the
  // others would mix two versions of the app (different APIs → the app breaks).
  let timer = null;
  const timeout = navigation
    ? new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), NETWORK_TIMEOUT_MS);
    })
    : new Promise(() => {});

  try {
    const first = await Promise.race([fromNetwork, timeout]);
    if (first !== TIMEOUT) {
      if (isServerFailure(first)) {
        const cached = await matchCache(cache, request, navigation);
        if (cached) return { response: cached, fromCache: true };
      }
      return { response: first, fromCache: false };
    }
    // Slow network: answer from the cache if we can, otherwise keep waiting for the network.
    const cached = await matchCache(cache, request, navigation);
    if (cached) return { response: cached, fromCache: true };
    return { response: await fromNetwork, fromCache: false };
  } catch (err) {
    const cached = await matchCache(cache, request, navigation);
    if (cached) return { response: cached, fromCache: true };
    if (navigation) return { response: offlinePage(), fromCache: false };
    throw err; // → network error for this subresource, as without a service worker
  } finally {
    clearTimeout(timer);
  }
}

function offlinePage() {
  const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>手書きカレンダー</title></head>'
    + '<body style="font-family:-apple-system,\'Hiragino Sans\',sans-serif;background:#fffdf8;color:#1f2937;padding:32px;line-height:1.7">'
    + '<h1 style="font-size:20px">オフラインです</h1>'
    + '<p>手書きカレンダーを開けませんでした。インターネットに接続してから、もう一度読み込んでください。</p>'
    + '<p><a href="./" style="display:inline-block;padding:10px 18px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none">もう一度読み込む</a></p>'
    + '</body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
