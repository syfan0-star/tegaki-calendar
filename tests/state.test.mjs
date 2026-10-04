import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_KEY,
  ROUTE_AT_KEY,
  SEEN_CALENDARS_KEY,
  ROUTE_RESTORE_MS,
  DEFAULT_SETTINGS,
  defaultSettings,
  sanitizeSettings,
  loadSettings,
  saveSettings,
  loadRouteAt,
  saveRouteAt,
  loadSeenCalendarIds,
  saveSeenCalendarIds,
  createStore,
  createSettingsStore,
  resolveInitialRoute,
  reconcileCalendarVisibility,
  isValidYMD,
  INK_DB_NAMES,
  inkDbName,
  decideInkAccount,
  REAUTH_IDLE_MS,
  reauthIdleMs,
  silentReauthReady,
  shouldRedirectBeforeUi,
  returnScrollRatio,
  DRAFT_MAX_AGE_MS,
  normalizeEventInput,
  encodeDraft,
  parseDraft,
  encodeEventsEntry,
  decodeEventsEntry,
  touchLru,
  offlineBannerText,
  UPDATE_REOFFER_MS,
  shouldOfferUpdate,
} from '../js/state.js';

/** localStorage-like fake. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** Storage whose every access throws (Safari private mode / blocked storage). */
const throwingStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
};

const NOW = new Date(2026, 9, 4, 10, 30).getTime(); // 2026-10-04 10:30 local (Asia/Tokyo in tests)

function quietWarn(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = orig;
  }
}

// ---------------------------------------------------------------- defaults & validation

test('defaultSettings matches SPEC §2 and fills date with today', () => {
  const s = defaultSettings({ now: NOW });
  assert.deepEqual({ ...s, hiddenCalendarIds: [...s.hiddenCalendarIds] }, {
    weekStart: 1, allowFinger: false, eraseInkAfterConvert: true, hiddenCalendarIds: [],
    defaultCalendarId: null, demo: false, tool: 'pen', penColor: '#1f2937', penSize: 'medium',
    hlColor: '#fde047', view: 'week', date: '2026-10-04',
  });
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.hiddenCalendarIds));
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
});

test('sanitizeSettings drops unknown keys and replaces invalid values with the fallback', () => {
  const fallback = defaultSettings({ now: NOW });
  const s = sanitizeSettings({
    weekStart: 1,
    allowFinger: 'yes',          // wrong type
    eraseInkAfterConvert: false,
    hiddenCalendarIds: ['a', '', 'b', 'a', 42, null, '  '],
    defaultCalendarId: 7,        // wrong type
    demo: true,
    tool: 'spray',               // unknown tool
    penColor: '#2563EB',         // normalized to lowercase
    penSize: 'huge',
    hlColor: 'yellow',
    view: 'month',
    date: '2026-02-30',          // impossible date
    secret: 'drop me',
    __proto__: { polluted: true },
  }, fallback);
  assert.equal(s.weekStart, 1);
  assert.equal(s.allowFinger, false);
  assert.equal(s.eraseInkAfterConvert, false);
  assert.deepEqual([...s.hiddenCalendarIds], ['a', 'b']);
  assert.equal(s.defaultCalendarId, null);
  assert.equal(s.demo, true);
  assert.equal(s.tool, 'pen');
  assert.equal(s.penColor, '#2563eb');
  assert.equal(s.penSize, 'medium');
  assert.equal(s.hlColor, '#fde047');
  assert.equal(s.view, 'month');
  assert.equal(s.date, '2026-10-04');
  assert.equal('secret' in s, false);
  assert.equal(s.polluted, undefined);
});

test('sanitizeSettings: weekStart is fixed to Monday (1), all tools and sizes accepted', () => {
  // Saved Sunday starts (0) from older versions and any garbage are upgraded to Monday.
  for (const v of [0, 1, '1', 2, -1, 0.5, null, true, undefined]) {
    assert.equal(sanitizeSettings({ weekStart: v }).weekStart, 1, String(v));
  }
  assert.equal(sanitizeSettings({}).weekStart, 1);
  for (const tool of ['pen', 'highlighter', 'eraser', 'lasso', 'event']) {
    assert.equal(sanitizeSettings({ tool }).tool, tool);
  }
  for (const penSize of ['thin', 'medium', 'thick']) {
    assert.equal(sanitizeSettings({ penSize }).penSize, penSize);
  }
  assert.equal(sanitizeSettings({ defaultCalendarId: 'me@example.com' }).defaultCalendarId, 'me@example.com');
  assert.equal(sanitizeSettings({ defaultCalendarId: '' }).defaultCalendarId, null);
});

