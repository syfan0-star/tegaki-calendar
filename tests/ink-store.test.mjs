import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInkStore } from '../js/data/ink-store.js';
import { createMemoryKV } from '../js/util/idb.js';
import {
  addStrokes, deserializePage, emptyPage, makeStroke, mergePages, removeStrokes, sameContent,
} from '../js/ink/model.js';

const PAGE = 'd-2026-10-04';
const PAGE2 = 'w-2026-09-27';

// ---------------------------------------------------------------- helpers

const macrotask = () => new Promise((resolve) => setImmediate(resolve));
async function settle(n = 30) {
  for (let i = 0; i < n; i++) await macrotask();
}

const md5 = (text) => createHash('md5').update(text).digest('hex');

function netError() {
  return Object.assign(new Error('network'), { name: 'ApiError', status: 0, reason: 'network' });
}
function authError() {
  const err = new Error('Googleへのログインが必要です');
  err.name = 'AuthRequiredError';
  return err;
}
function apiError(status, reason) {
  return Object.assign(new Error(`api ${status}`), { name: 'ApiError', status, reason });
}

/** One remote appDataFolder shared by every fake device. */
function createRemote() {
  let clock = Date.parse('2026-10-04T00:00:00.000Z');
  let seq = 0;
  return {
    files: new Map(),
    nextTime() {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId() {
      seq += 1;
      return `file${String(seq).padStart(4, '0')}`;
    },
    /** Adds a file directly (as if another installation wrote it). */
    put({ id = this.newId(), page, dev, content, createdTime = this.nextTime() }) {
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      this.files.set(id, {
        id, name: `ink-${page}--${dev}.json`, appProperties: { page, dev, schema: '1' },
        content: text, md5Checksum: md5(text), version: 1, createdTime, modifiedTime: createdTime,
      });
      return id;
    },
    filesOf(page, dev) {
      return [...this.files.values()].filter((f) => f.appProperties.page === page && (!dev || f.appProperties.dev === dev));
    },
    /** What any reader would see: the merge of every device's file for the page. */
    merged(page) {
      return this.filesOf(page).reduce((acc, f) => mergePages(acc, deserializePage(f.content, page)), emptyPage(page));
    },
  };
}

const metaOf = (f) => ({
  id: f.id, name: f.name, createdTime: f.createdTime, modifiedTime: f.modifiedTime, version: String(f.version),
  md5Checksum: f.md5Checksum, size: String(f.content.length), appProperties: { ...f.appProperties },
});

/** Fake js/google/drive.js API over a shared remote, with failure switches and call recording. */
function createFakeDrive(remote) {
  const calls = [];
  const state = {
    offline: false,
    auth: false,
    quota: false,
    failAfterCreateOnce: false, // the server creates the file but the client sees a network error
    listMisses: new Set(), // file ids listPageFiles does not return yet (Drive search is eventually consistent)
    holdWrites: false,
    waiters: [],
    activeWrites: new Map(),
    maxActiveWrites: 0,
  };
  const notFound = () => apiError(404, 'notFound');

  async function call(name, args, fn) {
    calls.push({ name, args });
    await Promise.resolve();
    if (state.offline) throw netError();
    if (state.auth) throw authError();
    return fn();
  }

  async function write(page, fn) {
    const n = (state.activeWrites.get(page) || 0) + 1;
    state.activeWrites.set(page, n);
    state.maxActiveWrites = Math.max(state.maxActiveWrites, n);
    try {
      if (state.holdWrites) await new Promise((resolve) => state.waiters.push(resolve));
      return fn();
    } finally {
      state.activeWrites.set(page, state.activeWrites.get(page) - 1);
    }
  }

  return {
    calls,
    state,
    count: (name) => calls.filter((c) => c.name === name).length,
    release() {
      for (const resolve of state.waiters.splice(0)) resolve();
    },
    listPageFiles: (pageId) => call('listPageFiles', [pageId], () => remote.filesOf(pageId)
      .filter((f) => !state.listMisses.has(f.id))
      .sort((a, b) => a.createdTime.localeCompare(b.createdTime))
      .map(metaOf)),
    getMeta: (id) => call('getMeta', [id], () => {
      const f = remote.files.get(id);
      if (!f) throw notFound();
      return metaOf(f);
    }),
    download: (id) => call('download', [id], () => {
      const f = remote.files.get(id);
      if (!f) throw notFound();
      return f.content;
    }),
    generateId: () => call('generateId', [], () => remote.newId()),
    create: (meta, text) => call('create', [meta, text], () => write(meta.appProperties.page, () => {
      if (state.quota) throw apiError(403, 'storageQuotaExceeded');
      const existing = remote.files.get(meta.id);
      if (existing) {
        // 409 with a pre-generated id → drive.js writes this (newer) content with update(id, text)
        existing.content = text;
        existing.md5Checksum = md5(text);
        existing.version += 1;
        existing.modifiedTime = remote.nextTime();
        return metaOf(existing);
      }
      const time = remote.nextTime();
      const f = {
        id: meta.id, name: meta.name, appProperties: { ...meta.appProperties }, content: text,
        md5Checksum: md5(text), version: 1, createdTime: time, modifiedTime: time,
      };
      remote.files.set(f.id, f);
      if (state.failAfterCreateOnce) {
        state.failAfterCreateOnce = false;
        throw netError();
      }
      return metaOf(f);
    })),
    update: (id, text) => call('update', [id, text], () => write(remote.files.get(id)?.appProperties.page ?? '?', () => {
      if (state.quota) throw apiError(403, 'storageQuotaExceeded');
      const f = remote.files.get(id);
      if (!f) throw notFound();
      f.content = text;
      f.md5Checksum = md5(text);
      f.version += 1;
      f.modifiedTime = remote.nextTime();
      return metaOf(f);
    })),
    remove: (id) => call('remove', [id], () => {
      remote.files.delete(id);
    }),
  };
}

function createFakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimer: (fn, ms) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimer: (id) => {
      pending.delete(id);
    },
    get size() {
      return pending.size;
    },
    delays: () => [...pending.values()].map((t) => t.ms),
    async runAll() {
      const list = [...pending.values()];
      pending.clear();
      for (const t of list) t.fn();
      await settle();
    },
  };
}

