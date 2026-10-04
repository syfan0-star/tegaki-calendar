import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDriveApi, META_FIELDS, DRIVE_API, DRIVE_UPLOAD_API, escapeQueryValue, buildMultipart,
} from '../js/google/drive.js';
import { createHttp, ApiError } from '../js/google/http.js';

function fakeHttp(handler = () => ({})) {
  const calls = [];
  return {
    calls,
    async request(url, opts = {}) {
      calls.push({ url, ...opts });
      return handler(url, opts, calls.length - 1);
    },
  };
}

test('META_FIELDS constant', () => {
  assert.equal(META_FIELDS, 'id,name,createdTime,modifiedTime,version,md5Checksum,size,appProperties');
});

test('requires an http with request()', () => {
  assert.throws(() => createDriveApi(undefined), TypeError);
});

test('escapeQueryValue escapes backslash and single quote', () => {
  assert.equal(escapeQueryValue("d-2026-10-04"), 'd-2026-10-04');
  assert.equal(escapeQueryValue("a'b\\c"), "a\\'b\\\\c");
});

test('listPageFiles: exact query, nextPageToken in fields, all pages', async () => {
  const pages = [
    { files: [{ id: 'f1' }], nextPageToken: 't2' },
    { files: [], nextPageToken: 't3' },
    { files: [{ id: 'f2' }] },
  ];
  const http = fakeHttp((url, opts, i) => pages[i]);
  const drive = createDriveApi(http);
  const files = await drive.listPageFiles("w-2026-09-27");
  assert.deepEqual(files.map((f) => f.id), ['f1', 'f2']);
  assert.equal(http.calls.length, 3);
  const q = http.calls[0];
  assert.equal(q.url, `${DRIVE_API}/files`);
  assert.deepEqual(q.query, {
    spaces: 'appDataFolder',
    q: "appProperties has { key='page' and value='w-2026-09-27' }",
    fields: `nextPageToken,files(${META_FIELDS})`,
    pageSize: 1000,
    orderBy: 'createdTime',
    pageToken: undefined,
  });
  assert.equal(http.calls[1].query.pageToken, 't2');
  assert.equal(http.calls[2].query.pageToken, 't3');
});

test('listPageFiles escapes the page id and validates it', async () => {
  const http = fakeHttp(() => ({ files: [] }));
  const drive = createDriveApi(http);
  await drive.listPageFiles("x'y\\z");
  assert.equal(http.calls[0].query.q, "appProperties has { key='page' and value='x\\'y\\\\z' }");
  await assert.rejects(drive.listPageFiles(''), TypeError);
});

test('getMeta / download use encoded ids', async () => {
  const http = fakeHttp((url, opts) => (opts.responseType === 'text' ? '{"v":1}' : { id: 'a/b' }));
  const drive = createDriveApi(http);
  assert.deepEqual(await drive.getMeta('a/b'), { id: 'a/b' });
  assert.equal(http.calls[0].url, `${DRIVE_API}/files/a%2Fb`);
  assert.deepEqual(http.calls[0].query, { fields: META_FIELDS });
  assert.equal(await drive.download('id1'), '{"v":1}');
  assert.equal(http.calls[1].url, `${DRIVE_API}/files/id1`);
  assert.deepEqual(http.calls[1].query, { alt: 'media' });
  assert.equal(http.calls[1].responseType, 'text');
  assert.throws(() => drive.getMeta(''), TypeError);
});

test('generateId keeps a pool of 20 and shares one in-flight refill', async () => {
  let n = 0;
  const http = fakeHttp(() => {
    n++;
    return { ids: Array.from({ length: 20 }, (_, i) => `id${n}-${i}`) };
  });
  const drive = createDriveApi(http);
  const ids = await Promise.all(Array.from({ length: 25 }, () => drive.generateId()));
  assert.equal(new Set(ids).size, 25);
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[0].url, `${DRIVE_API}/files/generateIds`);
  assert.deepEqual(http.calls[0].query, { count: 20, space: 'appDataFolder', type: 'files' });
  assert.equal(ids[0], 'id1-0');
});

