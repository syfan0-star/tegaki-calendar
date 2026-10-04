import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryKV, openKV } from '../js/util/idb.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };

function domError(name, message = name) {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * Minimal fake of the IndexedDB API surface used by idb.js: open (upgradeneeded/success/error/blocked),
 * objectStoreNames.contains, createObjectStore, transaction → objectStore get/put/delete/getAllKeys,
 * oncomplete/onerror/onabort, close, onversionchange/onclose. Events fire asynchronously like the real thing;
 * writes become visible only when the transaction commits.
 */
function createFakeIndexedDB() {
  const dbs = new Map(); // name → { version, stores: Map<string, Map>, connections: Set }
  const fake = {
    openBehavior: 'ok', // 'ok' | 'error' | 'blocked' | 'hang' | 'throw'
    failWrites: null, // Error to fail put/delete with
    commitsPaused: false,
    pendingCommits: [],
    opens: 0,
    dbs,
    open(name, version) {
      fake.opens++;
      if (fake.openBehavior === 'throw') throw domError('SecurityError');
      const behavior = fake.openBehavior;
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        if (behavior === 'hang') return;
        if (behavior === 'error') {
          req.error = domError('UnknownError', 'open failed');
          req.onerror?.({ preventDefault() {} });
          return;
        }
        if (behavior === 'blocked') {
          req.onblocked?.({});
          return;
        }
        let rec = dbs.get(name);
        if (!rec) {
          rec = { version: 0, stores: new Map(), connections: new Set() };
          dbs.set(name, rec);
        }
        const target = version ?? Math.max(rec.version, 1);
        if (target < rec.version) {
          req.error = domError('VersionError');
          req.onerror?.({ preventDefault() {} });
          return;
        }
        const conn = makeConnection(rec);
        req.result = conn;
        if (target > rec.version) {
          for (const other of rec.connections) other.onversionchange?.({});
          rec.version = target;
          conn.version = target;
          req.onupgradeneeded?.({});
        }
        rec.connections.add(conn);
        req.onsuccess?.({});
      }, 0);
      return req;
    },
    /** Simulates WebKit silently dropping every connection (no event). */
    loseConnections() {
      for (const rec of dbs.values()) {
        for (const conn of rec.connections) conn.closed = true;
        rec.connections.clear();
      }
    },
    /** Simulates another tab upgrading the database. */
    fireVersionChange() {
      for (const rec of dbs.values()) for (const conn of [...rec.connections]) conn.onversionchange?.({});
    },
    resumeCommits() {
      fake.commitsPaused = false;
      const list = fake.pendingCommits.splice(0);
      for (const fn of list) fn();
    },
    committed(dbName, storeName = 'kv') {
      return dbs.get(dbName)?.stores.get(storeName);
    },
  };

  function makeConnection(rec) {
    const conn = {
      version: rec.version,
      closed: false,
      onversionchange: null,
      onclose: null,
      objectStoreNames: { contains: (n) => rec.stores.has(n) },
      createObjectStore(n) {
        rec.stores.set(n, new Map());
      },
      close() {
        conn.closed = true;
        rec.connections.delete(conn);
      },
      transaction(storeName, mode) {
        if (conn.closed) throw domError('InvalidStateError', 'The database connection is closing.');
        if (!rec.stores.has(storeName)) throw domError('NotFoundError');
        return makeTransaction(rec.stores.get(storeName), mode);
      },
    };
    return conn;
  }

  function makeTransaction(data, mode) {
    const requests = [];
    const staged = [];
    const tx = {
      error: null,
      aborted: false,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort() { tx.aborted = true; },
      objectStore() { return store; },
    };
    const enqueue = (fn) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      requests.push({ req, fn });
      return req;
    };
    const assertWritable = () => {
      if (mode !== 'readwrite') throw domError('ReadOnlyError');
    };
    const store = {
      get: (key) => enqueue(() => structuredClone(data.get(key))),
      put(value, key) {
        assertWritable();
        const copy = structuredClone(value); // throws DataCloneError synchronously, like IndexedDB
        return enqueue(() => {
          if (fake.failWrites) throw fake.failWrites;
          staged.push(() => data.set(key, copy));
          return key;
        });
      },
      delete(key) {
        assertWritable();
        return enqueue(() => {
          if (fake.failWrites) throw fake.failWrites;
          staged.push(() => data.delete(key));
        });
      },
      getAllKeys: (range) => enqueue(() => [...data.keys()]
        .filter((k) => !range || (k >= range.lower && k <= range.upper))
        .sort()),
    };
    setTimeout(() => {
      if (tx.aborted) {
        tx.onabort?.({});
        return;
      }
      for (const { req, fn } of requests) {
        try {
          req.result = fn();
          req.onsuccess?.({});
        } catch (err) {
          req.error = err;
          tx.error = err;
          req.onerror?.({});
          tx.onerror?.({});
          tx.onabort?.({});
          return;
        }
      }
      const commit = () => {
        for (const apply of staged) apply();
        tx.oncomplete?.({});
      };
      if (fake.commitsPaused) fake.pendingCommits.push(commit);
      else commit();
    }, 0);
    return tx;
  }

  return fake;
}

