import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuth, AUTH_KEYS, AUTH_ENDPOINT, REVOKE_ENDPOINT, normalizeScopes } from '../js/google/auth.js';
import {
  APP_VERSION, GOOGLE_CLIENT_ID, SCOPES, PAGES_ORIGIN_PATH, redirectUri, isGoogleConfigured,
} from '../js/config.js';

const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const REDIRECT = 'https://syfan0-star.github.io/tegaki-calendar/';
const ALL_SCOPES = [SCOPES.events, SCOPES.calList, SCOPES.appdata];

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function fakeLocation(hash = '') {
  return {
    hash,
    pathname: '/tegaki-calendar/',
    search: '',
    assigned: [],
    assign(url) { this.assigned.push(url); },
  };
}

function fakeHistory() {
  return {
    state: { keep: 1 },
    calls: [],
    replaceState(state, title, url) { this.calls.push({ state, title, url }); },
  };
}

function setup({ hash = '', storage = fakeStorage(), t = 1_700_000_000_000, fetchImpl } = {}) {
  const clock = { t };
  const location = fakeLocation(hash);
  const history = fakeHistory();
  const auth = createAuth({
    clientId: CLIENT_ID,
    scopes: SCOPES,
    redirectUri: REDIRECT,
    storage,
    location,
    history,
    now: () => clock.t,
    fetchImpl,
  });
  return { auth, storage, location, history, clock };
}

/** Signs in (navigates) and builds the fragment Google would send back. */
function startAndRespond(ctx, { silent = false, returnState = null, fragment = {} } = {}) {
  const url = ctx.auth.signIn({ silent, returnState });
  const state = new URL(url).searchParams.get('state');
  const params = new URLSearchParams({ state, ...fragment });
  ctx.location.hash = `#${params.toString()}`;
  return { url, state };
}

// ---------------- config.js ----------------

