// App state (module F2a): persisted settings + a tiny observable store.
//
// Settings live in localStorage under 'tegaki.settings.v1' (SPEC §2). Everything read from storage is
// untrusted: bad JSON → defaults, unknown keys dropped, every value type-checked (invalid → default).
// Storage is injected (getItem/setItem/removeItem) so this module runs in Node tests; every access is
// guarded because Safari private mode / disabled storage can throw.
//
// Also holds the small, pure decisions main.js makes, so they can be unit-tested: route / calendar
// bookkeeping (resolveInitialRoute, reconcileCalendarVisibility), which local database ink goes to and
// whose account it belongs to, whether a silent OAuth redirect may start, event drafts and the
// persisted events cache.

import { parseYMD, startOfDay, toYMD, formatTimeJa } from './util/date.js';

export const SETTINGS_KEY = 'tegaki.settings.v1';
/** ms epoch of the last time the user looked at the stored route (see resolveInitialRoute). */
export const ROUTE_AT_KEY = 'tegaki.route.at';
/** Calendar ids already seen once (so Google's 'selected' flag is applied only to new calendars). */
export const SEEN_CALENDARS_KEY = 'tegaki.calendars.seen.v1';

/** A stored date is restored only if the user looked at it this recently (else: today). */
export const ROUTE_RESTORE_MS = 6 * 60 * 60 * 1000;

export const VIEW_NAMES = Object.freeze(['day', 'week', 'month']);
export const TOOL_NAMES = Object.freeze(['pen', 'highlighter', 'eraser', 'lasso', 'event']);
export const PEN_SIZE_NAMES = Object.freeze(['thin', 'medium', 'thick']);

const MAX_CALENDAR_IDS = 500;
const MAX_ID_LENGTH = 1024;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Defaults (SPEC §2). `date` is filled with today's date by defaultSettings(). */
export const DEFAULT_SETTINGS = Object.freeze({
  weekStart: 0,
  allowFinger: false,
  eraseInkAfterConvert: true,
  hiddenCalendarIds: Object.freeze([]),
  defaultCalendarId: null,
  demo: false,
  tool: 'pen',
  penColor: '#1f2937',
  penSize: 'medium',
  hlColor: '#fde047',
  view: 'week',
  date: '',
});

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function toDate(now) {
  let v = now;
  try {
    if (typeof v === 'function') v = v();
  } catch {
    v = undefined;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime());
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v);
  return new Date();
}

function isValidId(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID_LENGTH;
}

/** Valid 'YYYY-MM-DD' that names a real calendar day. */
export function isValidYMD(v) {
  return typeof v === 'string' && YMD.test(v) && parseYMD(v) !== null;
}

function cleanIdList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  const seen = new Set();
  for (const id of v) {
    if (!isValidId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_CALENDAR_IDS) break;
  }
  return out;
}

/**
 * Per-key validators: value → cleaned value, or undefined when invalid.
 * Strings that only differ in case are normalized (colors lowercase).
 */
const VALIDATORS = {
  weekStart: (v) => (v === 0 || v === 1 ? v : undefined),
  allowFinger: (v) => (typeof v === 'boolean' ? v : undefined),
  eraseInkAfterConvert: (v) => (typeof v === 'boolean' ? v : undefined),
  hiddenCalendarIds: (v) => cleanIdList(v) ?? undefined,
  defaultCalendarId: (v) => (v === null ? null : isValidId(v) ? v : undefined),
  demo: (v) => (typeof v === 'boolean' ? v : undefined),
  tool: (v) => (TOOL_NAMES.includes(v) ? v : undefined),
  penColor: (v) => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : undefined),
  penSize: (v) => (PEN_SIZE_NAMES.includes(v) ? v : undefined),
  hlColor: (v) => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : undefined),
  view: (v) => (VIEW_NAMES.includes(v) ? v : undefined),
  date: (v) => (isValidYMD(v) ? v : undefined),
};

const SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