function fakeKeyRange() {
  const calls = [];
  return {
    calls,
    bound(lower, upper) {
      calls.push([lower, upper]);
      return { lower, upper };
    },
  };
}

// ---------------------------------------------------------------- memory KV

test('memory KV: get/set/del round trip', async () => {
  const kv = createMemoryKV();
  assert.equal(kv.kind, 'memory');
  assert.equal(await kv.get('missing'), undefined);
  await kv.set('a', { n: 1, list: [1, 2], when: new Date(0) });
  assert.deepEqual(await kv.get('a'), { n: 1, list: [1, 2], when: new Date(0) });
  await kv.set('a', 'replaced');
  assert.equal(await kv.get('a'), 'replaced');
  await kv.del('a');
  assert.equal(await kv.get('a'), undefined);
  await kv.del('never-existed'); // no throw
});

test('memory KV: values are structured-cloned on the way in and out', async () => {
  const kv = createMemoryKV();
  const value = { strokes: { s1: { pts: [1, 2, 3] } } };
  await kv.set('page:x', value);
  value.strokes.s1.pts.push(99);
  const read1 = await kv.get('page:x');
  assert.deepEqual(read1.strokes.s1.pts, [1, 2, 3]);
  read1.strokes.s1.pts.length = 0;
  const read2 = await kv.get('page:x');
  assert.deepEqual(read2.strokes.s1.pts, [1, 2, 3]);
});

test('memory KV: keys(prefix) filters and sorts', async () => {
  const kv = createMemoryKV();
  for (const k of ['page:b', 'own:a', 'page:a', 'pages', 'dirty', 'page:']) await kv.set(k, 1);
  assert.deepEqual(await kv.keys('page:'), ['page:', 'page:a', 'page:b']);
  assert.deepEqual(await kv.keys(), ['dirty', 'own:a', 'page:', 'page:a', 'page:b', 'pages']);
  assert.deepEqual(await kv.keys(''), await kv.keys());
  assert.deepEqual(await kv.keys('zzz'), []);
});

test('memory KV: rejects bad keys and uncloneable values', async () => {
  const kv = createMemoryKV();
  await assert.rejects(kv.get(1), TypeError);
  await assert.rejects(kv.set(undefined, 1), TypeError);
  await assert.rejects(kv.del({}), TypeError);
  await assert.rejects(kv.keys(5), TypeError);
  await assert.rejects(kv.set('fn', { f() {} }));
  assert.equal(await kv.get('fn'), undefined);
});

test('memory KVs are independent', async () => {
  const a = createMemoryKV();
  const b = createMemoryKV();
  await a.set('k', 1);
  assert.equal(await b.get('k'), undefined);
});

