// Tiny promise-based key-value store over IndexedDB (one object store, out-of-line string keys),
// with an in-memory fallback.
//
// KV API (all methods async, values are structured-cloned):
//   get(key) → value | undefined
//   set(key, value)            resolves only after the write transaction has completed
//   update(key, fn)            read-modify-write in ONE readwrite transaction: fn(current) (synchronous, may be
//                              called again on a retry) returns the new value, or undefined to leave it as is;
//                              resolves to the value stored afterwards. Two tabs updating the same key can
//                              therefore never overwrite each other's change. If the read fails, nothing is
//                              written. Readwrite transactions on the store commit in the order they were
//                              started, so an update() issued before another one also lands first.
//   del(key)
//   keys(prefix = '') → string[] sorted (IndexedDB key order)
//   kind                       'indexeddb' | 'memory' (read-only; flips to 'memory' after a fallback)
//
// Safari / WebKit quirks handled:
//   - indexedDB missing, or open() throwing / erroring (e.g. some private modes)  → memory + console.warn
//   - open() 'blocked', or never answering (old WebKit hang)                       → memory + console.warn
//   - 'versionchange' from another tab (upgrade / delete): close and continue in memory (+ warn), so this
//     stale tab never writes into a database with a newer schema
//   - connection silently closed by WebKit ("Connection to Indexed Database server lost"): reopen once
//     on the next operation and retry it; if reopening fails → memory + console.warn
//   Falling back to memory in the MIDDLE of a session (reopen failed / versionchange) also calls the
//   `onDegraded(reason)` option: from then on nothing written survives a reload, and the app must say so.
//
// No top-level access to browser globals (importable in Node for tests).

const DEFAULT_DB_NAME = 'tegaki-calendar';
const DEFAULT_STORE_NAME = 'kv';
const DEFAULT_OPEN_TIMEOUT_MS = 5000;

function warn(message, detail) {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    if (detail === undefined) console.warn(`[idb] ${message}`);
    else console.warn(`[idb] ${message}`, detail);
  }
}

function assertKey(key) {
  if (typeof key !== 'string') throw new TypeError(`KV key must be a string (got ${typeof key})`);
}

function normalizePrefix(prefix) {
  if (prefix === undefined || prefix === null) return '';
  if (typeof prefix !== 'string') throw new TypeError(`KV prefix must be a string (got ${typeof prefix})`);
  return prefix;
}

