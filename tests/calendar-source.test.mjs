// Run with TZ=Asia/Tokyo (npm test sets it) — expectations use +09:00 local time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_COLORS, UNTITLED, DEFAULT_CALENDAR_COLOR, DEMO_STORAGE_KEY,
  readableTextColor, isHolidayCalendarId, normalizeCalendar, normalizeEvent,
  toApiEventBody, toApiPatchBody, createGoogleCalendarSource, createDemoCalendarSource, newEventId,
} from '../js/data/calendar-source.js';
import { ApiError, AuthRequiredError } from '../js/google/http.js';

const d = (y, m, day, h = 0, mi = 0) => new Date(y, m - 1, day, h, mi);
const HOLIDAY_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Tests whose expected strings are +09:00 literals only run in Asia/Tokyo (npm test sets TZ); the rest
// of the suite must pass in any time zone.
const IS_JST = new Date(2026, 9, 4).getTimezoneOffset() === -540 && new Date(2026, 0, 4).getTimezoneOffset() === -540;
const jstOnly = { skip: IS_JST ? false : 'expects TZ=Asia/Tokyo (+09:00 literals)' };

test('test environment runs in Asia/Tokyo', jstOnly, () => {
  assert.equal(new Date(2026, 9, 4).getTimezoneOffset(), -540, 'run with TZ=Asia/Tokyo');
});

// ---------------- colors ----------------

test('EVENT_COLORS: the 11 standard Google event colors', () => {
  assert.deepEqual({ ...EVENT_COLORS }, {
    1: '#a4bdfc', 2: '#7ae7bf', 3: '#dbadff', 4: '#ff887c', 5: '#fbd75b', 6: '#ffb878',
    7: '#46d6db', 8: '#e1e1e1', 9: '#5484ed', 10: '#51b749', 11: '#dc2127',
  });
  assert.equal(EVENT_COLORS['11'], '#dc2127');
});

test('readableTextColor picks dark or white by luminance', () => {
  assert.equal(readableTextColor('#ffffff'), '#1d1d1d');
  assert.equal(readableTextColor('#fbd75b'), '#1d1d1d');
  assert.equal(readableTextColor('#a4bdfc'), '#1d1d1d');
  assert.equal(readableTextColor('#000000'), '#ffffff');
  assert.equal(readableTextColor('#dc2127'), '#ffffff');
  assert.equal(readableTextColor('#0b8043'), '#ffffff');
  assert.equal(readableTextColor('#FFF'), '#1d1d1d');
  assert.equal(readableTextColor('#123'), '#ffffff');
  for (const bad of [undefined, null, '', 'red', '#12345', 42]) assert.equal(readableTextColor(bad), '#1d1d1d');
});

// ---------------- normalizeCalendar ----------------

test('normalizeCalendar maps calendarList entries to CalInfo', () => {
  const cal = normalizeCalendar({
    id: 'me@example.com', summary: 'me@example.com', summaryOverride: '私', backgroundColor: '#9FC6E7',
    foregroundColor: '#000000', primary: true, accessRole: 'owner', selected: true,
  });
  assert.deepEqual(cal, {
    id: 'me@example.com', name: '私', color: '#9fc6e7', textColor: '#000000', primary: true,
    writable: true, holiday: false, selected: true, accessRole: 'owner',
  });
  for (const [role, writable] of [['owner', true], ['writer', true], ['writerWithoutPrivateAccess', true], ['reader', false], ['freeBusyReader', false], [undefined, false]]) {
    assert.equal(normalizeCalendar({ id: 'x', accessRole: role }).writable, writable, String(role));
  }
  const holiday = normalizeCalendar({ id: HOLIDAY_ID, summary: '日本の祝日', accessRole: 'reader' });
  assert.equal(holiday.holiday, true);
  assert.equal(holiday.selected, false);
  assert.equal(holiday.primary, false);
  const bare = normalizeCalendar({ id: 'bare' });
  assert.equal(bare.name, 'bare');
  assert.equal(bare.color, DEFAULT_CALENDAR_COLOR);
  assert.equal(bare.textColor, readableTextColor(DEFAULT_CALENDAR_COLOR));
  assert.equal(normalizeCalendar({ id: 's', summary: '  仕事 ' }).name, '仕事');
  assert.equal(normalizeCalendar(null), null);
  assert.equal(normalizeCalendar({ summary: 'no id' }), null);
  assert.equal(isHolidayCalendarId(HOLIDAY_ID), true);
  assert.equal(isHolidayCalendarId('ja.japanese.official#holiday@group.v.calendar.google.com'), true);
  assert.equal(isHolidayCalendarId('me@example.com'), false);
});

// ---------------- normalizeEvent ----------------

const ownerCal = normalizeCalendar({ id: 'me@example.com', backgroundColor: '#9fc6e7', accessRole: 'owner', primary: true });
const readerCal = normalizeCalendar({ id: 'r@group.calendar.google.com', backgroundColor: '#ffad46', accessRole: 'reader' });
const wwpaCal = normalizeCalendar({ id: 'w@group.calendar.google.com', accessRole: 'writerWithoutPrivateAccess' });

test('normalizeEvent: timed event', () => {
  const at = (iso) => new Date(iso);
  const ev = normalizeEvent({
    id: 'e1', status: 'confirmed', summary: '会議', description: '<b>議題</b>', location: '会議室',
    start: { dateTime: '2026-10-05T10:00:00+09:00', timeZone: 'Asia/Tokyo' },
    end: { dateTime: '2026-10-05T01:30:00Z' },
    htmlLink: 'https://www.google.com/calendar/event?eid=x', eventType: 'default',
  }, ownerCal);
  assert.deepEqual(ev, {
    id: 'e1', calendarId: 'me@example.com', title: '会議', description: '<b>議題</b>', location: '会議室',
    allDay: false, start: at('2026-10-05T10:00:00+09:00'), end: at('2026-10-05T10:30:00+09:00'),
    color: '#9fc6e7', textColor: readableTextColor('#9fc6e7'), htmlLink: 'https://www.google.com/calendar/event?eid=x',
    recurring: false, editable: true,
  });
});

