// Small fetch wrapper for Google REST APIs (Calendar v3, Drive v3).
//
// - Adds `Authorization: Bearer <token>` (token from the injected getToken; never logged).
// - Retries 429 and 403 rate-limit reasons (the request was rejected, so repeating it is always safe) and
//   500 / 502 / 503 / 504 with exponential backoff + jitter. A 5xx may arrive AFTER Google has done the
//   work, so 5xx are retried only for requests that are safe to repeat: GET / HEAD / PUT / PATCH / DELETE,
//   or a POST the caller marks `idempotent: true` (e.g. a create with a client-generated id → 409 on repeat).
// - 401 → onAuthError(token) then AuthRequiredError. No token → AuthRequiredError without any request.
// - A network failure (fetch rejects, or the body stream breaks) → ApiError { status: 0, reason: 'network' };
//   requests that are safe to repeat are retried up to twice first (iPad resume / Wi-Fi handover blips),
//   unless the browser reports navigator.onLine === false.
// - Every request uses cache: 'no-store' and an uppercase method ('patch' would NOT be normalized by fetch).

/** Thrown when there is no usable access token, or Google answered 401. */
export class AuthRequiredError extends Error {
  constructor(message = 'Googleへのログインが必要です', options) {
    super(message, options);
    this.name = 'AuthRequiredError';
  }
}

/**
 * HTTP / network error from a Google API.
 *   status: HTTP status (0 = network failure)
 *   reason: Google's error.errors[0].reason, else error.status (e.g. 'PERMISSION_DENIED'), else ''
 *   body:   parsed JSON error body, raw text, or null
 *
 * Accepted constructor forms (all equivalent):
 *   new ApiError({ status, reason, body, message, cause })
 *   new ApiError(status, reason, body, message)
 *   new ApiError(message, { status, reason, body, cause })
 */
export class ApiError extends Error {
  constructor(a, b, c, d) {
    const o = apiErrorArgs(a, b, c, d);
    super(o.message, o.cause !== undefined ? { cause: o.cause } : undefined);
    this.name = 'ApiError';
    this.status = o.status;
    this.reason = o.reason;
    this.body = o.body;
  }
}

function apiErrorArgs(a, b, c, d) {
  let o;
  if (typeof a === 'number') {
    o = b && typeof b === 'object' ? { ...b, status: a } : { status: a, reason: b, body: c, message: d };
  } else if (a && typeof a === 'object') {
    o = { ...a };
  } else {
    o = b && typeof b === 'object' ? { ...b, message: a } : { message: a, status: b, reason: c, body: d };
  }
  const status = Number.isFinite(Number(o.status)) ? Number(o.status) : 0;
  const reason = typeof o.reason === 'string' ? o.reason : '';
  const message = typeof o.message === 'string' && o.message
    ? o.message
    : `Google API error ${status}${reason ? ` (${reason})` : ''}`;
  return { status, reason, body: o.body === undefined ? null : o.body, message, cause: o.cause };
}