test('sanitizeSettings tolerates garbage input', () => {
  for (const raw of [null, undefined, 42, 'str', [], [1, 2]]) {
    const s = sanitizeSettings(raw);
    assert.equal(s.view, 'week');
    assert.ok(isValidYMD(s.date));
  }
});

test('isValidYMD', () => {
  assert.equal(isValidYMD('2026-10-04'), true);
  assert.equal(isValidYMD('2028-02-29'), true);
  assert.equal(isValidYMD('2026-02-29'), false);
  assert.equal(isValidYMD('2026-1-4'), false);
  assert.equal(isValidYMD(' 2026-10-04'), false);
  assert.equal(isValidYMD(20261004), false);
});

// ---------------------------------------------------------------- load / save

test('loadSettings: missing, bad JSON and non-objects give defaults', () => {
  assert.equal(loadSettings(memoryStorage(), { now: NOW }).date, '2026-10-04');
  assert.equal(loadSettings(memoryStorage({ [SETTINGS_KEY]: '{not json' }), { now: NOW }).view, 'week');
  assert.equal(loadSettings(memoryStorage({ [SETTINGS_KEY]: '[1,2]' }), { now: NOW }).tool, 'pen');
  assert.equal(loadSettings(memoryStorage({ [SETTINGS_KEY]: 'null' }), { now: NOW }).demo, false);
  assert.equal(loadSettings(null, { now: NOW }).view, 'week');
  assert.equal(loadSettings(throwingStorage, { now: NOW }).view, 'week');
});

test('saveSettings / loadSettings round trip (validated, unknown keys dropped)', () => {
  const storage = memoryStorage();
  const ok = saveSettings(storage, { ...defaultSettings({ now: NOW }), view: 'day', date: '2026-12-31', extra: 1 });
  assert.equal(ok, true);
  const json = JSON.parse(storage.map.get(SETTINGS_KEY));
  assert.equal(json.view, 'day');
  assert.equal('extra' in json, false);
  const back = loadSettings(storage, { now: NOW });
  assert.equal(back.view, 'day');
  assert.equal(back.date, '2026-12-31');
});

test('saveSettings returns false (never throws) when storage fails', () => {
  quietWarn(() => {
    assert.equal(saveSettings(throwingStorage, defaultSettings()), false);
    assert.equal(saveSettings(null, defaultSettings()), false);
  });
});

test('route timestamp and seen calendar ids helpers', () => {
  const storage = memoryStorage();
  assert.equal(loadRouteAt(storage), null);
  saveRouteAt(storage, NOW);
  assert.equal(loadRouteAt(storage), NOW);
  storage.map.set(ROUTE_AT_KEY, 'garbage');
  assert.equal(loadRouteAt(storage), null);

  assert.deepEqual(loadSeenCalendarIds(storage), []);
  saveSeenCalendarIds(storage, ['a', 'a', '', 'b']);
  assert.deepEqual(loadSeenCalendarIds(storage), ['a', 'b']);
  storage.map.set(SEEN_CALENDARS_KEY, '{oops');
  assert.deepEqual(loadSeenCalendarIds(storage), []);
  assert.deepEqual(loadSeenCalendarIds(throwingStorage), []);
});

// ---------------------------------------------------------------- store

test('createStore: get / set / subscribe / unsubscribe', () => {
  const store = createStore({ a: 1, b: 'x' });
  assert.deepEqual(store.get(), { a: 1, b: 'x' });
  assert.ok(Object.isFrozen(store.get()));

  const calls = [];
  const unsubscribe = store.subscribe((state, prev, changed) => calls.push({ state, prev, changed }));
  store.set({ a: 2 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].state, { a: 2, b: 'x' });
  assert.deepEqual(calls[0].prev, { a: 1, b: 'x' });
  assert.deepEqual(calls[0].changed, ['a']);

  store.set({ a: 2 }); // no change → no notification
  store.set(null);     // ignored
  store.set('nope');   // ignored
  assert.equal(calls.length, 1);

  unsubscribe();
  store.set({ b: 'y' });
  assert.equal(calls.length, 1);
  assert.equal(store.get().b, 'y');
});