test('config constants', () => {
  // One version everywhere: the service worker cache name and package.json follow js/config.js.
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.equal(sw.match(/const VERSION = '([^']+)'/)[1], APP_VERSION);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, APP_VERSION);
  // Empty until the Google Cloud setup is done, then a web client id.
  assert.ok(GOOGLE_CLIENT_ID === '' || GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com'));
  assert.equal(PAGES_ORIGIN_PATH, 'https://syfan0-star.github.io/tegaki-calendar/');
  assert.equal(SCOPES.events, 'https://www.googleapis.com/auth/calendar.events');
  assert.equal(SCOPES.calList, 'https://www.googleapis.com/auth/calendar.calendarlist.readonly');
  assert.equal(SCOPES.appdata, 'https://www.googleapis.com/auth/drive.appdata');
  assert.ok(Object.isFrozen(SCOPES));
});

test('isGoogleConfigured: false while the client id is empty', () => {
  assert.equal(isGoogleConfigured(), GOOGLE_CLIENT_ID !== '');
  assert.equal(isGoogleConfigured(''), false);
  assert.equal(isGoogleConfigured('.apps.googleusercontent.com'), false);
  assert.equal(isGoogleConfigured('abc.example.com'), false);
  assert.equal(isGoogleConfigured(CLIENT_ID), true);
});

test('redirectUri: exact constant by hostname, never from href', () => {
  assert.equal(redirectUri({ hostname: 'localhost', origin: 'http://localhost:8000', href: 'http://localhost:8000/index.html?x#y' }), 'http://localhost:8000/');
  assert.equal(redirectUri({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:5500' }), 'http://127.0.0.1:5500/');
  assert.equal(redirectUri({ hostname: 'localhost', protocol: 'http:', host: 'localhost:8000' }), 'http://localhost:8000/');
  assert.equal(redirectUri({ hostname: 'syfan0-star.github.io', origin: 'https://syfan0-star.github.io', href: 'https://syfan0-star.github.io/tegaki-calendar/index.html' }), PAGES_ORIGIN_PATH);
  assert.equal(redirectUri({ hostname: 'evil.example', origin: 'https://evil.example' }), PAGES_ORIGIN_PATH);
  assert.equal(redirectUri(undefined), PAGES_ORIGIN_PATH); // Node: no location
});

// ---------------- auth.js ----------------

test('normalizeScopes accepts array, object and string', () => {
  assert.deepEqual(normalizeScopes(SCOPES), ALL_SCOPES);
  assert.deepEqual(normalizeScopes(ALL_SCOPES.join(' ')), ALL_SCOPES);
  assert.deepEqual(normalizeScopes([...ALL_SCOPES, ALL_SCOPES[0], '', 3]), ALL_SCOPES);
  assert.deepEqual(normalizeScopes(null), []);
});

test('handleRedirect with no OAuth fragment → none, URL untouched', () => {
  const ctx = setup({ hash: '#something-else' });
  assert.deepEqual(ctx.auth.handleRedirect(), { status: 'none' });
  assert.equal(ctx.history.calls.length, 0);
  assert.equal(setup().auth.handleRedirect().status, 'none');
});

test('signIn builds the implicit-flow URL and stores a pending state', () => {
  const ctx = setup();
  ctx.auth.setLoginHint('me@example.com');
  const url = ctx.auth.signIn({ returnState: { view: 'week', date: '2026-10-04' } });
  assert.deepEqual(ctx.location.assigned, [url]);
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, AUTH_ENDPOINT);
  const p = u.searchParams;
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), REDIRECT);
  assert.equal(p.get('response_type'), 'token');
  assert.equal(p.get('scope'), ALL_SCOPES.join(' '));
  assert.equal(p.get('include_granted_scopes'), 'true');
  assert.equal(p.get('login_hint'), 'me@example.com');
  assert.equal(p.has('prompt'), false);
  assert.match(p.get('state'), /^[A-Za-z0-9_-]{43}$/);
  const pending = JSON.parse(ctx.storage.getItem(AUTH_KEYS.pending));
  assert.equal(pending.state, p.get('state'));
  assert.equal(pending.silent, false);
  assert.deepEqual(pending.returnState, { view: 'week', date: '2026-10-04' });
  assert.equal(pending.t, ctx.clock.t);
  assert.equal(ctx.storage.getItem(AUTH_KEYS.lastSilent), null);
});

test('signIn variants: silent → prompt=none + lastSilent; consent; explicit login hint', () => {
  const ctx = setup();
  const silent = new URL(ctx.auth.signIn({ silent: true })).searchParams;
  assert.equal(silent.get('prompt'), 'none');
  assert.equal(ctx.storage.getItem(AUTH_KEYS.lastSilent), String(ctx.clock.t));
  assert.equal(silent.has('login_hint'), false);
  const consent = new URL(ctx.auth.signIn({ consent: true, loginHint: 'x@y.z' })).searchParams;
  assert.equal(consent.get('prompt'), 'consent');
  assert.equal(consent.get('login_hint'), 'x@y.z');
  assert.equal(new URL(ctx.auth.signIn({ prompt: 'select_account' })).searchParams.get('prompt'), 'select_account');
  assert.equal(new URL(ctx.auth.signIn({ prompt: 'bogus' })).searchParams.has('prompt'), false);
  // each attempt gets a fresh state
  const s1 = new URL(ctx.auth.signIn()).searchParams.get('state');
  const s2 = new URL(ctx.auth.signIn()).searchParams.get('state');
  assert.notEqual(s1, s2);
});

test('signIn without a client id throws (Google not configured)', () => {
  const auth = createAuth({ clientId: '', scopes: SCOPES, redirectUri: REDIRECT, storage: fakeStorage(), location: fakeLocation(), history: fakeHistory() });
  assert.throws(() => auth.signIn(), /設定/);
});

test('redirectUri may be a function', () => {
  const location = fakeLocation();
  const auth = createAuth({ clientId: CLIENT_ID, scopes: SCOPES, redirectUri: () => 'http://localhost:8000/', storage: fakeStorage(), location, history: fakeHistory() });
  assert.equal(new URL(auth.signIn()).searchParams.get('redirect_uri'), 'http://localhost:8000/');
});

test('successful redirect: token stored, fragment stripped, pending consumed', () => {
  const ctx = setup();
  startAndRespond(ctx, {
    returnState: { view: 'month', date: '2026-10-01' },
    fragment: { access_token: 'ya29.secret', token_type: 'Bearer', expires_in: '3599', scope: ALL_SCOPES.join(' ') },
  });
  ctx.clock.t += 5000; // Google round trip
  const r = ctx.auth.handleRedirect();
  assert.equal(r.status, 'success');
  assert.deepEqual(r.returnState, { view: 'month', date: '2026-10-01' });
  assert.deepEqual(r.scopes, ALL_SCOPES);
  assert.equal(r.silent, false);
  assert.deepEqual(ctx.history.calls, [{ state: { keep: 1 }, title: '', url: '/tegaki-calendar/' }]);
  assert.equal(ctx.storage.getItem(AUTH_KEYS.pending), null);
  assert.equal(ctx.storage.getItem(AUTH_KEYS.ever), '1');
  const stored = JSON.parse(ctx.storage.getItem(AUTH_KEYS.token));
  assert.equal(stored.access_token, 'ya29.secret');
  assert.equal(stored.exp, ctx.clock.t + (3599 - 120) * 1000);
  assert.deepEqual(stored.scopes, ALL_SCOPES);
  assert.equal(ctx.auth.getToken(), 'ya29.secret');
  assert.equal(ctx.auth.isSignedIn(), true);
  assert.equal(ctx.auth.hasEverSignedIn(), true);
  assert.equal(ctx.auth.expiresAt(), stored.exp);
  assert.equal(ctx.auth.lastError(), null);
});

test('the same fragment cannot be replayed (one-time state)', () => {
  const ctx = setup();
  startAndRespond(ctx, { fragment: { access_token: 'tok', expires_in: '3600', scope: SCOPES.events } });
  const hash = ctx.location.hash;
  assert.equal(ctx.auth.handleRedirect().status, 'success');
  ctx.location.hash = hash; // replay
  const again = ctx.auth.handleRedirect();
  assert.deepEqual(again, { status: 'error', error: 'state_mismatch' });
  assert.equal(ctx.auth.lastError(), 'state_mismatch');
});

test('state mismatch / missing / stale → state_mismatch and no token', () => {
  // mismatched
  let ctx = setup();
  ctx.auth.signIn();
  ctx.location.hash = '#access_token=evil&state=forged&expires_in=3600';
  assert.deepEqual(ctx.auth.handleRedirect(), { status: 'error', error: 'state_mismatch' });
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.storage.getItem(AUTH_KEYS.pending), null);
  assert.equal(ctx.history.calls.length, 1); // fragment still stripped

  // no pending at all (injected token)
  ctx = setup({ hash: '#access_token=evil&state=x' });
  assert.equal(ctx.auth.handleRedirect().error, 'state_mismatch');

  // state param missing
  ctx = setup();
  ctx.auth.signIn();
  ctx.location.hash = '#access_token=evil';
  assert.equal(ctx.auth.handleRedirect().error, 'state_mismatch');

  // stale (> 10 min)
  ctx = setup();
  startAndRespond(ctx, { fragment: { access_token: 'late', scope: SCOPES.events } });
  ctx.clock.t += 10 * 60 * 1000 + 1;
  assert.equal(ctx.auth.handleRedirect().error, 'state_mismatch');
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.auth.hasEverSignedIn(), false);

  // pending from the future (clock moved back) is not trusted
  ctx = setup();
  startAndRespond(ctx, { fragment: { access_token: 'x', scope: SCOPES.events } });
  ctx.clock.t -= 60_000;
  assert.equal(ctx.auth.handleRedirect().error, 'state_mismatch');
});