/** Deep-ish freeze for settings (the only nested value is the id array). */
function freezeSettings(s) {
  return Object.freeze({ ...s, hiddenCalendarIds: Object.freeze([...s.hiddenCalendarIds]) });
}

/**
 * Fresh default settings (date = today).
 * @param {{ now?: (() => number) | Date | number }} [opts]
 */
export function defaultSettings({ now } = {}) {
  return freezeSettings({ ...DEFAULT_SETTINGS, date: toYMD(startOfDay(toDate(now))) });
}

/**
 * Validates `raw` key by key. Invalid or missing values fall back to `fallback` (itself assumed valid;
 * defaults when omitted). Unknown keys are dropped. Never throws.
 * @param {unknown} raw
 * @param {object} [fallback]
 * @returns {Readonly<object>} frozen settings
 */
export function sanitizeSettings(raw, fallback) {
  const base = isPlainObject(fallback) ? fallback : defaultSettings();
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const key of SETTING_KEYS) {
    let value;
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      try {
        value = VALIDATORS[key](src[key]);
      } catch {
        value = undefined;
      }
    }
    if (value === undefined) {
      const fb = VALIDATORS[key](base[key]);
      value = fb === undefined ? DEFAULT_SETTINGS[key] : fb;
    }
    out[key] = value;
  }
  if (!isValidYMD(out.date)) out.date = toYMD(startOfDay(new Date()));
  return freezeSettings(out);
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

function storageGet(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const v = storage.getItem(key);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function storageSet(storage, key, value) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[state] could not write', key, err && err.message);
    return false;
  }
}

/**
 * Reads settings from storage. Missing / bad JSON / non-object → defaults; bad values → defaults.
 * @param {Storage|null} storage
 * @param {{ now?: (() => number) | Date | number }} [opts]
 */
export function loadSettings(storage, { now } = {}) {
  const defaults = defaultSettings({ now });
  const raw = storageGet(storage, SETTINGS_KEY);
  if (!raw) return defaults;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  return isPlainObject(parsed) ? sanitizeSettings(parsed, defaults) : defaults;
}

/**
 * Writes settings (validated first). Returns false when storage is unavailable or full.
 * @param {Storage|null} storage
 * @param {object} settings
 */
export function saveSettings(storage, settings) {
  const clean = sanitizeSettings(settings);
  return storageSet(storage, SETTINGS_KEY, JSON.stringify(clean));
}