test('normalizeEvent: all-day uses local midnight and exclusive end', () => {
  const ev = normalizeEvent({ id: 'a', summary: '旅行', start: { date: '2026-10-09' }, end: { date: '2026-10-11' } }, ownerCal);
  assert.equal(ev.allDay, true);
  assert.deepEqual(ev.start, d(2026, 10, 9));
  assert.deepEqual(ev.end, d(2026, 10, 11));
  // missing or broken end → one day
  const one = normalizeEvent({ id: 'b', start: { date: '2026-10-09' } }, ownerCal);
  assert.deepEqual(one.end, d(2026, 10, 10));
  const same = normalizeEvent({ id: 'c', start: { date: '2026-10-09' }, end: { date: '2026-10-09' } }, ownerCal);
  assert.deepEqual(same.end, d(2026, 10, 10));
});

test('normalizeEvent: skips cancelled, workingLocation and malformed items', () => {
  const base = { id: 'x', start: { dateTime: '2026-10-05T10:00:00+09:00' }, end: { dateTime: '2026-10-05T11:00:00+09:00' } };
  assert.equal(normalizeEvent({ ...base, status: 'cancelled' }, ownerCal), null);
  assert.equal(normalizeEvent({ ...base, eventType: 'workingLocation' }, ownerCal), null);
  assert.equal(normalizeEvent({ ...base, id: '' }, ownerCal), null);
  assert.equal(normalizeEvent({ ...base, start: undefined }, ownerCal), null);
  assert.equal(normalizeEvent({ ...base, start: { dateTime: 'garbage' } }, ownerCal), null);
  assert.equal(normalizeEvent({ ...base, start: { date: '2026-13-40' } }, ownerCal), null);
  assert.equal(normalizeEvent(null, ownerCal), null);
  // tentative is kept; end before start is clamped to a zero-length event
  const t = normalizeEvent({ ...base, status: 'tentative', end: { dateTime: '2026-10-05T09:00:00+09:00' } }, ownerCal);
  assert.deepEqual(t.end, t.start);
});

test('normalizeEvent: title fallback, recurring flag, colors', () => {
  const base = { id: 'x', start: { dateTime: '2026-10-05T10:00:00+09:00' }, end: { dateTime: '2026-10-05T11:00:00+09:00' } };
  assert.equal(normalizeEvent(base, ownerCal).title, UNTITLED);
  assert.equal(UNTITLED, '(タイトルなし)');
  assert.equal(normalizeEvent({ ...base, summary: '   ' }, ownerCal).title, UNTITLED);
  assert.equal(normalizeEvent({ ...base, recurringEventId: 'series' }, ownerCal).recurring, true);
  const tomato = normalizeEvent({ ...base, colorId: '11' }, ownerCal);
  assert.equal(tomato.color, '#dc2127');
  assert.equal(tomato.textColor, '#ffffff');
  assert.equal(normalizeEvent({ ...base, colorId: 5 }, ownerCal).color, '#fbd75b');
  assert.equal(normalizeEvent({ ...base, colorId: '99' }, ownerCal).color, '#9fc6e7');
  assert.equal(normalizeEvent(base, null).color, DEFAULT_CALENDAR_COLOR);
  assert.equal(normalizeEvent(base, null).calendarId, '');
});

test('normalizeEvent: editable rules', () => {
  const base = { id: 'x', start: { dateTime: '2026-10-05T10:00:00+09:00' }, end: { dateTime: '2026-10-05T11:00:00+09:00' } };
  assert.equal(normalizeEvent(base, ownerCal).editable, true);
  assert.equal(normalizeEvent({ ...base, eventType: 'default' }, ownerCal).editable, true);
  assert.equal(normalizeEvent({ ...base, eventType: 'focusTime' }, ownerCal).editable, true);
  assert.equal(normalizeEvent({ ...base, locked: true }, ownerCal).editable, false);
  assert.equal(normalizeEvent({ ...base, eventType: 'fromGmail' }, ownerCal).editable, false);
  assert.equal(normalizeEvent({ ...base, eventType: 'birthday' }, ownerCal).editable, false);
  assert.equal(normalizeEvent(base, readerCal).editable, false);
  assert.equal(normalizeEvent(base, null).editable, false);
  assert.equal(normalizeEvent(base, wwpaCal).editable, true);
  assert.equal(normalizeEvent({ ...base, visibility: 'private' }, wwpaCal).editable, false);
  assert.equal(normalizeEvent({ ...base, visibility: 'confidential' }, wwpaCal).editable, false, 'legacy synonym of private');
  assert.equal(normalizeEvent({ ...base, visibility: 'private' }, ownerCal).editable, true);
});

test('normalizeEvent: invitations from someone else are read-only unless guests may modify them', () => {
  const base = { id: 'x', start: { dateTime: '2026-10-05T10:00:00+09:00' }, end: { dateTime: '2026-10-05T11:00:00+09:00' } };
  // Own event / event of a shared calendar: the organizer is this calendar.
  assert.equal(normalizeEvent({ ...base, organizer: { email: 'me@example.com', self: true } }, ownerCal).editable, true);
  // Someone else's invitation on my primary calendar (Google omits self:false): editing would change only my copy.
  assert.equal(normalizeEvent({ ...base, organizer: { email: 'boss@example.com' } }, ownerCal).editable, false);
  assert.equal(normalizeEvent({ ...base, organizer: { email: 'boss@example.com', self: false } }, ownerCal).editable, false);
  assert.equal(normalizeEvent({ ...base, organizer: { email: 'boss@example.com' }, guestsCanModify: true }, ownerCal).editable, true);
  // No organizer info (older data) → unchanged behaviour.
  assert.equal(normalizeEvent(base, ownerCal).editable, true);
});