test('error fragment (e.g. silent attempt failed) → error with silent flag and returnState', () => {
  const ctx = setup();
  startAndRespond(ctx, { silent: true, returnState: { view: 'day' }, fragment: { error: 'interaction_required' } });
  const r = ctx.auth.handleRedirect();
  assert.deepEqual(r, { status: 'error', error: 'interaction_required', silent: true, returnState: { view: 'day' } });
  assert.equal(ctx.auth.lastError(), 'interaction_required');
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.history.calls.length, 1);

  const ctx2 = setup();
  startAndRespond(ctx2, { fragment: { error: 'access_denied' } });
  const r2 = ctx2.auth.handleRedirect();
  assert.equal(r2.error, 'access_denied');
  assert.equal(r2.silent, false);
});

test('granular consent: only granted scopes count; "+"-separated scope param', () => {
  const ctx = setup();
  const state = new URL(ctx.auth.signIn()).searchParams.get('state');
  // Google may send '+' between scopes
  ctx.location.hash = `#access_token=t&expires_in=3600&state=${state}&scope=${encodeURIComponent(SCOPES.calList)}+${encodeURIComponent(SCOPES.appdata)}`;
  const r = ctx.auth.handleRedirect();
  assert.equal(r.status, 'success');
  assert.deepEqual(r.scopes, [SCOPES.calList, SCOPES.appdata]);
  assert.deepEqual(ctx.auth.grantedScopes(), [SCOPES.calList, SCOPES.appdata]);
  assert.equal(ctx.auth.hasScopes([SCOPES.appdata]), true);
  assert.equal(ctx.auth.hasScopes(SCOPES.appdata), true);
  assert.equal(ctx.auth.hasScopes([SCOPES.events, SCOPES.appdata]), false);
  assert.equal(ctx.auth.hasScopes([]), true);
});