function makeDevice(remote, name, { kv = createMemoryKV(), drive, ...opts } = {}) {
  const timers = createFakeTimers();
  const remoteUpdates = [];
  const statuses = [];
  const fakeDrive = drive === undefined ? createFakeDrive(remote) : drive;
  const store = createInkStore({
    kv,
    drive: fakeDrive,
    deviceId: `dev-${name}`,
    onRemoteUpdate: (pageId, doc) => remoteUpdates.push({ pageId, doc }),
    onStatus: (status, detail) => statuses.push({ status, ...detail }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => 1_700_000_000_000,
    ...opts,
  });
  return { name, store, kv, drive: fakeDrive, timers, remoteUpdates, statuses, deviceId: `dev-${name}` };
}

let strokeX = 0;
function stroke() {
  strokeX += 10;
  return makeStroke({ tool: 'pen', color: '#1f2937', size: 3.5, pts: [strokeX, 10, 0.5, strokeX + 5, 30, 0.6], t: 1000 + strokeX });
}

/** Simulates the surface: take the current doc, add strokes, save. */
async function draw(dev, pageId, ...strokes) {
  const doc = await dev.store.load(pageId);
  const next = addStrokes(doc, strokes, 2000);
  await dev.store.save(pageId, next);
  return next;
}
async function erase(dev, pageId, ids) {
  const doc = await dev.store.load(pageId);
  const next = removeStrokes(doc, ids, 3000);
  await dev.store.save(pageId, next);
  return next;
}
const liveIds = (doc) => Object.keys(doc.strokes).sort();
const statusList = (dev) => dev.statuses.map((s) => s.status);

// ---------------------------------------------------------------- construction / validation

test('createInkStore validates its options', () => {
  assert.throws(() => createInkStore({ deviceId: 'x' }), TypeError);
  assert.throws(() => createInkStore({ kv: createMemoryKV() }), TypeError);
  assert.throws(() => createInkStore({ kv: createMemoryKV(), deviceId: 'x', drive: { listPageFiles() {} } }), TypeError);
  assert.doesNotThrow(() => createInkStore({ kv: createMemoryKV(), deviceId: 'x', drive: null }));
});

test('invalid page ids and docs are rejected', async () => {
  const { store } = makeDevice(createRemote(), 'a', { drive: null });
  await assert.rejects(store.load(''), TypeError);
  await assert.rejects(store.load(42), TypeError);
  await assert.rejects(store.refresh(null), TypeError);
  await assert.rejects(store.save(PAGE, null), TypeError);
  await assert.rejects(store.save(PAGE, { strokes: 'x' }), TypeError);
  await assert.rejects(store.save('', emptyPage('')), TypeError);
});

// ---------------------------------------------------------------- local behaviour

test('load returns emptyPage for an unknown page, then what was saved; never touches the network', async () => {
  const remote = createRemote();
  const dev = makeDevice(remote, 'a');
  const empty = await dev.store.load(PAGE);
  assert.deepEqual(liveIds(empty), []);
  assert.equal(empty.pageId, PAGE);
  const s = stroke();
  await draw(dev, PAGE, s);
  const again = await dev.store.load(PAGE);
  assert.deepEqual(liveIds(again), [s.id]);
  assert.equal(dev.drive.calls.length, 0, 'load/save must not call Drive (upload is debounced)');

  // A fresh store over the same KV (app restart) reads it back from 'page:<id>' without network.
  const restarted = makeDevice(remote, 'a', { kv: dev.kv });
  const reloaded = await restarted.store.load(PAGE);
  assert.deepEqual(liveIds(reloaded), [s.id]);
  assert.equal(restarted.drive.calls.length, 0);
  assert.ok((await dev.kv.get(`page:${PAGE}`)).strokes[s.id]);
});

test('load tolerates garbage in the KV', async () => {
  const kv = createMemoryKV();
  await kv.set(`page:${PAGE}`, '{"v":1,"strokes":{"bad":{"id":"bad"}}}');
  await kv.set(`page:${PAGE2}`, 12345);
  const { store } = makeDevice(createRemote(), 'a', { kv, drive: null });
  assert.deepEqual(liveIds(await store.load(PAGE)), []);
  assert.deepEqual(liveIds(await store.load(PAGE2)), []);
});

test('without a drive: status local, saves persist + mark dirty, refresh returns null', async () => {
  const dev = makeDevice(createRemote(), 'a', { drive: null });
  assert.equal(dev.store.getStatus(), 'local');
  await draw(dev, PAGE, stroke());
  assert.deepEqual(await dev.kv.get('dirty'), [PAGE]);
  assert.equal(dev.timers.size, 0, 'no upload scheduled without a drive');
  assert.equal(await dev.store.refresh(PAGE), null);
  assert.equal(await dev.store.flush(), false, 'still unsent');
  assert.equal(dev.store.getStatus(), 'local');
});

test('save merges with what is stored and reports content the caller lacks', async () => {
  const dev = makeDevice(createRemote(), 'a', { drive: null });
  const a = stroke();
  const b = stroke();
  await draw(dev, PAGE, a);
  // The caller still holds an old doc (without `a`) and adds `b`.
  const stale = addStrokes(emptyPage(PAGE), [b], 2000);
  const result = await dev.store.save(PAGE, stale);
  assert.deepEqual(liveIds(result), [a.id, b.id].sort());
  assert.deepEqual(liveIds(await dev.store.load(PAGE)), [a.id, b.id].sort());
  assert.equal(dev.remoteUpdates.length, 1);
  assert.deepEqual(liveIds(dev.remoteUpdates[0].doc), [a.id, b.id].sort());
});

// ---------------------------------------------------------------- upload

test('save schedules ONE debounced upload that creates this device\'s own file', async () => {
  const remote = createRemote();
  const dev = makeDevice(remote, 'a', { debounceMs: 1500 });
  await draw(dev, PAGE, stroke());
  await draw(dev, PAGE, stroke());
  await draw(dev, PAGE, stroke());
  assert.equal(dev.timers.size, 1, 'debounced');
  assert.deepEqual(dev.timers.delays(), [1500]);
  assert.equal(dev.store.getStatus(), 'pending');
  assert.equal(dev.drive.calls.length, 0);

  await dev.timers.runAll();
  assert.equal(dev.store.getStatus(), 'synced');
  assert.equal(dev.drive.count('create'), 1);
  const [file] = remote.filesOf(PAGE);
  assert.equal(file.name, `ink-${PAGE}--dev-a.json`);
  assert.deepEqual(file.appProperties, { page: PAGE, dev: 'dev-a', schema: '1' });
  assert.ok(sameContent(deserializePage(file.content, PAGE), await dev.store.load(PAGE)));
  assert.equal(await dev.kv.get(`own:${PAGE}`), file.id);
  assert.deepEqual(await dev.kv.get(`seen:${PAGE}`), { [file.id]: file.md5Checksum });
  assert.deepEqual(await dev.kv.get('dirty'), []);

  // Next change updates the same file (no new create, no list).
  await draw(dev, PAGE, stroke());
  await dev.timers.runAll();
  assert.equal(dev.drive.count('create'), 1);
  assert.equal(dev.drive.count('update'), 1);
  assert.equal(remote.files.size, 1);
  assert.equal(liveIds(deserializePage(remote.files.get(file.id).content, PAGE)).length, 4);
});

test('status transitions: pending → syncing → synced, reported through onStatus', async () => {
  const dev = makeDevice(createRemote(), 'a');
  assert.equal(dev.store.getStatus(), 'synced');
  await draw(dev, PAGE, stroke());
  assert.equal(dev.store.getStatus(), 'pending');
  await dev.timers.runAll();
  assert.deepEqual(statusList(dev), ['pending', 'syncing', 'synced']);
  const last = dev.statuses.at(-1);
  assert.equal(last.message, null);
  assert.equal(last.dirtyCount, 0);
  assert.equal(last.lastSyncAt, 1_700_000_000_000);
});

test('two devices editing the same page concurrently converge after flush + refresh', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  const B = makeDevice(remote, 'b');
  const a1 = stroke();
  const a2 = stroke();
  const b1 = stroke();
  await Promise.all([draw(A, PAGE, a1, a2), draw(B, PAGE, b1)]);
  await Promise.all([A.store.flush(), B.store.flush()]);
  assert.equal(remote.files.size, 2, 'one file per device');

  const [mergedA, mergedB] = await Promise.all([A.store.refresh(PAGE), B.store.refresh(PAGE)]);
  const expected = [a1.id, a2.id, b1.id].sort();
  assert.deepEqual(liveIds(mergedA), expected);
  assert.deepEqual(liveIds(mergedB), expected);
  assert.ok(sameContent(await A.store.load(PAGE), await B.store.load(PAGE)));
  assert.deepEqual(liveIds(A.remoteUpdates.at(-1).doc), expected);
  assert.deepEqual(liveIds(B.remoteUpdates.at(-1).doc), expected);

  // Each own file is brought up to the full merged doc; a further round changes nothing.
  await Promise.all([A.store.flush(), B.store.flush()]);
  for (const f of remote.filesOf(PAGE)) assert.deepEqual(liveIds(deserializePage(f.content, PAGE)), expected);
  assert.equal(await A.store.refresh(PAGE), null);
  assert.equal(await B.store.refresh(PAGE), null);
  assert.equal(A.store.getStatus(), 'synced');
  assert.equal(B.store.getStatus(), 'synced');
});