test('normalizeEvent: invitations the user declined are not shown', () => {
  const base = { id: 'x', start: { dateTime: '2026-10-05T10:00:00+09:00' }, end: { dateTime: '2026-10-05T11:00:00+09:00' } };
  assert.equal(normalizeEvent({ ...base, attendees: [{ self: true, responseStatus: 'declined' }] }, ownerCal), null);
  assert.equal(normalizeEvent({ ...base, attendees: [{ responseStatus: 'declined' }, { self: true, responseStatus: 'accepted' }] }, ownerCal).id, 'x');
  for (const status of ['needsAction', 'tentative', 'accepted']) {
    assert.notEqual(normalizeEvent({ ...base, attendees: [{ self: true, responseStatus: status }] }, ownerCal), null, status);
  }
  assert.notEqual(normalizeEvent({ ...base, attendees: 'garbage' }, ownerCal), null);
});

// ---------------- request bodies ----------------

test('toApiEventBody: timed → dateTime with local offset + IANA zone', jstOnly, () => {
  const body = toApiEventBody({ title: ' 打ち合わせ ', description: 'メモ', location: '渋谷 ', allDay: false, start: d(2026, 10, 5, 9), end: d(2026, 10, 5, 10, 30) });
  assert.deepEqual(body, {
    summary: '打ち合わせ',
    description: 'メモ',
    location: '渋谷',
    start: { dateTime: '2026-10-05T09:00:00+09:00', timeZone: TZ },
    end: { dateTime: '2026-10-05T10:30:00+09:00', timeZone: TZ },
  });
  assert.equal(TZ, 'Asia/Tokyo');
});

test('toApiEventBody: all-day → date strings, end exclusive', () => {
  assert.deepEqual(toApiEventBody({ title: '旅行', allDay: true, start: d(2026, 10, 9), end: d(2026, 10, 11) }), {
    summary: '旅行', description: '', location: '',
    start: { date: '2026-10-09' }, end: { date: '2026-10-11' },
  });
  // non-midnight values are widened to whole days; empty / inverted end → one day
  assert.deepEqual(toApiEventBody({ title: 'x', allDay: true, start: d(2026, 10, 9, 15), end: d(2026, 10, 10, 9) }).end, { date: '2026-10-11' });
  assert.deepEqual(toApiEventBody({ title: 'x', allDay: true, start: d(2026, 10, 9, 15), end: d(2026, 10, 9, 15) }).start, { date: '2026-10-09' });
  assert.deepEqual(toApiEventBody({ title: 'x', allDay: true, start: d(2026, 10, 9), end: d(2026, 10, 9) }).end, { date: '2026-10-10' });
  assert.deepEqual(toApiEventBody({ title: 'x', allDay: true, start: d(2026, 10, 9) }).end, { date: '2026-10-10' });
  // year boundary
  assert.deepEqual(toApiEventBody({ title: 'x', allDay: true, start: d(2026, 12, 31), end: d(2027, 1, 1) }).end, { date: '2027-01-01' });
});

test('toApiEventBody validates input', () => {
  assert.throws(() => toApiEventBody(null), TypeError);
  assert.throws(() => toApiEventBody({ title: 'x', start: new Date(NaN), end: d(2026, 10, 5) }), TypeError);
  assert.throws(() => toApiEventBody({ title: 'x', allDay: false, start: d(2026, 10, 5, 9) }), TypeError);
  assert.throws(() => toApiEventBody({ title: 'x', start: d(2026, 10, 5, 10), end: d(2026, 10, 5, 9) }), RangeError);
  // zero-length timed events are allowed
  assert.doesNotThrow(() => toApiEventBody({ title: 'x', start: d(2026, 10, 5, 10), end: d(2026, 10, 5, 10) }));
  // missing text fields become ''
  const b = toApiEventBody({ start: d(2026, 10, 5, 10), end: d(2026, 10, 5, 11) });
  assert.equal(b.summary, '');
  assert.equal(b.description, '');
  assert.equal(b.location, '');
});

test('toApiPatchBody: explicit nulls for the unused variant', jstOnly, () => {
  const timed = toApiPatchBody({ title: 't', description: '', location: '', allDay: false, start: d(2026, 10, 5, 9), end: d(2026, 10, 5, 10) });
  assert.deepEqual(timed.start, { dateTime: '2026-10-05T09:00:00+09:00', timeZone: TZ, date: null });
  assert.deepEqual(timed.end, { dateTime: '2026-10-05T10:00:00+09:00', timeZone: TZ, date: null });
  assert.equal(timed.summary, 't');
  assert.equal(timed.description, '');
  const allDay = toApiPatchBody({ title: 'a', allDay: true, start: d(2026, 10, 5), end: d(2026, 10, 6) });
  assert.deepEqual(allDay.start, { date: '2026-10-05', dateTime: null, timeZone: null });
  assert.deepEqual(allDay.end, { date: '2026-10-06', dateTime: null, timeZone: null });
});

// ---------------- Google source ----------------

function fakeCalendarApi({ calendars = [], events = {}, fail = {} } = {}) {
  const calls = [];
  const api = {
    calls,
    async listCalendars() {
      calls.push(['listCalendars']);
      if (fail.listCalendars) throw fail.listCalendars;
      return calendars;
    },
    async listEvents(id, timeMin, timeMax) {
      calls.push(['listEvents', id, timeMin, timeMax]);
      if (fail[id]) throw fail[id];
      return events[id] || [];
    },
    async insertEvent(id, body) {
      calls.push(['insertEvent', id, body]);
      return { id: 'created', htmlLink: 'https://x', ...body };
    },
    /** Like Google: fields absent from the body keep their stored value (`stored[eventId]`, if any). */
    async patchEvent(id, eventId, body) {
      calls.push(['patchEvent', id, eventId, body]);
      const prev = (api.stored && api.stored[eventId]) || {};
      const next = { ...prev, id: eventId, ...body };
      const time = (t) => (t.date ? { date: t.date } : { dateTime: t.dateTime });
      next.start = time(next.start);
      next.end = time(next.end);
      if (api.stored) api.stored[eventId] = next;
      return next;
    },
    async deleteEvent(id, eventId) {
      calls.push(['deleteEvent', id, eventId]);
    },
  };
  return api;
}