test('missing expires_in defaults to 3600 s; missing scope falls back to requested scopes', () => {
  const ctx = setup();
  startAndRespond(ctx, { fragment: { access_token: 't' } });
  ctx.auth.handleRedirect();
  assert.equal(ctx.auth.expiresAt(), ctx.clock.t + (3600 - 120) * 1000);
  assert.deepEqual(ctx.auth.grantedScopes(), ALL_SCOPES);
});

test('getToken returns null when 60 s or less remain', () => {
  const ctx = setup();
  startAndRespond(ctx, { fragment: { access_token: 'tok', expires_in: '3600', scope: SCOPES.events } });
  ctx.auth.handleRedirect();
  const exp = ctx.auth.expiresAt();
  ctx.clock.t = exp - 61_000;
  assert.equal(ctx.auth.getToken(), 'tok');
  ctx.clock.t = exp - 60_000;
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.auth.isSignedIn(), false);
  assert.equal(ctx.auth.expiresAt(), exp); // still known after expiry
  assert.deepEqual(ctx.auth.grantedScopes(), [SCOPES.events]);
});

test('corrupt storage is tolerated', () => {
  const storage = fakeStorage({ [AUTH_KEYS.token]: '{not json', [AUTH_KEYS.pending]: 'garbage' });
  const ctx = setup({ storage });
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.auth.expiresAt(), null);
  assert.deepEqual(ctx.auth.grantedScopes(), []);
  ctx.location.hash = '#access_token=x&state=y';
  assert.equal(ctx.auth.handleRedirect().error, 'state_mismatch');

  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const c2 = setup({ storage: throwing });
    assert.equal(c2.auth.getToken(), null);
    // The one-time state cannot be stored: never navigate (the answer would be a state_mismatch loop).
    assert.throws(() => c2.auth.signIn(), /storage unavailable/);
    assert.throws(() => c2.auth.signIn({ silent: true }), /storage unavailable/);
    assert.equal(c2.location.assigned.length, 0);
    // Quota: the pending state is written but the lastSilent time gate is not → a silent attempt must not leave.
    const quota = fakeStorage();
    const setItem = quota.setItem;
    quota.setItem = (k, v) => { if (k === AUTH_KEYS.lastSilent) throw new Error('QuotaExceededError'); setItem(k, v); };
    const c3 = setup({ storage: quota });
    assert.throws(() => c3.auth.signIn({ silent: true }), /storage unavailable/);
    assert.equal(c3.location.assigned.length, 0);
    assert.equal(quota.getItem(AUTH_KEYS.pending), null, 'no stale pending state left behind');
    assert.doesNotThrow(() => c3.auth.signIn()); // interactive sign-in needs no time gate
  } finally {
    console.warn = warn;
  }
});