test('createStore: a throwing subscriber does not break the others', () => {
  const store = createStore({ n: 0 });
  let seen = 0;
  store.subscribe(() => { throw new Error('boom'); });
  store.subscribe((s) => { seen = s.n; });
  quietWarn(() => store.set({ n: 5 }));
  assert.equal(seen, 5);
});

test('createStore: arrays are compared by content', () => {
  const store = createStore({ ids: ['a'] });
  let count = 0;
  store.subscribe(() => { count++; });
  store.set({ ids: ['a'] });
  assert.equal(count, 0);
  store.set({ ids: ['a', 'b'] });
  assert.equal(count, 1);
});

test('createSettingsStore validates updates, keeps current values for invalid ones, persists', () => {
  const storage = memoryStorage();
  let t = NOW;
  const store = createSettingsStore({ storage, now: () => t });
  assert.equal(store.get().date, '2026-10-04');

  store.set({ penColor: '#DC2626', tool: 'highlighter' });
  assert.equal(store.get().penColor, '#dc2626');
  assert.equal(store.get().tool, 'highlighter');
  assert.equal(JSON.parse(storage.map.get(SETTINGS_KEY)).penColor, '#dc2626');

  store.set({ tool: 'bogus', weekStart: 0 }); // invalid tool → kept; weekStart stays Monday
  assert.equal(store.get().tool, 'highlighter');
  assert.equal(store.get().weekStart, 1);

  assert.equal(storage.map.has(ROUTE_AT_KEY), false);
  t = NOW + 1000;
  store.set({ view: 'month' });
  assert.equal(Number(storage.map.get(ROUTE_AT_KEY)), NOW + 1000);

  const reopened = createSettingsStore({ storage, now: () => t });
  assert.equal(reopened.get().view, 'month');
  assert.equal(reopened.get().tool, 'highlighter');
});

test('createSettingsStore works without storage and with throwing storage', () => {
  const a = createSettingsStore({ storage: null, now: () => NOW });
  a.set({ demo: true });
  assert.equal(a.get().demo, true);
  quietWarn(() => {
    const b = createSettingsStore({ storage: throwingStorage, now: () => NOW });
    b.set({ allowFinger: true });
    assert.equal(b.get().allowFinger, true);
  });
});

// ---------------------------------------------------------------- route

test('resolveInitialRoute: OAuth returnState wins', () => {
  const r = resolveInitialRoute({
    returnState: { view: 'day', date: '2026-11-03' },
    settings: { view: 'month', date: '2026-01-01' },
    lastRouteAt: null,
    now: NOW,
  });
  assert.equal(r.view, 'day');
  assert.equal(r.date.getTime(), new Date(2026, 10, 3).getTime());
});

test('resolveInitialRoute: recent stored route is restored, stale one opens today (same view)', () => {
  const settings = { view: 'day', date: '2026-09-01' };
  const recent = resolveInitialRoute({ settings, lastRouteAt: NOW - 60 * 1000, now: NOW });
  assert.equal(recent.view, 'day');
  assert.equal(recent.date.getTime(), new Date(2026, 8, 1).getTime());

  const stale = resolveInitialRoute({ settings, lastRouteAt: NOW - ROUTE_RESTORE_MS - 1, now: NOW });
  assert.equal(stale.view, 'day');
  assert.equal(stale.date.getTime(), new Date(2026, 9, 4).getTime());

  const unknown = resolveInitialRoute({ settings, lastRouteAt: null, now: NOW });
  assert.equal(unknown.date.getTime(), new Date(2026, 9, 4).getTime());

  const future = resolveInitialRoute({ settings, lastRouteAt: NOW + 10 * ROUTE_RESTORE_MS, now: NOW });
  assert.equal(future.date.getTime(), new Date(2026, 9, 4).getTime());
});