const RAW_CALENDARS = [
  { id: HOLIDAY_ID, summary: '日本の祝日', accessRole: 'reader', backgroundColor: '#16a765' },
  { id: 'work@group.calendar.google.com', summary: '仕事', accessRole: 'writer', backgroundColor: '#ffad46', selected: true },
  { id: 'hidden@group.calendar.google.com', summary: '隠し', accessRole: 'owner', hidden: true },
  { id: 'gone@group.calendar.google.com', summary: '削除', accessRole: 'owner', deleted: true },
  { id: 'me@example.com', summary: 'me@example.com', accessRole: 'owner', primary: true, backgroundColor: '#9fc6e7', selected: true },
  { id: 'friend@example.com', summary: 'アキ', accessRole: 'reader', backgroundColor: '#cd74e6' },
];

const quiet = { warn() {} };

test('createGoogleCalendarSource validates its api', () => {
  assert.throws(() => createGoogleCalendarSource({}), TypeError);
  assert.equal(createGoogleCalendarSource(fakeCalendarApi()).kind, 'google');
});

test('google listCalendars: hidden/deleted removed, primary first, holiday last', async () => {
  const src = createGoogleCalendarSource(fakeCalendarApi({ calendars: RAW_CALENDARS }), { logger: quiet });
  const cals = await src.listCalendars();
  assert.deepEqual(cals.map((c) => c.id), ['me@example.com', 'friend@example.com', 'work@group.calendar.google.com', HOLIDAY_ID]);
  assert.equal(cals[0].primary, true);
  assert.equal(cals.at(-1).holiday, true);
  assert.equal(cals.find((c) => c.id === 'friend@example.com').writable, false);
});

test('google listCalendars without calendarlist scope → only primary with default color', async () => {
  const api = fakeCalendarApi({ fail: { listCalendars: new ApiError({ status: 403, reason: 'insufficientPermissions' }) } });
  const src = createGoogleCalendarSource(api, { logger: quiet });
  const cals = await src.listCalendars();
  assert.equal(cals.length, 1);
  assert.equal(cals[0].id, 'primary');
  assert.equal(cals[0].primary, true);
  assert.equal(cals[0].writable, true);
  assert.equal(cals[0].color, DEFAULT_CALENDAR_COLOR);
  // other errors propagate
  const net = createGoogleCalendarSource(fakeCalendarApi({ fail: { listCalendars: new ApiError(0, 'network') } }), { logger: quiet });
  await assert.rejects(net.listCalendars(), (e) => e.status === 0);
});

test('google listEvents: per-calendar fan-out, holiday skipped, merged and sorted', jstOnly, async () => {
  const api = fakeCalendarApi({
    calendars: RAW_CALENDARS,
    events: {
      'me@example.com': [
        { id: 'm2', summary: 'ランチ', start: { dateTime: '2026-10-05T12:00:00+09:00' }, end: { dateTime: '2026-10-05T13:00:00+09:00' } },
        { id: 'm1', summary: '朝会', start: { dateTime: '2026-10-05T09:00:00+09:00' }, end: { dateTime: '2026-10-05T09:30:00+09:00' } },
        { id: 'cx', status: 'cancelled' },
      ],
      'work@group.calendar.google.com': [
        { id: 'w1', summary: '締切', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
        { id: 'w2', summary: '長い会議', start: { dateTime: '2026-10-05T09:00:00+09:00' }, end: { dateTime: '2026-10-05T11:00:00+09:00' }, colorId: '9' },
      ],
      'friend@example.com': [
        { id: 'f1', summary: '友達', start: { dateTime: '2026-10-05T09:00:00+09:00' }, end: { dateTime: '2026-10-05T10:00:00+09:00' } },
      ],
    },
  });
  const src = createGoogleCalendarSource(api, { logger: quiet });
  await src.listCalendars();
  const events = await src.listEvents(['me@example.com', 'work@group.calendar.google.com', HOLIDAY_ID, 'friend@example.com', 'me@example.com'], d(2026, 10, 4), d(2026, 10, 11));

  const listCalls = api.calls.filter((c) => c[0] === 'listEvents');
  assert.deepEqual(listCalls.map((c) => c[1]), ['me@example.com', 'work@group.calendar.google.com', 'friend@example.com']);
  assert.equal(listCalls[0][2], '2026-10-04T00:00:00+09:00');
  assert.equal(listCalls[0][3], '2026-10-11T00:00:00+09:00');

  assert.deepEqual(events.map((e) => e.id), ['w1', 'w2', 'f1', 'm1', 'm2']);
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));
  assert.equal(byId.w1.allDay, true);
  assert.equal(byId.w1.calendarId, 'work@group.calendar.google.com');
  assert.equal(byId.w1.color, '#ffad46');
  assert.equal(byId.w2.color, EVENT_COLORS[9]);
  assert.equal(byId.f1.editable, false); // reader calendar
  assert.equal(byId.m1.editable, true);
  assert.ok(events.every((e) => e.start instanceof Date && e.end instanceof Date));
});

test('google listEvents: one failing calendar is skipped; all failing rethrows the first error', async () => {
  const warnings = [];
  const logger = { warn: (...a) => warnings.push(a.join(' ')) };
  const err1 = new ApiError({ status: 500, reason: 'backendError' });
  const api = fakeCalendarApi({
    calendars: RAW_CALENDARS,
    events: { 'me@example.com': [{ id: 'ok', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } }] },
    fail: { 'work@group.calendar.google.com': err1 },
  });
  const src = createGoogleCalendarSource(api, { logger });
  const events = await src.listEvents(['me@example.com', 'work@group.calendar.google.com'], d(2026, 10, 4), d(2026, 10, 11));
  assert.deepEqual(events.map((e) => e.id), ['ok']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /仕事/);

  const authErr = new AuthRequiredError();
  const all = fakeCalendarApi({ calendars: RAW_CALENDARS, fail: { 'me@example.com': authErr, 'work@group.calendar.google.com': err1 } });
  const src2 = createGoogleCalendarSource(all, { logger: quiet });
  await assert.rejects(src2.listEvents(['me@example.com', 'work@group.calendar.google.com'], d(2026, 10, 4), d(2026, 10, 11)), (e) => e === authErr);
});

