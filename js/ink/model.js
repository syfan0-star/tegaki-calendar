/**
 * Ink document model (module B): a small state-based CRDT for one handwriting page.
 *
 * - Strokes are immutable and identified by a random id.
 * - Deleting a stroke records a tombstone (id → deletion time in ms). A tombstoned id can never come
 *   back, which is why undoing a deletion re-adds *clones with new ids* (see invertOp).
 * - mergePages(a, b) = (strokes(a) ∪ strokes(b)) − (tombstones(a) ∪ tombstones(b)).
 *   It is commutative, associative and idempotent, so devices converge whatever the sync order.
 *
 * Docs are immutable values: every function returns a new doc and never mutates its arguments.
 * Pure module: importable in Node (no DOM access).
 *
 * @typedef {{ id: string, tool: 'pen'|'highlighter', color: string, size: number, pts: number[], t: number }} Stroke
 * @typedef {{ v: 1, pageId: string, strokes: Object<string, Stroke>, deleted: Object<string, number>, updatedAt: number }} PageDoc
 * @typedef {{ type: 'add', strokes: Stroke[] } | { type: 'remove', strokes: Stroke[] } | { type: 'batch', ops: Op[] }} Op
 */

const TOOLS = ['pen', 'highlighter'];
const DEFAULT_COLORS = { pen: '#1f2937', highlighter: '#fde047' };
const DEFAULT_SIZES = { pen: 3.5, highlighter: 18 };

// Sanity limits applied to everything that enters a doc (local or remote).
const MIN_SIZE = 0.1;
const MAX_SIZE = 200;
const MAX_COORD = 100000; // lu; pages are ≤ 2400 lu, anything beyond this is garbage
const MAX_POINTS = 20000; // per stroke
const MAX_STROKES = 20000; // per page
const MAX_TOMBSTONES = 200000; // per page
const MAX_ID_LENGTH = 128;
const MAX_PAGE_ID_LENGTH = 256;
const MAX_JSON_LENGTH = 64 * 1024 * 1024; // characters
const MAX_OP_DEPTH = 64; // nested batches

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

let idCounter = 0;

// ---------------------------------------------------------------------------------------------
// Small validation / normalisation helpers
// ---------------------------------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Ids become object keys, so reject '__proto__' (assignment would change the prototype). */
function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH && id !== '__proto__';
}

/** Deterministic number for comparisons (non-finite → 0). */
const num = (v) => (Number.isFinite(v) ? v : 0);

/** Rounds to 0.1 and turns -0 into 0 (so JSON and deep equality stay stable). */
const round1 = (v) => Math.round(v * 10) / 10 + 0;
const round2 = (v) => Math.round(v * 100) / 100 + 0;

function normalizeColor(color) {
  if (typeof color !== 'string' || !COLOR_RE.test(color)) return null;
  const c = color.toLowerCase();
  if (c.length === 4) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  return c;
}

function normalizeSize(size, tool) {
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_SIZES[tool];
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, round2(size)));
}

function normalizeTime(t) {
  return Number.isFinite(t) && t > 0 ? Math.round(t) : 0;
}

/** Tombstone time: any garbage value still counts as a deletion (time 0). */
const tombTime = normalizeTime;

/**
 * Rounds a flat [x,y,p,...] array: x,y to 0.1 lu, p clamped to 0..1 and rounded to 0.01
 * (non-numeric pressure → 0.5). Drops non-finite or absurd coordinates and consecutive duplicates,
 * caps the point count. Optional (dx, dy) translation is applied before rounding.
 * @returns {number[]}
 */
function normalizePts(raw, dx = 0, dy = 0) {
  if (!raw || typeof raw !== 'object' || typeof raw.length !== 'number') return [];
  const len = raw.length - (raw.length % 3);
  const scanLimit = Math.min(len, MAX_POINTS * 3 * 4); // bounded work even for absurd input
  const maxOut = MAX_POINTS * 3;
  const out = [];
  let lx = NaN;
  let ly = NaN;
  for (let i = 0; i < scanLimit && out.length < maxOut; i += 3) {
    const rx = raw[i];
    const ry = raw[i + 1];
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) continue;
    const x = round1(rx + dx);
    const y = round1(ry + dy);
    if (!(Math.abs(x) <= MAX_COORD && Math.abs(y) <= MAX_COORD)) continue;
    if (x === lx && y === ly) continue;
    const rp = raw[i + 2];
    const p = Number.isFinite(rp) ? round2(rp < 0 ? 0 : rp > 1 ? 1 : rp) : 0.5;
    out.push(x, y, p);
    lx = x;
    ly = y;
  }
  return out;
}