// ---------------------------------------------------------------- openKV fallbacks

test('openKV: no indexedDB (Node) → memory KV with a warning', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const kv = await openKV({ indexedDB: null });
  assert.equal(kv.kind, 'memory');
  await kv.set('x', 1);
  assert.equal(await kv.get('x'), 1);
  assert.equal(warn.mock.callCount(), 1);
});

test('openKV: default options in Node fall back to memory', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const kv = await openKV();
  assert.equal(kv.kind, 'memory');
});

for (const behavior of ['error', 'blocked', 'throw']) {
  test(`openKV: open ${behavior} → memory KV with a warning`, async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const idb = createFakeIndexedDB();
    idb.openBehavior = behavior;
    const kv = await openKV({ indexedDB: idb });
    assert.equal(kv.kind, 'memory');
    assert.equal(warn.mock.callCount(), 1);
    await kv.set('k', 'v');
    assert.equal(await kv.get('k'), 'v');
  });
}

test('openKV: an open() that never answers times out → memory', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const idb = createFakeIndexedDB();
  idb.openBehavior = 'hang';
  const started = Date.now();
  const kv = await openKV({ indexedDB: idb, openTimeoutMs: 30 });
  assert.equal(kv.kind, 'memory');
  assert.ok(Date.now() - started < 2000);
});

// ---------------------------------------------------------------- IndexedDB path

test('openKV: IndexedDB get/set/del/keys and persistence across opens', async () => {
  const idb = createFakeIndexedDB();
  const range = fakeKeyRange();
  const kv = await openKV({ indexedDB: idb, IDBKeyRange: range, dbName: 'test-db' });
  assert.equal(kv.kind, 'indexeddb');
  assert.equal(idb.dbs.get('test-db').version, 1);
  assert.equal(await kv.get('nope'), undefined);

  await kv.set('page:d-2026-10-04', { v: 1, strokes: {} });
  await kv.set('page:w-2026-09-27', { v: 1, strokes: {} });
  await kv.set('dirty', ['d-2026-10-04']);
  assert.deepEqual(await kv.get('dirty'), ['d-2026-10-04']);

  assert.deepEqual(await kv.keys('page:'), ['page:d-2026-10-04', 'page:w-2026-09-27']);
  assert.deepEqual(range.calls.at(-1), ['page:', 'page:￿']);
  assert.deepEqual(await kv.keys(), ['dirty', 'page:d-2026-10-04', 'page:w-2026-09-27']);

  await kv.del('dirty');
  assert.equal(await kv.get('dirty'), undefined);

  // "Reload": a second openKV on the same factory sees the data.
  const kv2 = await openKV({ indexedDB: idb, IDBKeyRange: range, dbName: 'test-db' });
  assert.deepEqual(await kv2.get('page:w-2026-09-27'), { v: 1, strokes: {} });
});

test('IndexedDB KV: keys(prefix) works without IDBKeyRange (filters in JS)', async () => {
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, IDBKeyRange: null });
  await kv.set('own:a', 1);
  await kv.set('page:a', 1);
  assert.deepEqual(await kv.keys('own:'), ['own:a']);
});

test('IndexedDB KV: set resolves only after the transaction completes', async () => {
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, dbName: 'commit-db' });
  idb.commitsPaused = true;
  let done = false;
  const p = kv.set('k', 42).then(() => { done = true; });
  await ticks(5);
  assert.equal(done, false, 'must not resolve on request success alone');
  assert.equal(idb.committed('commit-db').has('k'), false);
  idb.resumeCommits();
  await p;
  assert.equal(done, true);
  assert.equal(idb.committed('commit-db').get('k'), 42);
});