/** Last time the stored route was in use (ms), or null. */
export function loadRouteAt(storage) {
  const n = Number(storageGet(storage, ROUTE_AT_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function saveRouteAt(storage, t = Date.now()) {
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? storageSet(storage, ROUTE_AT_KEY, String(Math.round(n))) : false;
}

export function loadSeenCalendarIds(storage) {
  const raw = storageGet(storage, SEEN_CALENDARS_KEY);
  if (!raw) return [];
  try {
    return cleanIdList(JSON.parse(raw)) || [];
  } catch {
    return [];
  }
}

export function saveSeenCalendarIds(storage, ids) {
  return storageSet(storage, SEEN_CALENDARS_KEY, JSON.stringify(cleanIdList(ids) || []));
}

// ---------------------------------------------------------------------------------------------
// Observable store
// ---------------------------------------------------------------------------------------------

function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  }
  return false;
}

/**
 * Tiny observable store over a plain object.
 *   get()               current (frozen) state
 *   set(partial)        shallow-merges; notifies subscribers only if some value changed; returns the state
 *   subscribe(fn)       fn(state, prev, changedKeys) after every change → returns unsubscribe()
 * A throwing subscriber is logged and never breaks the others.
 * @param {object} initial
 * @param {{ normalize?: (next: object, prev: object) => object }} [opts]
 *        normalize: validates/derives the merged state (e.g. sanitizeSettings)
 */
export function createStore(initial = {}, { normalize } = {}) {
  const norm = typeof normalize === 'function' ? normalize : (next) => Object.freeze({ ...next });
  let state = norm(isPlainObject(initial) ? { ...initial } : {}, {});
  const subscribers = new Set();

  function get() {
    return state;
  }

  function set(partial) {
    if (!isPlainObject(partial)) return state;
    const prev = state;
    let next;
    try {
      next = norm({ ...prev, ...partial }, prev);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[state] rejected update', err);
      return state;
    }
    const changed = Object.keys(next).filter((k) => !sameValue(prev[k], next[k]));
    for (const k of Object.keys(prev)) if (!(k in next) && !changed.includes(k)) changed.push(k);
    if (changed.length === 0) return state;
    state = next;
    for (const fn of [...subscribers]) {
      try {
        fn(state, prev, changed);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[state] subscriber failed', err);
      }
    }
    return state;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }

  return { get, set, subscribe };
}

/**
 * Settings store: loads from storage, validates every update (invalid values keep the current value),
 * and persists after each change. Also records when the route (view/date) was last changed.
 * @param {{ storage?: Storage|null, now?: () => number }} [opts]
 */
export function createSettingsStore({ storage = null, now = Date.now } = {}) {
  const clock = () => {
    try {
      const t = Number(now());
      return Number.isFinite(t) ? t : Date.now();
    } catch {
      return Date.now();
    }
  };
  const store = createStore(loadSettings(storage, { now: clock }), {
    normalize: (next, prev) => sanitizeSettings(next, isPlainObject(prev) && Object.keys(prev).length ? prev : undefined),
  });
  store.subscribe((state, _prev, changed) => {
    saveSettings(storage, state);
    if (changed.includes('view') || changed.includes('date')) saveRouteAt(storage, clock());
  });
  return store;
}

// ---------------------------------------------------------------------------------------------
// Route & calendar bookkeeping (pure)
// ---------------------------------------------------------------------------------------------

/**
 * The route to open at boot.
 * - view: returnState.view (after an OAuth redirect) → settings.view → 'week'.
 * - date: returnState.date → settings.date if the route was in use within maxAgeMs → today.
 *   (Reopening the app the next morning shows today, while a reload / OAuth round trip stays put.)
 * @param {{ returnState?: any, settings?: object, lastRouteAt?: number|null, now?: Date|number|(() => number), maxAgeMs?: number }} o
 * @returns {{ view: 'day'|'week'|'month', date: Date }}  date = local midnight
 */
export function resolveInitialRoute({ returnState = null, settings = null, lastRouteAt = null, now, maxAgeMs = ROUTE_RESTORE_MS } = {}) {
  const today = startOfDay(toDate(now));
  const rs = isPlainObject(returnState) ? returnState : null;
  const s = isPlainObject(settings) ? settings : {};

  let view = 'week';
  if (rs && VIEW_NAMES.includes(rs.view)) view = rs.view;
  else if (VIEW_NAMES.includes(s.view)) view = s.view;

  let date = null;
  if (rs && isValidYMD(rs.date)) date = parseYMD(rs.date);
  if (!date && isValidYMD(s.date)) {
    const at = Number(lastRouteAt);
    const age = toDate(now).getTime() - at;
    // A timestamp far in the future (clock changed) is not trusted either.
    const fresh = lastRouteAt !== null && Number.isFinite(at) && at > 0 && age <= maxAgeMs && age >= -maxAgeMs;
    if (fresh) date = parseYMD(s.date);
  }
  return { view, date: date || today };
}

/**
 * Applies Google's per-calendar 'selected' flag to calendars seen for the first time: an unselected
 * calendar (hidden in Google's own UI) starts hidden here too. Calendars seen before keep the user's
 * choice. The primary calendar is never auto-hidden.
 * @param {{ calendars: object[], hiddenCalendarIds: string[], seenIds: string[] }} o
 * @returns {{ hiddenCalendarIds: string[], seenIds: string[], changed: boolean }}
 */
export function reconcileCalendarVisibility({ calendars, hiddenCalendarIds, seenIds } = {}) {
  const hidden = cleanIdList(hiddenCalendarIds) || [];
  const seen = cleanIdList(seenIds) || [];
  const hiddenSet = new Set(hidden);
  const seenSet = new Set(seen);
  let changed = false;
  for (const cal of Array.isArray(calendars) ? calendars : []) {
    if (!cal || !isValidId(cal.id) || seenSet.has(cal.id)) continue;
    seenSet.add(cal.id);
    seen.push(cal.id);
    changed = true;
    if (cal.selected === false && cal.primary !== true && !hiddenSet.has(cal.id)) {
      hiddenSet.add(cal.id);
      hidden.push(cal.id);
    }
  }
  return {
    hiddenCalendarIds: hidden.slice(0, MAX_CALENDAR_IDS),
    seenIds: seen.slice(-MAX_CALENDAR_IDS),
    changed,
  };
}

// ---------------------------------------------------------------------------------------------
// Local ink: which database, whose account (pure)
// ---------------------------------------------------------------------------------------------

/**
 * IndexedDB names. お試しモード never shares a database with a Google account: demo scribbles (and demo
 * erasures, which are tombstones) must never be uploaded to a real Drive.
 */
export const INK_DB_NAMES = Object.freeze({ google: 'tegaki-calendar', demo: 'tegaki-calendar-demo' });

/** @param {'google'|'demo'|string} mode */
export function inkDbName(mode) {
  return mode === 'demo' ? INK_DB_NAMES.demo : INK_DB_NAMES.google;
}

function normalizeAccount(v) {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * Whose handwriting is in the local Google database?
 *   bound   = account the local ink belongs to (null: none yet)
 *   current = the signed-in account (null: not known yet)
 * → 'unknown' (wait: do not sync yet) | 'bind' (first account: adopt it) | 'match' | 'mismatch' (never sync)
 * Emails compare case-insensitively.
 * @param {{ bound?: string|null, current?: string|null }} [o]
 * @returns {'unknown'|'bind'|'match'|'mismatch'}
 */
export function decideInkAccount({ bound = null, current = null } = {}) {
  const b = normalizeAccount(bound);
  const c = normalizeAccount(current);
  if (!c) return 'unknown';
  if (!b) return 'bind';
  return b === c ? 'match' : 'mismatch';
}

// ---------------------------------------------------------------------------------------------
// Silent re-auth policy (pure)
// ---------------------------------------------------------------------------------------------

/**
 * Input silence required before a silent (prompt=none) redirect, per trigger. App open / return
 * (boot, visible) go almost at once; a retry after a busy moment waits a little; a token that ran
 * out in the middle of a session (api, 401, online) waits for a real pause, so a short thinking break
 * never reloads the page under the pen (undo history, selection and scroll are lost on reload).
 */
export const REAUTH_IDLE_MS = Object.freeze({
  boot: 0,
  visible: 1500,
  retry: 4000,
  api: 60 * 1000,
  401: 60 * 1000,
  online: 60 * 1000,
});

const MID_SESSION_TRIGGERS = new Set(['api', '401', 'online']);

/** @param {string} trigger */
export function reauthIdleMs(trigger) {
  return Object.prototype.hasOwnProperty.call(REAUTH_IDLE_MS, trigger) ? REAUTH_IDLE_MS[trigger] : REAUTH_IDLE_MS.api;
}

/**
 * May a silent re-auth redirect start now (else: retry later)?
 * @param {{ trigger: string, quietForMs: number, drawing?: boolean, dialogOpen?: boolean,
 *           welcomeOpen?: boolean, hasSelection?: boolean }} o
 */
export function silentReauthReady({ trigger, quietForMs, drawing = false, dialogOpen = false, welcomeOpen = false, hasSelection = false } = {}) {
  if (drawing || dialogOpen || welcomeOpen) return false;
  if (hasSelection && MID_SESSION_TRIGGERS.has(trigger)) return false;
  const quiet = Number(quietForMs);
  return (Number.isFinite(quiet) ? quiet : 0) >= reauthIdleMs(trigger);
}

/**
 * Boot-time silent re-auth BEFORE any UI exists (no ink surface → nothing can be drawn and lost while
 * the browser navigates to Google). Only when a redirect would happen right after boot anyway.
 * @param {{ mode: string, configured: boolean, redirectStatus: string, tokenFresh: boolean,
 *           everSignedIn: boolean, canTrySilent: boolean, online: boolean, visible: boolean,
 *           storageWritable: boolean }} o
 */
export function shouldRedirectBeforeUi({
  mode, configured, redirectStatus, tokenFresh, everSignedIn, canTrySilent, online, visible, storageWritable,
} = {}) {
  return mode === 'google' && configured === true && redirectStatus === 'none' && tokenFresh !== true
    && everSignedIn === true && canTrySilent === true && online !== false && visible !== false
    && storageWritable === true;
}

/** Scroll ratio carried through an OAuth round trip (returnState.scroll), or null. */
export function returnScrollRatio(returnState) {
  if (!isPlainObject(returnState)) return null;
  const r = Number(returnState.scroll);
  return returnState.scroll !== null && returnState.scroll !== '' && Number.isFinite(r) && r >= 0 && r <= 1 ? r : null;
}

// ---------------------------------------------------------------------------------------------
// Event drafts (what the user entered survives a redirect / failed save) (pure)
// ---------------------------------------------------------------------------------------------

export const DRAFT_KEY = 'tegaki.draft.v1';
export const DRAFT_MAX_AGE_MS = 60 * 60 * 1000;

const isValidDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

/**
 * Validates an EventInput (from the dialog or a stored draft); dates may be Date or ISO strings.
 * @returns {{ title: string, description: string, location: string, allDay: boolean, start: Date, end: Date } | null}
 */
export function normalizeEventInput(input) {
  if (!isPlainObject(input)) return null;
  const start = input.start instanceof Date ? input.start : new Date(input.start);
  const end = input.end instanceof Date ? input.end : new Date(input.end);
  if (!isValidDate(start) || !isValidDate(end) || end <= start) return null;
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    title: str(input.title),
    description: str(input.description),
    location: str(input.location),
    allDay: input.allDay === true,
    start: new Date(start.getTime()),
    end: new Date(end.getTime()),
  };
}

/**
 * Draft → JSON string (null when the input is invalid).
 * @param {{ kind: 'create'|'update', input: object, calendarId: string, eventId?: string|null,
 *           recurring?: boolean, mode: string, now?: number }} d
 */
export function encodeDraft({ kind, input, calendarId, eventId = null, recurring = false, mode, now = Date.now() } = {}) {
  const clean = normalizeEventInput(input);
  if (!clean || (kind !== 'create' && kind !== 'update') || !isValidId(calendarId)) return null;
  return JSON.stringify({
    kind, calendarId, eventId: isValidId(eventId) ? eventId : null, recurring: recurring === true,
    mode: typeof mode === 'string' ? mode : '', at: Number(now),
    input: { ...clean, start: clean.start.toISOString(), end: clean.end.toISOString() },
  });
}

/**
 * Reads a stored draft WITHOUT consuming it.
 *   'none'        nothing stored
 *   'ok'          usable draft for this mode
 *   'other-mode'  valid, but written in the other mode (keep it)
 *   'invalid'     corrupt or older than maxAgeMs (drop it)
 * @param {string|null} raw
 * @param {{ mode: string, now?: number, maxAgeMs?: number }} o
 * @returns {{ status: 'none'|'ok'|'other-mode'|'invalid', draft: object|null }}
 */
export function parseDraft(raw, { mode, now = Date.now(), maxAgeMs = DRAFT_MAX_AGE_MS } = {}) {
  if (typeof raw !== 'string' || !raw) return { status: 'none', draft: null };
  const invalid = { status: 'invalid', draft: null };
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return invalid;
  }
  if (!isPlainObject(d)) return invalid;
  const age = Number(now) - Number(d.at);
  if (!(Number.isFinite(age) && age >= 0 && age < maxAgeMs)) return invalid;
  const input = normalizeEventInput(d.input);
  if (!input || !isValidId(d.calendarId)) return invalid;
  let draft = null;
  if (d.kind === 'create') {
    // eventId: the client id of the insert (same id on every retry → no duplicate event).
    draft = { kind: 'create', input, calendarId: d.calendarId, eventId: isValidId(d.eventId) ? d.eventId : null };
  }
  else if (d.kind === 'update' && isValidId(d.eventId)) {
    draft = { kind: 'update', input, calendarId: d.calendarId, eventId: d.eventId, recurring: d.recurring === true };
  }
  if (!draft) return invalid;
  return d.mode === mode ? { status: 'ok', draft } : { status: 'other-mode', draft };
}