/** Deep copy with structured-clone semantics (JSON round-trip as a last resort). */
function cloneValue(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** In-memory KV with the same contract as the IndexedDB one (data is lost on reload). */
export function createMemoryKV() {
  const map = new Map();
  return {
    kind: 'memory',
    async get(key) {
      assertKey(key);
      return map.has(key) ? cloneValue(map.get(key)) : undefined;
    },
    async set(key, value) {
      assertKey(key);
      map.set(key, cloneValue(value)); // throws (→ rejects) for uncloneable values, like IndexedDB
    },
    async update(key, fn) {
      assertKey(key);
      assertUpdater(fn);
      const current = map.has(key) ? cloneValue(map.get(key)) : undefined;
      const next = fn(current);
      if (next === undefined) return current;
      map.set(key, cloneValue(next));
      return next;
    },
    async del(key) {
      assertKey(key);
      map.delete(key);
    },
    async keys(prefix = '') {
      const p = normalizePrefix(prefix);
      return [...map.keys()].filter((k) => k.startsWith(p)).sort();
    },
  };
}

function assertUpdater(fn) {
  if (typeof fn !== 'function') throw new TypeError('KV update needs a function');
}

function safeGlobal(name) {
  try {
    return globalThis[name];
  } catch {
    return undefined; // some sandboxed contexts throw SecurityError on access
  }
}

/**
 * Opens (or creates) the database and resolves to a KV. Never rejects: any failure falls back to
 * createMemoryKV() with a console.warn.
 * @param {object} [options]
 * @param {string} [options.dbName='tegaki-calendar']
 * @param {string} [options.storeName='kv']
 * @param {IDBFactory|null} [options.indexedDB=globalThis.indexedDB]
 * @param {typeof IDBKeyRange|null} [options.IDBKeyRange=globalThis.IDBKeyRange]  for keys(prefix) ranges
 * @param {number} [options.openTimeoutMs=5000]  give up on an open() that never answers (0 = wait forever)
 * @param {(reason: string) => void} [options.onDegraded]  IndexedDB became unusable mid-session and the KV now
 *        continues in memory ('versionchange' | 'reopen failed'): show a persistent warning. (A memory KV from
 *        the start is visible through kv.kind instead.)
 */
export async function openKV(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const dbName = typeof opts.dbName === 'string' && opts.dbName ? opts.dbName : DEFAULT_DB_NAME;
  const storeName = typeof opts.storeName === 'string' && opts.storeName ? opts.storeName : DEFAULT_STORE_NAME;
  const openTimeoutMs = Number.isFinite(opts.openTimeoutMs) && opts.openTimeoutMs >= 0
    ? opts.openTimeoutMs
    : DEFAULT_OPEN_TIMEOUT_MS;
  const factory = opts.indexedDB !== undefined ? opts.indexedDB : safeGlobal('indexedDB');
  const keyRange = opts.IDBKeyRange !== undefined ? opts.IDBKeyRange : safeGlobal('IDBKeyRange');
  const onDegraded = typeof opts.onDegraded === 'function' ? opts.onDegraded : null;

  if (!factory || typeof factory.open !== 'function') {
    warn('IndexedDB is not available; using in-memory storage (data will not survive a reload)');
    return createMemoryKV();
  }
  try {
    const db = await openDatabase(factory, dbName, storeName, openTimeoutMs);
    return createIdbKV({ db, factory, dbName, storeName, openTimeoutMs, keyRange, onDegraded });
  } catch (err) {
    warn('could not open IndexedDB; using in-memory storage', err);
    return createMemoryKV();
  }
}

function safeClose(db) {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

/**
 * indexedDB.open() as a promise. Without `version` it opens the current version (creating v1 if new),
 * so another tab having upgraded the database never causes a VersionError here.
 */
function openDatabase(factory, dbName, storeName, timeoutMs, version) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return false;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      fn(value);
      return true;
    };

    let req;
    try {
      req = version === undefined ? factory.open(dbName) : factory.open(dbName, version);
    } catch (err) {
      settle(reject, err);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        safeClose(db); // late success after a timeout / blocked fallback: don't leak the connection
        return;
      }
      if (!db.objectStoreNames.contains(storeName)) {
        // The database exists without our store (another storeName was used before): add it via a version bump.
        const next = db.version + 1;
        safeClose(db);
        if (version !== undefined) {
          settle(reject, new Error(`object store "${storeName}" is missing after upgrade`));
          return;
        }
        openDatabase(factory, dbName, storeName, timeoutMs, next).then(
          (upgraded) => {
            if (!settle(resolve, upgraded)) safeClose(upgraded);
          },
          (err) => settle(reject, err),
        );
        return;
      }
      settle(resolve, db);
    };
    req.onerror = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      settle(reject, req.error || new Error('IndexedDB open failed'));
    };
    req.onblocked = () => settle(reject, new Error('IndexedDB open was blocked by another connection'));
    if (timeoutMs > 0) {
      timer = setTimeout(() => settle(reject, new Error('IndexedDB open timed out')), timeoutMs);
    }
  });
}

/**
 * Runs one request in its own transaction. Resolves with the request's result only when the
 * transaction has COMPLETED (so a resolved write is durable as far as IndexedDB promises).
 */
function runTransaction(db, storeName, mode, op) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let result;
    let req;
    try {
      req = op(tx.objectStore(storeName));
    } catch (err) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      reject(err);
      return;
    }
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || (req && req.error) || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || (req && req.error) || new Error('IndexedDB transaction aborted'));
  });
}

/**
 * update(): get, fn, put inside ONE readwrite transaction (so no other tab can write in between). Resolves
 * with the stored value once the transaction has completed; a failing read, fn or put aborts it (nothing
 * written) and rejects.
 */
function runUpdate(db, storeName, key, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    let result;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      reject(err);
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
    };
    let req;
    try {
      const store = tx.objectStore(storeName);
      req = store.get(key);
      req.onsuccess = () => {
        if (failed) return;
        try {
          const current = req.result;
          const next = fn(current);
          if (next === undefined) {
            result = current;
            return;
          }
          store.put(next, key); // DataCloneError is thrown synchronously
          result = next;
        } catch (err) {
          fail(err);
        }
      };
    } catch (err) {
      fail(err);
      return;
    }
    tx.oncomplete = () => {
      if (!failed) resolve(result);
    };
    tx.onerror = () => fail(tx.error || (req && req.error) || new Error('IndexedDB transaction failed'));
    tx.onabort = () => fail(tx.error || (req && req.error) || new Error('IndexedDB transaction aborted'));
  });
}