test('IndexedDB KV: failed writes reject (and nothing is stored)', async () => {
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb });
  idb.failWrites = domError('QuotaExceededError');
  await assert.rejects(kv.set('big', 'x'), { name: 'QuotaExceededError' });
  idb.failWrites = null;
  assert.equal(await kv.get('big'), undefined);
  await assert.rejects(kv.set('fn', () => 1)); // DataCloneError thrown synchronously by put()
  await assert.rejects(kv.get(7), TypeError);
});

test('IndexedDB KV: a silently lost connection is reopened once and the operation retried', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, dbName: 'lost-db' });
  await kv.set('a', 1);
  const opensBefore = idb.opens;
  idb.loseConnections();
  assert.equal(await kv.get('a'), 1);
  assert.equal(idb.opens, opensBefore + 1);
  assert.equal(kv.kind, 'indexeddb');
  await kv.set('b', 2);
  assert.equal(idb.committed('lost-db').get('b'), 2);
  assert.equal(warn.mock.callCount(), 0);
});

test('IndexedDB KV: onclose (abnormal close) → reopen on next use', async () => {
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, dbName: 'close-db' });
  await kv.set('a', 1);
  const rec = idb.dbs.get('close-db');
  const [conn] = rec.connections;
  conn.closed = true;
  rec.connections.clear();
  conn.onclose?.({});
  assert.equal(await kv.get('a'), 1);
  assert.equal(kv.kind, 'indexeddb');
});

test('IndexedDB KV: if reopening fails, continue in memory with a warning', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb });
  idb.loseConnections();
  idb.openBehavior = 'error';
  await kv.set('x', 'mem');
  assert.equal(kv.kind, 'memory');
  assert.equal(await kv.get('x'), 'mem');
  assert.equal(warn.mock.callCount(), 1);
});

test('IndexedDB KV: versionchange → close the connection and continue in memory', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, dbName: 'vc-db' });
  await kv.set('before', 1);
  idb.fireVersionChange();
  assert.equal(kv.kind, 'memory');
  assert.equal(idb.dbs.get('vc-db').connections.size, 0, 'connection released so the other tab is not blocked');
  await kv.set('after', 2);
  assert.equal(await kv.get('after'), 2);
  assert.equal(idb.committed('vc-db').has('after'), false, 'stale tab never writes into the upgraded DB');
  assert.equal(warn.mock.callCount(), 1);
});

test('openKV: existing database without the store gets it via a version bump', async (t) => {
  t.mock.method(console, 'warn', () => {}); // the first KV gets a versionchange
  const idb = createFakeIndexedDB();
  const other = await openKV({ indexedDB: idb, dbName: 'shared', storeName: 'other' });
  await other.set('o', 1);
  const kv = await openKV({ indexedDB: idb, dbName: 'shared', storeName: 'kv' });
  assert.equal(kv.kind, 'indexeddb');
  assert.equal(idb.dbs.get('shared').version, 2);
  await kv.set('k', 'v');
  assert.equal(await kv.get('k'), 'v');
});

// ---------------------------------------------------------------- update (read-modify-write)

test('memory KV: update reads, writes and resolves to the stored value; undefined → no write', async () => {
  const kv = createMemoryKV();
  assert.equal(await kv.update('list', (cur) => [...(cur || []), 'a']).then((v) => v.length), 1);
  assert.deepEqual(await kv.update('list', (cur) => [...cur, 'b']), ['a', 'b']);
  assert.deepEqual(await kv.get('list'), ['a', 'b']);
  assert.deepEqual(await kv.update('list', () => undefined), ['a', 'b']);
  assert.equal(await kv.update('none', () => undefined), undefined);
  assert.equal(await kv.get('none'), undefined);
  await assert.rejects(kv.update('x', 'not a function'), TypeError);
  await assert.rejects(kv.update('x', () => { throw new Error('boom'); }), /boom/);
  await assert.rejects(kv.update('x', () => ({ f() {} }))); // uncloneable
  assert.equal(await kv.get('x'), undefined);
});