test('generateId propagates errors and recovers afterwards', async () => {
  let fail = true;
  const http = fakeHttp(() => {
    if (fail) throw new ApiError({ status: 0, reason: 'network' });
    return { ids: ['a'] };
  });
  const drive = createDriveApi(http);
  await assert.rejects(drive.generateId(), (e) => e.reason === 'network');
  fail = false;
  assert.equal(await drive.generateId(), 'a');
  const empty = createDriveApi(fakeHttp(() => ({ ids: [] })));
  await assert.rejects(empty.generateId(), (e) => e instanceof ApiError && e.reason === 'noIds');
});

function parseMultipart(contentType, body) {
  const boundary = /boundary=(\S+)$/.exec(contentType)[1];
  assert.ok(body.startsWith(`--${boundary}\r\n`));
  assert.ok(body.endsWith(`\r\n--${boundary}--\r\n`));
  assert.equal(body.replace(/\r\n/g, '').includes('\n'), false, 'only CRLF line endings');
  const parts = body.split(`--${boundary}`).slice(1, -1).map((p) => {
    const [head, ...rest] = p.replace(/^\r\n/, '').replace(/\r\n$/, '').split('\r\n\r\n');
    return { head, content: rest.join('\r\n\r\n') };
  });
  return parts;
}

test('create: multipart/related POST with metadata first, then content', async () => {
  const meta = { id: 'gen1', name: 'ink-d-2026-10-04--dev.json', version: '1' };
  const http = fakeHttp(() => meta);
  const drive = createDriveApi(http);
  const text = '{"v":1,"pageId":"d-2026-10-04","strokes":{"a":{"note":"改行\\nあり"}}}';
  const res = await drive.create({ id: 'gen1', name: 'ink-d-2026-10-04--dev.json', appProperties: { page: 'd-2026-10-04', dev: 'dev', schema: '1' } }, text);
  assert.equal(res, meta);
  const call = http.calls[0];
  assert.equal(call.url, `${DRIVE_UPLOAD_API}/files`);
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.query, { uploadType: 'multipart', fields: META_FIELDS });
  assert.match(call.headers['Content-Type'], /^multipart\/related; boundary=tegaki_[0-9a-f]{32}$/);
  assert.equal(typeof call.rawBody, 'string');
  const parts = parseMultipart(call.headers['Content-Type'], call.rawBody);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].head, 'Content-Type: application/json; charset=UTF-8');
  assert.deepEqual(JSON.parse(parts[0].content), {
    name: 'ink-d-2026-10-04--dev.json',
    parents: ['appDataFolder'],
    mimeType: 'application/json',
    id: 'gen1',
    appProperties: { page: 'd-2026-10-04', dev: 'dev', schema: '1' },
  });
  assert.equal(parts[1].head, 'Content-Type: application/json');
  assert.equal(parts[1].content, text);
});

test('create: 409 with a pre-generated id writes the NEW content into that file; without id rethrows', async () => {
  // An earlier attempt created the file (response lost) with older content; this attempt has newer content.
  const http = fakeHttp((url, opts) => {
    if (opts.method === 'POST') throw new ApiError({ status: 409, reason: 'duplicate' });
    return { id: 'gen9', name: 'n', md5Checksum: 'md5-of-new' };
  });
  const drive = createDriveApi(http);
  const res = await drive.create({ id: 'gen9', name: 'n' }, '{"v":1,"new":true}');
  assert.deepEqual(res, { id: 'gen9', name: 'n', md5Checksum: 'md5-of-new' });
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[1].method, 'PATCH');
  assert.equal(http.calls[1].url, `${DRIVE_UPLOAD_API}/files/gen9`);
  assert.deepEqual(http.calls[1].query, { uploadType: 'media', fields: META_FIELDS });
  assert.equal(http.calls[1].rawBody, '{"v":1,"new":true}');
  await assert.rejects(drive.create({ name: 'n' }, '{}'), (e) => e.status === 409);

  // Non-string content goes through the same JSON encoding on the 409 path.
  await drive.create({ id: 'gen9', name: 'n' }, { v: 1 });
  assert.equal(http.calls.at(-1).rawBody, '{"v":1}');
});

test('create: idempotent (5xx / network retries allowed) only with a pre-generated id', async () => {
  const http = fakeHttp(() => ({ id: 'x' }));
  const drive = createDriveApi(http);
  await drive.create({ id: 'gen1', name: 'n' }, '{}');
  await drive.create({ name: 'n' }, '{}');
  assert.equal(http.calls[0].idempotent, true);
  assert.equal(http.calls[1].idempotent, false);
});

