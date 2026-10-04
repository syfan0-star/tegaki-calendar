// App shell checks (module F2a): sw.js precache list and fetch strategy, manifest, index.html, boot watchdog.
// sw.js is a classic worker script: it is run in a node:vm sandbox with fake caches / fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { APP_VERSION } from '../js/config.js';
import { VIEWS } from '../js/views/page-geometry.js';
import { VIEW_NAMES } from '../js/state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const SW_SOURCE = read('sw.js');

function listFiles(dir, ext) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...listFiles(rel, ext));
    else if (name.endsWith(ext)) out.push(rel);
  }
  return out;
}

function appFiles() {
  const m = SW_SOURCE.match(/const APP_FILES = \[([\s\S]*?)\];/);
  assert.ok(m, 'APP_FILES not found in sw.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// ------------------------------------------------------------------ static checks

test('sw.js VERSION equals APP_VERSION (cache name follows the app version)', () => {
  const m = SW_SOURCE.match(/const VERSION = '([^']+)'/);
  assert.ok(m);
  assert.equal(m[1], APP_VERSION);
});

test('version 1.0.5 everywhere: config.js, sw.js and package.json agree', () => {
  assert.equal(APP_VERSION, '1.0.5');
  assert.equal(JSON.parse(read('package.json')).version, APP_VERSION);
});

test('APP_FILES precaches the year page and the two-finger tap module', () => {
  const files = appFiles();
  assert.ok(files.includes('js/views/year-view.js'));
  assert.ok(files.includes('js/ui/gestures.js'));
});

/** Source of a top-level function of main.js (from its declaration to the closing brace at column 0). */
function mainFunction(src, name) {
  let start = src.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = src.indexOf(`\nasync function ${name}(`);
  assert.ok(start >= 0, `main.js: function ${name} not found`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

test('main.js: every page view has a module, a route name and a keyboard shortcut (日 週 月 年)', () => {
  const src = read('js/main.js');
  assert.match(src, /import \* as yearView from '\.\/views\/year-view\.js';/);
  const modules = src.match(/const VIEW_MODULES = \{([^}]*)\}/);
  assert.ok(modules);
  const keys = [...modules[1].matchAll(/(\w+):/g)].map((m) => m[1]);
  assert.deepEqual([...VIEWS], [...VIEW_NAMES], 'state.js routes = page-geometry views');
  for (const v of VIEWS) assert.ok(keys.includes(v), `VIEW_MODULES lacks ${v}`);
  assert.match(src, /const VIEW_KEYS = \{[^}]*y: 'year'[^}]*\}/);
  // The year page's month names open that month; every view gets the callback.
  assert.match(mainFunction(src, 'renderViewNow'), /onMonthTap: guard\(\(month\) => goTo\('month', month\)/);
});

test('main.js: scrolling pages (width / grid) share scroll memory; minutesToY only for hour grids', () => {
  const src = read('js/main.js');
  assert.match(mainFunction(src, 'pageScrolls'), /spec\.fit === 'width' \|\| spec\.fit === 'grid'/);
  // No fit === 'width' special cases are left: month (grid) scrolls too.
  assert.doesNotMatch(src, /fit === 'width'\)? ?(\?|&&|\{)/);
  for (const fn of ['leavePage', 'goToday', 'scrollToInitial', 'relayout', 'rememberReturnScroll']) {
    assert.match(mainFunction(src, fn), /pageScrolls\(/, fn);
  }
  const initial = mainFunction(src, 'initialScrollY');
  assert.match(initial, /typeof mod\?\.initialScrollY === 'function'/);
  assert.match(initial, /Number\.isFinite\(p\.spec\.hourH\)/);
  assert.equal(src.split('minutesToY(').length - 1, 1, 'minutesToY is called only from initialScrollY');
  // The month page gives the toolbar its own strip before it is measured.
  assert.match(mainFunction(src, 'layoutPage'), /app\.dataset\.fit = p\.spec\.fit[\s\S]*applyPageScale/);
  assert.match(read('styles/app.css'), /#app\[data-fit='grid'\] > \.viewport \{\s*margin-bottom:/);
});

test('main.js: a month page left (or signed in) at its top reopens at its top; relayout keeps it there', () => {
  const src = read('js/main.js');
  // leavePage: the remembered ratio comes from scrollMemoryRatio (null for a grid page at its top),
  // and a grid page at its top forgets an older position, so scrollToInitial opens it at the top.
  const leave = mainFunction(src, 'leavePage');
  assert.match(leave, /const ratio = scrollMemoryRatio\(prev\.spec\.fit, S\.els\.viewport\);/);
  assert.match(leave, /if \(ratio !== null\) S\.scrollMemory\.set\(prev\.pageId, ratio\);\s*else if \(prev\.spec\.fit === 'grid'\) S\.scrollMemory\.delete\(prev\.pageId\);/);
  assert.doesNotMatch(leave, /scrollRatio\(\)/);
  // The Google sign-in round trip carries no scroll for it either (rememberReturnScroll then stores nothing).
  const signIn = mainFunction(src, 'startSignIn');
  assert.match(signIn, /pageScrolls\(S\.page\.spec\) \? scrollMemoryRatio\(S\.page\.spec\.fit, S\.els\.viewport\) : null/);
  assert.doesNotMatch(signIn, /scrollRatio\(\)/);
  // Without a memory, the month page (no initialScrollY, no hour grid) starts at y 0.
  assert.match(mainFunction(src, 'scrollToInitial'), /if \(!smooth && S\.scrollMemory\.has\(p\.pageId\)\)[\s\S]*initialScrollY\(p\)/);
  assert.match(mainFunction(src, 'initialScrollY'), /if \(!Number\.isFinite\(p\.spec\.hourH\)\) return 0;/);
  // relayout decides through the tested scrollTopAfterRelayout (a month page at its top stays at the top).
  const relayout = mainFunction(src, 'relayout');
  assert.match(relayout, /scrollTopAfterRelayout\(\{[\s\S]*fit: p\.spec\.fit[\s\S]*\}\);\s*if \(y !== null\) vp\.scrollTop = y;/);
  // Banners change the viewport's top inside keepContentStill, so relayout's prevTop is already the new top.
  assert.match(mainFunction(src, 'updateBanner'), /keepContentStill\(\(\) => \{[\s\S]*showBanner\(elBanner, b\)/);
});

test('main.js: the year page caches only all-day events and refreshes every third periodic tick', () => {
  const src = read('js/main.js');
  const load = mainFunction(src, 'loadEvents');
  // filtered right after the fetch, before the failed-calendar merge, putEvents and the offline copy
  assert.match(load, /let list = \[\.\.\.eventsKeptForView\(p\.view, events\)\];[\s\S]*putEvents\(cacheId, list, key/);
  assert.match(mainFunction(src, 'applyEventChange'), /list = eventsKeptForView\(p\.view, \[/);
  const periodic = mainFunction(src, 'startPeriodicRefresh');
  assert.match(periodic, /periodicRefreshDue\(\{ view: S\.page\.view, at, now: Date\.now\(\), intervalMs: EVENTS_REFRESH_MS \}\)/);
  assert.match(periodic, /if \(!S\.dialogOpen && due\) loadEvents\(S\.page, \{ force: true \}\);/);
});

test('main.js: the two-finger tap listens passively and never blocks scrolling or the swipe', () => {
  const src = read('js/main.js');
  assert.match(mainFunction(src, 'installInteractions'), /installSwipe\(vp\);\s*installTwoFingerTap\(vp\);/);
  const fn = mainFunction(src, 'installTwoFingerTap');
  assert.match(fn, /const opts = \{ capture: true, passive: true \};/);
  assert.doesNotMatch(fn, /passive: false|preventDefault|stopPropagation/);
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    assert.match(fn, new RegExp(`addEventListener\\('${type}'[\\s\\S]*?, opts\\);`), type);
  }
  const blocked = mainFunction(src, 'twoFingerTapBlocked');
  for (const k of ['S.dialogOpen', 'S.welcomeOpen', 'S.leaving', "contactsDown('pen')"]) assert.ok(blocked.includes(k), k);
  // Like a toolbar tap (selectTool), then a 1 s toast.
  const toggle = mainFunction(src, 'toggleEraserByTap');
  assert.match(toggle, /twoFingerTapTool\(st\.tool, st\.lastInkTool\)/);
  assert.match(toggle, /selectTool\(next\.tool\)/);
  assert.match(src, /const TOOL_TOAST_MS = 1000;/);
});

test('APP_FILES: every entry exists, and every app module / stylesheet is listed', () => {
  const files = appFiles();
  assert.equal(new Set(files).size, files.length, 'duplicates in APP_FILES');
  for (const f of files) {
    const p = f === './' ? 'index.html' : f;
    assert.ok(existsSync(join(ROOT, p)), `listed but missing: ${f}`);
  }
  const listed = new Set(files);
  for (const f of [...listFiles('js', '.js'), ...listFiles('styles', '.css')]) {
    assert.ok(listed.has(relative(ROOT, join(ROOT, f))), `not precached: ${f}`);
  }
  for (const f of ['./', 'index.html', 'manifest.webmanifest', 'js/main.js', 'js/boot-watchdog.js']) {
    assert.ok(listed.has(f), `missing ${f}`);
  }
});

test('manifest: id is app-specific (not the origin root), start_url/scope relative, icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  // id resolves against start_url's ORIGIN: './' or '/' would be the whole github.io account.
  assert.ok(typeof m.id === 'string' && m.id.length > 0);
  assert.notEqual(new URL(m.id, 'https://syfan0-star.github.io/').pathname, '/');
  assert.equal(new URL(m.id, 'https://syfan0-star.github.io/').href, 'https://syfan0-star.github.io/tegaki-calendar');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  for (const icon of m.icons) assert.ok(existsSync(join(ROOT, icon.src)), icon.src);
});

test('index.html: the classic boot watchdog runs before the module, splash text is addressable', () => {
  const html = read('index.html');
  const watchdog = html.indexOf('<script src="js/boot-watchdog.js"></script>');
  const main = html.indexOf('<script type="module" src="js/main.js"></script>');
  assert.ok(watchdog > 0 && main > watchdog);
  assert.match(html, /class="boot-splash-text"/);
  assert.match(html, /id="boot-splash"/);
  assert.match(html, /script-src 'self';/); // no inline scripts (hence the external watchdog)
  assert.match(html, /\.leave-shield/);
});

test('boot watchdog never touches the handwriting (IndexedDB / localStorage) and only this app’s caches', () => {
  const src = read('js/boot-watchdog.js').replace(/\/\/.*$/gm, ''); // code only, not the comments
  assert.doesNotMatch(src, /indexedDB|localStorage|sessionStorage/);
  assert.match(src, /'tegaki-v'/);
  assert.match(src, /__tegakiBooted/);
  assert.match(read('js/main.js'), /window\.__tegakiBooted = true/);
});

// ------------------------------------------------------------------ service worker behaviour (vm)

class FakeCache {
  constructor() {
    this.map = new Map();
  }

  static key(req, ignoreSearch) {
    const u = new URL(typeof req === 'string' ? req : req.url);
    if (ignoreSearch) u.search = '';
    return u.href;
  }

  async match(req, opts) {
    const ignore = !!(opts && opts.ignoreSearch);
    for (const [k, v] of this.map) {
      if (FakeCache.key(k, ignore) === FakeCache.key(req, ignore)) return v.clone();
    }
    return undefined;
  }

  async put(req, res) {
    this.map.set(FakeCache.key(req, false), res);
  }
}

function loadWorker({ fetchImpl, timeoutMs } = {}) {
  const listeners = {};
  const stores = new Map();
  const cachesApi = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  const self = {
    location: new URL('https://syfan0-star.github.io/tegaki-calendar/sw.js'),
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    clients: { claim: async () => {} },
    skipWaiting: () => {},
  };
  const context = vm.createContext({
    self,
    caches: cachesApi,
    fetch: fetchImpl,
    Request,
    Response,
    URL,
    Promise,
    Symbol,
    Set,
    Map,
    Date,
    console: { warn() {}, log() {} },
    setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms),
    clearTimeout,
  });
  vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' });
  const cacheName = `tegaki-v${APP_VERSION}`;
  return { listeners, stores, cachesApi, cacheName };
}

/** Dispatches a fetch event; resolves with the Response given to respondWith (and all waitUntil done). */
async function dispatchFetch(listeners, { url, mode = 'no-cors', destination = 'script', clientId = '', resultingClientId = '' }) {
  const request = new Request(url);
  Object.defineProperty(request, 'mode', { value: mode });
  Object.defineProperty(request, 'destination', { value: destination });
  let responded = null;
  const waits = [];
  const event = {
    request, clientId, resultingClientId,
    respondWith(p) {
      responded = Promise.resolve(p);
    },
    waitUntil(p) {
      waits.push(Promise.resolve(p));
    },
  };
  listeners.fetch(event);
  assert.ok(responded, 'respondWith was not called');
  const response = await responded;
  await Promise.all(waits);
  return response;
}

const BASE = 'https://syfan0-star.github.io/tegaki-calendar/';

/** A same-origin network response (Node's Response has type 'default'; browsers report 'basic'). */
function basic(body, init = { status: 200 }) {
  const res = new Response(body, init);
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

test('sw: a 5xx / 404 from the server falls back to a cached copy', async () => {
  let status = 503;
  const w = loadWorker({ fetchImpl: async () => basic('server says no', { status }) });
  const cache = await w.cachesApi.open(w.cacheName);
  await cache.put(`${BASE}js/main.js`, new Response('cached main', { status: 200 }));
  let res = await dispatchFetch(w.listeners, { url: `${BASE}js/main.js` });
  assert.equal(await res.text(), 'cached main');
  status = 404;
  res = await dispatchFetch(w.listeners, { url: `${BASE}js/main.js` });
  assert.equal(await res.text(), 'cached main');
  // Nothing cached: the server's answer is passed on.
  res = await dispatchFetch(w.listeners, { url: `${BASE}js/other.js` });
  assert.equal(res.status, 404);
});

test('sw: a navigation answered from the cache makes that load cache-first (no mixed versions)', async () => {
  let online = false;
  let fetches = 0;
  const w = loadWorker({
    fetchImpl: async (req) => {
      fetches += 1;
      if (!online) throw new TypeError('network down');
      return basic(`network ${new URL(req.url).pathname}`);
    },
  });
  const cache = await w.cachesApi.open(w.cacheName);
  await cache.put(BASE, new Response('cached index', { status: 200 }));
  await cache.put(`${BASE}js/main.js`, new Response('cached main', { status: 200 }));

  const page = await dispatchFetch(w.listeners, { url: BASE, mode: 'navigate', destination: 'document', resultingClientId: 'c1' });
  assert.equal(await page.text(), 'cached index');
  // The network is back a moment later: this page load still gets its modules from the same (cached) version.
  online = true;
  const before = fetches;
  const mod = await dispatchFetch(w.listeners, { url: `${BASE}js/main.js`, clientId: 'c1' });
  assert.equal(await mod.text(), 'cached main');
  assert.equal(fetches, before, 'no network request for a cache-first subresource');
  // A module that is not cached still comes from the network.
  const other = await dispatchFetch(w.listeners, { url: `${BASE}js/new.js`, clientId: 'c1' });
  assert.equal(await other.text(), 'network /tegaki-calendar/js/new.js');

  // A new navigation from the network ends cache-first mode for other clients.
  await dispatchFetch(w.listeners, { url: BASE, mode: 'navigate', destination: 'document', resultingClientId: 'c2' });
  const fresh = await dispatchFetch(w.listeners, { url: `${BASE}js/main.js`, clientId: 'c2' });
  assert.equal(await fresh.text(), 'network /tegaki-calendar/js/main.js');
});

test('sw: offline navigation without any cache shows the offline page with a reload link', async () => {
  const w = loadWorker({ fetchImpl: async () => { throw new TypeError('offline'); } });
  const res = await dispatchFetch(w.listeners, { url: BASE, mode: 'navigate', destination: 'document' });
  assert.equal(res.status, 503);
  const html = await res.text();
  assert.match(html, /<a href="\.\/"[^>]*>もう一度読み込む<\/a>/);
});

test('sw: successful responses refresh the cache (kept alive with waitUntil)', async () => {
  const w = loadWorker({ fetchImpl: async () => basic('fresh') });
  const res = await dispatchFetch(w.listeners, { url: `${BASE}styles/app.css` });
  assert.equal(await res.text(), 'fresh'); // the page still gets a readable body
  const cache = await w.cachesApi.open(w.cacheName);
  const hit = await cache.match(`${BASE}styles/app.css`);
  assert.equal(await hit.text(), 'fresh');
});

test('sw: an incomplete precache fails the install (the old complete cache survives)', async () => {
  const w = loadWorker({
    fetchImpl: async (req) => (String(req.url).endsWith('js/main.js')
      ? basic('nope', { status: 500 })
      : basic('ok')),
  });
  let installed = null;
  w.listeners.install({ waitUntil: (p) => { installed = Promise.resolve(p); } });
  await assert.rejects(installed, /precache incomplete/);

  const ok = loadWorker({ fetchImpl: async () => basic('ok') });
  let done = null;
  ok.listeners.install({ waitUntil: (p) => { done = Promise.resolve(p); } });
  await done; // resolves
});