test('IndexedDB KV: concurrent updates of one key never lose each other (one transaction each)', async () => {
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, dbName: 'upd-db' });
  const add = (id) => kv.update('dirty', (cur) => [...(Array.isArray(cur) ? cur : []), id]);
  await Promise.all([add('p1'), add('p2'), add('p3')]);
  assert.deepEqual(await kv.get('dirty'), ['p1', 'p2', 'p3']);
  // A second "tab" (another connection on the same database) interleaves with this one.
  const other = await openKV({ indexedDB: idb, dbName: 'upd-db' });
  await Promise.all([add('p4'), other.update('dirty', (cur) => cur.filter((x) => x !== 'p1'))]);
  assert.deepEqual(await kv.get('dirty'), ['p2', 'p3', 'p4']);
});

test('IndexedDB KV: update resolves after commit; undefined → nothing written', async () => {
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, dbName: 'upd2-db' });
  idb.commitsPaused = true;
  let done = false;
  const p = kv.update('k', () => 7).then((v) => { done = v; });
  await ticks(5);
  assert.equal(done, false);
  idb.resumeCommits();
  await p;
  assert.equal(done, 7);
  assert.equal(idb.committed('upd2-db').get('k'), 7);
  assert.equal(await kv.update('k', (cur) => (cur === 7 ? undefined : 0)), 7);
  assert.equal(await kv.update('missing', () => undefined), undefined);
  assert.equal(idb.committed('upd2-db').has('missing'), false);
});

test('IndexedDB KV: a failing write or updater rejects update and stores nothing', async () => {
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, dbName: 'upd3-db' });
  await kv.set('k', 1);
  idb.failWrites = domError('QuotaExceededError');
  await assert.rejects(kv.update('k', () => 2), { name: 'QuotaExceededError' });
  idb.failWrites = null;
  assert.equal(await kv.get('k'), 1);
  await assert.rejects(kv.update('k', () => { throw new Error('bad merge'); }), /bad merge/);
  await assert.rejects(kv.update('k', () => () => 1)); // DataCloneError from put()
  assert.equal(await kv.get('k'), 1);
  await assert.rejects(kv.update(5, () => 1), TypeError);
  await assert.rejects(kv.update('k'), TypeError);
});

test('IndexedDB KV: update after a lost connection reopens and re-runs the updater on fresh data', async () => {
  const idb = createFakeIndexedDB();
  const kv = await openKV({ indexedDB: idb, dbName: 'upd4-db' });
  await kv.set('n', 1);
  idb.loseConnections();
  assert.equal(await kv.update('n', (cur) => cur + 1), 2);
  assert.equal(idb.committed('upd4-db').get('n'), 2);
});

// ---------------------------------------------------------------- onDegraded

test('onDegraded fires once when IndexedDB is lost mid-session (versionchange / reopen failed)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const idb = createFakeIndexedDB();
  const reasons = [];
  const kv = await openKV({ indexedDB: idb, dbName: 'deg-db', onDegraded: (r) => reasons.push(r) });
  assert.deepEqual(reasons, []);
  idb.fireVersionChange();
  idb.fireVersionChange();
  assert.deepEqual(reasons, ['versionchange']);
  assert.equal(kv.kind, 'memory');

  const idb2 = createFakeIndexedDB();
  const reasons2 = [];
  const kv2 = await openKV({ indexedDB: idb2, onDegraded: (r) => { reasons2.push(r); throw new Error('handler bug'); } });
  idb2.loseConnections();
  idb2.openBehavior = 'error';
  await kv2.set('x', 1); // still works (in memory)
  assert.deepEqual(reasons2, ['reopen failed']);
  assert.equal(await kv2.update('x', (cur) => cur + 1), 2);
});

test('onDegraded is not called for a memory KV from the start (kind tells that)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const reasons = [];
  const kv = await openKV({ indexedDB: null, onDegraded: (r) => reasons.push(r) });
  assert.equal(kv.kind, 'memory');
  assert.deepEqual(reasons, []);
});