test('erasing on device B removes A\'s stroke on A after refresh', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  const B = makeDevice(remote, 'b');
  const keep = stroke();
  const gone = stroke();
  await draw(A, PAGE, keep, gone);
  await A.store.flush();

  const seenOnB = await B.store.refresh(PAGE);
  assert.deepEqual(liveIds(seenOnB), [keep.id, gone.id].sort());
  await erase(B, PAGE, [gone.id]);
  await B.store.flush();

  const onA = await A.store.refresh(PAGE);
  assert.deepEqual(liveIds(onA), [keep.id]);
  assert.ok(onA.deleted[gone.id], 'tombstone merged');
  assert.deepEqual(liveIds(A.remoteUpdates.at(-1).doc), [keep.id]);
  assert.deepEqual(liveIds(await A.store.load(PAGE)), [keep.id]);
  // A's own file was written by A only, and still holds the stroke until A uploads again: readers
  // nevertheless see it as deleted because tombstones win in the merge.
  assert.deepEqual(liveIds(remote.merged(PAGE)), [keep.id]);
  await A.store.flush();
  assert.deepEqual(liveIds(deserializePage(remote.filesOf(PAGE, 'dev-a')[0].content, PAGE)), [keep.id]);
});

test('refresh returns null when nothing changed and skips files whose md5 is unchanged', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  const B = makeDevice(remote, 'b');
  await draw(A, PAGE, stroke());
  await A.store.flush();

  assert.notEqual(await B.store.refresh(PAGE), null);
  const downloads = B.drive.count('download');
  assert.equal(downloads, 1);
  assert.equal(await B.store.refresh(PAGE), null);
  assert.equal(B.drive.count('download'), downloads, 'unchanged md5 → no download');
  assert.equal(B.remoteUpdates.length, 1);

  // Own file is not downloaded by its writer either.
  assert.equal(await A.store.refresh(PAGE), null);
  assert.equal(A.drive.count('download'), 0);
  // A page nobody wrote: nothing to do.
  assert.equal(await A.store.refresh(PAGE2), null);
});