test('resolveInitialRoute: garbage falls back to week / today', () => {
  const r = resolveInitialRoute({ returnState: { view: 'year', date: 'x' }, settings: { view: 7 }, now: NOW });
  assert.equal(r.view, 'week');
  assert.equal(r.date.getTime(), new Date(2026, 9, 4).getTime());
  const r2 = resolveInitialRoute();
  assert.equal(r2.view, 'week');
  assert.ok(r2.date instanceof Date);
});

// ---------------------------------------------------------------- calendars

test('reconcileCalendarVisibility hides new unselected calendars once and respects user choices', () => {
  const calendars = [
    { id: 'me@example.com', primary: true, selected: true },
    { id: 'team', primary: false, selected: false },
    { id: 'family', primary: false, selected: true },
    { id: 'odd-primary', primary: true, selected: false },
  ];
  const first = reconcileCalendarVisibility({ calendars, hiddenCalendarIds: [], seenIds: [] });
  assert.equal(first.changed, true);
  assert.deepEqual(first.hiddenCalendarIds, ['team']);
  assert.deepEqual(first.seenIds, ['me@example.com', 'team', 'family', 'odd-primary']);

  // The user shows 'team' again: it is already seen, so it stays visible.
  const second = reconcileCalendarVisibility({ calendars, hiddenCalendarIds: [], seenIds: first.seenIds });
  assert.equal(second.changed, false);
  assert.deepEqual(second.hiddenCalendarIds, []);

  // A new unselected calendar appears later.
  const third = reconcileCalendarVisibility({
    calendars: [...calendars, { id: 'new', selected: false }, null, { id: '' }],
    hiddenCalendarIds: ['family'],
    seenIds: first.seenIds,
  });
  assert.equal(third.changed, true);
  assert.deepEqual(third.hiddenCalendarIds, ['family', 'new']);
});

test('reconcileCalendarVisibility tolerates garbage', () => {
  const r = reconcileCalendarVisibility({ calendars: 'x', hiddenCalendarIds: null, seenIds: 5 });
  assert.deepEqual(r, { hiddenCalendarIds: [], seenIds: [], changed: false });
  assert.deepEqual(reconcileCalendarVisibility(), { hiddenCalendarIds: [], seenIds: [], changed: false });
});

// ---------------------------------------------------------------- local ink: database & account

test('inkDbName: お試しモード has its own database, Google keeps the default one', () => {
  assert.equal(inkDbName('demo'), INK_DB_NAMES.demo);
  assert.equal(inkDbName('google'), 'tegaki-calendar'); // SPEC default (existing Google ink stays put)
  assert.equal(inkDbName('none'), INK_DB_NAMES.google);
  assert.notEqual(INK_DB_NAMES.demo, INK_DB_NAMES.google);
  assert.ok(Object.isFrozen(INK_DB_NAMES));
});

test('decideInkAccount: unknown until the account is known; bind once; mismatch never syncs', () => {
  assert.equal(decideInkAccount({ bound: null, current: null }), 'unknown');
  assert.equal(decideInkAccount({ bound: 'a@example.com', current: null }), 'unknown');
  assert.equal(decideInkAccount({ bound: 'a@example.com', current: '' }), 'unknown');
  assert.equal(decideInkAccount({ bound: null, current: 'a@example.com' }), 'bind');
  assert.equal(decideInkAccount({ bound: '  ', current: 'a@example.com' }), 'bind');
  assert.equal(decideInkAccount({ bound: 'a@example.com', current: 'a@example.com' }), 'match');
  assert.equal(decideInkAccount({ bound: 'A@Example.com', current: 'a@example.com ' }), 'match');
  assert.equal(decideInkAccount({ bound: 'a@example.com', current: 'b@example.com' }), 'mismatch');
  assert.equal(decideInkAccount(), 'unknown');
  assert.equal(decideInkAccount({ bound: 42, current: {} }), 'unknown');
});

// ---------------------------------------------------------------- silent re-auth policy

