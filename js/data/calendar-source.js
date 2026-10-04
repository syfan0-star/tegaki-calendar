// Calendar sources: Google Calendar (via js/google/calendar.js) and the offline お試しモード demo.
// Both expose the same CalendarSource interface and speak only CalInfo / CalEvent / EventInput
// (docs/SPEC.md §2, §4 C, §5).

import { toRFC3339, toYMD, parseYMD, startOfDay, addDays, startOfWeek, atMinutes } from '../util/date.js';
import { ApiError, AuthRequiredError } from '../google/http.js';
import { isValidEventId, newEventId } from '../google/calendar.js';

/** Fresh id for createEvent(…, { id }): generate once per 「予定を作る」 flow and reuse it on every retry. */
export { newEventId };

/** Google's 11 standard event colors (colorId → background). Their Google foreground is '#1d1d1d'. */
export const EVENT_COLORS = Object.freeze({
  1: '#a4bdfc',
  2: '#7ae7bf',
  3: '#dbadff',
  4: '#ff887c',
  5: '#fbd75b',
  6: '#ffb878',
  7: '#46d6db',
  8: '#e1e1e1',
  9: '#5484ed',
  10: '#51b749',
  11: '#dc2127',
});

export const UNTITLED = '(タイトルなし)';
export const DEFAULT_CALENDAR_COLOR = '#4285f4';
export const DEMO_STORAGE_KEY = 'tegaki.demo.events.v1';

const DARK_TEXT = '#1d1d1d';
const LIGHT_TEXT = '#ffffff';
const WRITABLE_ROLES = new Set(['owner', 'writer', 'writerWithoutPrivateAccess']);
const SKIPPED_EVENT_TYPES = new Set(['workingLocation']);
const READONLY_EVENT_TYPES = new Set(['fromGmail', 'birthday']);
const SCOPE_ERROR_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'PERMISSION_DENIED']);

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** '#rgb' | '#rrggbb' (any case) → '#rrggbb' lowercase, else null. */
function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return null;
}

/** WCAG relative luminance of '#rrggbb'. */
function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const DARK_TEXT_LUMINANCE = luminance(DARK_TEXT);

/**
 * Text color for an event box on background `bg`: whichever of dark ('#1d1d1d') / white ('#ffffff')
 * has the higher WCAG contrast ratio. Invalid input → dark.
 * @param {string} bg
 * @returns {'#1d1d1d'|'#ffffff'}
 */
export function readableTextColor(bg) {
  const hex = normalizeHex(bg);
  if (!hex) return DARK_TEXT;
  const l = luminance(hex);
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastDark = (l + 0.05) / (DARK_TEXT_LUMINANCE + 0.05);
  return contrastWhite > contrastDark ? LIGHT_TEXT : DARK_TEXT;
}

// ---------------------------------------------------------------------------
// Normalization (Google → CalInfo / CalEvent)
// ---------------------------------------------------------------------------

/** Holiday calendars (e.g. 'ja.japanese#holiday@group.v.calendar.google.com') are never shown as events. */
export function isHolidayCalendarId(id) {
  return typeof id === 'string' && id.includes('#holiday@');
}

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * calendarList entry → CalInfo (plus `accessRole`), or null for an entry without an id.
 * Hidden entries are normalized too; listCalendars() filters them out.
 */
export function normalizeCalendar(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const color = normalizeHex(raw.backgroundColor) || DEFAULT_CALENDAR_COLOR;
  const accessRole = str(raw.accessRole);
  return {
    id: raw.id,
    name: str(raw.summaryOverride).trim() || str(raw.summary).trim() || raw.id,
    color,
    textColor: normalizeHex(raw.foregroundColor) || readableTextColor(color),
    primary: raw.primary === true,
    writable: WRITABLE_ROLES.has(accessRole),
    holiday: isHolidayCalendarId(raw.id),
    selected: raw.selected === true,
    accessRole,
  };
}