test('google listEvents: a partial result tells which calendars failed (so the caller keeps their events)', async () => {
  const err = new ApiError({ status: 0, reason: 'network' });
  const api = fakeCalendarApi({
    calendars: RAW_CALENDARS,
    events: { 'me@example.com': [{ id: 'ok', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } }] },
    fail: { 'work@group.calendar.google.com': err },
  });
  const src = createGoogleCalendarSource(api, { logger: quiet });
  const events = await src.listEvents(['me@example.com', 'work@group.calendar.google.com'], d(2026, 10, 4), d(2026, 10, 11));
  assert.deepEqual(events.failedCalendarIds, ['work@group.calendar.google.com']);
  assert.equal(events.firstError, err);
  assert.deepEqual(Object.keys(events), ['0'], 'extra info is non-enumerable: still a plain list');
  assert.ok(Array.isArray(events));

  const complete = await src.listEvents(['me@example.com'], d(2026, 10, 4), d(2026, 10, 11));
  assert.deepEqual(complete.failedCalendarIds, []);
  assert.equal(complete.firstError, null);
  assert.deepEqual((await src.listEvents([], d(2026, 10, 4), d(2026, 10, 11))).failedCalendarIds, []);
});

test('google listEvents: one calendar failing for lack of authorization fails the whole load (reconnect)', async () => {
  const authErr = new AuthRequiredError();
  const api = fakeCalendarApi({
    calendars: RAW_CALENDARS,
    events: { 'me@example.com': [{ id: 'ok', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } }] },
    fail: { 'work@group.calendar.google.com': authErr },
  });
  const src = createGoogleCalendarSource(api, { logger: quiet });
  await assert.rejects(src.listEvents(['me@example.com', 'work@group.calendar.google.com'], d(2026, 10, 4), d(2026, 10, 11)), (e) => e === authErr);
});

test('google listEvents loads the calendar list lazily (once) and handles edge ranges', async () => {
  const api = fakeCalendarApi({ calendars: RAW_CALENDARS });
  const src = createGoogleCalendarSource(api, { logger: quiet });
  assert.deepEqual(await src.listEvents([], d(2026, 10, 4), d(2026, 10, 5)), []);
  assert.deepEqual(await src.listEvents([HOLIDAY_ID], d(2026, 10, 4), d(2026, 10, 5)), []);
  assert.deepEqual(await src.listEvents(['me@example.com'], d(2026, 10, 5), d(2026, 10, 4)), []);
  assert.equal(api.calls.length, 0); // nothing to fetch → no requests at all
  await src.listEvents(['me@example.com'], d(2026, 10, 4), d(2026, 10, 5));
  await src.listEvents(['me@example.com'], d(2026, 10, 4), d(2026, 10, 5));
  assert.equal(api.calls.filter((c) => c[0] === 'listCalendars').length, 1);
  assert.equal(api.calls.filter((c) => c[0] === 'listEvents').length, 2);
  await assert.rejects(src.listEvents(['me@example.com'], 'x', d(2026, 10, 4)), TypeError);
  // null → every known non-holiday calendar
  const before = api.calls.length;
  await src.listEvents(null, d(2026, 10, 4), d(2026, 10, 5));
  assert.deepEqual(api.calls.slice(before).filter((c) => c[0] === 'listEvents').map((c) => c[1]).sort(),
    ['friend@example.com', 'me@example.com', 'work@group.calendar.google.com']);
});

test('google listEvents still works when the calendar list cannot be loaded', async () => {
  const api = fakeCalendarApi({
    fail: { listCalendars: new ApiError(500, 'backendError') },
    events: { primary: [{ id: 'p', start: { dateTime: '2026-10-05T09:00:00+09:00' }, end: { dateTime: '2026-10-05T10:00:00+09:00' } }] },
  });
  const src = createGoogleCalendarSource(api, { logger: quiet });
  const events = await src.listEvents(['primary'], d(2026, 10, 4), d(2026, 10, 11));
  assert.equal(events.length, 1);
  assert.equal(events[0].calendarId, 'primary');
  assert.equal(events[0].color, DEFAULT_CALENDAR_COLOR);
});

test('google createEvent / updateEvent / deleteEvent', async () => {
  const api = fakeCalendarApi({ calendars: RAW_CALENDARS });
  const src = createGoogleCalendarSource(api, { logger: quiet });
  const input = { title: '会議', description: 'd', location: 'l', allDay: false, start: d(2026, 10, 5, 9), end: d(2026, 10, 5, 10) };
  const created = await src.createEvent('work@group.calendar.google.com', input);
  const insert = api.calls.find((c) => c[0] === 'insertEvent');
  assert.equal(insert[1], 'work@group.calendar.google.com');
  const { id: sentId, ...sentBody } = insert[2];
  assert.deepEqual(sentBody, toApiEventBody(input));
  assert.match(sentId, /^[a-v0-9]{32}$/, 'always sent with a client id (idempotent insert)');
  assert.equal(created.id, sentId);
  assert.equal(created.title, '会議');
  assert.equal(created.calendarId, 'work@group.calendar.google.com');
  assert.equal(created.color, '#ffad46');
  assert.equal(created.editable, true);
  assert.deepEqual(created.start, d(2026, 10, 5, 9));

  const updated = await src.updateEvent('work@group.calendar.google.com', 'ev1', { ...input, allDay: true, start: d(2026, 10, 6), end: d(2026, 10, 7) });
  const patch = api.calls.find((c) => c[0] === 'patchEvent');
  assert.equal(patch[2], 'ev1');
  assert.deepEqual(patch[3].start, { date: '2026-10-06', dateTime: null, timeZone: null });
  assert.equal(updated.allDay, true);
  assert.deepEqual(updated.end, d(2026, 10, 7));

  await src.deleteEvent('work@group.calendar.google.com', 'ev1');
  assert.deepEqual(api.calls.at(-1), ['deleteEvent', 'work@group.calendar.google.com', 'ev1']);

  await assert.rejects(src.createEvent('', input), TypeError);
  await assert.rejects(src.updateEvent('x', '', input), TypeError);
  await assert.rejects(src.createEvent('x', { title: 'bad', start: d(2026, 10, 5, 10), end: d(2026, 10, 5, 9) }), RangeError);
});