test('reauthIdleMs: app open goes at once, mid-session expiry waits for a real pause', () => {
  assert.equal(reauthIdleMs('boot'), 0);
  assert.equal(reauthIdleMs('visible'), REAUTH_IDLE_MS.visible);
  assert.ok(REAUTH_IDLE_MS.visible > 0 && REAUTH_IDLE_MS.visible <= 2000);
  assert.ok(reauthIdleMs('retry') >= 4000);
  for (const t of ['api', '401', 'online']) assert.ok(reauthIdleMs(t) >= 60 * 1000, t);
  assert.equal(reauthIdleMs('something-else'), REAUTH_IDLE_MS.api); // unknown → the careful value
});

test('silentReauthReady: never while drawing / dialog / welcome; selection blocks mid-session triggers', () => {
  const base = { quietForMs: 10 * 60 * 1000 };
  assert.equal(silentReauthReady({ ...base, trigger: 'boot' }), true);
  assert.equal(silentReauthReady({ ...base, trigger: 'visible' }), true);
  assert.equal(silentReauthReady({ ...base, trigger: 'api' }), true);
  for (const trigger of ['boot', 'visible', 'retry', 'api', '401', 'online']) {
    assert.equal(silentReauthReady({ ...base, trigger, drawing: true }), false, trigger);
    assert.equal(silentReauthReady({ ...base, trigger, dialogOpen: true }), false, trigger);
    assert.equal(silentReauthReady({ ...base, trigger, welcomeOpen: true }), false, trigger);
  }
  assert.equal(silentReauthReady({ ...base, trigger: 'api', hasSelection: true }), false);
  assert.equal(silentReauthReady({ ...base, trigger: '401', hasSelection: true }), false);
  assert.equal(silentReauthReady({ ...base, trigger: 'visible', hasSelection: true }), true);
});

test('silentReauthReady: a 4 s thinking pause does not reload the page mid-session', () => {
  assert.equal(silentReauthReady({ trigger: 'api', quietForMs: 4500 }), false);
  assert.equal(silentReauthReady({ trigger: 'api', quietForMs: 59 * 1000 }), false);
  assert.equal(silentReauthReady({ trigger: 'api', quietForMs: 61 * 1000 }), true);
  assert.equal(silentReauthReady({ trigger: 'retry', quietForMs: 3000 }), false);
  assert.equal(silentReauthReady({ trigger: 'retry', quietForMs: 4500 }), true);
  assert.equal(silentReauthReady({ trigger: 'visible', quietForMs: 500 }), false); // pen just touched down
  assert.equal(silentReauthReady({ trigger: 'boot', quietForMs: 0 }), true);
  assert.equal(silentReauthReady({ trigger: 'boot', quietForMs: NaN }), true);
  assert.equal(silentReauthReady({ trigger: 'api', quietForMs: NaN }), false);
  assert.equal(silentReauthReady(), false);
});

test('shouldRedirectBeforeUi: only when a silent redirect would follow the first render anyway', () => {
  const ok = {
    mode: 'google', configured: true, redirectStatus: 'none', tokenFresh: false, everSignedIn: true,
    canTrySilent: true, online: true, visible: true, storageWritable: true,
  };
  assert.equal(shouldRedirectBeforeUi(ok), true);
  for (const [k, v] of [
    ['mode', 'demo'], ['mode', 'none'], ['configured', false], ['redirectStatus', 'success'],
    ['redirectStatus', 'error'], ['tokenFresh', true], ['everSignedIn', false], ['canTrySilent', false],
    ['online', false], ['visible', false], ['storageWritable', false],
  ]) {
    assert.equal(shouldRedirectBeforeUi({ ...ok, [k]: v }), false, `${k}=${v}`);
  }
  assert.equal(shouldRedirectBeforeUi(), false);
});

test('returnScrollRatio accepts only a ratio in [0, 1]', () => {
  assert.equal(returnScrollRatio({ view: 'day', date: '2026-10-04', scroll: 0.42 }), 0.42);
  assert.equal(returnScrollRatio({ scroll: 0 }), 0);
  assert.equal(returnScrollRatio({ scroll: 1 }), 1);
  for (const scroll of [-0.1, 1.2, NaN, 'x', null, '', undefined, Infinity]) {
    assert.equal(returnScrollRatio({ scroll }), null, String(scroll));
  }
  assert.equal(returnScrollRatio(null), null);
  assert.equal(returnScrollRatio('0.5'), null);
});

// ---------------------------------------------------------------- drafts