test('viewing a page refreshed from another device does not echo-loop', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  const B = makeDevice(remote, 'b');
  await draw(A, PAGE, stroke());
  await A.store.flush();
  await B.store.refresh(PAGE);
  await B.store.flush(); // B's own file now holds the merged doc too
  assert.equal(await A.store.refresh(PAGE), null, 'B\'s file adds nothing new for A');
  assert.equal(A.store.getStatus(), 'synced');
  assert.equal(A.timers.size, 0);
});

// ---------------------------------------------------------------- errors / offline

test('offline save keeps the page dirty (persisted) and uploads later', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  A.drive.state.offline = true;
  const s1 = stroke();
  await draw(A, PAGE, s1);
  await A.timers.runAll();
  assert.equal(A.store.getStatus(), 'offline');
  assert.match(A.store.getStatusDetail().message, /オフライン/);
  assert.deepEqual(await A.kv.get('dirty'), [PAGE]);
  assert.equal(remote.files.size, 0);
  assert.deepEqual(liveIds(await A.store.load(PAGE)), [s1.id], 'local data intact');

  // Still offline: the next save retries (and fails again) without losing anything.
  const s2 = stroke();
  await draw(A, PAGE, s2);
  await A.timers.runAll();
  assert.equal(A.store.getStatus(), 'offline');

  // Back online: flush() (main.js calls it on window 'online').
  A.drive.state.offline = false;
  assert.equal(await A.store.flush(), true);
  assert.equal(A.store.getStatus(), 'synced');
  assert.deepEqual(await A.kv.get('dirty'), []);
  assert.deepEqual(liveIds(remote.merged(PAGE)), [s1.id, s2.id].sort());
});

test('unsent pages survive a restart and are uploaded by the next session', async () => {
  const remote = createRemote();
  const kv = createMemoryKV();
  const first = makeDevice(remote, 'a', { kv });
  first.drive.state.offline = true;
  const s = stroke();
  await draw(first, PAGE, s);
  await first.timers.runAll();
  assert.equal(first.store.getStatus(), 'offline');

  const second = makeDevice(remote, 'a', { kv }); // app restarted, network back
  await settle();
  assert.equal(second.store.getStatus(), 'pending');
  assert.equal(second.timers.size, 1, 'leftover dirty page scheduled');
  await second.timers.runAll();
  assert.equal(second.store.getStatus(), 'synced');
  assert.deepEqual(liveIds(remote.merged(PAGE)), [s.id]);
});

test('a network error after the server created the file does not create a duplicate on retry', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  A.drive.state.failAfterCreateOnce = true;
  await draw(A, PAGE, stroke());
  assert.equal(await A.store.flush(), false);
  assert.equal(A.store.getStatus(), 'offline');
  assert.equal(remote.files.size, 1, 'server did create it');

  await draw(A, PAGE, stroke());
  assert.equal(await A.store.flush(), true);
  assert.equal(remote.files.size, 1, 'retry reused the pre-generated id (409 → existing file)');
  assert.equal(A.drive.count('generateId'), 1);
  assert.equal(liveIds(remote.merged(PAGE)).length, 2);
});

test('auth error → pending, no automatic retries, setDrive() retries', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  A.drive.state.auth = true;
  await draw(A, PAGE, stroke());
  await A.timers.runAll();
  assert.equal(A.store.getStatus(), 'pending');
  assert.match(A.store.getStatusDetail().message, /再接続/);
  const callsAfterFailure = A.drive.calls.length;

  await draw(A, PAGE, stroke());
  await A.timers.runAll();
  assert.equal(A.drive.calls.length, callsAfterFailure, 'waits for setDrive() instead of hammering');
  assert.equal(await A.store.refresh(PAGE), null);
  assert.equal(A.drive.calls.length, callsAfterFailure);

  A.drive.state.auth = false;
  assert.equal(await A.store.setDrive(A.drive), true);
  assert.equal(A.store.getStatus(), 'synced');
  assert.equal(liveIds(remote.merged(PAGE)).length, 2);
});

test('storage quota exceeded → error with a message; data kept; later success clears it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  A.drive.state.quota = true;
  await draw(A, PAGE, stroke());
  await A.timers.runAll();
  assert.equal(A.store.getStatus(), 'error');
  assert.match(A.store.getStatusDetail().message, /容量/);
  assert.match(A.statuses.at(-1).message, /容量/);
  assert.deepEqual(await A.kv.get('dirty'), [PAGE]);

  A.drive.state.quota = false;
  assert.equal(await A.store.flush(), true);
  assert.equal(A.store.getStatus(), 'synced');
  assert.equal(A.store.getStatusDetail().message, null);
});

test('other API errors → error status, page stays dirty, retried on the next flush', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  const original = A.drive.generateId;
  A.drive.generateId = async () => { throw apiError(500, 'backendError'); };
  await draw(A, PAGE, stroke());
  assert.equal(await A.store.flush(), false);
  assert.equal(A.store.getStatus(), 'error');
  assert.deepEqual(await A.kv.get('dirty'), [PAGE]);
  assert.equal(warn.mock.callCount(), 1);
  A.drive.generateId = original;
  assert.equal(await A.store.flush(), true);
  assert.equal(A.store.getStatus(), 'synced');
});

test('refresh errors are reported through the status and resolve to null', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  A.drive.state.offline = true;
  assert.equal(await A.store.refresh(PAGE), null);
  assert.equal(A.store.getStatus(), 'offline');
  A.drive.state.offline = false;
  assert.equal(await A.store.refresh(PAGE), null);
  assert.equal(A.store.getStatus(), 'synced');
});

// ---------------------------------------------------------------- concurrency