/** Max retries after the first attempt (delays 0.5 s, 1 s, 2 s, 4 s + jitter). */
export const MAX_RETRIES = 4;
/** Max retries of a network failure (status 0), within MAX_RETRIES. */
export const MAX_NETWORK_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_JITTER_MS = 250;
/** Statuses that may arrive after the server already acted: retried only when repeating is safe. */
const SERVER_ERROR_STATUSES = new Set([500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
/** Methods whose repetition has the same effect as one request. */
const REPEATABLE_METHODS = new Set(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** false only when the browser positively reports being offline. */
function defaultIsOnline() {
  try {
    const nav = globalThis.navigator;
    return !nav || nav.onLine !== false;
  } catch {
    return true;
  }
}

/**
 * @param {object} opts
 * @param {() => (string|null|Promise<string|null>)} opts.getToken
 * @param {(token: string) => void} [opts.onAuthError]  called on 401 (before AuthRequiredError is thrown) with
 *        the token that request used, so the caller can expire exactly that token (a newer one stored by
 *        another window meanwhile must survive)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]  injectable for tests
 * @param {() => number} [opts.random]  jitter source in [0,1) (injectable for tests)
 * @param {() => boolean} [opts.isOnline]  defaults to navigator.onLine !== false (injectable for tests)
 */
export function createHttp({
  getToken,
  onAuthError,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  random = Math.random,
  isOnline = defaultIsOnline,
} = {}) {
  if (typeof getToken !== 'function') throw new TypeError('createHttp: getToken must be a function');

  /**
   * @param {string} url absolute URL (may already contain a query string)
   * @param {object} [opts]
   * @param {string} [opts.method='GET']
   * @param {Record<string, any>} [opts.query]  null/undefined values skipped; arrays become repeated params
   * @param {Record<string, string>} [opts.headers]
   * @param {any} [opts.json]     JSON-encoded, Content-Type application/json; charset=UTF-8
   * @param {any} [opts.rawBody]  sent as-is (caller sets Content-Type)
   * @param {any} [opts.body]     plain object → like json; string/Blob/URLSearchParams/... → like rawBody
   * @param {'json'|'text'|'none'} [opts.responseType='json']
   * @param {AbortSignal} [opts.signal]
   * @param {boolean} [opts.idempotent]  true: repeating this request is harmless even for POST (5xx and
   *        network failures are then retried like for GET)
   * @returns {Promise<any>} parsed JSON (null for an empty body), text, or null ('none')
   */
  async function request(url, opts = {}) {
    if (typeof url !== 'string' || !url) throw new TypeError('http.request: url must be a non-empty string');
    const { method = 'GET', query, headers, responseType = 'json', signal, idempotent } = opts || {};
    const fullUrl = withQuery(url, query);
    const { payload, contentType } = encodeBody(opts || {});
    const verb = String(method || 'GET').toUpperCase();
    const repeatable = idempotent === true || REPEATABLE_METHODS.has(verb);
    let networkRetries = 0;

    for (let attempt = 0; ; attempt++) {
      const token = await readToken();
      if (!token) throw new AuthRequiredError();

      const init = {
        method: verb,
        headers: buildHeaders(headers, contentType, token),
        cache: 'no-store',
      };
      if (payload !== undefined) init.body = payload;
      if (signal) init.signal = signal;

      let res;
      try {
        res = await send(fullUrl, init);
        if (res.ok) return await readBody(res, responseType);
      } catch (e) {
        if (repeatable && isNetworkFailure(e) && networkRetries < MAX_NETWORK_RETRIES && attempt < MAX_RETRIES
          && online()) {
          await sleep(backoffDelay(networkRetries, random));
          networkRetries++;
          continue;
        }
        throw e;
      }

      if (res.status === 401) {
        notifyAuthError(token);
        throw new AuthRequiredError();
      }
      const err = await errorFromResponse(res);
      if (attempt < MAX_RETRIES && isRetryable(err, repeatable)) {
        await sleep(backoffDelay(attempt, random));
        continue;
      }
      throw err;
    }
  }

  function online() {
    try {
      return isOnline() !== false;
    } catch {
      return true;
    }
  }

  async function readToken() {
    try {
      const t = await getToken();
      return typeof t === 'string' && t ? t : null;
    } catch {
      return null;
    }
  }

  function notifyAuthError(token) {
    if (typeof onAuthError !== 'function') return;
    try {
      onAuthError(token);
    } catch (e) {
      console.warn('[http] onAuthError handler failed:', e && e.message);
    }
  }

  async function send(url, init) {
    if (typeof fetchImpl !== 'function') {
      throw new ApiError({ status: 0, reason: 'network', message: 'fetch is not available' });
    }
    try {
      return await fetchImpl(url, init); // plain call (this = undefined) avoids "Illegal invocation"
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new ApiError({ status: 0, reason: 'network', message: 'ネットワークに接続できません', cause: e });
    }
  }

  return { request };
}

/** Appends a query object to url. */
function withQuery(url, query) {
  if (!query || typeof query !== 'object') return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === undefined || v === null) continue;
      params.append(key, v instanceof Date ? v.toISOString() : String(v));
    }
  }
  const qs = params.toString();
  if (!qs) return url;
  return url + (url.includes('?') ? (/[?&]$/.test(url) ? '' : '&') : '?') + qs;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null || Array.isArray(v);
}

/** Resolves json / rawBody / body into a fetch body and an implied Content-Type. */
function encodeBody({ json, rawBody, body }) {
  if (json !== undefined) return { payload: JSON.stringify(json), contentType: 'application/json; charset=UTF-8' };
  if (rawBody !== undefined) return { payload: rawBody, contentType: null };
  if (body !== undefined) {
    if (isPlainObject(body)) return { payload: JSON.stringify(body), contentType: 'application/json; charset=UTF-8' };
    return { payload: body, contentType: null };
  }
  return { payload: undefined, contentType: null };
}