/** Cheap structural check used on hot paths (strokes from makeStroke/deserialize always pass). */
function isValidStroke(s) {
  return (
    s !== null &&
    typeof s === 'object' &&
    isValidId(s.id) &&
    (s.tool === 'pen' || s.tool === 'highlighter') &&
    Array.isArray(s.pts) &&
    s.pts.length >= 3
  );
}

/** Full validation + normalisation of untrusted stroke data. Returns null if unusable. */
function normalizeStroke(raw, fallbackId) {
  if (!isPlainObject(raw)) return null;
  const id = isValidId(raw.id) ? raw.id : isValidId(fallbackId) ? fallbackId : null;
  if (!id) return null;
  if (!TOOLS.includes(raw.tool)) return null;
  const tool = raw.tool;
  const pts = normalizePts(raw.pts);
  if (pts.length < 3) return null;
  return {
    id,
    tool,
    color: normalizeColor(raw.color) ?? DEFAULT_COLORS[tool],
    size: normalizeSize(raw.size, tool),
    pts,
    t: normalizeTime(raw.t),
  };
}

/** Shallow view of any input as a PageDoc (never throws; does not copy the maps). */
function asDoc(doc) {
  if (!isPlainObject(doc)) return emptyPage('');
  return {
    v: 1,
    pageId: typeof doc.pageId === 'string' ? doc.pageId : '',
    strokes: isPlainObject(doc.strokes) ? doc.strokes : {},
    deleted: isPlainObject(doc.deleted) ? doc.deleted : {},
    updatedAt: normalizeTime(doc.updatedAt),
  };
}

function validNow(now) {
  return Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
}

/** Accepts an array, any iterable or a single stroke; returns a plain array. */
function toList(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    if (typeof v[Symbol.iterator] === 'function') return Array.from(v);
    return [v];
  }
  return [];
}

/**
 * Total order on stroke contents. Two different objects with the same id should be identical
 * (strokes are immutable), but if they ever differ every replica must still pick the same one,
 * otherwise merge would not be commutative.
 */