test('uploads are serialized per page (a save during an upload re-schedules after it)', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  A.drive.state.holdWrites = true;
  const s1 = stroke();
  await draw(A, PAGE, s1);
  await A.timers.runAll(); // upload #1 starts and is held inside create()
  assert.equal(A.store.getStatus(), 'syncing');
  assert.equal(A.drive.state.activeWrites.get(PAGE), 1);

  const s2 = stroke();
  await draw(A, PAGE, s2);
  await A.timers.runAll(); // upload #2 queued behind #1
  const flushed = A.store.flush(); // and an explicit flush on top
  const s3 = stroke();
  await draw(A, PAGE2, s3); // another page is independent
  await settle();
  assert.equal(A.drive.state.maxActiveWrites, 1);

  let done = false;
  flushed.then(() => { done = true; });
  for (let i = 0; i < 20 && !done; i++) {
    A.drive.release();
    await settle(5);
  }
  assert.equal(done, true);
  assert.equal(A.drive.state.maxActiveWrites, 1, 'never two concurrent uploads for one page');
  assert.deepEqual(liveIds(remote.merged(PAGE)), [s1.id, s2.id].sort());
  assert.equal(remote.filesOf(PAGE, 'dev-a').length, 1);
  A.drive.state.holdWrites = false;
  await A.timers.runAll();
  assert.deepEqual(liveIds(remote.merged(PAGE2)), [s3.id]);
  assert.equal(A.store.getStatus(), 'synced');
});

// ---------------------------------------------------------------- own-file recovery

test('404 on update → forget the own file id and create a new file', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  const s1 = stroke();
  await draw(A, PAGE, s1);
  await A.store.flush();
  const oldId = await A.kv.get(`own:${PAGE}`);
  remote.files.delete(oldId); // e.g. the user deleted hidden app data

  const s2 = stroke();
  await draw(A, PAGE, s2);
  assert.equal(await A.store.flush(), true);
  const newId = await A.kv.get(`own:${PAGE}`);
  assert.notEqual(newId, oldId);
  assert.deepEqual(liveIds(deserializePage(remote.files.get(newId).content, PAGE)), [s1.id, s2.id].sort());
});

test('duplicates of the own file: oldest survives with everything merged, the rest are removed', async () => {
  const remote = createRemote();
  const s1 = stroke();
  const s2 = stroke();
  const older = remote.put({ page: PAGE, dev: 'dev-a', content: addStrokes(emptyPage(PAGE), [s1], 1) });
  const newer = remote.put({ page: PAGE, dev: 'dev-a', content: addStrokes(emptyPage(PAGE), [s2], 1) });
  const other = remote.put({ page: PAGE, dev: 'dev-b', content: emptyPage(PAGE) });

  const A = makeDevice(remote, 'a'); // e.g. reinstalled with the same deviceId: KV knows nothing
  const s3 = stroke();
  await draw(A, PAGE, s3);
  assert.equal(await A.store.flush(), true);

  assert.equal(await A.kv.get(`own:${PAGE}`), older);
  assert.equal(remote.files.has(newer), false, 'duplicate removed');
  assert.equal(remote.files.has(other), true, 'other devices\' files are never touched');
  assert.deepEqual(liveIds(deserializePage(remote.files.get(older).content, PAGE)), [s1.id, s2.id, s3.id].sort());
  assert.deepEqual(liveIds(await A.store.load(PAGE)), [s1.id, s2.id, s3.id].sort());
  assert.deepEqual(liveIds(A.remoteUpdates.at(-1).doc), [s1.id, s2.id, s3.id].sort());
  assert.equal(A.drive.count('update'), 1);
  assert.equal(A.drive.count('create'), 0);
});

test('duplicates found by refresh are cleaned up by the next upload', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  const s1 = stroke();
  await draw(A, PAGE, s1);
  await A.store.flush();
  const ownId = await A.kv.get(`own:${PAGE}`);
  // A stray second file of this device appears (e.g. created by a lost-KV session).
  const s2 = stroke();
  const stray = remote.put({ page: PAGE, dev: 'dev-a', content: addStrokes(emptyPage(PAGE), [s2], 1) });

  const merged = await A.store.refresh(PAGE);
  assert.deepEqual(liveIds(merged), [s1.id, s2.id].sort());
  assert.equal(A.store.getStatus(), 'pending');
  await A.timers.runAll();
  assert.equal(A.store.getStatus(), 'synced');
  assert.deepEqual(remote.filesOf(PAGE, 'dev-a').map((f) => f.id), [ownId]);
  assert.equal(remote.files.has(stray), false);
  assert.deepEqual(liveIds(remote.merged(PAGE)), [s1.id, s2.id].sort());
});

test('reinstall with the same deviceId: refresh recovers and adopts the own file', async () => {
  const remote = createRemote();
  const before = makeDevice(remote, 'a');
  const s1 = stroke();
  await draw(before, PAGE, s1);
  await before.store.flush();
  const fileId = await before.kv.get(`own:${PAGE}`);

  const after = makeDevice(remote, 'a'); // fresh KV
  const merged = await after.store.refresh(PAGE);
  assert.deepEqual(liveIds(merged), [s1.id]);
  assert.equal(await after.kv.get(`own:${PAGE}`), fileId);
  assert.equal(after.store.getStatus(), 'synced', 'local == own file → nothing to upload');
  assert.equal(after.timers.size, 0);
});

test('the own file changed behind our back is merged, not overwritten, on the next upload', async () => {
  const remote = createRemote();
  const kv = createMemoryKV();
  const first = makeDevice(remote, 'a', { kv });
  const s1 = stroke();
  await draw(first, PAGE, s1);
  await first.store.flush();
  const fileId = await kv.get(`own:${PAGE}`);
  // Someone else (another tab, a session that ran on a lost KV) rewrote our file with more content.
  const foreign = stroke();
  const f = remote.files.get(fileId);
  f.content = JSON.stringify(addStrokes(deserializePage(f.content, PAGE), [foreign], 5));
  f.md5Checksum = md5(f.content);

  const second = makeDevice(remote, 'a', { kv }); // new session, same KV
  const s2 = stroke();
  await draw(second, PAGE, s2);
  assert.equal(await second.store.flush(), true);
  assert.deepEqual(liveIds(deserializePage(remote.files.get(fileId).content, PAGE)), [s1.id, s2.id, foreign.id].sort());
  assert.deepEqual(liveIds(await second.store.load(PAGE)), [s1.id, s2.id, foreign.id].sort());
  assert.equal(second.drive.count('getMeta'), 1);
});

