// Ink storage: local-first (KV / IndexedDB) with Google Drive appDataFolder sync.
//
// Design (docs/SPEC.md §4 D):
// - One Drive file PER PAGE PER DEVICE: 'ink-<pageId>--<deviceId>.json',
//   appProperties { page, dev, schema: '1' }. A device writes ONLY its own file, whose content is its
//   full merged PageDoc; readers merge every device's file (union strokes − union tombstones), so there
//   are no cross-device lost updates even though Drive v3 has no If-Match.
// - KV keys: 'page:<pageId>' → PageDoc, 'dirty' → pageIds not yet uploaded,
//   'own:<pageId>' → own Drive fileId, 'seen:<pageId>' → { fileId: md5Checksum } already merged.
// - Within this tab the in-memory cache is the authority: save() merges into it synchronously (when the
//   page was loaded), so a remote merge can never hide a stroke that was just drawn.
// - 'page:<id>' is only ever written by read-merge-write (kv.update: one IndexedDB transaction), never by a
//   blind set: another tab / window of the app on this device (same IndexedDB, same deviceId) may have
//   stored strokes this tab's cache lacks. They are kept, folded into the cache (onRemoteUpdate), and
//   included in the next upload; before every upload the stored doc is merged in again.
// - The 'dirty' list is changed per page by atomic updates (no whole-list snapshots that could drop another
//   tab's marks), and save() issues the dirty mark BEFORE the page write: same-store readwrite transactions
//   commit in order, so a crash in between leaves at worst a harmless extra upload, never unsent strokes
//   without a mark.
// - A page whose stored doc cannot be read ('unreadable') is never overwritten: its changes stay in memory
//   (dirty pages are never evicted) and are uploaded after merging the own Drive file (the 'seen' shortcut
//   is ignored, since local knowledge is incomplete); the stored doc is merged in once it can be read.
// - Network work (refresh / upload) is serialized per page. Errors never lose local data:
//   AuthRequiredError → 'pending' (retried after the next setDrive()), network (status 0) → 'offline'
//   (retried on the next save()/flush()), 403 storageQuotaExceeded → 'error' with a message,
//   anything else → 'error' (page stays dirty, retried on the next save()/flush()).
//   After an 'offline' / 'error' failure with unsent pages, one retry timer runs flush() by itself
//   (15 s, doubling up to 5 min; the backoff resets after any successful round trip).
//
// Errors are recognised structurally (err.name / err.status / err.reason) so this module does not
// depend on js/google/http.js.

import { deserializePage, emptyPage, mergePages, sameContent, serializePage } from '../ink/model.js';

/** @typedef {import('../ink/model.js').PageDoc} PageDoc */
/** @typedef {'local'|'synced'|'pending'|'syncing'|'error'|'offline'} SyncStatus */

const DIRTY_KEY = 'dirty';
const pageKey = (pageId) => `page:${pageId}`;
const ownKey = (pageId) => `own:${pageId}`;
const seenKey = (pageId) => `seen:${pageId}`;

const DEFAULT_DEBOUNCE_MS = 1500;
const RETRY_MIN_MS = 15 * 1000;     // first automatic retry after a failed upload / pull
const RETRY_MAX_MS = 5 * 60 * 1000; // backoff cap
const CACHE_LIMIT = 48; // clean pages kept in memory; dirty / busy pages are never evicted
const SCHEMA = '1';

const MESSAGES = {
  auth: 'Google への再接続が必要です。手書きはこの端末に保存されています',
  offline: 'オフラインです。手書きはこの端末に保存され、接続が戻ると同期されます',
  quota: 'Google ドライブの保存容量が不足しているため、手書きを同期できません',
  error: '手書きの同期に失敗しました。この端末には保存されています（あとで再試行します）',
};

const DRIVE_METHODS = ['listPageFiles', 'getMeta', 'download', 'generateId', 'create', 'update', 'remove'];

const noop = () => {};

function warn(message, detail) {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    if (detail === undefined) console.warn(`[ink-store] ${message}`);
    else console.warn(`[ink-store] ${message}`, detail);
  }
}

/** Log-safe summary of an error (no request headers / tokens). */
function describeError(err) {
  if (!err || typeof err !== 'object') return String(err);
  const parts = [err.name || 'Error'];
  if (err.status !== undefined) parts.push(`status=${err.status}`);
  if (err.reason) parts.push(`reason=${err.reason}`);
  if (err.message) parts.push(err.message);
  return parts.join(' ');
}