/**
 * Google event → CalEvent, or null (cancelled, workingLocation, an invitation the user declined, malformed).
 * @param {object} raw  Google event resource
 * @param {object} cal  CalInfo of the calendar it came from
 */
export function normalizeEvent(raw, cal) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  if (raw.status === 'cancelled') return null;
  if (SKIPPED_EVENT_TYPES.has(raw.eventType)) return null;
  if (isDeclined(raw)) return null; // the user said no: drawing it would invite planning around it
  const times = parseEventTimes(raw.start, raw.end);
  if (!times) return null;
  const colorId = raw.colorId == null ? '' : String(raw.colorId);
  const color = EVENT_COLORS[colorId] || normalizeHex(cal && cal.color) || DEFAULT_CALENDAR_COLOR;
  return {
    id: raw.id,
    calendarId: cal && typeof cal.id === 'string' ? cal.id : '',
    title: str(raw.summary).trim() ? raw.summary : UNTITLED,
    description: str(raw.description),
    location: str(raw.location),
    allDay: times.allDay,
    start: times.start,
    end: times.end,
    color,
    textColor: readableTextColor(color),
    htmlLink: str(raw.htmlLink),
    recurring: !!raw.recurringEventId,
    editable: isEventEditable(raw, cal),
  };
}

/** An invitation whose attendee entry for this user says 'declined'. */
function isDeclined(raw) {
  return Array.isArray(raw.attendees)
    && raw.attendees.some((a) => a && a.self === true && a.responseStatus === 'declined');
}

function isEventEditable(raw, cal) {
  if (!cal || cal.writable !== true) return false;
  if (raw.locked === true) return false;
  if (READONLY_EVENT_TYPES.has(raw.eventType)) return false;
  // Someone else's event (an invitation): an edit would change only this user's copy — the organizer and the
  // other guests would keep the old time — unless the organizer lets guests modify the event.
  if (raw.organizer && typeof raw.organizer === 'object' && raw.organizer.self !== true && raw.guestsCanModify !== true) {
    return false;
  }
  // writerWithoutPrivateAccess may not modify private events ('confidential' is a legacy synonym).
  if (cal.accessRole === 'writerWithoutPrivateAccess'
    && (raw.visibility === 'private' || raw.visibility === 'confidential')) return false;
  return true;
}

const isValidDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

/**
 * { date } (all-day, end exclusive) or { dateTime } → { allDay, start, end } in local time, or null.
 * Defensive: a missing / non-increasing all-day end becomes start + 1 day; a bad timed end becomes start.
 */
function parseEventTimes(start, end) {
  if (!start || typeof start !== 'object') return null;
  const e = end && typeof end === 'object' ? end : {};
  if (typeof start.date === 'string' && start.date) {
    const s = parseYMD(start.date);
    if (!s) return null;
    let en = typeof e.date === 'string' ? parseYMD(e.date) : null;
    if (!en || en <= s) en = addDays(s, 1);
    return { allDay: true, start: s, end: en };
  }
  if (typeof start.dateTime === 'string' && start.dateTime) {
    const s = new Date(start.dateTime);
    if (!isValidDate(s)) return null;
    let en = typeof e.dateTime === 'string' ? new Date(e.dateTime) : null;
    if (!isValidDate(en) || en < s) en = new Date(s.getTime());
    return { allDay: false, start: s, end: en };
  }
  return null;
}

// ---------------------------------------------------------------------------
// EventInput → Google request bodies
// ---------------------------------------------------------------------------

function toDateOrNull(v) {
  if (isValidDate(v)) return new Date(v.getTime());
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v);
  return null;
}

/** Midnight at or after d (all-day exclusive ends must fall on a day boundary). */
function ceilToDay(d) {
  const s = startOfDay(d);
  return s.getTime() === d.getTime() ? s : addDays(s, 1);
}

/**
 * Validates and canonicalizes an EventInput.
 * all-day: start → local midnight, end → exclusive midnight ≥ start + 1 day.
 * timed:   end must not be before start.
 */
function normalizeInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('予定の内容が正しくありません');
  const allDay = input.allDay === true;
  const start = toDateOrNull(input.start);
  let end = toDateOrNull(input.end);
  if (!start) throw new TypeError('開始日時が正しくありません');
  let s = start;
  if (allDay) {
    s = startOfDay(start);
    end = end ? ceilToDay(end) : addDays(s, 1);
    if (end <= s) end = addDays(s, 1);
  } else {
    if (!end) throw new TypeError('終了日時が正しくありません');
    if (end < s) throw new RangeError('終了日時は開始日時より後にしてください');
  }
  return {
    title: str(input.title).trim(),
    description: str(input.description),
    location: str(input.location).trim(),
    allDay,
    start: s,
    end,
  };
}

/** The device's IANA time zone (e.g. 'Asia/Tokyo'), or '' if unavailable. */
function localTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' ? tz : '';
  } catch {
    return '';
  }
}

function timeField(d, allDay, explicitNulls) {
  if (allDay) return explicitNulls ? { date: toYMD(d), dateTime: null, timeZone: null } : { date: toYMD(d) };
  const out = { dateTime: toRFC3339(d) };
  const tz = localTimeZone();
  if (tz) out.timeZone = tz;
  else if (explicitNulls) out.timeZone = null;
  if (explicitNulls) out.date = null;
  return out;
}

function eventBody(input, explicitNulls) {
  const n = normalizeInput(input);
  return {
    summary: n.title,
    description: n.description,
    location: n.location,
    start: timeField(n.start, n.allDay, explicitNulls),
    end: timeField(n.end, n.allDay, explicitNulls),
  };
}

/**
 * EventInput → body for events.insert.
 * all-day → { start: { date }, end: { date } } (end exclusive); timed → { dateTime (with offset), timeZone }.
 */
export function toApiEventBody(input) {
  return eventBody(input, false);
}

/**
 * EventInput → body for events.patch: like toApiEventBody but with explicit nulls for the unused
 * variant, so switching timed ⇄ all-day really removes the old fields
 * (timed → { dateTime, timeZone, date: null }; all-day → { date, dateTime: null, timeZone: null }).
 */
export function toApiPatchBody(input) {
  return eventBody(input, true);
}

/** Text compared the way the dialog round-trips it (CRLF → LF, trailing whitespace ignored). */
const comparableText = (v) => str(v).replace(/\r\n?/g, '\n').replace(/\s+$/, '');

/** A CalEvent the edit dialog was opened from, usable as the base of a diff. */
function isUsableOriginal(original, calendarId, eventId) {
  return !!original && typeof original === 'object'
    && original.id === eventId && original.calendarId === calendarId
    && isValidDate(original.start) && isValidDate(original.end);
}

/**
 * events.patch body holding ONLY what the user changed compared with `original` (the CalEvent the dialog
 * was opened from), so a field edited elsewhere in the meantime (a memo or place added on the phone, by a
 * family member…) is not overwritten with the stale copy, an untitled event does not get the literal
 * '(タイトルなし)' and an unchanged time keeps its time zone. start and end are always sent together
 * (Google validates the pair), with the explicit nulls of toApiPatchBody.
 * @returns {object|null} null when nothing changed
 */