/** Errors meaning "this connection is dead", worth one reopen + retry. */
function isConnectionLost(err) {
  if (!err) return false;
  if (err.name === 'InvalidStateError' || err.name === 'UnknownError') return true;
  return /connection.*(lost|clos)/i.test(String(err.message || ''));
}

function createIdbKV({ db, factory, dbName, storeName, openTimeoutMs, keyRange, onDegraded = null }) {
  let current = db; // live IDBDatabase, or null when it must be reopened
  let memory = null; // memory KV once IndexedDB became unusable for this session
  let reopening = null;

  function switchToMemory(reason, err) {
    if (memory) return;
    memory = createMemoryKV();
    current = null;
    warn(`IndexedDB unavailable (${reason}); continuing with in-memory storage until reload`, err);
    if (onDegraded) {
      try {
        onDegraded(reason);
      } catch (e) {
        warn('onDegraded handler failed', e);
      }
    }
  }

  function attach(conn) {
    conn.onversionchange = () => {
      // Another tab upgrades or deletes the database. Release it at once (otherwise we block that tab)
      // and stop using it: this tab's code may not understand the new schema.
      safeClose(conn);
      switchToMemory('versionchange');
    };
    conn.onclose = () => {
      // Abnormal close by the browser (WebKit "server lost"): reopen lazily on the next operation.
      if (current === conn) current = null;
    };
  }
  attach(db);

  function connection() {
    if (memory) return Promise.resolve(null);
    if (current) return Promise.resolve(current);
    if (!reopening) {
      reopening = openDatabase(factory, dbName, storeName, openTimeoutMs)
        .then(
          (conn) => {
            if (memory) {
              safeClose(conn);
              return null;
            }
            attach(conn);
            current = conn;
            return conn;
          },
          (err) => {
            switchToMemory('reopen failed', err);
            return null;
          },
        )
        .finally(() => {
          reopening = null;
        });
    }
    return reopening;
  }

  /** Runs `execute(conn)` against IndexedDB (one reopen+retry on a dead connection) or the memory fallback. */
  async function run(execute, memoryOp) {
    for (let attempt = 0; ; attempt++) {
      const conn = await connection();
      if (!conn) return memoryOp(memory);
      try {
        return await execute(conn);
      } catch (err) {
        if (attempt > 0 || !isConnectionLost(err)) throw err;
        if (current === conn) {
          safeClose(conn);
          current = null;
        }
      }
    }
  }

  return {
    get kind() {
      return memory ? 'memory' : 'indexeddb';
    },
    async get(key) {
      assertKey(key);
      return run((conn) => runTransaction(conn, storeName, 'readonly', (store) => store.get(key)), (m) => m.get(key));
    },
    async set(key, value) {
      assertKey(key);
      await run((conn) => runTransaction(conn, storeName, 'readwrite', (store) => store.put(value, key)), (m) => m.set(key, value));
    },
    async update(key, fn) {
      assertKey(key);
      assertUpdater(fn);
      return run((conn) => runUpdate(conn, storeName, key, fn), (m) => m.update(key, fn));
    },
    async del(key) {
      assertKey(key);
      await run((conn) => runTransaction(conn, storeName, 'readwrite', (store) => store.delete(key)), (m) => m.del(key));
    },
    async keys(prefix = '') {
      const p = normalizePrefix(prefix);
      const range = p && keyRange && typeof keyRange.bound === 'function'
        ? keyRange.bound(p, `${p}￿`)
        : undefined;
      const list = await run(
        (conn) => runTransaction(conn, storeName, 'readonly',
          (store) => (range === undefined ? store.getAllKeys() : store.getAllKeys(range))),
        (m) => m.keys(p),
      );
      // Filter again: covers the no-IDBKeyRange path and keeps the result to string keys only.
      return (Array.isArray(list) ? list : []).filter((k) => typeof k === 'string' && k.startsWith(p));
    },
  };
}