/** 'auth' | 'offline' | 'quota' | 'error' */
function classifyError(err) {
  if (!err || typeof err !== 'object') return 'error';
  if (err.name === 'AuthRequiredError' || err.constructor?.name === 'AuthRequiredError' || err.status === 401) {
    return 'auth';
  }
  if (err.status === 0) return 'offline';
  // A raw fetch failure that was not wrapped into ApiError(status 0).
  if (err.name === 'TypeError' && /fetch|network|load failed/i.test(String(err.message || ''))) return 'offline';
  if (err.status === 403 && err.reason === 'storageQuotaExceeded') return 'quota';
  return 'error';
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPageId = (v) => typeof v === 'string' && v.length > 0;

function assertPageId(pageId) {
  if (!isPageId(pageId)) throw new TypeError('ink-store: pageId must be a non-empty string');
}

function isDriveApi(d) {
  return isRecord(d) && DRIVE_METHODS.every((m) => typeof d[m] === 'function');
}

function isEmptyDoc(doc) {
  return Object.keys(doc.strokes).length === 0 && Object.keys(doc.deleted).length === 0;
}

/** mergePages, with the page id forced (mergePages picks the smaller id on a mismatch). */
function mergeFor(pageId, a, b) {
  const merged = mergePages(a, b);
  return merged.pageId === pageId ? merged : { ...merged, pageId };
}

/** Untrusted content (remote file text, odd local values) → valid PageDoc. Never throws. */
function parseDoc(content, pageId) {
  try {
    if (typeof content === 'string' || isRecord(content)) return deserializePage(content, pageId);
  } catch {
    /* fall through */
  }
  return emptyPage(pageId);
}

/** A value read from 'page:<id>'. Our own writes are trusted; anything else is re-validated. */
function normalizeLocal(raw, pageId) {
  if (raw === undefined || raw === null) return emptyPage(pageId);
  if (isRecord(raw) && raw.v === 1 && isRecord(raw.strokes) && isRecord(raw.deleted)) {
    return raw.pageId === pageId ? raw : { ...raw, pageId };
  }
  return parseDoc(raw, pageId);
}

/** A doc handed to save(): must look like a PageDoc; missing parts are tolerated. */
function coerceSaveDoc(doc, pageId) {
  if (!isRecord(doc) || !isRecord(doc.strokes)) {
    throw new TypeError('ink-store: save() needs a PageDoc ({ strokes, deleted, ... })');
  }
  if (doc.v === 1 && isRecord(doc.deleted) && doc.pageId === pageId) return doc;
  return {
    v: 1,
    pageId,
    strokes: doc.strokes,
    deleted: isRecord(doc.deleted) ? doc.deleted : {},
    updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0,
  };
}

/** Content fingerprint of a Drive file: md5Checksum (fallbacks: version, modifiedTime). */
function fingerprint(meta) {
  if (!isRecord(meta)) return null;
  if (typeof meta.md5Checksum === 'string' && meta.md5Checksum) return meta.md5Checksum;
  if (meta.version !== undefined && meta.version !== null && meta.version !== '') return `v:${meta.version}`;
  if (typeof meta.modifiedTime === 'string' && meta.modifiedTime) return `t:${meta.modifiedTime}`;
  return null;
}

function sameSeen(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Valid file metas only, unique by id. */
function normalizeFiles(list) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const f of list) {
    if (isRecord(f) && typeof f.id === 'string' && f.id && !byId.has(f.id)) byId.set(f.id, f);
  }
  return [...byId.values()];
}