function toApiPatchDiff(input, original) {
  const full = toApiPatchBody(input); // validates
  const n = normalizeInput(input);
  const body = {};
  if (n.title !== str(original.title).trim()) body.summary = full.summary;
  if (comparableText(n.description) !== comparableText(original.description)) body.description = full.description;
  if (n.location !== str(original.location).trim()) body.location = full.location;
  if (n.allDay !== (original.allDay === true)
    || n.start.getTime() !== original.start.getTime()
    || n.end.getTime() !== original.end.getTime()) {
    body.start = full.start;
    body.end = full.end;
  }
  return Object.keys(body).length > 0 ? body : null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Sort: start, then all-day first, then longer first, then title, then ids (deterministic). */
function compareEvents(a, b) {
  return (a.start - b.start)
    || (Number(b.allDay) - Number(a.allDay))
    || ((b.end - b.start) - (a.end - a.start))
    || a.title.localeCompare(b.title, 'ja')
    || cmp(a.calendarId, b.calendarId)
    || cmp(a.id, b.id);
}

const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

function compareCalendars(a, b) {
  return (Number(b.primary) - Number(a.primary))
    || (Number(a.holiday) - Number(b.holiday))
    || a.name.localeCompare(b.name, 'ja')
    || cmp(a.id, b.id);
}

function cloneEvent(ev) {
  return { ...ev, start: new Date(ev.start.getTime()), end: new Date(ev.end.getTime()) };
}

function requireRange(start, end) {
  if (!isValidDate(start) || !isValidDate(end)) throw new TypeError('listEvents: start / end must be valid Dates');
}

function requireId(id, name) {
  if (typeof id !== 'string' || !id) throw new TypeError(`${name} must be a non-empty string`);
  return id;
}

/** Array of ids (a single string is accepted); null/undefined → null meaning "all calendars". */
function idList(calendarIds) {
  if (calendarIds === null || calendarIds === undefined) return null;
  const list = Array.isArray(calendarIds) ? calendarIds : [calendarIds];
  return [...new Set(list.filter((id) => typeof id === 'string' && id))];
}

/** True if [ev.start, ev.end) overlaps [start, end); zero-length events count when inside the range. */
function overlaps(ev, start, end) {
  if (ev.end.getTime() === ev.start.getTime()) return ev.start >= start && ev.start < end;
  return ev.start < end && ev.end > start;
}

function errorText(err) {
  if (!err) return '';
  const parts = [err.name, err.status, err.reason, err.message].filter((x) => x !== undefined && x !== '');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Google source
// ---------------------------------------------------------------------------

function isScopeError(err) {
  return err instanceof ApiError && err.status === 403 && SCOPE_ERROR_REASONS.has(err.reason);
}

/** Used when calendarList is not readable (calendarlist.readonly not granted): only 'primary'. */
function fallbackPrimaryCalendar() {
  return {
    id: 'primary',
    name: 'マイカレンダー',
    color: DEFAULT_CALENDAR_COLOR,
    textColor: readableTextColor(DEFAULT_CALENDAR_COLOR),
    primary: true,
    writable: true,
    holiday: false,
    selected: true,
    accessRole: 'owner',
  };
}

/** CalInfo stand-in for a calendar not (yet) in the list; writes are allowed, Google enforces ACLs. */
function unknownCalendar(id) {
  return {
    id,
    name: id,
    color: DEFAULT_CALENDAR_COLOR,
    textColor: readableTextColor(DEFAULT_CALENDAR_COLOR),
    primary: id === 'primary',
    writable: !isHolidayCalendarId(id),
    holiday: isHolidayCalendarId(id),
    selected: true,
    accessRole: '',
  };
}

/**
 * CalendarSource backed by the Google Calendar API.
 * @param {ReturnType<import('../google/calendar.js').createCalendarApi>} calendarApi
 * @param {{ logger?: { warn: Function } }} [opts]
 */
export function createGoogleCalendarSource(calendarApi, { logger = console } = {}) {
  for (const m of ['listCalendars', 'listEvents', 'insertEvent', 'patchEvent', 'deleteEvent']) {
    if (!calendarApi || typeof calendarApi[m] !== 'function') {
      throw new TypeError(`createGoogleCalendarSource: calendarApi.${m} is required`);
    }
  }
  const warn = (...args) => {
    try {
      logger && typeof logger.warn === 'function' && logger.warn(...args);
    } catch {
      // never let logging break data loading
    }
  };

  /** id → CalInfo from the last successful listCalendars(). */
  const known = new Map();
  let loading = null;

  async function listCalendars() {
    let raws;
    try {
      raws = await calendarApi.listCalendars();
    } catch (e) {
      if (!isScopeError(e)) throw e;
      warn('[calendar] カレンダー一覧の権限がないため、メインのカレンダーのみ表示します');
      raws = null;
    }
    const byId = new Map();
    for (const raw of Array.isArray(raws) ? raws : []) {
      if (!raw || raw.hidden === true || raw.deleted === true) continue;
      const cal = normalizeCalendar(raw);
      if (cal && !byId.has(cal.id)) byId.set(cal.id, cal);
    }
    if (byId.size === 0) byId.set('primary', fallbackPrimaryCalendar());
    const list = [...byId.values()].sort(compareCalendars);
    known.clear();
    for (const cal of list) known.set(cal.id, cal);
    return list.map((c) => ({ ...c }));
  }

  /** Loads the calendar list once if nothing is known yet (needed for colors / editability). */
  async function ensureCalendars() {
    if (known.size > 0) return;
    if (!loading) {
      loading = listCalendars().catch((e) => {
        warn('[calendar] カレンダー一覧を取得できませんでした:', errorText(e));
      }).finally(() => {
        loading = null;
      });
    }
    await loading;
  }

  const calendarFor = (id) => known.get(id) || unknownCalendar(id);

  /**
   * Events of the given calendars, merged and sorted. One failing calendar does not fail all: the result
   * then carries (non-enumerable) `failedCalendarIds` (string[]) and `firstError`, so the caller can keep
   * its previous events of those calendars instead of showing them as gone. Always present ([] = complete).
   * Throws when every calendar failed, or when one failed for lack of authorization (reconnect needed).
   */
  async function listEvents(calendarIds, start, end) {
    requireRange(start, end);
    if (end <= start) return withFailures([], [], null);
    const requested = idList(calendarIds);
    // Nothing fetchable (empty list or holiday calendars only) → no requests at all.
    if (requested !== null && requested.every(isHolidayCalendarId)) return withFailures([], [], null);
    await ensureCalendars();
    const ids = (requested === null ? [...known.keys()] : requested).filter((id) => !isHolidayCalendarId(id));
    if (ids.length === 0) return withFailures([], [], null);

    const timeMin = toRFC3339(start);
    const timeMax = toRFC3339(end);
    const results = await Promise.allSettled(ids.map((id) => calendarApi.listEvents(id, timeMin, timeMax)));

    const events = [];
    const seen = new Set();
    const failedIds = [];
    let firstError = null;
    let authError = null;
    results.forEach((r, i) => {
      const cal = calendarFor(ids[i]);
      if (r.status === 'rejected') {
        if (!firstError) firstError = r.reason;
        if (!authError && isAuthError(r.reason)) authError = r.reason;
        failedIds.push(ids[i]);
        warn(`[calendar] 「${cal.name}」の予定を取得できませんでした:`, errorText(r.reason));
        return;
      }
      for (const raw of Array.isArray(r.value) ? r.value : []) {
        const ev = normalizeEvent(raw, cal);
        if (!ev) continue;
        const key = `${ev.calendarId}\n${ev.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(ev);
      }
    });
    if (firstError && results.every((r) => r.status === 'rejected')) throw firstError;
    // The token died midway: a partial list would hide calendars without triggering the reconnect.
    if (authError) throw authError;
    return withFailures(events.sort(compareEvents), failedIds, firstError);
  }

  /**
   * @param {string} calendarId
   * @param {object} input EventInput
   * @param {{ id?: string }} [opts]  id from newEventId(): pass the SAME id when retrying a failed save, so
   *        an attempt that did reach Google (lost response) is returned instead of creating a duplicate
   */
  async function createEvent(calendarId, input, opts = {}) {
    requireId(calendarId, 'calendarId');
    const body = toApiEventBody(input);
    const id = opts && isValidEventId(opts.id) ? opts.id : newEventId();
    await ensureCalendars();
    const raw = await calendarApi.insertEvent(calendarId, { ...body, id });
    return toEventOrThrow(raw, calendarFor(calendarId));
  }

  /**
   * @param {string} calendarId
   * @param {string} eventId
   * @param {object} input EventInput from the dialog
   * @param {object} [original] the CalEvent the dialog was opened from: only fields that differ from it are
   *        sent (nothing changed → no request, the original is returned). Without it every field is sent.
   */
  async function updateEvent(calendarId, eventId, input, original) {
    requireId(calendarId, 'calendarId');
    requireId(eventId, 'eventId');
    const usable = isUsableOriginal(original, calendarId, eventId);
    const body = usable ? toApiPatchDiff(input, original) : toApiPatchBody(input);
    if (body === null) return cloneEvent(original);
    await ensureCalendars();
    const raw = await calendarApi.patchEvent(calendarId, eventId, body);
    return toEventOrThrow(raw, calendarFor(calendarId));
  }

  async function deleteEvent(calendarId, eventId) {
    requireId(calendarId, 'calendarId');
    requireId(eventId, 'eventId');
    await calendarApi.deleteEvent(calendarId, eventId);
  }

  return { kind: 'google', listCalendars, listEvents, createEvent, updateEvent, deleteEvent };
}

function isAuthError(err) {
  return err instanceof AuthRequiredError || (!!err && err.name === 'AuthRequiredError');
}

/** Attaches the partial-failure info to a listEvents result (non-enumerable: the array stays a plain list). */
function withFailures(list, failedIds, firstError) {
  Object.defineProperty(list, 'failedCalendarIds', { value: failedIds, enumerable: false });
  Object.defineProperty(list, 'firstError', { value: firstError, enumerable: false });
  return list;
}

function toEventOrThrow(raw, cal) {
  const ev = normalizeEvent(raw, cal);
  if (!ev) throw new ApiError({ status: 200, reason: 'invalidResponse', body: raw, message: 'Google returned an unusable event' });
  return ev;
}

// ---------------------------------------------------------------------------
// Demo source (お試しモード)
// ---------------------------------------------------------------------------

const DEMO_CALENDARS = Object.freeze([
  { id: 'demo-main', name: 'マイカレンダー', color: '#4285f4', primary: true, accessRole: 'owner' },
  { id: 'demo-work', name: '仕事', color: '#0b8043', primary: false, accessRole: 'owner' },
  { id: 'demo-family', name: '家族', color: '#e67c73', primary: false, accessRole: 'reader' },
].map((c) => Object.freeze({
  ...c,
  textColor: readableTextColor(c.color),
  writable: WRITABLE_ROLES.has(c.accessRole),
  holiday: false,
  selected: true,
})));

/**
 * Sample events, relative to the Sunday that starts the current week.
 * week: weeks from the current week; day: 0 = Sunday … 6 = Saturday (may exceed 6);
 * timed events have from/to minutes; all-day events have days (≥ 1).
 */
const DEMO_SEED = [
  ...[-1, 0, 1, 2].map((week) => ({
    key: `weekly-${week}`, cal: 'demo-work', title: '週次定例', week, day: 1, from: 600, to: 660,
    location: '会議室A', recurring: true,
  })),
  { key: 'review', cal: 'demo-work', title: '企画レビュー', week: 0, day: 1, from: 630, to: 720, description: '新サービスの企画書を確認' },
  { key: 'lunch', cal: 'demo-main', title: 'ランチ', week: 0, day: 1, from: 720, to: 780 },
  { key: 'standup', cal: 'demo-work', title: '朝会', week: 0, day: 2, from: 540, to: 570 },
  { key: 'dentist', cal: 'demo-main', title: '歯医者', week: 0, day: 2, from: 900, to: 960, location: '駅前歯科' },
  { key: 'deadline', cal: 'demo-work', title: '資料提出日', week: 0, day: 3, days: 1 },
  { key: 'one-on-one', cal: 'demo-work', title: '1on1', week: 0, day: 3, from: 780, to: 810 },
  { key: 'visitor', cal: 'demo-work', title: '来客対応', week: 0, day: 3, from: 780, to: 870 },
  { key: 'gym', cal: 'demo-main', title: 'ジム', week: 0, day: 4, from: 1140, to: 1230 },
  { key: 'party', cal: 'demo-work', title: '歓迎会', week: 0, day: 5, from: 1110, to: 1260, location: '新宿' },
  { key: 'trip', cal: 'demo-family', title: '家族旅行', week: 0, day: 5, days: 2, location: '箱根' },
  { key: 'shopping', cal: 'demo-family', title: '買い物', week: 0, day: 0, from: 600, to: 720 },
  { key: 'yoga', cal: 'demo-main', title: 'ヨガ', week: -1, day: 4, from: 1170, to: 1230 },
  { key: 'business-trip', cal: 'demo-work', title: '出張（大阪）', week: 1, day: 1, days: 2 },
  { key: 'birthday', cal: 'demo-family', title: 'おばあちゃんの誕生日', week: 1, day: 3, days: 1 },
];

/** Accepts a clock function, a Date or epoch ms; falls back to Date.now(). */
function resolveNow(now) {
  let v = now;
  try {
    if (typeof v === 'function') v = v();
  } catch {
    v = undefined;
  }
  if (isValidDate(v)) return new Date(v.getTime());
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v);
  return new Date();
}

/** Builds the deterministic sample events for the week containing `today`. */
function seedDemoEvents(today) {
  const weekStart = startOfWeek(today, 0);
  const events = DEMO_SEED.map((s) => {
    const day = addDays(weekStart, s.week * 7 + s.day);
    const base = {
      id: `demo-${s.key}`,
      calendarId: s.cal,
      title: s.title,
      description: s.description || '',
      location: s.location || '',
      recurring: s.recurring === true,
    };
    if (s.days) return { ...base, allDay: true, start: day, end: addDays(day, s.days) };
    return { ...base, allDay: false, start: atMinutes(day, s.from), end: atMinutes(day, s.to) };
  });
  const todayStart = startOfDay(today);
  events.push({
    id: 'demo-try-today',
    calendarId: 'demo-main',
    title: '手書きカレンダーを試す',
    description: 'ペンで予定を書いたり、「予定」ツールで時間をなぞって予定を作ってみましょう',
    location: '',
    recurring: false,
    allDay: false,
    start: atMinutes(todayStart, 960),
    end: atMinutes(todayStart, 1020),
  });
  return events;
}

/** Stored record → internal record, or null if malformed. */
function decodeStoredEvent(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || typeof r.calendarId !== 'string') return null;
  const allDay = r.allDay === true;
  const start = allDay ? parseYMD(r.start) : (typeof r.start === 'string' ? new Date(r.start) : null);
  const end = allDay ? parseYMD(r.end) : (typeof r.end === 'string' ? new Date(r.end) : null);
  if (!isValidDate(start) || !isValidDate(end) || end < start) return null;
  if (allDay && end <= start) return null;
  return {
    id: r.id,
    calendarId: r.calendarId,
    title: str(r.title),
    description: str(r.description),
    location: str(r.location),
    allDay,
    start,
    end,
    recurring: r.recurring === true,
  };
}

function encodeStoredEvent(e) {
  return {
    id: e.id,
    calendarId: e.calendarId,
    title: e.title,
    description: e.description,
    location: e.location,
    allDay: e.allDay,
    // all-day dates as 'YYYY-MM-DD' so they stay on the same calendar days in any time zone
    start: e.allDay ? toYMD(e.start) : e.start.toISOString(),
    end: e.allDay ? toYMD(e.end) : e.end.toISOString(),
    recurring: e.recurring,
  };
}

function newDemoId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `demo-${c.randomUUID()}`;
  return `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Offline CalendarSource with sample data. Events persist in `storage` (localStorage-like) under
 * 'tegaki.demo.events.v1'; without storage (or when it fails) everything stays in memory.
 * @param {{ storage?: Storage|null, now?: (() => number)|Date|number }} [opts]
 */
export function createDemoCalendarSource({ storage = null, now = Date.now } = {}) {
  const calendars = new Map(DEMO_CALENDARS.map((c) => [c.id, c]));
  let events = loadOrSeed();

  function loadOrSeed() {
    const stored = readStorage();
    if (stored) return stored;
    const seeded = seedDemoEvents(resolveNow(now));
    persist(seeded);
    return seeded;
  }

  function readStorage() {
    if (!storage || typeof storage.getItem !== 'function') return null;
    let raw;
    try {
      raw = storage.getItem(DEMO_STORAGE_KEY);
    } catch {
      return null;
    }
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || data.v !== 1 || !Array.isArray(data.events)) return null;
      return data.events.map(decodeStoredEvent).filter((e) => e && calendars.has(e.calendarId));
    } catch {
      return null;
    }
  }

  function persist(list = events) {
    if (!storage || typeof storage.setItem !== 'function') return;
    try {
      storage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ v: 1, events: list.map(encodeStoredEvent) }));
    } catch (e) {
      console.warn('[demo] 予定を保存できませんでした:', e && e.message);
    }
  }

  function toCalEvent(e) {
    const cal = calendars.get(e.calendarId);
    return {
      id: e.id,
      calendarId: e.calendarId,
      title: e.title.trim() ? e.title : UNTITLED,
      description: e.description,
      location: e.location,
      allDay: e.allDay,
      start: new Date(e.start.getTime()),
      end: new Date(e.end.getTime()),
      color: cal.color,
      textColor: cal.textColor,
      htmlLink: '',
      recurring: e.recurring,
      editable: cal.writable,
    };
  }

  function writableCalendar(calendarId) {
    requireId(calendarId, 'calendarId');
    const cal = calendars.get(calendarId);
    if (!cal) throw new ApiError({ status: 404, reason: 'notFound', message: 'カレンダーが見つかりません' });
    if (!cal.writable) throw new ApiError({ status: 403, reason: 'requiredAccessLevel', message: 'このカレンダーは編集できません' });
    return cal;
  }

  async function listCalendars() {
    return [...calendars.values()].map((c) => ({ ...c }));
  }

  async function listEvents(calendarIds, start, end) {
    requireRange(start, end);
    if (end <= start) return [];
    const ids = idList(calendarIds);
    const wanted = new Set(ids === null ? calendars.keys() : ids);
    return events
      .filter((e) => wanted.has(e.calendarId) && overlaps(e, start, end))
      .map(toCalEvent)
      .sort(compareEvents);
  }

  async function createEvent(calendarId, input, opts = {}) {
    writableCalendar(calendarId);
    const n = normalizeInput(input);
    // Same idempotency contract as Google: a repeated create with the same id returns the first event.
    const id = opts && isValidEventId(opts.id) ? `demo-${opts.id}` : newDemoId();
    const existing = events.find((e) => e.id === id && e.calendarId === calendarId);
    if (existing) return toCalEvent(existing);
    const record = { id, calendarId, ...pickInputFields(n), recurring: false };
    events = [...events, record];
    persist();
    return toCalEvent(record);
  }

  /** The 4th argument (original CalEvent) is accepted for interface parity; local edits cannot race. */
  async function updateEvent(calendarId, eventId, input) {
    writableCalendar(calendarId);
    requireId(eventId, 'eventId');
    const index = events.findIndex((e) => e.id === eventId && e.calendarId === calendarId);
    if (index < 0) throw new ApiError({ status: 404, reason: 'notFound', message: '予定が見つかりません' });
    const n = normalizeInput(input);
    const updated = { ...events[index], ...pickInputFields(n) };
    events = events.map((e, i) => (i === index ? updated : e));
    persist();
    return toCalEvent(updated);
  }

  async function deleteEvent(calendarId, eventId) {
    writableCalendar(calendarId);
    requireId(eventId, 'eventId');
    const next = events.filter((e) => !(e.id === eventId && e.calendarId === calendarId));
    if (next.length === events.length) return; // already gone: success, like Google's 404/410
    events = next;
    persist();
  }

  return { kind: 'demo', listCalendars, listEvents, createEvent, updateEvent, deleteEvent };
}

function pickInputFields(n) {
  return {
    title: n.title,
    description: n.description,
    location: n.location,
    allDay: n.allDay,
    start: n.start,
    end: n.end,
  };
}