test('refresh survives a file deleted between list and download, and garbage content', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  remote.put({ page: PAGE, dev: 'dev-b', content: 'not json {' });
  const s = stroke();
  const good = remote.put({ page: PAGE, dev: 'dev-c', content: addStrokes(emptyPage(PAGE), [s], 1) });
  const vanishing = remote.put({ page: PAGE, dev: 'dev-d', content: emptyPage(PAGE) });
  const download = A.drive.download;
  A.drive.download = async (id) => {
    if (id === vanishing) remote.files.delete(id);
    return download(id);
  };
  const merged = await A.store.refresh(PAGE);
  assert.deepEqual(liveIds(merged), [s.id]);
  assert.ok(remote.files.has(good));
  assert.notEqual(A.store.getStatus(), 'error');
});

// ---------------------------------------------------------------- setDrive

test('setDrive(null) → local (timers cancelled); setDrive(drive) uploads what was saved meanwhile', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  await draw(A, PAGE, stroke());
  assert.equal(A.timers.size, 1);
  await A.store.setDrive(null);
  assert.equal(A.store.getStatus(), 'local');
  assert.equal(A.timers.size, 0);
  await draw(A, PAGE2, stroke());
  assert.equal(A.timers.size, 0);
  assert.equal(A.drive.calls.length, 0);

  assert.equal(await A.store.setDrive(A.drive), true);
  assert.equal(A.store.getStatus(), 'synced');
  assert.equal(remote.filesOf(PAGE).length, 1);
  assert.equal(remote.filesOf(PAGE2).length, 1);
  assert.throws(() => A.store.setDrive({ nope: true }), TypeError);
});

test('a store created without a drive can be given one later', async () => {
  const remote = createRemote();
  const drive = createFakeDrive(remote);
  const A = makeDevice(remote, 'a', { drive: null });
  const s = stroke();
  await draw(A, PAGE, s);
  assert.equal(await A.store.setDrive(drive), true);
  assert.deepEqual(liveIds(remote.merged(PAGE)), [s.id]);
});

test('remote wipe (own file gone) → refresh marks the page dirty and it is uploaded again', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  const s = stroke();
  await draw(A, PAGE, s);
  await A.store.flush();
  remote.files.clear(); // "Delete hidden app data" in Drive settings
  assert.equal(await A.store.refresh(PAGE), null, 'local content unchanged');
  assert.equal(A.store.getStatus(), 'pending', 'local has content the remote lacks');
  await A.timers.runAll();
  assert.equal(A.store.getStatus(), 'synced');
  assert.deepEqual(liveIds(remote.merged(PAGE)), [s.id]);
});

test('a failing local write rejects save() but the change is kept in memory and still uploaded', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const remote = createRemote();
  const base = createMemoryKV();
  let failPages = true;
  const kv = {
    get: base.get,
    del: base.del,
    keys: base.keys,
    async set(key, value) {
      if (failPages && key.startsWith('page:')) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      return base.set(key, value);
    },
  };
  const A = makeDevice(remote, 'a', { kv });
  const s = stroke();
  const doc = addStrokes(await A.store.load(PAGE), [s], 2000);
  await assert.rejects(A.store.save(PAGE, doc), { name: 'QuotaExceededError' });
  assert.deepEqual(liveIds(await A.store.load(PAGE)), [s.id]);
  assert.equal(A.store.getStatus(), 'pending');
  assert.equal(await A.store.flush(), true);
  assert.deepEqual(liveIds(remote.merged(PAGE)), [s.id]);
  failPages = false;
});

test('load and save of a cold page share one KV read; concurrent saves never lose strokes', async () => {
  const remote = createRemote();
  const base = createMemoryKV();
  let reads = 0;
  const kv = { ...base, async get(key) { if (key.startsWith('page:')) reads += 1; return base.get(key); } };
  const A = makeDevice(remote, 'a', { kv, drive: null });
  const s1 = stroke();
  const s2 = stroke();
  await Promise.all([
    A.store.load(PAGE),
    A.store.save(PAGE, addStrokes(emptyPage(PAGE), [s1], 1)),
    A.store.save(PAGE, addStrokes(emptyPage(PAGE), [s2], 1)),
  ]);
  assert.equal(reads, 1);
  assert.deepEqual(liveIds(await A.store.load(PAGE)), [s1.id, s2.id].sort());
  assert.deepEqual(liveIds(await base.get(`page:${PAGE}`)), [s1.id, s2.id].sort());
});

// ---------------------------------------------------------------- lost create response + stale listing

test('create retried after a lost response uploads the NEWER content (409 → update), not the first attempt', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  A.drive.state.failAfterCreateOnce = true;
  const s1 = stroke();
  await draw(A, PAGE, s1);
  assert.equal(await A.store.flush(), false);
  const [file] = remote.filesOf(PAGE);
  A.drive.state.listMisses.add(file.id); // the new file is not searchable yet

  const s2 = stroke();
  await draw(A, PAGE, s2);
  assert.equal(await A.store.flush(), true);
  assert.equal(remote.files.size, 1, 'same pre-generated id → no duplicate');
  assert.deepEqual(liveIds(deserializePage(remote.files.get(file.id).content, PAGE)), [s1.id, s2.id].sort());
  assert.deepEqual(await A.kv.get(`seen:${PAGE}`), { [file.id]: remote.files.get(file.id).md5Checksum });
  assert.equal(A.store.getStatus(), 'synced');
});

// ---------------------------------------------------------------- several tabs on one device