/** Deterministic survivor order: oldest createdTime first (unknown = newest), then smallest id. */
function byAge(a, b) {
  const ta = Date.parse(a.createdTime);
  const tb = Date.parse(b.createdTime);
  const ka = Number.isFinite(ta) ? ta : Infinity;
  const kb = Number.isFinite(tb) ? tb : Infinity;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @param {object} opts
 * @param {{ get: Function, set: Function, del: Function, keys?: Function }} opts.kv
 * @param {object|null} [opts.drive]  js/google/drive.js API, or null (local only)
 * @param {string} opts.deviceId      stable per installation
 * @param {(pageId: string, doc: PageDoc) => void} [opts.onRemoteUpdate]
 *        the stored doc gained content the app has not seen (remote merge) → re-render with `doc`
 * @param {(status: SyncStatus, detail: { message: string|null, dirtyCount: number, lastSyncAt: number|null }) => void} [opts.onStatus]
 * @param {number} [opts.debounceMs=1500]
 * @param {() => number} [opts.now=Date.now]
 * @param {Function} [opts.setTimer=setTimeout]
 * @param {Function} [opts.clearTimer=clearTimeout]
 */
export function createInkStore({
  kv,
  drive = null,
  deviceId,
  onRemoteUpdate,
  onStatus,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function' || typeof kv.del !== 'function') {
    throw new TypeError('createInkStore: kv { get, set, del } is required');
  }
  if (!isPageId(deviceId)) throw new TypeError('createInkStore: deviceId must be a non-empty string');
  if (drive !== null && drive !== undefined && !isDriveApi(drive)) {
    throw new TypeError(`createInkStore: drive must provide ${DRIVE_METHODS.join(', ')}`);
  }
  const delay = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : DEFAULT_DEBOUNCE_MS;
  const clock = typeof now === 'function' ? now : Date.now;

  let currentDrive = drive || null;
  const cache = new Map(); // pageId → PageDoc (latest local content, LRU order)
  const warming = new Map(); // pageId → pending kv read
  const busy = new Map(); // pageId → running operations (pinned in the cache)
  const dirty = new Set(); // pageIds with local content not yet in our own Drive file
  const timers = new Map(); // pageId → debounced upload timer
  const queues = new Map(); // pageId → tail of the per-page network queue
  const createIds = new Map(); // pageId → pre-generated Drive id, reused when a create is retried
  const trustedOwn = new Set(); // pages whose own Drive file is known to match 'seen' (this session)
  const needsDedupe = new Set(); // pages where Drive holds several files of this device
  const unreadable = new Set(); // pages whose stored 'page:<id>' could not be read (last attempt failed)
  let inflight = 0; // uploads in progress
  let failure = null; // { kind, message } of the last failed network operation
  let authBlocked = false; // auth failed: no automatic uploads until setDrive() / an explicit flush()
  let lastSyncAt = null;
  let lastEmitted = null;
  let retryTimer = null; // single automatic flush() after an 'offline' / 'error' failure
  let retryDelay = RETRY_MIN_MS;

  // ------------------------------------------------------------------ status

  function computeStatus() {
    if (!currentDrive) return 'local';
    if (inflight > 0) return 'syncing';
    if (failure) {
      if (failure.kind === 'auth') return 'pending';
      if (failure.kind === 'offline') return 'offline';
      return 'error';
    }
    return dirty.size > 0 ? 'pending' : 'synced';
  }

  function statusDetail() {
    const status = computeStatus();
    const message = failure && status !== 'local' && status !== 'syncing' ? failure.message : null;
    return { status, message, dirtyCount: dirty.size, lastSyncAt };
  }

  function emitStatus() {
    const { status, ...detail } = statusDetail();
    const key = `${status}|${detail.message ?? ''}`;
    if (key === lastEmitted) return;
    lastEmitted = key;
    if (typeof onStatus !== 'function') return;
    try {
      onStatus(status, detail);
    } catch (err) {
      warn('onStatus callback failed', err);
    }
  }

  function recordFailure(err) {
    const kind = classifyError(err);
    if (kind === 'auth') authBlocked = true;
    failure = { kind, message: MESSAGES[kind] };
    if (kind === 'error' || kind === 'quota') warn('sync failed', describeError(err));
    if (kind === 'offline' || kind === 'error') armRetry();
    emitStatus();
  }

  /** A network round trip worked: forget connectivity / auth problems (upload success clears all). */
  function recordSuccess({ upload }) {
    authBlocked = false;
    if (failure && (upload || failure.kind === 'offline' || failure.kind === 'auth')) failure = null;
    lastSyncAt = clock();
    retryDelay = RETRY_MIN_MS;
  }

  /**
   * Arms the single retry timer (no-op when one is armed, nothing is unsent or there is no drive). Nothing
   * else would retry an upload that failed while the app stays open and no new ink is written.
   */
  function armRetry() {
    if (retryTimer !== null || !currentDrive || dirty.size === 0) return;
    const wait = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    let handle = null;
    handle = setTimer(() => {
      if (retryTimer === handle) retryTimer = null;
      if (!currentDrive || authBlocked || dirty.size === 0) return;
      flush().catch((err) => warn('retry failed', describeError(err)));
    }, wait);
    retryTimer = handle;
  }

  function cancelRetry() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  // ------------------------------------------------------------------ dirty set

  const ready = (async () => {
    try {
      const list = await kv.get(DIRTY_KEY);
      if (Array.isArray(list)) for (const id of list) if (isPageId(id)) dirty.add(id);
    } catch (err) {
      warn('could not read the list of unsent pages', err);
    }
    emitStatus();
    if (currentDrive) for (const id of dirty) scheduleUpload(id); // leftovers from a previous session
  })();

  /** Adds / removes ONE page in the stored list (atomic, so other tabs' marks are never dropped). */
  function persistDirty(pageId, add) {
    return kvUpdate(DIRTY_KEY, (list) => {
      const set = new Set(Array.isArray(list) ? list.filter(isPageId) : []);
      if (add ? set.has(pageId) : !set.has(pageId)) return undefined; // already right: no write
      if (add) set.add(pageId);
      else set.delete(pageId);
      return [...set];
    }).catch((err) => warn('could not persist the list of unsent pages', err));
  }

  /** `durable`: write the mark even if this tab already has it (another tab may have cleared it). */
  function markDirty(pageId, durable = false) {
    const added = !dirty.has(pageId);
    if (added) dirty.add(pageId);
    if (added || durable) persistDirty(pageId, true);
    emitStatus();
  }

  function markClean(pageId) {
    if (dirty.delete(pageId)) persistDirty(pageId, false);
    if (dirty.size === 0) cancelRetry();
    emitStatus();
  }

  /** kv.update, or get + set for a KV without it (not atomic, but never writes after a failed read). */
  function kvUpdate(key, fn) {
    if (typeof kv.update === 'function') return kv.update(key, fn);
    return Promise.resolve()
      .then(() => kv.get(key))
      .then(async (current) => {
        const next = fn(current);
        if (next === undefined) return current;
        await kv.set(key, next);
        return next;
      });
  }

  // ------------------------------------------------------------------ local cache

  function cachePut(pageId, doc) {
    cache.delete(pageId);
    cache.set(pageId, doc);
    if (cache.size <= CACHE_LIMIT) return;
    for (const id of cache.keys()) {
      if (cache.size <= CACHE_LIMIT) break;
      if (id !== pageId && !dirty.has(id) && !busy.has(id)) cache.delete(id);
    }
  }

  /** Loads 'page:<id>' into the cache (once; concurrent callers share the read). Rejects on kv errors. */
  function warm(pageId) {
    if (cache.has(pageId)) return Promise.resolve(cache.get(pageId));
    let pending = warming.get(pageId);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => kv.get(pageKey(pageId)))
        .then((raw) => {
          // Another operation may have filled the cache meanwhile; that value is at least as new.
          if (!cache.has(pageId)) cachePut(pageId, normalizeLocal(raw, pageId));
          return cache.get(pageId);
        });
      warming.set(pageId, pending);
      const cleanup = () => {
        if (warming.get(pageId) === pending) warming.delete(pageId);
      };
      pending.then(cleanup, cleanup);
    }
    return pending;
  }

  /** Runs fn with the page pinned in the cache (not evicted while in use). */
  async function withPage(pageId, fn) {
    busy.set(pageId, (busy.get(pageId) || 0) + 1);
    try {
      return await fn();
    } finally {
      const n = busy.get(pageId) - 1;
      if (n > 0) busy.set(pageId, n);
      else busy.delete(pageId);
    }
  }

  /** Merges `incoming` into the cached doc SYNCHRONOUSLY (no I/O). The page must be cached and pinned. */
  function mergeLocal(pageId, incoming) {
    const before = cache.get(pageId);
    const merged = mergeFor(pageId, before, incoming);
    const changed = !sameContent(before, merged);
    if (changed) cachePut(pageId, merged);
    return { before, after: changed ? merged : before, changed };
  }

  /**
   * Persists the cached doc by read-merge-write of 'page:<id>' (one transaction): what another tab stored
   * is kept, and folded into the cache (onRemoteUpdate). A failed read writes nothing. Rejects on failure.
   */
  function writeLocal(pageId) {
    const doc = cache.get(pageId);
    return kvUpdate(pageKey(pageId), (raw) => (
      raw === undefined || raw === null ? doc : mergeFor(pageId, normalizeLocal(raw, pageId), doc)
    )).then((stored) => {
      unreadable.delete(pageId);
      foldStored(pageId, stored);
    });
  }

  /** Merges a stored doc into the cache; true (and onRemoteUpdate) when the cache gained content. */
  function foldStored(pageId, raw) {
    const cur = cache.get(pageId);
    if (!cur || raw === undefined || raw === null) return false;
    const merged = mergeFor(pageId, cur, normalizeLocal(raw, pageId));
    if (sameContent(cur, merged)) return false;
    cachePut(pageId, merged);
    notifyRemote(pageId, merged);
    return true;
  }

  /**
   * Brings the cache up to date with 'page:<id>' (another tab may have stored more): reads it when the page
   * is cold, else merges it in (onRemoteUpdate on new content). Never throws: an unreadable page is marked
   * and, when not cached, seeded with an empty doc (all later writes are read-merge-writes, so the stored
   * doc can never be overwritten from it). Resolves to true when the stored doc was read.
   */
  async function syncFromStore(pageId) {
    try {
      if (!cache.has(pageId)) {
        await warm(pageId);
      } else {
        foldStored(pageId, await kv.get(pageKey(pageId)));
      }
      unreadable.delete(pageId);
      return true;
    } catch (err) {
      warn('could not read local ink', describeError(err));
      unreadable.add(pageId);
      if (!cache.has(pageId)) cachePut(pageId, emptyPage(pageId));
      return false;
    }
  }

  function notifyRemote(pageId, doc) {
    if (typeof onRemoteUpdate !== 'function') return;
    try {
      onRemoteUpdate(pageId, doc);
    } catch (err) {
      warn('onRemoteUpdate callback failed', err);
    }
  }

  async function readOwnId(pageId) {
    const id = await kv.get(ownKey(pageId));
    return typeof id === 'string' && id ? id : null;
  }

  async function readSeen(pageId) {
    const raw = await kv.get(seenKey(pageId));
    const seen = {};
    if (isRecord(raw)) {
      for (const [id, fp] of Object.entries(raw)) if (typeof fp === 'string') seen[id] = fp;
    }
    return seen;
  }

  // ------------------------------------------------------------------ Drive helpers

  function fileName(pageId) {
    return `ink-${pageId}--${deviceId}.json`;
  }

  const isMine = (meta) => isRecord(meta.appProperties) && meta.appProperties.dev === deviceId;

  async function downloadOrNull(d, fileId) {
    try {
      return await d.download(fileId);
    } catch (err) {
      if (err && err.status === 404) return null; // deleted between list and download
      throw err;
    }
  }

  /** Downloads a file unless its fingerprint is already in `seen`; records the fingerprint in `nextSeen`. */
  async function fetchIfChanged(d, meta, seen, nextSeen, pageId) {
    const fp = fingerprint(meta);
    if (fp !== null && seen[meta.id] === fp) {
      nextSeen[meta.id] = fp;
      return null;
    }
    const content = await downloadOrNull(d, meta.id);
    if (content === null || content === undefined) return null;
    if (fp !== null) nextSeen[meta.id] = fp;
    return parseDoc(content, pageId);
  }

  async function getMetaOrNull(d, fileId) {
    try {
      const meta = await d.getMeta(fileId);
      return isRecord(meta) ? meta : null;
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  }

  async function forgetOwn(pageId, fileId, seen) {
    delete seen[fileId];
    trustedOwn.delete(pageId);
    await kv.del(ownKey(pageId));
  }

  /** Creates our file with a pre-generated id; the id is kept for retries so a retry yields 409, not a duplicate. */
  async function createOwn(d, pageId, text) {
    let id = createIds.get(pageId);
    if (!id) {
      id = await d.generateId();
      if (typeof id !== 'string' || !id) throw new Error('Drive generateId returned no id');
      createIds.set(pageId, id);
    }
    try {
      const meta = await d.create(
        { id, name: fileName(pageId), appProperties: { page: pageId, dev: deviceId, schema: SCHEMA } },
        text,
      );
      createIds.delete(pageId);
      return isRecord(meta) ? { ...meta, id: meta.id || id } : { id };
    } catch (err) {
      // A definite client error means the id may be unusable; anything else may have created the file.
      const s = err && err.status;
      if (Number.isInteger(s) && s >= 400 && s < 500 && s !== 401 && s !== 408 && s !== 429) createIds.delete(pageId);
      throw err;
    }
  }

  // ------------------------------------------------------------------ per-page network queue

  function enqueue(pageId, task) {
    const prev = queues.get(pageId) || Promise.resolve();
    const run = prev.then(() => task());
    const tail = run.then(noop, noop);
    queues.set(pageId, tail);
    tail.then(() => {
      if (queues.get(pageId) === tail) queues.delete(pageId);
    });
    return run;
  }

  // ------------------------------------------------------------------ refresh (pull)

  async function pullPage(pageId) {
    const d = currentDrive;
    if (!d || authBlocked) return null;
    try {
      const loaded = cache.get(pageId); // what the app was given (null: not loaded here yet)
      await syncFromStore(pageId);
      const blind = unreadable.has(pageId); // local doc unknown → do not trust 'seen' for our own file
      const files = normalizeFiles(await d.listPageFiles(pageId));
      let ownId = await readOwnId(pageId);
      const seen = await readSeen(pageId);
      const ownSeen = blind ? {} : seen;
      const nextSeen = {}; // pruned to the files that still exist
      const mine = files.filter(isMine).sort(byAge);
      const others = files.filter((f) => !isMine(f));

      let incoming = null;
      const absorb = (doc) => {
        incoming = incoming ? mergeFor(pageId, incoming, doc) : doc;
      };
      for (const f of others) {
        const doc = await fetchIfChanged(d, f, seen, nextSeen, pageId);
        if (doc) absorb(doc);
      }

      // Our own file(s): normally skipped (we wrote them). Downloaded only when unknown locally
      // (reinstall with the same deviceId, a lost KV, another tab) — never overwrite what we don't have.
      const adopt = !ownId && mine.length === 1;
      if (adopt) ownId = mine[0].id;
      let ownDoc = null;
      for (const f of mine) {
        const doc = await fetchIfChanged(d, f, ownSeen, nextSeen, pageId);
        if (!doc) continue;
        absorb(doc);
        if (f.id === ownId) ownDoc = doc;
      }
      const ownListed = ownId !== null && mine.some((f) => f.id === ownId);
      if (mine.some((f) => f.id !== ownId)) needsDedupe.add(pageId);

      const wasDirty = dirty.has(pageId);
      const { before, after, changed } = incoming
        ? mergeLocal(pageId, incoming)
        : { before: cache.get(pageId), after: cache.get(pageId), changed: false };
      if (changed) {
        try {
          await writeLocal(pageId);
        } catch (err) {
          if (!blind) throw err;
          // Unreadable local doc: show what Drive has anyway (kept in memory; Drive still holds it).
          warn('could not store remote ink locally', describeError(err));
        }
      }
      if (!sameSeen(seen, nextSeen)) await kv.set(seenKey(pageId), nextSeen);
      if (adopt) await kv.set(ownKey(pageId), ownId);
      if (ownListed) trustedOwn.add(pageId);

      // Does our own file now lack local content? (Invariant: a clean page's own file == local doc.)
      if (!wasDirty && !dirty.has(pageId) && !isEmptyDoc(after)) {
        let ownContent = null; // null = we have no file for this page
        if (ownListed) ownContent = ownDoc || before;
        if (!ownContent || !sameContent(after, ownContent) || needsDedupe.has(pageId)) {
          markDirty(pageId);
          scheduleUpload(pageId);
        }
      }

      recordSuccess({ upload: false });
      emitStatus();
      const latest = cache.get(pageId);
      if (loaded && sameContent(loaded, latest)) return null;
      if (!loaded && !changed) return null;
      notifyRemote(pageId, latest);
      return latest;
    } catch (err) {
      recordFailure(err);
      return null;
    }
  }

  // ------------------------------------------------------------------ upload (push)

  /** Uploads one dirty page (read-merge-write). Never throws; true = nothing left to do for it. */
  async function pushPage(pageId, explicit) {
    const d = currentDrive;
    if (!d || !dirty.has(pageId)) return true;
    if (authBlocked && !explicit) return false;
    inflight++;
    emitStatus();
    try {
      await syncFromStore(pageId); // another tab's strokes stored here go into this upload too
      const blind = unreadable.has(pageId);
      const seen = await readSeen(pageId);
      const ownSeen = blind ? {} : seen; // local doc unknown → always merge our own file before overwriting it
      let ownId = await readOwnId(pageId);
      let dupes = [];
      let incoming = null;
      const absorb = (doc) => {
        incoming = incoming ? mergeFor(pageId, incoming, doc) : doc;
      };

      if (!ownId || needsDedupe.has(pageId)) {
        // Find our file(s). Several → oldest survives; the others are merged into it, then removed.
        const mine = normalizeFiles(await d.listPageFiles(pageId)).filter(isMine).sort(byAge);
        if (mine.length > 0) {
          ownId = mine[0].id;
          dupes = mine.slice(1);
          for (const f of mine) {
            const doc = await fetchIfChanged(d, f, ownSeen, seen, pageId);
            if (doc) absorb(doc);
          }
        }
      } else if (blind || !trustedOwn.has(pageId)) {
        // First write this session: make sure the file still holds only what we know.
        const meta = await getMetaOrNull(d, ownId);
        if (!meta) {
          await forgetOwn(pageId, ownId, seen);
          ownId = null;
        } else {
          const doc = await fetchIfChanged(d, meta, ownSeen, seen, pageId);
          if (doc) absorb(doc);
        }
      }

      if (incoming) {
        const { changed } = mergeLocal(pageId, incoming);
        if (changed) {
          // A failing local write must not stop the upload: Drive then holds the merged doc.
          await writeLocal(pageId).catch((err) => warn('could not store merged ink locally', describeError(err)));
          notifyRemote(pageId, cache.get(pageId));
        }
      }

      const doc = cache.get(pageId);
      const text = serializePage(doc);
      let meta = null;
      if (ownId) {
        try {
          meta = await d.update(ownId, text);
        } catch (err) {
          if (!err || err.status !== 404) throw err;
          await forgetOwn(pageId, ownId, seen); // our file was deleted → create a new one
          ownId = null;
        }
      }
      if (!ownId) meta = await createOwn(d, pageId, text);

      const fileId = isRecord(meta) && typeof meta.id === 'string' && meta.id ? meta.id : ownId;
      await kv.set(ownKey(pageId), fileId);
      const fp = fingerprint(meta);
      if (fp !== null) seen[fileId] = fp;
      else delete seen[fileId];
      trustedOwn.add(pageId);

      // Survivor written first; only now delete the duplicates (DELETE is permanent in appDataFolder).
      let removedAll = true;
      for (const dup of dupes) {
        if (dup.id === fileId) continue;
        try {
          await d.remove(dup.id);
          delete seen[dup.id];
        } catch (err) {
          removedAll = false;
          warn('could not remove a duplicate ink file', describeError(err));
          break;
        }
      }
      if (removedAll) needsDedupe.delete(pageId);
      await kv.set(seenKey(pageId), seen);

      recordSuccess({ upload: true });
      // Stored by another tab during the upload → not clean yet. Still unreadable → the stored doc may hold
      // strokes this upload lacks: keep the page dirty (uploaded again once it can be read).
      const readable = await syncFromStore(pageId);
      if (readable && sameContent(cache.get(pageId), doc)) {
        markClean(pageId);
      } else if (!timers.has(pageId)) {
        scheduleUpload(pageId); // changed while uploading (e.g. merged content) → go again
      }
      return true;
    } catch (err) {
      recordFailure(err);
      return false;
    } finally {
      inflight--;
      emitStatus();
    }
  }

  function runUpload(pageId, explicit) {
    return enqueue(pageId, () => withPage(pageId, () => pushPage(pageId, explicit)));
  }

  function scheduleUpload(pageId) {
    if (!currentDrive) return;
    const prev = timers.get(pageId);
    if (prev !== undefined) clearTimer(prev);
    let handle;
    handle = setTimer(() => {
      if (timers.get(pageId) === handle) timers.delete(pageId);
      runUpload(pageId, false).catch((err) => warn('upload failed', describeError(err)));
    }, delay);
    timers.set(pageId, handle);
  }

  function cancelTimer(pageId) {
    const handle = timers.get(pageId);
    if (handle === undefined) return;
    clearTimer(handle);
    timers.delete(pageId);
  }

  function cancelTimers() {
    for (const handle of timers.values()) clearTimer(handle);
    timers.clear();
  }

  // ------------------------------------------------------------------ public API

  /**
   * Local doc for a page (emptyPage if none). Never touches the network. If the stored doc cannot be read,
   * resolves to what this tab holds in memory (or emptyPage) and isUnreadable(pageId) becomes true.
   */
  async function load(pageId) {
    assertPageId(pageId);
    if (unreadable.has(pageId) && cache.has(pageId)) {
      // Retry the read; whatever is stored gets merged in.
      return withPage(pageId, async () => {
        await syncFromStore(pageId);
        return cache.get(pageId);
      });
    }
    try {
      const doc = await warm(pageId);
      unreadable.delete(pageId);
      return doc;
    } catch (err) {
      warn('could not read local ink', describeError(err));
      unreadable.add(pageId);
      return emptyPage(pageId); // not cached: later writes are read-merge-writes and never overwrite unseen data
    }
  }

  /**
   * Merges `doc` into the stored page, persists it (awaited), marks it dirty and schedules a debounced
   * upload. If the store already had content `doc` lacks (e.g. a remote merge, another tab), onRemoteUpdate
   * fires with the merged doc. Resolves to the stored (merged) doc. Rejects only on invalid input or a
   * failed local read/write — the change is still kept in memory, marked dirty and uploaded.
   */
  async function save(pageId, doc) {
    assertPageId(pageId);
    const incoming = coerceSaveDoc(doc, pageId);
    return withPage(pageId, async () => {
      if (!cache.has(pageId)) {
        try {
          await warm(pageId);
          unreadable.delete(pageId);
        } catch (err) {
          // Keep the change anyway; the stored doc is merged in (never overwritten) once it can be read.
          warn('could not read local ink before saving', describeError(err));
          unreadable.add(pageId);
          if (!cache.has(pageId)) cachePut(pageId, emptyPage(pageId));
        }
      }
      const { after, changed } = mergeLocal(pageId, incoming);
      let persisted = Promise.resolve();
      if (changed) {
        markDirty(pageId, true); // issued BEFORE the page write: it commits first
        persisted = writeLocal(pageId);
        scheduleUpload(pageId);
      }
      if (!sameContent(after, incoming)) notifyRemote(pageId, after);
      await persisted;
      return cache.get(pageId);
    });
  }

  /**
   * Pulls remote changes for a page and merges them locally. Resolves to the merged doc when the
   * local content changed (onRemoteUpdate is called too), else null (also: an error — see getStatus()).
   * Without a drive it only picks up what another tab of the app stored for a page loaded here.
   */
  async function refresh(pageId) {
    assertPageId(pageId);
    if (!currentDrive) {
      if (!cache.has(pageId)) return null; // not loaded here: load() reads the stored doc fresh
      return enqueue(pageId, () => withPage(pageId, async () => {
        const before = cache.get(pageId);
        await syncFromStore(pageId); // onRemoteUpdate on new content
        const after = cache.get(pageId);
        return before && after && !sameContent(before, after) ? after : null;
      }));
    }
    return enqueue(pageId, () => withPage(pageId, () => pullPage(pageId)));
  }

  /** Adds pages that another tab marked unsent (the stored list) to this tab's set. Never throws. */
  async function adoptStoredDirty() {
    try {
      const list = await kv.get(DIRTY_KEY);
      let added = false;
      if (Array.isArray(list)) {
        for (const id of list) {
          if (isPageId(id) && !dirty.has(id)) {
            dirty.add(id);
            added = true;
          }
        }
      }
      if (added) emitStatus();
    } catch (err) {
      warn('could not read the list of unsent pages', err);
    }
  }

  /**
   * Uploads every dirty page now — including pages another tab of the app marked unsent. Resolves (never
   * rejects) to true when nothing is left unsent.
   */
  async function flush() {
    await ready;
    if (!currentDrive) return dirty.size === 0;
    await adoptStoredDirty();
    if (!currentDrive) return false;
    let ok = true;
    for (const pageId of [...dirty]) {
      if (!currentDrive) return false;
      // Only the page about to be uploaded loses its debounce timer: pages left behind when the loop
      // stops early (offline / auth) keep theirs.
      cancelTimer(pageId);
      const done = await runUpload(pageId, true).catch(() => false);
      if (!done) {
        ok = false;
        const kind = failure && failure.kind;
        if (kind === 'offline' || kind === 'auth') break; // the rest would fail the same way
      }
    }
    return ok && dirty.size === 0;
  }

  /** Sign-in state changed. Non-null → retry everything that is unsent. Resolves like flush(). */
  function setDrive(next) {
    const d = next || null;
    if (d !== null && !isDriveApi(d)) {
      throw new TypeError(`ink-store: drive must provide ${DRIVE_METHODS.join(', ')}`);
    }
    if (d !== currentDrive) trustedOwn.clear(); // possibly another account: re-verify own files
    currentDrive = d;
    authBlocked = false;
    failure = null;
    cancelRetry();
    retryDelay = RETRY_MIN_MS;
    if (!d) {
      cancelTimers();
      emitStatus();
      return ready.then(() => dirty.size === 0);
    }
    emitStatus();
    return flush();
  }

  function getStatus() {
    return computeStatus();
  }

  /** Extra: status plus a Japanese message (errors), unsent page count and last successful sync time. */
  function getStatusDetail() {
    return statusDetail();
  }

  /**
   * Extra: true when the last attempt to read this page's stored ink failed (the page may look emptier than
   * it is; nothing stored is overwritten, and the read is retried on the next load / save / refresh).
   */
  function isUnreadable(pageId) {
    return unreadable.has(pageId);
  }

  lastEmitted = `${computeStatus()}|`;

  return { load, refresh, save, flush, setDrive, getStatus, getStatusDetail, isUnreadable };
}