const DRAFT_INPUT = {
  title: '歯医者', description: '', location: '駅前', allDay: false,
  start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 10, 0),
};

test('normalizeEventInput validates dates and strings (Date or ISO input)', () => {
  const a = normalizeEventInput(DRAFT_INPUT);
  assert.equal(a.title, '歯医者');
  assert.equal(a.start.getTime(), DRAFT_INPUT.start.getTime());
  assert.notEqual(a.start, DRAFT_INPUT.start); // a copy
  const b = normalizeEventInput({ ...DRAFT_INPUT, start: DRAFT_INPUT.start.toISOString(), end: DRAFT_INPUT.end.toISOString(), title: 7, allDay: 'yes' });
  assert.equal(b.title, '');
  assert.equal(b.allDay, false);
  assert.equal(b.end.getTime(), DRAFT_INPUT.end.getTime());
  assert.equal(normalizeEventInput({ ...DRAFT_INPUT, end: DRAFT_INPUT.start }), null); // end must be after start
  assert.equal(normalizeEventInput({ ...DRAFT_INPUT, start: 'garbage' }), null);
  assert.equal(normalizeEventInput(null), null);
  assert.equal(normalizeEventInput([]), null);
});

test('encodeDraft / parseDraft round trip; reading does not consume', () => {
  const raw = encodeDraft({ kind: 'create', input: DRAFT_INPUT, calendarId: 'primary', mode: 'google', now: NOW });
  assert.equal(typeof raw, 'string');
  const r = parseDraft(raw, { mode: 'google', now: NOW + 1000 });
  assert.equal(r.status, 'ok');
  assert.equal(r.draft.kind, 'create');
  assert.equal(r.draft.calendarId, 'primary');
  assert.equal(r.draft.input.title, '歯医者');
  assert.equal(r.draft.input.start.getTime(), DRAFT_INPUT.start.getTime());
  assert.equal(r.draft.eventId, null);
  // Same input again: still there (nothing is deleted by reading).
  assert.equal(parseDraft(raw, { mode: 'google', now: NOW + 2000 }).status, 'ok');
  // A create draft keeps the client event id, so restoring it cannot create a duplicate.
  const withId = encodeDraft({ kind: 'create', input: DRAFT_INPUT, calendarId: 'primary', eventId: 'abc0123456789', mode: 'google', now: NOW });
  assert.equal(parseDraft(withId, { mode: 'google', now: NOW }).draft.eventId, 'abc0123456789');

  const upd = encodeDraft({ kind: 'update', input: DRAFT_INPUT, calendarId: 'c1', eventId: 'e1', recurring: true, mode: 'demo', now: NOW });
  const u = parseDraft(upd, { mode: 'demo', now: NOW });
  assert.deepEqual({ kind: u.draft.kind, eventId: u.draft.eventId, recurring: u.draft.recurring }, { kind: 'update', eventId: 'e1', recurring: true });
});

test('parseDraft: other mode is kept, old or corrupt drafts are invalid', () => {
  const raw = encodeDraft({ kind: 'create', input: DRAFT_INPUT, calendarId: 'primary', mode: 'google', now: NOW });
  assert.equal(parseDraft(raw, { mode: 'demo', now: NOW }).status, 'other-mode');
  assert.equal(parseDraft(raw, { mode: 'google', now: NOW + DRAFT_MAX_AGE_MS + 1 }).status, 'invalid');
  assert.equal(parseDraft(raw, { mode: 'google', now: NOW - 60 * 1000 }).status, 'invalid'); // from the future
  assert.equal(parseDraft(null, { mode: 'google' }).status, 'none');
  assert.equal(parseDraft('', { mode: 'google' }).status, 'none');
  assert.equal(parseDraft('{not json', { mode: 'google' }).status, 'invalid');
  assert.equal(parseDraft('[]', { mode: 'google' }).status, 'invalid');
  const noEventId = JSON.stringify({ ...JSON.parse(raw), kind: 'update' });
  assert.equal(parseDraft(noEventId, { mode: 'google', now: NOW }).status, 'invalid');
  assert.equal(encodeDraft({ kind: 'create', input: { ...DRAFT_INPUT, end: DRAFT_INPUT.start }, calendarId: 'x', mode: 'google' }), null);
  assert.equal(encodeDraft({ kind: 'move', input: DRAFT_INPUT, calendarId: 'x', mode: 'google' }), null);
  assert.equal(encodeDraft({ kind: 'create', input: DRAFT_INPUT, calendarId: '', mode: 'google' }), null);
});

