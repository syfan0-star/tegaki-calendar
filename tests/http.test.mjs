import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHttp, AuthRequiredError, ApiError, MAX_RETRIES, MAX_NETWORK_RETRIES, parseGoogleError, describeError,
} from '../js/google/http.js';

/** fetch fake: replies from a queue (Response | Error | function), records every call. */
function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    const r = typeof next === 'function' ? next(url, init) : next;
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

const jsonRes = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const googleError = (status, reason, extra = {}) => jsonRes(status, {
  error: { code: status, message: `msg ${reason}`, errors: [{ domain: 'global', reason, message: `msg ${reason}` }], ...extra },
});

function setup({ token = 'tok', replies = [() => jsonRes(200, { ok: true })], random = () => 0, isOnline } = {}) {
  const fetchImpl = fakeFetch(...replies);
  const sleeps = [];
  const authTokens = [];
  const http = createHttp({
    getToken: () => token,
    onAuthError: (t) => { authTokens.push(t); },
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    random,
    isOnline,
  });
  return { http, fetchImpl, sleeps, authErrors: () => authTokens.length, authTokens };
}

test('adds bearer token, no-store, uppercase method, encoded query, JSON body', async () => {
  const { http, fetchImpl } = setup({ replies: [jsonRes(200, { id: 'x' })] });
  const out = await http.request('https://example.test/api', {
    method: 'patch',
    query: { a: 'x y', b: true, n: 0, skip: null, undef: undefined, list: ['p', 'q'] },
    json: { hello: '世界' },
  });
  assert.deepEqual(out, { id: 'x' });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://example.test/api?a=x+y&b=true&n=0&list=p&list=q');
  assert.equal(init.method, 'PATCH');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.equal(init.headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.equal(init.body, JSON.stringify({ hello: '世界' }));
});

test('appends query to a URL that already has one', async () => {
  const { http, fetchImpl } = setup();
  await http.request('https://example.test/api?x=1', { query: { y: 2 } });
  assert.equal(fetchImpl.calls[0].url, 'https://example.test/api?x=1&y=2');
});

test('GET without body sends no body and no content-type', async () => {
  const { http, fetchImpl } = setup();
  await http.request('https://example.test/api');
  const { init } = fetchImpl.calls[0];
  assert.equal(init.method, 'GET');
  assert.equal('body' in init, false);
  assert.equal(init.headers['Content-Type'], undefined);
});

test('rawBody is sent untouched with the caller content-type; caller Authorization is ignored', async () => {
  const { http, fetchImpl } = setup();
  await http.request('https://example.test/upload', {
    method: 'POST',
    rawBody: '--b\r\nraw\r\n--b--',
    headers: { 'Content-Type': 'multipart/related; boundary=b', Authorization: 'Bearer evil' },
  });
  const { init } = fetchImpl.calls[0];
  assert.equal(init.body, '--b\r\nraw\r\n--b--');
  assert.equal(init.headers['Content-Type'], 'multipart/related; boundary=b');
  assert.equal(init.headers.Authorization, 'Bearer tok');
});

test('body: plain object is JSON-encoded, string is raw', async () => {
  const { http, fetchImpl } = setup();
  await http.request('https://example.test/a', { method: 'POST', body: { a: 1 } });
  await http.request('https://example.test/b', { method: 'POST', body: 'token=abc', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(fetchImpl.calls[0].init.body, '{"a":1}');
  assert.equal(fetchImpl.calls[0].init.headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.equal(fetchImpl.calls[1].init.body, 'token=abc');
  assert.equal(fetchImpl.calls[1].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('no token → AuthRequiredError without fetching', async () => {
  const { http, fetchImpl } = setup({ token: null });
  await assert.rejects(http.request('https://example.test/api'), AuthRequiredError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('async getToken is awaited; a throwing getToken means signed out', async () => {
  const fetchImpl = fakeFetch(() => jsonRes(200, {}));
  const http = createHttp({ getToken: async () => 'async-tok', fetchImpl, sleep: async () => {} });
  await http.request('https://example.test/api');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer async-tok');

  const http2 = createHttp({ getToken: () => { throw new Error('boom'); }, fetchImpl, sleep: async () => {} });
  await assert.rejects(http2.request('https://example.test/api'), AuthRequiredError);
});

test('401 → onAuthError(token) then AuthRequiredError, no retry', async () => {
  const { http, fetchImpl, authErrors, authTokens, sleeps } = setup({ replies: [googleError(401, 'authError')] });
  await assert.rejects(http.request('https://example.test/api'), (e) => e instanceof AuthRequiredError);
  assert.equal(authErrors(), 1);
  assert.deepEqual(authTokens, ['tok'], 'the token that got the 401 (so only that one is expired)');
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('retries 503 then succeeds, with backoff', async () => {
  const { http, fetchImpl, sleeps } = setup({ replies: [googleError(503, 'backendError'), jsonRes(200, { done: 1 })] });
  assert.deepEqual(await http.request('https://example.test/api'), { done: 1 });
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(sleeps, [500]);
});

test('gives up after MAX_RETRIES with exponential delays + jitter', async () => {
  const { http, fetchImpl, sleeps } = setup({ replies: [() => googleError(500, 'backendError')], random: () => 1 });
  await assert.rejects(http.request('https://example.test/api'), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 500);
    assert.equal(e.reason, 'backendError');
    return true;
  });
  assert.equal(MAX_RETRIES, 4);
  assert.equal(fetchImpl.calls.length, 5);
  assert.deepEqual(sleeps, [750, 1250, 2250, 4250]);
});

test('retries 429, 502, 504 and 403 rate-limit reasons', async () => {
  for (const reply of [jsonRes(429, {}), jsonRes(502, null), jsonRes(504, {}), googleError(403, 'rateLimitExceeded'), googleError(403, 'userRateLimitExceeded')]) {
    const { http, fetchImpl } = setup({ replies: [reply, jsonRes(200, { ok: 1 })] });
    assert.deepEqual(await http.request('https://example.test/api'), { ok: 1 });
    assert.equal(fetchImpl.calls.length, 2);
  }
});

test('403 quotaExceeded / insufficientPermissions / requiredAccessLevel are not retried', async () => {
  for (const reason of ['quotaExceeded', 'insufficientPermissions', 'requiredAccessLevel', 'storageQuotaExceeded']) {
    const { http, fetchImpl, sleeps } = setup({ replies: [googleError(403, reason)] });
    await assert.rejects(http.request('https://example.test/api'), (e) => e instanceof ApiError && e.status === 403 && e.reason === reason);
    assert.equal(fetchImpl.calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test('404 is thrown immediately with parsed body', async () => {
  const { http, fetchImpl } = setup({ replies: [googleError(404, 'notFound')] });
  await assert.rejects(http.request('https://example.test/api'), (e) => {
    assert.equal(e.status, 404);
    assert.equal(e.reason, 'notFound');
    assert.equal(e.message, 'msg notFound');
    assert.equal(e.body.error.code, 404);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('reason falls back to error.status when errors[] is missing', async () => {
  const { http } = setup({ replies: [jsonRes(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'nope' } })] });
  await assert.rejects(http.request('https://example.test/api'), (e) => e.reason === 'PERMISSION_DENIED' && e.message === 'nope');
});

test('non-JSON error body is kept as text', async () => {
  const { http } = setup({ replies: [new Response('<html>bad gateway</html>', { status: 400 })] });
  await assert.rejects(http.request('https://example.test/api'), (e) => e.status === 400 && e.reason === '' && e.body === '<html>bad gateway</html>');
});

test('network TypeError → ApiError(status 0, reason network) after MAX_NETWORK_RETRIES retries of a GET', async () => {
  const { http, fetchImpl, sleeps } = setup({ replies: [new TypeError('Load failed')] });
  await assert.rejects(http.request('https://example.test/api'), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 0);
    assert.equal(e.reason, 'network');
    assert.ok(e.cause instanceof TypeError);
    return true;
  });
  assert.equal(MAX_NETWORK_RETRIES, 2);
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('a transient network failure (iPad resume) is retried for repeatable methods and succeeds', async () => {
  for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) {
    const { http, fetchImpl } = setup({ replies: [new TypeError('Load failed'), jsonRes(200, { ok: method })] });
    assert.deepEqual(await http.request('https://example.test/api', { method }), { ok: method });
    assert.equal(fetchImpl.calls.length, 2, method);
  }
});

test('network failure of a POST is not retried unless the caller marks it idempotent', async () => {
  const plain = setup({ replies: [new TypeError('Load failed'), jsonRes(200, { ok: 1 })] });
  await assert.rejects(plain.http.request('https://example.test/api', { method: 'POST', json: {} }), (e) => e.status === 0);
  assert.equal(plain.fetchImpl.calls.length, 1);
  assert.deepEqual(plain.sleeps, []);

  const marked = setup({ replies: [new TypeError('Load failed'), jsonRes(200, { ok: 1 })] });
  assert.deepEqual(await marked.http.request('https://example.test/api', { method: 'POST', json: {}, idempotent: true }), { ok: 1 });
  assert.equal(marked.fetchImpl.calls.length, 2);
});

test('no network retries while the browser reports offline', async () => {
  const { http, fetchImpl, sleeps } = setup({ replies: [new TypeError('Load failed')], isOnline: () => false });
  await assert.rejects(http.request('https://example.test/api'), (e) => e.status === 0);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('5xx of a POST is not retried (Google may already have done it); 429 / 403 rate limits are', async () => {
  for (const status of [500, 502, 503, 504]) {
    const { http, fetchImpl, sleeps } = setup({ replies: [googleError(status, 'backendError'), jsonRes(200, { ok: 1 })] });
    await assert.rejects(http.request('https://example.test/api', { method: 'POST', json: {} }), (e) => e.status === status);
    assert.equal(fetchImpl.calls.length, 1, String(status));
    assert.deepEqual(sleeps, []);
  }
  for (const reply of [jsonRes(429, {}), googleError(403, 'rateLimitExceeded'), googleError(403, 'userRateLimitExceeded')]) {
    const { http, fetchImpl } = setup({ replies: [reply, jsonRes(200, { ok: 1 })] });
    assert.deepEqual(await http.request('https://example.test/api', { method: 'POST', json: {} }), { ok: 1 });
    assert.equal(fetchImpl.calls.length, 2);
  }
  const idem = setup({ replies: [googleError(503, 'backendError'), jsonRes(200, { ok: 1 })] });
  assert.deepEqual(await idem.http.request('https://example.test/api', { method: 'POST', json: {}, idempotent: true }), { ok: 1 });
  assert.equal(idem.fetchImpl.calls.length, 2);
});

/** A 200 whose body stream breaks (connection lost after the headers). */
function brokenBody() {
  const res = new Response('{"ok":1}', { status: 200 });
  Object.defineProperty(res, 'text', { value: () => Promise.reject(new TypeError('Load failed')) });
  return res;
}

test('a body that fails to arrive → ApiError(status 0), retried for GET', async () => {
  const post = setup({ replies: [() => brokenBody()] });
  await assert.rejects(post.http.request('https://example.test/api', { method: 'POST', json: {} }), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 0);
    assert.equal(e.reason, 'network');
    assert.ok(e.cause instanceof TypeError);
    return true;
  });
  assert.equal(post.fetchImpl.calls.length, 1);
  const text = setup({ replies: [() => brokenBody()] });
  await assert.rejects(text.http.request('https://example.test/api', { method: 'POST', responseType: 'text' }), (e) => e.status === 0);

  const get = setup({ replies: [() => brokenBody(), jsonRes(200, { ok: 2 })] });
  assert.deepEqual(await get.http.request('https://example.test/api'), { ok: 2 });
  assert.equal(get.fetchImpl.calls.length, 2);
});

test('AbortError is rethrown as-is (never retried)', async () => {
  const abort = new DOMException('aborted', 'AbortError');
  const { http, fetchImpl } = setup({ replies: [abort] });
  await assert.rejects(http.request('https://example.test/api'), (e) => e === abort);
  assert.equal(fetchImpl.calls.length, 1);
});

test('responseType text / none, empty JSON body → null', async () => {
  const { http } = setup({ replies: [new Response('{"strokes":{}}', { status: 200 }), new Response(null, { status: 204 }), new Response('', { status: 200 })] });
  assert.equal(await http.request('https://example.test/a', { responseType: 'text' }), '{"strokes":{}}');
  assert.equal(await http.request('https://example.test/b', { method: 'DELETE', responseType: 'none' }), null);
  assert.equal(await http.request('https://example.test/c'), null);
});

test('invalid JSON on a 200 → ApiError invalidJson', async () => {
  const { http } = setup({ replies: [new Response('not json', { status: 200 })] });
  await assert.rejects(http.request('https://example.test/a'), (e) => e instanceof ApiError && e.reason === 'invalidJson');
});

test('onAuthError that throws does not replace AuthRequiredError', async () => {
  const fetchImpl = fakeFetch(jsonRes(401, {}));
  const http = createHttp({ getToken: () => 't', onAuthError: () => { throw new Error('x'); }, fetchImpl, sleep: async () => {} });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(http.request('https://example.test/a'), AuthRequiredError);
  } finally {
    console.warn = warn;
  }
});

test('bad arguments', async () => {
  assert.throws(() => createHttp({}), TypeError);
  const { http } = setup();
  await assert.rejects(http.request(''), TypeError);
});

test('ApiError constructor forms', () => {
  const a = new ApiError({ status: 404, reason: 'notFound', body: { x: 1 } });
  const b = new ApiError(404, 'notFound', { x: 1 });
  const c = new ApiError('gone', { status: 404, reason: 'notFound', body: { x: 1 } });
  for (const e of [a, b, c]) {
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'ApiError');
    assert.equal(e.status, 404);
    assert.equal(e.reason, 'notFound');
    assert.deepEqual(e.body, { x: 1 });
  }
  assert.equal(c.message, 'gone');
  const net = new ApiError(0, 'network');
  assert.equal(net.status, 0);
  assert.equal(net.reason, 'network');
  assert.equal(new ApiError().status, 0);
  assert.equal(new AuthRequiredError().name, 'AuthRequiredError');
});

test('parseGoogleError handles Google and OAuth shapes', () => {
  assert.deepEqual(parseGoogleError({ error: { errors: [{ reason: 'notFound' }], message: 'm', status: 'NOT_FOUND' } }), { reason: 'notFound', message: 'm' });
  assert.deepEqual(parseGoogleError({ error: { status: 'UNAUTHENTICATED', message: 'm' } }), { reason: 'UNAUTHENTICATED', message: 'm' });
  assert.deepEqual(parseGoogleError({ error: 'invalid_token', error_description: 'd' }), { reason: 'invalid_token', message: 'd' });
  assert.deepEqual(parseGoogleError(null), { reason: '', message: '' });
  assert.deepEqual(parseGoogleError('text'), { reason: '', message: '' });
});

test('describeError gives Japanese messages', () => {
  assert.match(describeError(new AuthRequiredError()), /再接続/);
  assert.match(describeError(new ApiError(0, 'network')), /オフライン/);
  assert.match(describeError(new ApiError(403, 'insufficientPermissions')), /権限/);
  assert.equal(describeError(new ApiError(403, 'requiredAccessLevel')), 'このカレンダーは編集できません');
  assert.equal(describeError(new ApiError(403, 'forbiddenForNonOrganizer')), 'このカレンダーは編集できません');
  assert.match(describeError(new ApiError(403, 'storageQuotaExceeded')), /容量/);
  assert.match(describeError(new ApiError(503, 'backendError')), /サーバー/);
  assert.match(describeError(new Error('x')), /予期しない/);
});