test('login hint and canTrySilent time gate', () => {
  const ctx = setup();
  assert.equal(ctx.auth.loginHint(), null);
  ctx.auth.setLoginHint('  me@example.com ');
  assert.equal(ctx.auth.loginHint(), 'me@example.com');
  ctx.auth.setLoginHint(null);
  assert.equal(ctx.auth.loginHint(), null);

  assert.equal(ctx.auth.canTrySilent(), false); // never signed in
  ctx.storage.setItem(AUTH_KEYS.ever, '1');
  assert.equal(ctx.auth.canTrySilent(), true); // hint not required
  ctx.auth.signIn({ silent: true });
  assert.equal(ctx.auth.canTrySilent(), false);
  ctx.clock.t += 5 * 60 * 1000;
  assert.equal(ctx.auth.canTrySilent(), false);
  ctx.clock.t += 1;
  assert.equal(ctx.auth.canTrySilent(), true);
  // clock moved back: a future lastSilent must not block forever
  ctx.storage.setItem(AUTH_KEYS.lastSilent, String(ctx.clock.t + 3_600_000));
  assert.equal(ctx.auth.canTrySilent(), true);
});

test('clearToken expires the token but keeps the granted scopes, hint and ever', () => {
  const ctx = setup();
  ctx.auth.setLoginHint('me@example.com');
  startAndRespond(ctx, { fragment: { access_token: 'tok', scope: `${SCOPES.events} ${SCOPES.appdata}` } });
  ctx.auth.handleRedirect();
  ctx.auth.clearToken();
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.auth.isSignedIn(), false);
  assert.equal(ctx.auth.hasEverSignedIn(), true);
  assert.equal(ctx.auth.loginHint(), 'me@example.com');
  // After a 401 + restart the app still knows its capabilities (it needs 再接続, not 権限を追加).
  const restarted = createAuth({ clientId: CLIENT_ID, scopes: SCOPES, redirectUri: REDIRECT, storage: ctx.storage, now: () => ctx.clock.t });
  assert.deepEqual(restarted.grantedScopes().sort(), [SCOPES.events, SCOPES.appdata].sort());
  assert.equal(restarted.hasScopes([SCOPES.appdata]), true);
  assert.equal(restarted.getToken(), null);
  // The next successful sign-in replaces it completely.
  startAndRespond(ctx, { fragment: { access_token: 'tok2', scope: ALL_SCOPES.join(' ') } });
  ctx.auth.handleRedirect();
  assert.equal(ctx.auth.getToken(), 'tok2');
});

test('clearToken(token) expires only that token: a newer one (other window, re-auth) survives a late 401', () => {
  const ctx = setup();
  startAndRespond(ctx, { fragment: { access_token: 'new-tok', scope: SCOPES.events } });
  ctx.auth.handleRedirect();
  ctx.auth.clearToken('old-tok');
  assert.equal(ctx.auth.getToken(), 'new-tok');
  ctx.auth.clearToken('new-tok');
  assert.equal(ctx.auth.getToken(), null);
  assert.deepEqual(ctx.auth.grantedScopes(), [SCOPES.events]);
  assert.equal(ctx.auth.expiresAt(), 0);
  // Garbage in storage is simply dropped.
  ctx.storage.setItem(AUTH_KEYS.token, '{"broken"');
  ctx.auth.clearToken();
  assert.equal(ctx.storage.getItem(AUTH_KEYS.token), null);
});