function buildHeaders(extra, contentType, token) {
  const out = {};
  if (contentType) out['Content-Type'] = contentType;
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      // Caller-supplied Content-Type replaces the implied one (case-insensitively).
      if (k.toLowerCase() === 'content-type') delete out['Content-Type'];
      if (k.toLowerCase() === 'authorization') continue; // the token always comes from getToken
      out[k] = String(v);
    }
  }
  out.Authorization = `Bearer ${token}`;
  return out;
}

async function readBody(res, responseType) {
  if (responseType === 'none') return null;
  let text;
  try {
    text = await res.text();
  } catch (e) {
    // The connection dropped after the headers (iPad backgrounded, Wi-Fi handover): same as no response.
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError({ status: 0, reason: 'network', message: 'ネットワークに接続できません', cause: e });
  }
  if (responseType === 'text') return text;
  if (!text || res.status === 204) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError({ status: res.status, reason: 'invalidJson', body: text, message: 'Google API returned invalid JSON', cause: e });
  }
}

/** Builds an ApiError from a non-OK response, parsing Google's error JSON when present. */
async function errorFromResponse(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let body = text || null;
  try {
    if (text) body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  const info = parseGoogleError(body);
  return new ApiError({ status: res.status, reason: info.reason, body, message: info.message || `HTTP ${res.status}` });
}

/**
 * Extracts { reason, message } from Google's error JSON:
 * { error: { code, message, errors: [{ domain, reason, message }], status } }
 */
export function parseGoogleError(body) {
  const e = body && typeof body === 'object' ? body.error : null;
  if (!e || typeof e !== 'object') {
    // OAuth-style errors: { error: 'invalid_token', error_description }
    if (body && typeof body.error === 'string') return { reason: body.error, message: body.error_description || '' };
    return { reason: '', message: '' };
  }
  const first = Array.isArray(e.errors) && e.errors[0] && typeof e.errors[0] === 'object' ? e.errors[0] : null;
  const reason = (first && typeof first.reason === 'string' && first.reason) || (typeof e.status === 'string' ? e.status : '');
  const message = typeof e.message === 'string' ? e.message : '';
  return { reason, message };
}

/**
 * 429 / 403 rate limits: the request was refused before doing anything → always worth retrying.
 * 5xx: Google may already have done the work → only when repeating the request is harmless.
 */
function isRetryable(err, repeatable) {
  if (err.status === 429) return true;
  if (err.status === 403 && RATE_LIMIT_REASONS.has(err.reason)) return true;
  return repeatable && SERVER_ERROR_STATUSES.has(err.status);
}

function isNetworkFailure(e) {
  return e instanceof ApiError && e.status === 0 && e.reason === 'network';
}

function backoffDelay(attempt, random) {
  let r = 0;
  try {
    r = Number(random());
  } catch {
    r = 0;
  }
  const jitter = Number.isFinite(r) ? Math.max(0, Math.min(1, r)) * MAX_JITTER_MS : 0;
  return BASE_DELAY_MS * 2 ** attempt + Math.round(jitter);
}

/**
 * Japanese user-facing message for an error thrown by request() (or by the data sources).
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  if (err instanceof AuthRequiredError) return 'Googleへの再接続が必要です';
  if (err instanceof ApiError) {
    if (err.status === 0) return 'オフラインのため接続できません';
    switch (err.reason) {
      case 'insufficientPermissions':
      case 'ACCESS_TOKEN_SCOPE_INSUFFICIENT':
        return '権限が不足しています（設定から「権限を追加」してください）';
      case 'requiredAccessLevel':
      case 'forbiddenForNonOrganizer':
        return 'このカレンダーは編集できません';
      case 'storageQuotaExceeded':
        return 'Googleドライブの保存容量が不足しています';
      case 'quotaExceeded':
      case 'dailyLimitExceeded':
      case 'rateLimitExceeded':
      case 'userRateLimitExceeded':
        return 'Googleの利用制限に達しました。しばらくしてから再度お試しください';
      default:
        break;
    }
    if (err.status === 404 || err.status === 410) return '対象が見つかりません（削除された可能性があります）';
    if (err.status >= 500) return 'Googleのサーバーで一時的なエラーが発生しました';
    return `Googleとの通信でエラーが発生しました（${err.status}）`;
  }
  return '予期しないエラーが発生しました';
}