// ---------------------------------------------------------------- persisted events

test('encodeEventsEntry / decodeEventsEntry round trip (structured-clone friendly, dates revived)', () => {
  const ev = {
    id: 'e1', calendarId: 'primary', title: '会議', description: '', location: '', allDay: false,
    start: new Date(2026, 9, 5, 9, 0), end: new Date(2026, 9, 5, 10, 0), color: '#039be5', textColor: '#ffffff',
    htmlLink: '', recurring: false, editable: true,
  };
  const enc = encodeEventsEntry({ events: [ev, { id: 'bad', calendarId: 'x', start: 'nope', end: new Date() }], key: 'google|primary', at: NOW });
  assert.equal(enc.events.length, 1);
  assert.equal(typeof enc.events[0].start, 'string');
  const json = JSON.parse(JSON.stringify(enc));
  const dec = decodeEventsEntry(json);
  assert.equal(dec.key, 'google|primary');
  assert.equal(dec.at, NOW);
  assert.equal(dec.events.length, 1);
  assert.ok(dec.events[0].start instanceof Date);
  assert.equal(dec.events[0].start.getTime(), ev.start.getTime());
  assert.equal(dec.events[0].title, '会議');
});

test('decodeEventsEntry tolerates garbage', () => {
  assert.equal(decodeEventsEntry(null), null);
  assert.equal(decodeEventsEntry({}), null);
  assert.equal(decodeEventsEntry({ v: 2, events: [] }), null);
  const d = decodeEventsEntry({ v: 1, key: 3, at: 'x', events: [null, 1, { id: 'a' }, { id: 'b', calendarId: 'c', start: '2026-10-05T10:00:00Z', end: '2026-10-05T09:00:00Z' }] });
  assert.deepEqual(d, { key: '', at: 0, events: [] });
});

test('touchLru moves to the end and evicts the oldest', () => {
  assert.deepEqual(touchLru(['a', 'b', 'c'], 'a', 3), { list: ['b', 'c', 'a'], evicted: [] });
  assert.deepEqual(touchLru(['a', 'b', 'c'], 'd', 3), { list: ['b', 'c', 'd'], evicted: ['a'] });
  assert.deepEqual(touchLru(null, 'x', 2), { list: ['x'], evicted: [] });
  assert.deepEqual(touchLru(['a', 7, '', 'b'], 'c', 2), { list: ['b', 'c'], evicted: ['a'] });
});

test('offlineBannerText names the time (and the date when not today)', () => {
  const now = new Date(2026, 9, 4, 12, 0);
  assert.equal(offlineBannerText(new Date(2026, 9, 4, 9, 5).getTime(), now), 'オフラインです（9:05 時点の予定を表示しています）');
  assert.equal(offlineBannerText(new Date(2026, 9, 3, 21, 30).getTime(), now), 'オフラインです（10月3日 21:30 時点の予定を表示しています）');
  assert.equal(offlineBannerText(0, now), 'オフラインです（接続が戻ると予定を読み込みます）');
  assert.equal(offlineBannerText(null, now), 'オフラインです（接続が戻ると予定を読み込みます）');
});

// ---------------------------------------------------------------- service worker update offer

test('shouldOfferUpdate: a new worker always, the same one again after the interval', () => {
  const w1 = {};
  const w2 = {};
  assert.equal(shouldOfferUpdate({ worker: null }), false);
  assert.equal(shouldOfferUpdate({ worker: w1, now: NOW }), true);
  assert.equal(shouldOfferUpdate({ worker: w1, offeredWorker: w1, offeredAt: NOW, now: NOW + 60 * 1000 }), false);
  assert.equal(shouldOfferUpdate({ worker: w1, offeredWorker: w1, offeredAt: NOW, now: NOW + UPDATE_REOFFER_MS + 1 }), true);
  assert.equal(shouldOfferUpdate({ worker: w2, offeredWorker: w1, offeredAt: NOW, now: NOW + 1 }), true);
});