test('signOut clears storage first, then revokes (form-urlencoded POST)', async () => {
  const calls = [];
  let storageAtRevoke = null;
  let ctx;
  const fetchImpl = async (url, init) => {
    storageAtRevoke = [...ctx.storage.map.keys()];
    calls.push({ url, init });
    return new Response('{}', { status: 200 });
  };
  ctx = setup({ fetchImpl });
  ctx.auth.setLoginHint('me@example.com');
  startAndRespond(ctx, { fragment: { access_token: 'tok/with+chars', scope: SCOPES.events } });
  ctx.auth.handleRedirect();
  ctx.storage.setItem(AUTH_KEYS.lastSilent, '1');

  await ctx.auth.signOut();
  assert.deepEqual(storageAtRevoke, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REVOKE_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].init.keepalive, true, 'survives the reload that follows a sign-out');
  assert.equal(new URLSearchParams(calls[0].init.body).get('token'), 'tok/with+chars');
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.auth.hasEverSignedIn(), false);
  assert.equal(ctx.auth.loginHint(), null);
  assert.equal(ctx.auth.canTrySilent(), false);
});

test('signOut ignores revoke failures and skips revoke without a token', async () => {
  let n = 0;
  const failing = async () => { n++; throw new TypeError('offline'); };
  const ctx = setup({ fetchImpl: failing });
  await ctx.auth.signOut(); // no token → no request
  assert.equal(n, 0);
  startAndRespond(ctx, { fragment: { access_token: 'tok', scope: SCOPES.events } });
  ctx.auth.handleRedirect();
  await assert.doesNotReject(ctx.auth.signOut());
  assert.equal(n, 1);
  assert.equal(ctx.auth.getToken(), null);
});

test('signOut does not wait for a revoke that never answers (captive / stalled network)', async () => {
  let calls = 0;
  const hanging = () => { calls++; return new Promise(() => {}); };
  const ctx = setup({ fetchImpl: hanging });
  startAndRespond(ctx, { fragment: { access_token: 'tok', scope: SCOPES.events } });
  ctx.auth.handleRedirect();
  const started = Date.now();
  await ctx.auth.signOut({ timeoutMs: 30 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls, 1);
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.auth.hasEverSignedIn(), false);
});

test('signOut does not try to revoke a token Google already rejected (401 → clearToken)', async () => {
  let calls = 0;
  const ctx = setup({ fetchImpl: async () => { calls++; return new Response('{}'); } });
  startAndRespond(ctx, { fragment: { access_token: 'tok', scope: SCOPES.events } });
  ctx.auth.handleRedirect();
  ctx.auth.clearToken('tok');
  await ctx.auth.signOut();
  assert.equal(calls, 0);
  assert.deepEqual(ctx.auth.grantedScopes(), [], 'sign-out forgets everything');
});

test('signOut({ revoke: false }) signs out locally without ending the grant on other devices', async () => {
  let calls = 0;
  const ctx = setup({ fetchImpl: async () => { calls++; return new Response('{}'); } });
  startAndRespond(ctx, { fragment: { access_token: 'tok', scope: SCOPES.events } });
  ctx.auth.handleRedirect();
  await ctx.auth.signOut({ revoke: false });
  assert.equal(calls, 0);
  assert.equal(ctx.auth.getToken(), null);
  assert.equal(ctx.auth.hasEverSignedIn(), false);
});

test('returnState that is not JSON-serializable is dropped', () => {
  const ctx = setup();
  const cyclic = {};
  cyclic.self = cyclic;
  ctx.auth.signIn({ returnState: cyclic });
  assert.equal(JSON.parse(ctx.storage.getItem(AUTH_KEYS.pending)).returnState, null);
});