test('google createEvent: the same id on a retried save (idempotent); invalid ids replaced', async () => {
  const api = fakeCalendarApi({ calendars: RAW_CALENDARS });
  const src = createGoogleCalendarSource(api, { logger: quiet });
  const input = { title: '会議', allDay: false, start: d(2026, 10, 5, 9), end: d(2026, 10, 5, 10) };
  const id = newEventId();
  assert.match(id, /^[a-v0-9]{32}$/);
  await src.createEvent('me@example.com', input, { id });
  await src.createEvent('me@example.com', input, { id });
  const inserts = api.calls.filter((c) => c[0] === 'insertEvent');
  assert.equal(inserts[0][2].id, id);
  assert.equal(inserts[1][2].id, id);
  await src.createEvent('me@example.com', input, { id: 'NOT VALID' });
  await src.createEvent('me@example.com', input, null);
  const more = api.calls.filter((c) => c[0] === 'insertEvent').slice(2);
  for (const c of more) assert.match(c[2].id, /^[a-v0-9]{32}$/);
  assert.notEqual(more[0][2].id, more[1][2].id);
});

/** A cached CalEvent as main.js holds it, plus the raw event "on Google" for the fake patch. */
async function editableEvent(raw) {
  const api = fakeCalendarApi({ calendars: RAW_CALENDARS });
  api.stored = { [raw.id]: { ...raw } };
  const src = createGoogleCalendarSource(api, { logger: quiet });
  await src.listCalendars();
  const original = normalizeEvent(raw, normalizeCalendar(RAW_CALENDARS[4]));
  return { api, src, original, patches: () => api.calls.filter((c) => c[0] === 'patchEvent') };
}

const eventInput = (ev) => ({
  title: ev.title, description: ev.description, location: ev.location, allDay: ev.allDay, start: ev.start, end: ev.end,
});

test('google updateEvent with the original: only changed fields are sent (concurrent edits elsewhere survive)', jstOnly, async () => {
  const raw = {
    id: 'ev1', summary: '夕食', description: 'メモ', location: '',
    start: { dateTime: '2026-10-05T18:00:00+09:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-05T19:00:00+09:00', timeZone: 'America/New_York' },
  };
  const { api, src, original, patches } = await editableEvent(raw);
  // Meanwhile a family member adds a place on their phone.
  api.stored.ev1.location = '駅前のレストラン';
  // On the iPad (stale copy) the user changes only the time.
  const input = { ...eventInput(original), start: d(2026, 10, 5, 19), end: d(2026, 10, 5, 20) };
  const updated = await src.updateEvent('me@example.com', 'ev1', input, original);
  const [, , , body] = patches()[0];
  assert.deepEqual(Object.keys(body).sort(), ['end', 'start']);
  assert.deepEqual(body.start, { dateTime: '2026-10-05T19:00:00+09:00', timeZone: TZ, date: null });
  assert.equal(updated.location, '駅前のレストラン', 'the other edit is not overwritten');
  assert.deepEqual(updated.start, d(2026, 10, 5, 19));

  // Title only → only summary (the time zone of the event stays as it is).
  await src.updateEvent('me@example.com', 'ev1', { ...eventInput(original), title: '家族で夕食' }, original);
  assert.deepEqual(patches()[1][3], { summary: '家族で夕食' });
  // Memo + place
  await src.updateEvent('me@example.com', 'ev1', { ...eventInput(original), description: '予約済み', location: '新宿' }, original);
  assert.deepEqual(patches()[2][3], { description: '予約済み', location: '新宿' });
  // all-day switch sends both ends with explicit nulls
  await src.updateEvent('me@example.com', 'ev1', { ...eventInput(original), allDay: true, start: d(2026, 10, 5), end: d(2026, 10, 6) }, original);
  assert.deepEqual(patches()[3][3], {
    start: { date: '2026-10-05', dateTime: null, timeZone: null },
    end: { date: '2026-10-06', dateTime: null, timeZone: null },
  });
});

test('google updateEvent: nothing changed → no request; untitled stays untitled; trailing whitespace ignored', async () => {
  const raw = {
    id: 'ev2', description: '1行目\r\n2行目  \n',
    start: { date: '2026-10-05' }, end: { date: '2026-10-07' },
  };
  const { src, original, patches } = await editableEvent(raw);
  assert.equal(original.title, UNTITLED);
  // The dialog round-trips CRLF → LF and strips trailing whitespace.
  const input = { ...eventInput(original), description: '1行目\n2行目' };
  const same = await src.updateEvent('me@example.com', 'ev2', input, original);
  assert.equal(patches().length, 0);
  assert.deepEqual(same, original);
  assert.notEqual(same, original, 'a copy');
  // Only the end changes: the literal '(タイトルなし)' is never written as the title.
  await src.updateEvent('me@example.com', 'ev2', { ...input, end: d(2026, 10, 8) }, original);
  assert.deepEqual(Object.keys(patches()[0][3]).sort(), ['end', 'start']);
});

test('google updateEvent: without a matching original every field is sent (draft restore)', async () => {
  const raw = { id: 'ev3', summary: 'x', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } };
  const { src, original, patches } = await editableEvent(raw);
  const input = eventInput(original);
  await src.updateEvent('me@example.com', 'ev3', input);
  await src.updateEvent('me@example.com', 'ev3', input, { ...original, id: 'other' });
  await src.updateEvent('me@example.com', 'ev3', input, { ...original, start: 'garbage' });
  for (const [, , , body] of patches()) assert.deepEqual(Object.keys(body).sort(), ['description', 'end', 'location', 'start', 'summary']);
  assert.equal(patches().length, 3);
  // invalid input is still rejected even when an original is given
  await assert.rejects(src.updateEvent('me@example.com', 'ev3', { ...input, allDay: false, start: d(2026, 10, 5, 10), end: d(2026, 10, 5, 9) }, original), RangeError);
});