/** Two tabs / Split View windows of the app: same IndexedDB (kv), same deviceId, separate memory. */
function twoTabs(remote, { drive = true } = {}) {
  const kv = createMemoryKV();
  const A = makeDevice(remote, 'same', { kv, drive: drive ? undefined : null });
  const B = makeDevice(remote, 'same', { kv, drive: drive ? undefined : null });
  return { kv, A, B };
}

test('two tabs: a stale tab drawing never overwrites the other tab\'s strokes (IndexedDB and Drive)', async () => {
  const remote = createRemote();
  const { kv, A, B } = twoTabs(remote);
  await B.store.load(PAGE); // B has the page open (empty) …
  const x = stroke();
  await draw(A, PAGE, x); // … tab A draws X and uploads it
  assert.equal(await A.store.flush(), true);

  // Tab B comes back to the front with its stale cache and draws Y on top of what it shows.
  const shown = await B.store.load(PAGE);
  assert.deepEqual(liveIds(shown), [], 'B still shows its old cache');
  const y = stroke();
  const result = await B.store.save(PAGE, addStrokes(shown, [y], 2000));
  assert.deepEqual(liveIds(result), [x.id, y.id].sort());
  assert.deepEqual(liveIds(await kv.get(`page:${PAGE}`)), [x.id, y.id].sort(), 'X kept in IndexedDB');
  assert.deepEqual(liveIds(B.remoteUpdates.at(-1).doc), [x.id, y.id].sort(), 'B is told to show X');

  assert.equal(await B.store.flush(), true);
  const own = remote.filesOf(PAGE, 'dev-same');
  assert.equal(own.length, 1);
  assert.deepEqual(liveIds(deserializePage(own[0].content, PAGE)), [x.id, y.id].sort(), 'X kept on Drive');

  // And A, still holding only X, draws Z: nothing of B's is lost either.
  const z = stroke();
  await A.store.save(PAGE, addStrokes(addStrokes(emptyPage(PAGE), [x], 1), [z], 2));
  assert.equal(await A.store.flush(), true);
  assert.deepEqual(liveIds(remote.merged(PAGE)), [x.id, y.id, z.id].sort());
  assert.deepEqual(liveIds(await kv.get(`page:${PAGE}`)), [x.id, y.id, z.id].sort());
});

test('two tabs: an upload includes what the other tab stored, even before this tab saves again', async () => {
  const remote = createRemote();
  const { A, B } = twoTabs(remote);
  const a1 = stroke();
  await draw(A, PAGE, a1);
  await B.store.load(PAGE);
  const b1 = stroke();
  await B.store.save(PAGE, addStrokes(emptyPage(PAGE), [b1], 2)); // B now holds a1 + b1 (read-merge-write)
  // A uploads with its cache {a1}: the stored doc is merged in first.
  assert.equal(await A.store.flush(), true);
  const [own] = remote.filesOf(PAGE, 'dev-same');
  assert.deepEqual(liveIds(deserializePage(own.content, PAGE)), [a1.id, b1.id].sort());
  assert.deepEqual(liveIds(A.remoteUpdates.at(-1).doc), [a1.id, b1.id].sort());
});

test('two tabs: one tab marking its page clean never drops the other tab\'s unsent marks', async () => {
  const remote = createRemote();
  const { kv, A, B } = twoTabs(remote);
  await draw(A, PAGE, stroke());
  const b = stroke();
  await draw(B, PAGE2, b);
  assert.deepEqual((await kv.get('dirty')).sort(), [PAGE, PAGE2].sort());
  await A.timers.runAll(); // A's debounced upload of PAGE clears only PAGE
  assert.deepEqual(await kv.get('dirty'), [PAGE2]);

  // B's tab is closed before its upload ran: the next flush of A (e.g. on going to the background) sends it.
  assert.equal(await A.store.flush(), true);
  assert.deepEqual(liveIds(remote.merged(PAGE2)), [b.id]);
  assert.deepEqual(await kv.get('dirty'), []);
});

test('two tabs without Drive: refresh picks up what the other tab stored', async () => {
  const remote = createRemote();
  const { A, B } = twoTabs(remote, { drive: false });
  await B.store.load(PAGE);
  const x = stroke();
  await draw(A, PAGE, x);
  const merged = await B.store.refresh(PAGE);
  assert.deepEqual(liveIds(merged), [x.id]);
  assert.deepEqual(liveIds(B.remoteUpdates.at(-1).doc), [x.id]);
  assert.equal(await B.store.refresh(PAGE), null);
  assert.equal(await B.store.refresh(PAGE2), null, 'not loaded here → nothing to do');
});

test('the dirty mark is written before the page content (a crash in between never leaves unsent ink unmarked)', async () => {
  const base = createMemoryKV();
  const order = [];
  const kv = {
    ...base,
    update(key, fn) {
      order.push(key);
      return base.update(key, fn);
    },
  };
  const A = makeDevice(createRemote(), 'a', { kv, drive: null });
  await settle();
  await draw(A, PAGE, stroke());
  await draw(A, PAGE, stroke()); // also when this tab already had the mark (another tab may have cleared it)
  assert.deepEqual(order, ['dirty', `page:${PAGE}`, 'dirty', `page:${PAGE}`]);
  assert.deepEqual(await base.get('dirty'), [PAGE]);
});

// ---------------------------------------------------------------- unreadable stored page

/** KV whose 'page:<PAGE>' read fails (WebKit "UnknownError" that the reopen+retry did not fix). */
function brokenPageKV(base = createMemoryKV()) {
  const state = { broken: true, sets: 0 };
  const fail = () => Object.assign(new Error('Connection to Indexed Database server lost'), { name: 'UnknownError' });
  return {
    state,
    base,
    kind: 'indexeddb',
    get: async (key) => {
      if (state.broken && key === `page:${PAGE}`) throw fail();
      return base.get(key);
    },
    set: async (key, value) => {
      if (key === `page:${PAGE}`) state.sets += 1;
      return base.set(key, value);
    },
    update: async (key, fn) => {
      if (state.broken && key === `page:${PAGE}`) throw fail();
      return base.update(key, fn);
    },
    del: base.del,
    keys: base.keys,
  };
}