function compareStrokes(a, b) {
  if (a === b) return 0;
  const at = num(a.t);
  const bt = num(b.t);
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.tool !== b.tool) return String(a.tool) < String(b.tool) ? -1 : 1;
  if (a.color !== b.color) return String(a.color) < String(b.color) ? -1 : 1;
  const as = num(a.size);
  const bs = num(b.size);
  if (as !== bs) return as < bs ? -1 : 1;
  const ap = a.pts;
  const bp = b.pts;
  if (ap.length !== bp.length) return ap.length < bp.length ? -1 : 1;
  for (let i = 0; i < ap.length; i++) {
    const x = num(ap[i]);
    const y = num(bp[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const pickStroke = (a, b) => (compareStrokes(a, b) >= 0 ? a : b);

/** Deterministic page id choice for merge: '' is neutral, otherwise the smaller string wins. */
function pickPageId(a, b) {
  if (a === b || !b) return a;
  if (!a) return b;
  return a < b ? a : b;
}

/** Copies the valid tombstones of a map. */
function copyTombstones(src) {
  const out = {};
  for (const id of Object.keys(src)) {
    if (isValidId(id)) out[id] = tombTime(src[id]);
  }
  return out;
}

/** Copies the valid, non-tombstoned strokes of a map. */
function copyLiveStrokes(src, deleted) {
  const out = {};
  for (const id of Object.keys(src)) {
    const s = src[id];
    if (isValidStroke(s) && s.id === id && !Object.hasOwn(deleted, id)) out[id] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** @returns {PageDoc} */
export function emptyPage(pageId) {
  return { v: 1, pageId: typeof pageId === 'string' ? pageId : '', strokes: {}, deleted: {}, updatedAt: 0 };
}

/** crypto.randomUUID() when available (secure contexts), else time + random base36. */
export function newStrokeId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // fall through (e.g. insecure context implementations that throw)
    }
  }
  let rand = '';
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(3);
    c.getRandomValues(buf);
    for (const v of buf) rand += v.toString(36).padStart(7, '0');
  } else {
    for (let i = 0; i < 3; i++) rand += Math.floor(Math.random() * 0x100000000).toString(36).padStart(7, '0');
  }
  idCounter = (idCounter + 1) % 1679616; // 36^4
  return `${Date.now().toString(36)}-${idCounter.toString(36).padStart(4, '0')}-${rand}`;
}

/**
 * Creates a stroke with a fresh id and normalised data (pts rounded, duplicates removed).
 * Never throws; with no usable points the stroke has `pts: []` and is ignored by addStrokes.
 * @returns {Stroke}
 */
export function makeStroke(input) {
  const { tool, color, size, pts, t } = isPlainObject(input) ? input : {};
  const tl = TOOLS.includes(tool) ? tool : 'pen';
  return {
    id: newStrokeId(),
    tool: tl,
    color: normalizeColor(color) ?? DEFAULT_COLORS[tl],
    size: normalizeSize(size, tl),
    pts: normalizePts(pts),
    t: Number.isFinite(t) && t > 0 ? Math.round(t) : Date.now(),
  };
}

/**
 * Returns a new doc with `strokes` added. Strokes whose id is tombstoned and malformed strokes are
 * ignored. `now` (extra optional parameter) sets updatedAt when something was added.
 * @returns {PageDoc}
 */
export function addStrokes(doc, strokes, now = Date.now()) {
  const d = asDoc(doc);
  const deleted = copyTombstones(d.deleted);
  const out = copyLiveStrokes(d.strokes, deleted);
  let changed = false;
  for (const s of toList(strokes)) {
    if (!isValidStroke(s) || Object.hasOwn(deleted, s.id)) continue;
    const prev = Object.hasOwn(out, s.id) ? out[s.id] : null;
    const chosen = prev ? pickStroke(prev, s) : s;
    if (chosen !== prev) {
      out[s.id] = chosen;
      changed = true;
    }
  }
  return {
    v: 1,
    pageId: d.pageId,
    strokes: out,
    deleted,
    updatedAt: changed ? Math.max(d.updatedAt, validNow(now)) : d.updatedAt,
  };
}

/**
 * Returns a new doc where `ids` are tombstoned at time `now` (kept at the max time if already
 * tombstoned). Ids that are not (yet) present are tombstoned too: the stroke may exist on another
 * device. Accepts ids or stroke objects.
 * @returns {PageDoc}
 */
export function removeStrokes(doc, ids, now = Date.now()) {
  const d = asDoc(doc);
  const time = validNow(now);
  const deleted = copyTombstones(d.deleted);
  let changed = false;
  for (const item of toList(ids)) {
    const id = item !== null && typeof item === 'object' ? item.id : item;
    if (!isValidId(id)) continue;
    const prev = Object.hasOwn(deleted, id) ? deleted[id] : -1;
    if (time > prev) deleted[id] = time;
    changed = true;
  }
  return {
    v: 1,
    pageId: d.pageId,
    strokes: copyLiveStrokes(d.strokes, deleted),
    deleted,
    updatedAt: changed ? Math.max(d.updatedAt, time) : d.updatedAt,
  };
}

/**
 * CRDT merge: union of strokes, union of tombstones (max time), tombstoned strokes dropped,
 * updatedAt = max. Commutative, associative and idempotent.
 * @returns {PageDoc}
 */
export function mergePages(a, b) {
  const A = asDoc(a);
  const B = asDoc(b);
  const deleted = copyTombstones(A.deleted);
  for (const id of Object.keys(B.deleted)) {
    if (!isValidId(id)) continue;
    const t = tombTime(B.deleted[id]);
    if (!Object.hasOwn(deleted, id) || t > deleted[id]) deleted[id] = t;
  }
  const strokes = copyLiveStrokes(A.strokes, deleted);
  for (const id of Object.keys(B.strokes)) {
    const s = B.strokes[id];
    if (!isValidStroke(s) || s.id !== id || Object.hasOwn(deleted, id)) continue;
    strokes[id] = Object.hasOwn(strokes, id) ? pickStroke(strokes[id], s) : s;
  }
  return {
    v: 1,
    pageId: pickPageId(A.pageId, B.pageId),
    strokes,
    deleted,
    updatedAt: Math.max(A.updatedAt, B.updatedAt),
  };
}

/** Draw order: highlighters first (under the pen), then pens; each by creation time, then id. */
function drawOrder(a, b) {
  const ka = a.tool === 'highlighter' ? 0 : 1;
  const kb = b.tool === 'highlighter' ? 0 : 1;
  if (ka !== kb) return ka - kb;
  const ta = num(a.t);
  const tb = num(b.t);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** @returns {Stroke[]} the visible strokes in draw order. */
export function liveStrokes(doc) {
  const d = asDoc(doc);
  const out = [];
  for (const id of Object.keys(d.strokes)) {
    const s = d.strokes[id];
    if (isValidStroke(s) && s.id === id && !Object.hasOwn(d.deleted, id)) out.push(s);
  }
  return out.sort(drawOrder);
}

/**
 * Copies strokes with new ids, translated by (dx, dy) and optionally recoloured. `t` is kept so
 * the copies keep the originals' draw order. Malformed strokes are skipped.
 * @returns {Stroke[]}
 */
export function cloneStrokes(strokes, { dx = 0, dy = 0, color } = {}) {
  const ox = Number.isFinite(dx) ? round1(dx) : 0;
  const oy = Number.isFinite(dy) ? round1(dy) : 0;
  const recolor = color === undefined ? null : normalizeColor(color);
  const out = [];
  for (const s of toList(strokes)) {
    if (!isValidStroke(s)) continue;
    const pts = ox === 0 && oy === 0 ? s.pts.slice() : normalizePts(s.pts, ox, oy);
    if (pts.length < 3) continue;
    out.push({
      id: newStrokeId(),
      tool: s.tool,
      color: recolor ?? s.color,
      size: s.size,
      pts,
      t: s.t,
    });
  }
  return out;
}

/**
 * Applies an undo/redo unit. add → addStrokes; remove → removeStrokes(ids); batch → sequential.
 * Unknown ops leave the doc unchanged.
 *
 * Stale references in 'remove': undoing an erase re-adds *clones* (new ids, identical content), so
 * older ops in an undo stack may still name the dead originals (draw X, erase X, undo, undo → the
 * last undo is "remove X" while X' is what is visible). When a stroke named by a remove op is no
 * longer live, the live stroke with identical content (tool, colour, size, t, pts) is removed
 * instead. Plain undo/redo stacks (undo: apply invertOp(op); redo: apply invertOp(thatInverse))
 * therefore work without remapping ids.
 * @returns {PageDoc}
 */
export function applyOp(doc, op, now = Date.now()) {
  return applyOpAt(isPlainObject(doc) ? doc : emptyPage(''), op, validNow(now), 0);
}

/** Ids to tombstone for a remove op, following stale references to identical live clones. */
function resolveRemovals(doc, items) {
  const d = asDoc(doc);
  const ids = [];
  const taken = new Set();
  let candidates = null;
  for (const item of items) {
    const id = item !== null && typeof item === 'object' ? item.id : item;
    const live = isValidId(id) && Object.hasOwn(d.strokes, id) && !Object.hasOwn(d.deleted, id);
    if (live && !taken.has(id)) {
      ids.push(id);
      taken.add(id);
      continue;
    }
    if (!live && isValidStroke(item)) {
      candidates ??= liveStrokes(d);
      const twin = candidates.find((s) => !taken.has(s.id) && compareStrokes(s, item) === 0);
      if (twin) {
        ids.push(twin.id);
        taken.add(twin.id);
        continue;
      }
    }
    if (isValidId(id)) ids.push(id); // keep the tombstone: the stroke may still exist elsewhere
  }
  return ids;
}

function applyOpAt(doc, op, now, depth) {
  if (!isPlainObject(op) || depth > MAX_OP_DEPTH) return doc;
  switch (op.type) {
    case 'add':
      return addStrokes(doc, op.strokes, now);
    case 'remove':
      return removeStrokes(doc, resolveRemovals(doc, toList(op.strokes)), now);
    case 'batch': {
      let d = doc;
      for (const sub of toList(op.ops)) d = applyOpAt(d, sub, now, depth + 1);
      return d;
    }
    default:
      return doc;
  }
}

/**
 * Inverse op for undo/redo: add S → remove S; remove S → add clones of S with NEW ids
 * (tombstoned ids can never come back); batch → reversed batch of inverses.
 * Call it once per undo/redo step and keep the result: inverting a remove creates new ids each time.
 * @returns {Op}
 */
export function invertOp(op) {
  return invertAt(op, 0);
}

function invertAt(op, depth) {
  if (!isPlainObject(op) || depth > MAX_OP_DEPTH) return { type: 'batch', ops: [] };
  switch (op.type) {
    case 'add':
      return { type: 'remove', strokes: toList(op.strokes).filter(isValidStroke) };
    case 'remove':
      return { type: 'add', strokes: cloneStrokes(op.strokes) };
    case 'batch':
      return {
        type: 'batch',
        ops: toList(op.ops)
          .slice()
          .reverse()
          .map((sub) => invertAt(sub, depth + 1)),
      };
    default:
      return { type: 'batch', ops: [] };
  }
}

function liveIdSet(d) {
  const set = new Set();
  for (const id of Object.keys(d.strokes)) {
    const s = d.strokes[id];
    if (isValidStroke(s) && s.id === id && !Object.hasOwn(d.deleted, id)) set.add(id);
  }
  return set;
}

function tombIdSet(d) {
  const set = new Set();
  for (const id of Object.keys(d.deleted)) if (isValidId(id)) set.add(id);
  return set;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** True when both docs have the same live stroke ids and the same tombstone ids. */
export function sameContent(a, b) {
  const A = asDoc(a);
  const B = asDoc(b);
  return sameSet(liveIdSet(A), liveIdSet(B)) && sameSet(tombIdSet(A), tombIdSet(B));
}

/**
 * Compact, deterministic JSON (keys sorted; strokes are written as stored — makeStroke,
 * cloneStrokes and deserializePage already round them).
 * @returns {string}
 */
export function serializePage(doc) {
  const d = asDoc(doc);
  const deleted = {};
  for (const id of Object.keys(d.deleted).sort()) {
    if (isValidId(id)) deleted[id] = tombTime(d.deleted[id]);
  }
  const strokes = {};
  for (const id of Object.keys(d.strokes).sort()) {
    const s = d.strokes[id];
    if (!isValidStroke(s) || s.id !== id || Object.hasOwn(deleted, id)) continue;
    strokes[id] = { id: s.id, tool: s.tool, color: s.color, size: s.size, pts: s.pts, t: s.t };
  }
  return JSON.stringify({ v: 1, pageId: d.pageId, strokes, deleted, updatedAt: d.updatedAt });
}

/**
 * Tolerant parse: accepts a JSON string (or an already parsed object), validates every field,
 * drops malformed strokes, caps absurd sizes and never throws. Garbage → emptyPage(pageId).
 * The `pageId` argument wins over the one stored in the data when given.
 * @returns {PageDoc}
 */
export function deserializePage(json, pageId) {
  const wanted = typeof pageId === 'string' ? pageId : '';
  try {
    let data = json;
    if (typeof json === 'string') {
      if (json.length === 0 || json.length > MAX_JSON_LENGTH) return emptyPage(wanted);
      data = JSON.parse(json);
    }
    if (!isPlainObject(data)) return emptyPage(wanted);

    const storedId =
      typeof data.pageId === 'string' && data.pageId.length <= MAX_PAGE_ID_LENGTH ? data.pageId : '';

    const deleted = {};
    if (isPlainObject(data.deleted)) {
      let count = 0;
      for (const id of Object.keys(data.deleted)) {
        if (count >= MAX_TOMBSTONES) break;
        if (!isValidId(id)) continue;
        deleted[id] = tombTime(data.deleted[id]);
        count++;
      }
    }

    const strokes = {};
    let count = 0;
    const add = (raw, key) => {
      const s = normalizeStroke(raw, key);
      if (!s || Object.hasOwn(deleted, s.id)) return;
      if (Object.hasOwn(strokes, s.id)) {
        strokes[s.id] = pickStroke(strokes[s.id], s);
        return;
      }
      strokes[s.id] = s;
      count++;
    };
    if (Array.isArray(data.strokes)) {
      for (let i = 0; i < data.strokes.length && count < MAX_STROKES; i++) add(data.strokes[i], undefined);
    } else if (isPlainObject(data.strokes)) {
      for (const key of Object.keys(data.strokes)) {
        if (count >= MAX_STROKES) break;
        add(data.strokes[key], key);
      }
    }

    return { v: 1, pageId: wanted || storedId, strokes, deleted, updatedAt: normalizeTime(data.updatedAt) };
  } catch {
    return emptyPage(wanted);
  }
}