// ---------------- Demo source ----------------

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

const NOW = d(2026, 10, 7, 10); // Wednesday; the week starts Sunday 2026-10-04
const WEEK = [d(2026, 10, 4), d(2026, 10, 11)];

test('demo calendars', async () => {
  const src = createDemoCalendarSource({ storage: memoryStorage(), now: () => NOW.getTime() });
  assert.equal(src.kind, 'demo');
  const cals = await src.listCalendars();
  assert.deepEqual(cals.map((c) => [c.name, c.writable, c.primary]), [
    ['マイカレンダー', true, true], ['仕事', true, false], ['家族', false, false],
  ]);
  for (const c of cals) {
    assert.match(c.color, /^#[0-9a-f]{6}$/);
    assert.equal(c.textColor, readableTextColor(c.color));
    assert.equal(c.holiday, false);
    assert.equal(c.selected, true);
  }
});

test('demo seed: deterministic sample week with timed, all-day, 2-day and overlapping events', async () => {
  const a = createDemoCalendarSource({ storage: memoryStorage(), now: () => NOW.getTime() });
  const b = createDemoCalendarSource({ storage: null, now: NOW });
  const ids = (await a.listCalendars()).map((c) => c.id);
  const evA = await a.listEvents(ids, ...WEEK);
  const evB = await b.listEvents(ids, ...WEEK);
  assert.deepEqual(evA, evB);
  assert.ok(evA.length >= 8);

  const timed = evA.filter((e) => !e.allDay);
  const allDay = evA.filter((e) => e.allDay);
  assert.ok(timed.length >= 5);
  assert.ok(allDay.some((e) => (e.end - e.start) === 86400000), 'a one-day all-day event');
  assert.ok(allDay.some((e) => Math.round((e.end - e.start) / 86400000) === 2), 'a two-day all-day event');
  assert.ok(allDay.every((e) => e.start.getHours() === 0 && e.end.getHours() === 0));
  const overlapping = timed.some((x) => timed.some((y) => x !== y && x.start < y.end && y.start < x.end));
  assert.ok(overlapping, 'overlapping timed events');
  assert.ok(evA.some((e) => e.recurring));
  assert.ok(evA.some((e) => !e.editable && e.calendarId === 'demo-family'));
  assert.ok(evA.every((e) => e.start >= WEEK[0] && e.start < WEEK[1]));
  assert.ok(evA.some((e) => e.start.getDate() === 7), 'something today');
  for (const e of evA) {
    assert.equal(typeof e.title, 'string');
    assert.ok(e.title.length > 0);
    assert.equal(e.htmlLink, '');
  }
  // sorted
  for (let i = 1; i < evA.length; i++) assert.ok(evA[i - 1].start <= evA[i].start);
  // other weeks have a few events too (weekly meeting)
  const next = await a.listEvents(ids, d(2026, 10, 11), d(2026, 10, 18));
  assert.ok(next.some((e) => e.title === '週次定例'));
});

test('demo seed is persisted and reloaded as-is', async () => {
  const storage = memoryStorage();
  const a = createDemoCalendarSource({ storage, now: () => NOW.getTime() });
  const stored = JSON.parse(storage.getItem(DEMO_STORAGE_KEY));
  assert.equal(stored.v, 1);
  assert.ok(Array.isArray(stored.events));
  const allDay = stored.events.find((e) => e.allDay);
  assert.match(allDay.start, /^\d{4}-\d{2}-\d{2}$/);

  const later = createDemoCalendarSource({ storage, now: () => d(2027, 1, 1).getTime() });
  const ids = ['demo-main', 'demo-work', 'demo-family'];
  assert.deepEqual(await later.listEvents(ids, ...WEEK), await a.listEvents(ids, ...WEEK));
});

test('demo CRUD persists to storage', async () => {
  const storage = memoryStorage();
  const src = createDemoCalendarSource({ storage, now: NOW });
  const created = await src.createEvent('demo-work', { title: ' 新しい予定 ', description: 'メモ', location: '', allDay: false, start: d(2026, 10, 8, 14), end: d(2026, 10, 8, 15) });
  assert.match(created.id, /^demo-/);
  assert.equal(created.title, '新しい予定');
  assert.equal(created.calendarId, 'demo-work');
  assert.equal(created.editable, true);
  assert.equal(created.recurring, false);

  // a fresh instance on the same storage sees it
  const again = createDemoCalendarSource({ storage, now: NOW });
  let found = (await again.listEvents(['demo-work'], ...WEEK)).find((e) => e.id === created.id);
  assert.deepEqual(found, created);

  const updated = await again.updateEvent('demo-work', created.id, { title: '', allDay: true, start: d(2026, 10, 9), end: d(2026, 10, 10) });
  assert.equal(updated.title, UNTITLED);
  assert.equal(updated.allDay, true);
  const third = createDemoCalendarSource({ storage, now: NOW });
  found = (await third.listEvents(['demo-work'], ...WEEK)).find((e) => e.id === created.id);
  assert.deepEqual(found.start, d(2026, 10, 9));
  assert.deepEqual(found.end, d(2026, 10, 10));

  await third.deleteEvent('demo-work', created.id);
  await third.deleteEvent('demo-work', created.id); // already gone → fine
  const fourth = createDemoCalendarSource({ storage, now: NOW });
  assert.equal((await fourth.listEvents(['demo-work'], ...WEEK)).some((e) => e.id === created.id), false);
});

test('demo createEvent with an id is idempotent like Google', async () => {
  const src = createDemoCalendarSource({ storage: memoryStorage(), now: NOW });
  const input = { title: '同じ', allDay: false, start: d(2026, 10, 8, 9), end: d(2026, 10, 8, 10) };
  const id = newEventId();
  const a = await src.createEvent('demo-main', input, { id });
  const b = await src.createEvent('demo-main', input, { id });
  assert.equal(a.id, b.id);
  assert.equal((await src.listEvents(['demo-main'], ...WEEK)).filter((e) => e.title === '同じ').length, 1);
  const c = await src.createEvent('demo-main', input);
  assert.notEqual(c.id, a.id);
});

test('demo: read-only calendar and missing events are rejected like Google', async () => {
  const src = createDemoCalendarSource({ storage: memoryStorage(), now: NOW });
  const input = { title: 'x', allDay: false, start: d(2026, 10, 8, 9), end: d(2026, 10, 8, 10) };
  await assert.rejects(src.createEvent('demo-family', input), (e) => e instanceof ApiError && e.status === 403 && e.reason === 'requiredAccessLevel');
  const family = (await src.listEvents(['demo-family'], ...WEEK))[0];
  await assert.rejects(src.updateEvent('demo-family', family.id, input), (e) => e.status === 403);
  await assert.rejects(src.deleteEvent('demo-family', family.id), (e) => e.status === 403);
  await assert.rejects(src.createEvent('nope', input), (e) => e.status === 404);
  await assert.rejects(src.updateEvent('demo-main', 'missing', input), (e) => e.status === 404);
  await assert.rejects(src.createEvent('demo-main', { title: 'x', start: d(2026, 10, 8, 10), end: d(2026, 10, 8, 9) }), RangeError);
});

test('demo listEvents filters by calendar and range (all-day end exclusive)', async () => {
  const src = createDemoCalendarSource({ storage: null, now: NOW });
  await src.createEvent('demo-main', { title: 'day', allDay: true, start: d(2026, 10, 20), end: d(2026, 10, 21) });
  assert.equal((await src.listEvents(['demo-main'], d(2026, 10, 20), d(2026, 10, 21))).filter((e) => e.title === 'day').length, 1);
  assert.equal((await src.listEvents(['demo-main'], d(2026, 10, 21), d(2026, 10, 22))).filter((e) => e.title === 'day').length, 0);
  assert.equal((await src.listEvents(['demo-main'], d(2026, 10, 19), d(2026, 10, 20))).filter((e) => e.title === 'day').length, 0);
  assert.equal((await src.listEvents(['demo-work'], d(2026, 10, 20), d(2026, 10, 21))).filter((e) => e.title === 'day').length, 0);
  assert.deepEqual(await src.listEvents('demo-main', d(2026, 10, 21), d(2026, 10, 20)), []);
  await assert.rejects(src.listEvents(['demo-main'], null, d(2026, 10, 20)), TypeError);
});

test('demo returns copies (callers cannot mutate the store)', async () => {
  const src = createDemoCalendarSource({ storage: null, now: NOW });
  const [first] = await src.listEvents(['demo-main', 'demo-work', 'demo-family'], ...WEEK);
  const t = first.start.getTime();
  first.start.setFullYear(1999);
  first.title = 'hacked';
  const [again] = await src.listEvents(['demo-main', 'demo-work', 'demo-family'], ...WEEK);
  assert.equal(again.start.getTime(), t);
  assert.notEqual(again.title, 'hacked');
});

test('demo storage: corrupt data reseeds, failing storage falls back to memory', async () => {
  const corrupt = memoryStorage({ [DEMO_STORAGE_KEY]: '{oops' });
  const src = createDemoCalendarSource({ storage: corrupt, now: NOW });
  assert.ok((await src.listEvents(null, ...WEEK)).length >= 8);
  assert.equal(JSON.parse(corrupt.getItem(DEMO_STORAGE_KEY)).v, 1);

  // malformed records are dropped, valid ones kept; empty list is respected (no reseed)
  const partial = memoryStorage({
    [DEMO_STORAGE_KEY]: JSON.stringify({ v: 1, events: [
      { id: 'ok', calendarId: 'demo-main', title: 'ok', allDay: true, start: '2026-10-05', end: '2026-10-06' },
      { id: 'bad', calendarId: 'demo-main', title: 'bad', allDay: false, start: 'x', end: 'y' },
      { id: 'orphan', calendarId: 'gone', title: 'o', allDay: true, start: '2026-10-05', end: '2026-10-06' },
    ] }),
  });
  const p = createDemoCalendarSource({ storage: partial, now: NOW });
  assert.deepEqual((await p.listEvents(null, ...WEEK)).map((e) => e.id), ['ok']);
  const empty = memoryStorage({ [DEMO_STORAGE_KEY]: JSON.stringify({ v: 1, events: [] }) });
  assert.deepEqual(await createDemoCalendarSource({ storage: empty, now: NOW }).listEvents(null, ...WEEK), []);

  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const m = createDemoCalendarSource({ storage: throwing, now: NOW });
    const ev = await m.createEvent('demo-main', { title: 'mem', allDay: false, start: d(2026, 10, 5, 9), end: d(2026, 10, 5, 10) });
    assert.ok((await m.listEvents(['demo-main'], ...WEEK)).some((e) => e.id === ev.id));
  } finally {
    console.warn = warn;
  }
});

test('demo now may be a function, Date or number; garbage falls back to the clock', async () => {
  const ids = ['demo-main', 'demo-work', 'demo-family'];
  const fromFn = await createDemoCalendarSource({ now: () => NOW.getTime() }).listEvents(ids, ...WEEK);
  const fromDate = await createDemoCalendarSource({ now: NOW }).listEvents(ids, ...WEEK);
  const fromNum = await createDemoCalendarSource({ now: NOW.getTime() }).listEvents(ids, ...WEEK);
  assert.deepEqual(fromFn, fromDate);
  assert.deepEqual(fromFn, fromNum);
  assert.doesNotThrow(() => createDemoCalendarSource({ now: 'garbage' }));
  assert.doesNotThrow(() => createDemoCalendarSource());
});
