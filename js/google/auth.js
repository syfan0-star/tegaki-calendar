// Google OAuth 2.0 — implicit grant by full-page redirect (response_type=token).
//
// Why: GIS's token client has no redirect mode and its popup is unreliable in iOS home-screen apps,
// so the same redirect code serves Safari tabs and standalone PWAs. Google documents this flow as
// legacy; everything about it lives here so it can be swapped for a backend code+PKCE flow later.
//
// All browser objects (storage, location, history) are injected so this module runs in Node tests.
// Never log the access token.

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** localStorage keys (SPEC §6). */
export const AUTH_KEYS = Object.freeze({
  token: 'tegaki.auth.token',          // { access_token, exp (ms), scopes: string[] }
  pending: 'tegaki.auth.pending',      // { state, silent, returnState, t } — one-time, 10-min TTL
  hint: 'tegaki.auth.hint',            // login_hint (email)
  lastSilent: 'tegaki.auth.lastSilent', // ms of the last prompt=none attempt
  ever: 'tegaki.auth.ever',            // '1' once a sign-in succeeded
});

const PENDING_TTL_MS = 10 * 60 * 1000;
const TOKEN_MIN_LEFT_MS = 60 * 1000;
const EXPIRY_MARGIN_S = 120;
const DEFAULT_EXPIRES_IN_S = 3600;
const SILENT_INTERVAL_MS = 5 * 60 * 1000;
/** signOut() waits at most this long for the revoke request (it keeps going in the background). */
const REVOKE_WAIT_MS = 3000;

/**
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string[]|Record<string,string>|string} opts.scopes  array, SCOPES-like object, or space-separated string
 * @param {string|(() => string)} opts.redirectUri  exact registered redirect URI (or a function returning it)
 * @param {Storage} [opts.storage]   localStorage-like (getItem/setItem/removeItem); defaults to globalThis.localStorage
 * @param {Location} [opts.location] needs hash, pathname, search, assign(); defaults to globalThis.location
 * @param {History} [opts.history]   needs replaceState(); defaults to globalThis.history
 * @param {() => number} [opts.now]
 * @param {typeof fetch} [opts.fetchImpl]  used for revoke only
 */