test('unreadable stored page: a save keeps the stroke, marks it dirty and uploads it — never overwriting the stored doc', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const remote = createRemote();
  const base = createMemoryKV();
  const old = stroke();
  await base.set(`page:${PAGE}`, addStrokes(emptyPage(PAGE), [old], 1)); // stored, not yet uploaded
  await base.set('dirty', [PAGE]);
  const kv = brokenPageKV(base);
  const A = makeDevice(remote, 'a', { kv });
  await settle();

  const shown = await A.store.load(PAGE);
  assert.deepEqual(liveIds(shown), []);
  assert.equal(A.store.isUnreadable(PAGE), true);

  const s1 = stroke();
  await assert.rejects(A.store.save(PAGE, addStrokes(shown, [s1], 2)), { name: 'UnknownError' });
  assert.deepEqual(liveIds(await A.store.load(PAGE)), [s1.id], 'kept in memory');
  assert.equal(kv.state.sets, 0, 'the unreadable record is never written blindly');
  assert.deepEqual(liveIds(await base.get(`page:${PAGE}`)), [old.id]);
  assert.equal(A.timers.size, 1, 'upload scheduled');

  await A.timers.runAll();
  assert.deepEqual(liveIds(remote.merged(PAGE)), [s1.id], 'the new stroke reached Drive');
  assert.deepEqual(await base.get('dirty'), [PAGE], 'still dirty: the stored doc may hold unsent strokes');
  assert.equal(A.store.getStatus(), 'pending');

  // The record becomes readable again: it is merged in, never lost, and the union is uploaded.
  kv.state.broken = false;
  const recovered = await A.store.load(PAGE);
  assert.deepEqual(liveIds(recovered), [old.id, s1.id].sort());
  assert.equal(A.store.isUnreadable(PAGE), false);
  assert.equal(await A.store.flush(), true);
  assert.deepEqual(liveIds(remote.merged(PAGE)), [old.id, s1.id].sort());
  assert.deepEqual(await base.get('dirty'), []);
});

test('unreadable stored page: the own Drive file is merged before it is overwritten (seen ignored)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const remote = createRemote();
  const base = createMemoryKV();
  // Earlier session: this device uploaded s0 and recorded it.
  const first = makeDevice(remote, 'a', { kv: base });
  const s0 = stroke();
  await draw(first, PAGE, s0);
  assert.equal(await first.store.flush(), true);

  const kv = brokenPageKV(base);
  const A = makeDevice(remote, 'a', { kv }); // new session, the page record cannot be read
  const s1 = stroke();
  await assert.rejects(A.store.save(PAGE, addStrokes(await A.store.load(PAGE), [s1], 2)));
  await A.timers.runAll();
  const [own] = remote.filesOf(PAGE, 'dev-a');
  assert.deepEqual(liveIds(deserializePage(own.content, PAGE)), [s0.id, s1.id].sort(), 's0 not overwritten on Drive');
  assert.deepEqual(liveIds(A.remoteUpdates.at(-1).doc), [s0.id, s1.id].sort(), 'and shown again');
});

test('unreadable stored page: refresh shows what Drive has', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const remote = createRemote();
  const s = stroke();
  remote.put({ page: PAGE, dev: 'dev-b', content: addStrokes(emptyPage(PAGE), [s], 1) });
  const kv = brokenPageKV();
  const A = makeDevice(remote, 'a', { kv });
  await A.store.load(PAGE);
  const merged = await A.store.refresh(PAGE);
  assert.deepEqual(liveIds(merged), [s.id]);
  assert.notEqual(A.store.getStatus(), 'error');
  assert.equal(kv.state.sets, 0);
});

// ---------------------------------------------------------------- automatic retry

test('a failed upload arms ONE retry timer (15 s, doubling to 5 min) that flushes by itself; success resets it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  A.drive.state.offline = true;
  await draw(A, PAGE, stroke());
  await A.timers.runAll(); // debounced upload fails → retry armed
  assert.equal(A.store.getStatus(), 'offline');
  assert.deepEqual(A.timers.delays(), [15000]);
  await A.timers.runAll(); // retry flush fails again → backoff doubles
  assert.deepEqual(A.timers.delays(), [30000]);
  for (let i = 0; i < 6; i++) await A.timers.runAll();
  assert.deepEqual(A.timers.delays(), [300000], 'capped at 5 min');

  A.drive.state.offline = false;
  await A.timers.runAll(); // the retry uploads without any save / flush from the app
  assert.equal(A.store.getStatus(), 'synced');
  assert.equal(A.timers.size, 0, 'nothing left to retry');
  assert.equal(remote.filesOf(PAGE).length, 1);

  // The backoff starts again at 15 s after a success.
  A.drive.state.offline = true;
  await draw(A, PAGE, stroke());
  await A.timers.runAll();
  assert.deepEqual(A.timers.delays(), [15000]);

  // Auth failures never retry by themselves; setDrive(null) cancels the retry.
  await A.store.setDrive(null);
  assert.equal(A.timers.size, 0);
});

test('flush() stopped early (offline) keeps the debounce timers of the pages it did not reach', async () => {
  const remote = createRemote();
  const A = makeDevice(remote, 'a');
  await draw(A, PAGE, stroke());
  await draw(A, PAGE2, stroke());
  assert.equal(A.timers.size, 2);
  A.drive.state.offline = true;
  assert.equal(await A.store.flush(), false);
  // PAGE's timer was taken by the attempt; PAGE2's debounce timer is still there (plus the retry timer).
  assert.deepEqual(A.timers.delays().sort((a, b) => a - b), [1500, 15000]);
  A.drive.state.offline = false;
  await A.timers.runAll();
  assert.equal(A.store.getStatus(), 'synced');
  assert.equal(remote.filesOf(PAGE).length, 1);
  assert.equal(remote.filesOf(PAGE2).length, 1);
});