test('create: other errors propagate; validation; non-string content is JSON-encoded', async () => {
  const http = fakeHttp(() => {
    throw new ApiError({ status: 403, reason: 'storageQuotaExceeded' });
  });
  const drive = createDriveApi(http);
  await assert.rejects(drive.create({ id: 'x', name: 'n' }, '{}'), (e) => e.reason === 'storageQuotaExceeded');
  await assert.rejects(drive.create({ name: '' }, '{}'), TypeError);

  const ok = fakeHttp(() => ({ id: 'z' }));
  await createDriveApi(ok).create({ name: 'n' }, { v: 1 });
  const parts = parseMultipart(ok.calls[0].headers['Content-Type'], ok.calls[0].rawBody);
  assert.equal(parts[1].content, '{"v":1}');
  assert.equal('id' in JSON.parse(parts[0].content), false);
});

test('update: uppercase PATCH to the upload endpoint with uploadType=media', async () => {
  const http = fakeHttp(() => ({ id: 'f 1', md5Checksum: 'abc' }));
  const drive = createDriveApi(http);
  const res = await drive.update('f 1', '{"v":1}');
  assert.equal(res.md5Checksum, 'abc');
  const call = http.calls[0];
  assert.equal(call.method, 'PATCH');
  assert.equal(call.url, `${DRIVE_UPLOAD_API}/files/f%201`);
  assert.deepEqual(call.query, { uploadType: 'media', fields: META_FIELDS });
  assert.deepEqual(call.headers, { 'Content-Type': 'application/json; charset=UTF-8' });
  assert.equal(call.rawBody, '{"v":1}');
  assert.throws(() => drive.update('', '{}'), TypeError);
});

test('remove: DELETE; 404 is success; other errors propagate', async () => {
  let reply = null;
  const http = fakeHttp(() => {
    if (reply) throw reply;
    return null;
  });
  const drive = createDriveApi(http);
  await drive.remove('f1');
  assert.equal(http.calls[0].method, 'DELETE');
  assert.equal(http.calls[0].url, `${DRIVE_API}/files/f1`);
  assert.equal(http.calls[0].responseType, 'none');
  reply = new ApiError({ status: 404, reason: 'notFound' });
  await assert.doesNotReject(drive.remove('f1'));
  reply = new ApiError({ status: 500, reason: 'backendError' });
  await assert.rejects(drive.remove('f1'), (e) => e.status === 500);
});

test('buildMultipart picks a boundary that does not occur in the content', () => {
  const { boundary, body } = buildMultipart({ name: 'x' }, 'hello');
  assert.ok(body.includes(`--${boundary}--`));
  assert.ok(!'hello'.includes(boundary));
});

test('end to end through http.js: query string, method and body reach fetch', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ files: [], id: 'x' }), { status: 200 });
  };
  const http = createHttp({ getToken: () => 't', fetchImpl, sleep: async () => {} });
  const drive = createDriveApi(http);
  await drive.listPageFiles('m-2026-10');
  const u = new URL(seen[0].url);
  assert.equal(u.origin + u.pathname, `${DRIVE_API}/files`);
  assert.equal(u.searchParams.get('spaces'), 'appDataFolder');
  assert.equal(u.searchParams.get('q'), "appProperties has { key='page' and value='m-2026-10' }");
  assert.equal(u.searchParams.get('fields'), `nextPageToken,files(${META_FIELDS})`);
  assert.equal(u.searchParams.get('pageSize'), '1000');
  assert.equal(u.searchParams.get('orderBy'), 'createdTime');

  await drive.update('abc', '{"v":1}');
  assert.equal(seen[1].init.method, 'PATCH');
  assert.equal(seen[1].url, `${DRIVE_UPLOAD_API}/files/abc?uploadType=media&fields=${encodeURIComponent(META_FIELDS)}`);
  assert.equal(seen[1].init.headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.equal(seen[1].init.body, '{"v":1}');
  assert.equal(seen[1].init.cache, 'no-store');

  await drive.create({ id: 'g', name: 'n' }, '{}');
  assert.match(seen[2].init.headers['Content-Type'], /^multipart\/related; boundary=/);
  assert.equal(seen[2].url.startsWith(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=`), true);

  await drive.remove('abc');
  assert.equal(seen[3].init.method, 'DELETE');
});