export function createAuth({
  clientId,
  scopes,
  redirectUri,
  storage,
  location,
  history,
  now = Date.now,
  fetchImpl,
} = {}) {
  const store = createStore(storage);
  const requestedScopes = normalizeScopes(scopes);
  const loc = () => location || globalThis.location;
  const hist = () => history || globalThis.history;
  const clock = () => {
    const t = Number(now());
    return Number.isFinite(t) ? t : Date.now();
  };
  let lastErrorCode = null;

  // ---- token ----

  function readToken() {
    const t = store.getJSON(AUTH_KEYS.token);
    if (!t || typeof t !== 'object' || typeof t.access_token !== 'string' || !t.access_token) return null;
    if (!Number.isFinite(t.exp)) return null;
    return { access_token: t.access_token, exp: t.exp, scopes: Array.isArray(t.scopes) ? t.scopes.filter((s) => typeof s === 'string') : [] };
  }

  /** Access token if more than 60 s remain, else null. */
  function getToken() {
    const t = readToken();
    return t && t.exp - clock() > TOKEN_MIN_LEFT_MS ? t.access_token : null;
  }

  // ---- redirect handling ----

  /**
   * Runs FIRST at boot. Consumes an OAuth response in location.hash, if any.
   * @returns {{ status: 'none' } |
   *   { status: 'success', returnState: any, scopes: string[], silent: boolean } |
   *   { status: 'error', error: string, silent?: boolean, returnState?: any }}
   */
  function handleRedirect() {
    const l = loc();
    const hash = l && typeof l.hash === 'string' ? l.hash : '';
    const params = new URLSearchParams(hash.replace(/^#/, '')); // '+' and %20 both decode to ' '
    if (!params.has('access_token') && !params.has('error')) return { status: 'none' };

    stripFragment(l);
    const pending = store.getJSON(AUTH_KEYS.pending);
    store.remove(AUTH_KEYS.pending); // one-time use, whatever the outcome

    if (!isPendingValid(pending, params.get('state'))) return fail('state_mismatch');

    const silent = !!pending.silent;
    const returnState = pending.returnState === undefined ? null : pending.returnState;
    const error = params.get('error');
    if (error) return { ...fail(error), silent, returnState };

    const accessToken = params.get('access_token');
    if (!accessToken) return { ...fail('invalid_response'), silent, returnState };

    const expiresIn = parseExpiresIn(params.get('expires_in'));
    const granted = parseScopeParam(params.get('scope'));
    // Google always returns `scope`; if it ever does not, assume what we asked for (the API will 403 otherwise).
    const scopeList = granted.length ? granted : requestedScopes.slice();
    store.setJSON(AUTH_KEYS.token, {
      access_token: accessToken,
      exp: clock() + Math.max(0, expiresIn - EXPIRY_MARGIN_S) * 1000,
      scopes: scopeList,
    });
    store.set(AUTH_KEYS.ever, '1');
    lastErrorCode = null;
    return { status: 'success', returnState, scopes: scopeList.slice(), silent };
  }

  function fail(code) {
    lastErrorCode = code;
    return { status: 'error', error: code };
  }

  function isPendingValid(pending, state) {
    if (!pending || typeof pending !== 'object') return false;
    if (typeof pending.state !== 'string' || !pending.state) return false;
    if (!state || state !== pending.state) return false;
    const age = clock() - Number(pending.t);
    return Number.isFinite(age) && age >= 0 && age <= PENDING_TTL_MS;
  }

  /** Removes the token from the address bar and from history (keeps path + query). */
  function stripFragment(l) {
    const h = hist();
    try {
      if (h && typeof h.replaceState === 'function') {
        h.replaceState(h.state ?? null, '', `${l.pathname || ''}${l.search || ''}`);
      }
    } catch (e) {
      console.warn('[auth] could not strip the URL fragment:', e && e.message);
    }
  }

  // ---- sign-in / out ----

  /**
   * Builds the authorization URL and navigates to it (full-page redirect).
   * Callers must persist ink/route before calling (JS memory is lost).
   * @param {object} [o]
   * @param {boolean} [o.silent=false]  prompt=none
   * @param {any} [o.returnState=null]  JSON-serializable state handed back by handleRedirect()
   * @param {string} [o.loginHint]      overrides the remembered hint
   * @param {boolean} [o.consent=false] prompt=consent (「権限を追加」)
   * @param {string} [o.prompt]         explicit prompt value for interactive sign-in ('consent' | 'select_account')
   * @returns {string} the URL navigated to
   * @throws {Error} 'storage unavailable' (nothing navigated) when the one-time state could not be stored
   */
  function signIn({ silent = false, returnState = null, loginHint, consent = false, prompt } = {}) {
    if (typeof clientId !== 'string' || !clientId) throw new Error('Google連携が設定されていません');
    const redirect = typeof redirectUri === 'function' ? redirectUri() : redirectUri;
    if (typeof redirect !== 'string' || !redirect) throw new Error('auth: redirectUri is not set');

    const state = randomState();
    const t = clock();
    store.setJSON(AUTH_KEYS.pending, { state, silent: !!silent, returnState: toJSONSafe(returnState), t });
    if (silent) store.set(AUTH_KEYS.lastSilent, String(t));
    // Read both back BEFORE leaving: a failed write (QuotaExceeded, blocked storage) would bring the user
    // back with state_mismatch — and a silent attempt without its time gate could redirect again and again.
    const stored = store.getJSON(AUTH_KEYS.pending);
    if (!stored || stored.state !== state || (silent && store.get(AUTH_KEYS.lastSilent) !== String(t))) {
      store.remove(AUTH_KEYS.pending);
      throw new Error('storage unavailable');
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: 'token',
      scope: requestedScopes.join(' '),
      state,
      include_granted_scopes: 'true',
    });
    const hint = typeof loginHint === 'string' && loginHint ? loginHint : getLoginHint();
    if (hint) params.set('login_hint', hint);
    if (silent) params.set('prompt', 'none');
    else if (consent) params.set('prompt', 'consent');
    else if (prompt === 'consent' || prompt === 'select_account') params.set('prompt', prompt);

    const url = `${AUTH_ENDPOINT}?${params.toString()}`;
    const l = loc();
    if (!l || typeof l.assign !== 'function') throw new Error('auth: location.assign is not available');
    l.assign(url);
    return url;
  }

  /**
   * Clears local auth state first, then revokes the token (best effort; never rejects).
   * NOTE: Google's revoke ends this app's grant for the whole account — every device of the user must then
   * sign in (with consent) again. Pass { revoke: false } for a local-only sign-out.
   * The revoke is sent with keepalive (it survives the reload that usually follows) and is awaited for at
   * most `timeoutMs`, so a captive / stalled network cannot leave the app stuck on the old screen.
   * @param {{ revoke?: boolean, timeoutMs?: number }} [o]
   */
  async function signOut({ revoke = true, timeoutMs = REVOKE_WAIT_MS } = {}) {
    const t = readToken();
    for (const key of Object.values(AUTH_KEYS)) store.remove(key);
    lastErrorCode = null;
    if (!t || !revoke || t.exp === 0) return; // exp 0: already rejected by Google (clearToken after a 401)
    const f = fetchImpl || globalThis.fetch;
    if (typeof f !== 'function') return;
    let sent;
    try {
      // form-urlencoded POST is a CORS "simple request": it reaches Google even if the response is unreadable.
      sent = Promise.resolve(f(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.access_token }).toString(),
        cache: 'no-store',
        keepalive: true,
      })).catch(() => {}); // ignore: local sign-out already happened
    } catch {
      return;
    }
    const wait = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : REVOKE_WAIT_MS;
    let timer = null;
    const giveUp = new Promise((resolve) => {
      timer = setTimeout(resolve, wait);
    });
    try {
      await Promise.race([sent, giveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Marks the stored token as dead (e.g. after a 401) without forgetting which scopes were granted, so the
   * next start still knows the capabilities (it needs a reconnect, not more permissions). Keeps the hint and
   * the 'ever signed in' flag. With `token`, only that exact token is expired: a newer token stored meanwhile
   * (another window, a finished re-auth) survives a late 401 of an old request.
   * @param {string} [token] the access token that got the 401
   */
  function clearToken(token) {
    const t = readToken();
    if (!t) {
      store.remove(AUTH_KEYS.token); // nothing usable (or garbage): drop it
      return;
    }
    if (typeof token === 'string' && token && token !== t.access_token) return;
    store.setJSON(AUTH_KEYS.token, { access_token: t.access_token, exp: 0, scopes: t.scopes });
  }

  // ---- small getters ----

  function grantedScopes() {
    const t = readToken();
    return t ? t.scopes.slice() : [];
  }

  function hasScopes(list) {
    const wanted = normalizeScopes(list);
    const granted = new Set(grantedScopes());
    return wanted.every((s) => granted.has(s));
  }

  function setLoginHint(email) {
    if (typeof email === 'string' && email.trim()) store.set(AUTH_KEYS.hint, email.trim());
    else store.remove(AUTH_KEYS.hint);
  }

  function getLoginHint() {
    const h = store.get(AUTH_KEYS.hint);
    return typeof h === 'string' && h ? h : null;
  }

  function hasEverSignedIn() {
    return store.get(AUTH_KEYS.ever) === '1';
  }

  /** hasEverSignedIn() and no prompt=none attempt in the last 5 minutes (loop guard). */
  function canTrySilent() {
    if (!hasEverSignedIn()) return false;
    const last = Number(store.get(AUTH_KEYS.lastSilent));
    if (!Number.isFinite(last) || last <= 0) return true;
    const elapsed = clock() - last;
    // A timestamp in the future (clock moved back) must not block re-auth for hours.
    return elapsed < 0 || elapsed > SILENT_INTERVAL_MS;
  }

  return {
    handleRedirect,
    getToken,
    isSignedIn: () => getToken() !== null,
    hasEverSignedIn,
    expiresAt: () => readToken()?.exp ?? null,
    grantedScopes,
    hasScopes,
    signIn,
    signOut,
    clearToken,
    setLoginHint,
    loginHint: getLoginHint,
    canTrySilent,
    lastError: () => lastErrorCode,
  };
}

// ---------- helpers ----------

/** Wraps a localStorage-like object; every access is guarded (private mode, quota, missing storage). */
function createStore(storage) {
  const memory = new Map();
  const target = () => storage || safeGlobalStorage();
  const get = (k) => {
    const s = target();
    if (!s) return memory.has(k) ? memory.get(k) : null;
    try {
      return s.getItem(k);
    } catch {
      return null;
    }
  };
  const set = (k, v) => {
    const s = target();
    if (!s) {
      memory.set(k, String(v));
      return;
    }
    try {
      s.setItem(k, String(v));
    } catch (e) {
      console.warn('[auth] storage write failed:', k, e && e.message);
    }
  };
  const remove = (k) => {
    const s = target();
    memory.delete(k);
    if (!s) return;
    try {
      s.removeItem(k);
    } catch {
      // ignore
    }
  };
  const getJSON = (k) => {
    const raw = get(k);
    if (typeof raw !== 'string' || !raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const setJSON = (k, v) => set(k, JSON.stringify(v));
  return { get, set, remove, getJSON, setJSON };
}

function safeGlobalStorage() {
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

/** Array / SCOPES-like object / space-separated string → unique string[]. */
export function normalizeScopes(scopes) {
  let list = [];
  if (Array.isArray(scopes)) list = scopes;
  else if (typeof scopes === 'string') list = scopes.split(/\s+/);
  else if (scopes && typeof scopes === 'object') list = Object.values(scopes);
  return [...new Set(list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))];
}

function parseScopeParam(value) {
  return typeof value === 'string' ? normalizeScopes(value) : [];
}

function parseExpiresIn(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EXPIRES_IN_S;
}

/** 32 random bytes, base64url without padding (43 chars). */
function randomState() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('auth: crypto.getRandomValues is not available');
  const bytes = c.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Keeps returnState only if it survives JSON round-tripping. */
function toJSONSafe(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}