// ---------------------------------------------------------------------------------------------
// Persisted events cache (offline cold start shows the last known events) (pure)
// ---------------------------------------------------------------------------------------------

/** CalEvent list → structured-clone/JSON friendly entry (dates as ISO strings). */
export function encodeEventsEntry({ events, key, at } = {}) {
  const list = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!isPlainObject(e) || !isValidDate(e.start) || !isValidDate(e.end)) continue;
    list.push({ ...e, start: e.start.toISOString(), end: e.end.toISOString() });
  }
  return { v: 1, key: typeof key === 'string' ? key : '', at: Number.isFinite(Number(at)) ? Number(at) : 0, events: list };
}

/** Inverse of encodeEventsEntry; drops malformed events; null for garbage. */
export function decodeEventsEntry(raw) {
  if (!isPlainObject(raw) || raw.v !== 1 || !Array.isArray(raw.events)) return null;
  const events = [];
  for (const e of raw.events) {
    if (!isPlainObject(e) || typeof e.id !== 'string' || !e.id || typeof e.calendarId !== 'string' || !e.calendarId) continue;
    const start = new Date(e.start);
    const end = new Date(e.end);
    if (!isValidDate(start) || !isValidDate(end) || end < start) continue;
    events.push({ ...e, start, end });
  }
  const at = Number(raw.at);
  return { key: typeof raw.key === 'string' ? raw.key : '', at: Number.isFinite(at) && at > 0 ? at : 0, events };
}

/**
 * Moves `id` to the end of an LRU id list and trims it to `limit`.
 * @returns {{ list: string[], evicted: string[] }}
 */
export function touchLru(list, id, limit) {
  const clean = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x && x !== id);
  if (typeof id === 'string' && id) clean.push(id);
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : clean.length;
  const evicted = clean.length > max ? clean.splice(0, clean.length - max) : [];
  return { list: clean, evicted };
}

/**
 * Offline banner text: 「オフラインです（9:05 時点の予定を表示しています）」 (date added when not today).
 * @param {number|null} at   ms of the events shown, or 0/null when none are known
 * @param {Date|number} [now]
 */
export function offlineBannerText(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return 'オフラインです（接続が戻ると予定を読み込みます）';
  const when = new Date(t);
  const today = startOfDay(toDate(now));
  const sameDay = startOfDay(when).getTime() === today.getTime();
  const label = sameDay ? formatTimeJa(when) : `${when.getMonth() + 1}月${when.getDate()}日 ${formatTimeJa(when)}`;
  return `オフラインです（${label} 時点の予定を表示しています）`;
}

// ---------------------------------------------------------------------------------------------
// Service worker update offer (pure)
// ---------------------------------------------------------------------------------------------

export const UPDATE_REOFFER_MS = 6 * 60 * 60 * 1000;

/**
 * Offer 「新しいバージョンがあります」 for `worker`? A new worker is always offered; the same one again
 * after `intervalMs` (a missed toast must not leave a long-lived app on old code for days).
 */
export function shouldOfferUpdate({ worker, offeredWorker = null, offeredAt = 0, now = Date.now(), intervalMs = UPDATE_REOFFER_MS } = {}) {
  if (!worker) return false;
  if (worker !== offeredWorker) return true;
  return Number(now) - Number(offeredAt) > intervalMs;
}
