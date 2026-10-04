// Tests for the UI modules (F2b): pure helpers first, then the components on a tiny fake DOM.
// Run: TZ=Asia/Tokyo node --test tests/ui-logic.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { h, clear, svgIcon, ICON_NAMES, openModal, isModalOpen, focusableWithin } from '../js/ui/dom.js';
import {
  formFromInput, inputFromForm, applyFieldChange, toggleAllDay, needsEndDate, writableCalendars, pickCalendarId,
  safeHttpUrl, openEventDialog, DIALOG_TEXT,
} from '../js/ui/event-dialog.js';
import { headerTitle, syncIndicatorInfo, authChipInfo, normalizeAuthState, createHeader } from '../js/ui/header.js';
import { normalizePenSize, mergeToolbarState, colorName, createToolbar, TOOLS } from '../js/ui/toolbar.js';
import { placeMenu, toClientRect, createSelectionMenu } from '../js/ui/selection-menu.js';
import {
  setCalendarVisible, defaultCalendarValue, displayableCalendars, accountView, openSettings,
} from '../js/ui/settings.js';
import { toast, showBanner, hideBanner } from '../js/ui/toast.js';
import { PEN_COLORS, HIGHLIGHTER_COLORS } from '../js/ink/render.js';

const d = (y, m, day, hh = 0, mm = 0) => new Date(y, m - 1, day, hh, mm, 0, 0);

// =============================================================================================
// Event dialog: form ↔ EventInput

test('formFromInput: timed event → date + times', () => {
  const f = formFromInput({ title: '会議', location: '本社', description: 'メモ', allDay: false,
    start: d(2026, 10, 4, 9, 0), end: d(2026, 10, 4, 10, 30) });
  assert.deepEqual(f, {
    title: '会議', location: '本社', description: 'メモ', allDay: false,
    startDate: '2026-10-04', endDate: '2026-10-04', startTime: '09:00', endTime: '10:30',
  });
  assert.equal(needsEndDate(f), false);
});

test('formFromInput: all-day exclusive end becomes the inclusive last day', () => {
  const multi = formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 7) });
  assert.equal(multi.startDate, '2026-10-04');
  assert.equal(multi.endDate, '2026-10-06');
  assert.equal(multi.allDay, true);
  // remembered times for toggling back
  assert.equal(multi.startTime, '09:00');
  assert.equal(multi.endTime, '10:00');

  const single = formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 5) });
  assert.equal(single.endDate, '2026-10-04');

  const yearEnd = formFromInput({ allDay: true, start: d(2026, 12, 31), end: d(2027, 1, 1) });
  assert.equal(yearEnd.endDate, '2026-12-31');
});

test('formFromInput: bad all-day ends are repaired', () => {
  // end ≤ start → one day
  assert.equal(formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 4) }).endDate, '2026-10-04');
  assert.equal(formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 1) }).endDate, '2026-10-04');
  // a non-midnight end still covers its own day
  assert.equal(formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 5, 12) }).endDate, '2026-10-05');
  // missing end
  assert.equal(formFromInput({ allDay: true, start: d(2026, 10, 4) }).endDate, '2026-10-04');
});

test('formFromInput: missing/invalid times fall back to the next hour, 1 hour long', () => {
  const now = d(2026, 10, 4, 14, 20);
  const f = formFromInput({ start: new Date(NaN) }, now);
  assert.equal(f.startDate, '2026-10-04');
  assert.equal(f.startTime, '15:00');
  assert.equal(f.endTime, '16:00');
  const g = formFromInput(null, now);
  assert.equal(g.title, '');
  assert.equal(g.startTime, '15:00');
  // end before start → start + 1 h
  const e = formFromInput({ start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 8) });
  assert.equal(e.endTime, '10:00');
  // non-string text fields
  const t = formFromInput({ title: 42, description: null, start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) });
  assert.equal(t.title, '42');
  assert.equal(t.description, '');
});

test('formFromInput: an end at midnight lands on the next date (shown with 終了日)', () => {
  const f = formFromInput({ start: d(2026, 10, 4, 23), end: d(2026, 10, 5, 0) });
  assert.equal(f.endDate, '2026-10-05');
  assert.equal(f.endTime, '00:00');
  assert.equal(needsEndDate(f), true);
});

test('inputFromForm: timed and all-day (inclusive → exclusive) conversion', () => {
  const timed = inputFromForm({ title: '  打合せ ', location: ' 会議室 ', description: '行1\n行2\n\n', allDay: false,
    startDate: '2026-10-04', startTime: '09:15', endDate: '2026-10-04', endTime: '10:45' });
  assert.equal(timed.ok, true);
  assert.equal(timed.input.title, '打合せ');
  assert.equal(timed.input.location, '会議室');
  assert.equal(timed.input.description, '行1\n行2');
  assert.equal(timed.input.allDay, false);
  assert.equal(timed.input.start.getTime(), d(2026, 10, 4, 9, 15).getTime());
  assert.equal(timed.input.end.getTime(), d(2026, 10, 4, 10, 45).getTime());

  const allDay = inputFromForm({ title: '旅行', allDay: true, startDate: '2026-12-30', endDate: '2027-01-02',
    startTime: '09:00', endTime: '10:00' });
  assert.equal(allDay.ok, true);
  assert.equal(allDay.input.allDay, true);
  assert.equal(allDay.input.start.getTime(), d(2026, 12, 30).getTime());
  assert.equal(allDay.input.end.getTime(), d(2027, 1, 3).getTime(), 'exclusive end = last day + 1');
});

test('inputFromForm: validation errors', () => {
  const base = { title: 'x', allDay: false, startDate: '2026-10-04', startTime: '09:00', endDate: '2026-10-04', endTime: '10:00' };
  assert.equal(inputFromForm({ ...base, title: '   ' }).errors.title, DIALOG_TEXT.errTitle);
  assert.equal(inputFromForm({ ...base, endTime: '09:00' }).errors.end, DIALOG_TEXT.errEndBeforeStart);
  assert.equal(inputFromForm({ ...base, endTime: '08:00' }).errors.end, DIALOG_TEXT.errEndBeforeStart);
  assert.equal(inputFromForm({ ...base, startDate: '' }).errors.start, DIALOG_TEXT.errStart);
  assert.equal(inputFromForm({ ...base, startDate: '2026-02-30' }).errors.start, DIALOG_TEXT.errStart);
  assert.equal(inputFromForm({ ...base, startTime: '' }).errors.start, DIALOG_TEXT.errStartTime);
  assert.equal(inputFromForm({ ...base, endDate: 'x' }).errors.end, DIALOG_TEXT.errEnd);
  assert.equal(inputFromForm({ ...base, endTime: '25:00' }).errors.end, DIALOG_TEXT.errEndTime);
  const ad = { ...base, allDay: true, startDate: '2026-10-04', endDate: '2026-10-03' };
  assert.equal(inputFromForm(ad).errors.end, DIALOG_TEXT.errEndDayBeforeStart);
  assert.equal(inputFromForm(ad).ok, false);
  // same-day all-day is fine
  assert.equal(inputFromForm({ ...ad, endDate: '2026-10-04' }).ok, true);
  // garbage
  assert.equal(inputFromForm(null).ok, false);
});

test('form round trip keeps the event (timed, overnight, all-day multi-day)', () => {
  const cases = [
    { title: 'a', description: '', location: '', allDay: false, start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10, 30) },
    { title: 'b', description: '', location: '', allDay: false, start: d(2026, 10, 4, 22), end: d(2026, 10, 5, 2) },
    { title: 'c', description: '', location: '', allDay: true, start: d(2026, 10, 30), end: d(2026, 11, 2) },
  ];
  for (const input of cases) {
    const out = inputFromForm(formFromInput(input));
    assert.equal(out.ok, true);
    assert.equal(out.input.allDay, input.allDay);
    assert.equal(out.input.start.getTime(), input.start.getTime());
    assert.equal(out.input.end.getTime(), input.end.getTime());
  }
});

test('applyFieldChange: moving the start keeps the duration', () => {
  const f = formFromInput({ start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10, 30) });
  const g = applyFieldChange(f, 'startTime', '13:00');
  assert.equal(g.startTime, '13:00');
  assert.equal(g.endTime, '14:30');
  assert.equal(g.endDate, '2026-10-04');

  const moved = applyFieldChange(g, 'startDate', '2026-10-09');
  assert.equal(moved.endDate, '2026-10-09');
  assert.equal(moved.endTime, '14:30');

  // crossing midnight
  const late = applyFieldChange(f, 'startTime', '23:30');
  assert.equal(late.endDate, '2026-10-05');
  assert.equal(late.endTime, '01:00');
  assert.equal(needsEndDate(late), true);

  // overnight event moved by date keeps its end on the following day
  const night = formFromInput({ start: d(2026, 10, 4, 22), end: d(2026, 10, 5, 2) });
  const n2 = applyFieldChange(night, 'startDate', '2026-10-10');
  assert.equal(n2.endDate, '2026-10-11');
  assert.equal(n2.endTime, '02:00');
});

test('applyFieldChange: all-day start keeps the number of days', () => {
  const f = formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 7) }); // 4–6
  const g = applyFieldChange(f, 'startDate', '2026-10-30');
  assert.equal(g.startDate, '2026-10-30');
  assert.equal(g.endDate, '2026-11-01');
});

test('applyFieldChange: an end before the start is auto-corrected', () => {
  const f = formFromInput({ start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) });
  const g = applyFieldChange(f, 'endTime', '08:00');
  assert.equal(g.endTime, '10:00');
  assert.equal(g.endDate, '2026-10-04');
  const same = applyFieldChange(f, 'endTime', '09:00');
  assert.equal(same.endTime, '10:00');
  const ok = applyFieldChange(f, 'endTime', '11:15');
  assert.equal(ok.endTime, '11:15');
  // late start: the corrected end rolls over to the next day
  const late = applyFieldChange(formFromInput({ start: d(2026, 10, 4, 23, 30), end: d(2026, 10, 5, 0, 30) }), 'endDate', '2026-10-04');
  assert.equal(late.endDate, '2026-10-05');
  assert.equal(late.endTime, '00:30');

  const ad = formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 6) });
  assert.equal(applyFieldChange(ad, 'endDate', '2026-10-01').endDate, '2026-10-04');
  assert.equal(applyFieldChange(ad, 'endDate', '2026-10-08').endDate, '2026-10-08');
});

test('applyFieldChange: cleared/garbage picker values are rejected', () => {
  const f = formFromInput({ start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) });
  assert.deepEqual(applyFieldChange(f, 'startDate', ''), f);
  assert.deepEqual(applyFieldChange(f, 'startTime', 'abc'), f);
  assert.deepEqual(applyFieldChange(f, 'endTime', ''), f);
  const ad = formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 5) });
  assert.deepEqual(applyFieldChange(ad, 'startDate', ''), ad);
  assert.deepEqual(applyFieldChange(ad, 'endDate', ''), ad);
  assert.deepEqual(applyFieldChange(f, 'nope', 'x'), f);
  assert.equal(applyFieldChange(f, 'title', 'abc').title, 'abc');
});

test('toggleAllDay: timed → all-day → timed', () => {
  const f = formFromInput({ start: d(2026, 10, 4, 13), end: d(2026, 10, 4, 14, 30) });
  const ad = toggleAllDay(f, true);
  assert.equal(ad.allDay, true);
  assert.equal(ad.startDate, '2026-10-04');
  assert.equal(ad.endDate, '2026-10-04');
  const back = toggleAllDay(ad, false);
  assert.equal(back.allDay, false);
  assert.equal(back.startTime, '13:00');
  assert.equal(back.endTime, '14:30');
  assert.equal(back.endDate, '2026-10-04');

  // ending exactly at midnight does not add a day
  const toMidnight = formFromInput({ start: d(2026, 10, 4, 23), end: d(2026, 10, 5, 0) });
  assert.equal(toggleAllDay(toMidnight, true).endDate, '2026-10-04');
  // overnight touches the next day
  const overnight = formFromInput({ start: d(2026, 10, 4, 22), end: d(2026, 10, 5, 2) });
  assert.equal(toggleAllDay(overnight, true).endDate, '2026-10-05');

  // all-day → timed with the default times
  const fromAllDay = toggleAllDay(formFromInput({ allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 7) }), false);
  assert.equal(fromAllDay.startDate, '2026-10-04');
  assert.equal(fromAllDay.endDate, '2026-10-04');
  assert.equal(fromAllDay.startTime, '09:00');
  assert.equal(fromAllDay.endTime, '10:00');

  // remembered times that are not ordered → start + 1 h
  const weird = toggleAllDay({ ...ad, startTime: '23:30', endTime: '01:00' }, false);
  assert.equal(weird.endDate, '2026-10-05');
  assert.equal(weird.endTime, '00:30');

  // no-op toggle
  assert.deepEqual(toggleAllDay(f, false), f);
});

test('writableCalendars / pickCalendarId', () => {
  const cals = [
    { id: 'ro', name: '共有', writable: false, primary: false },
    { id: 'hol', name: '祝日', writable: true, holiday: true },
    { id: 'work', name: '仕事', writable: true, primary: false },
    { id: 'me', name: '自分', writable: true, primary: true },
    null,
    { name: 'no id', writable: true },
  ];
  assert.deepEqual(writableCalendars(cals).map((c) => c.id), ['work', 'me']);
  assert.equal(pickCalendarId(cals, 'work'), 'work');
  assert.equal(pickCalendarId(cals, 'ro'), 'me');
  assert.equal(pickCalendarId(cals, null), 'me');
  assert.equal(pickCalendarId(cals.filter((c) => c?.id !== 'me'), null), 'work');
  assert.equal(pickCalendarId([], 'x'), 'x');
  assert.equal(pickCalendarId(undefined, null), null);
});

test('safeHttpUrl only allows http(s)', () => {
  assert.equal(safeHttpUrl('https://www.google.com/calendar/event?eid=abc'), 'https://www.google.com/calendar/event?eid=abc');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,x'), null);
  assert.equal(safeHttpUrl(null), null);
});

// =============================================================================================
// Header / toolbar / selection menu / settings helpers

test('headerTitle per view (holiday name on day pages)', () => {
  assert.deepEqual(headerTitle({ view: 'day', date: d(2026, 10, 12) }), { title: '2026年10月12日(月)', holiday: 'スポーツの日' });
  assert.deepEqual(headerTitle({ view: 'day', date: d(2026, 10, 13) }), { title: '2026年10月13日(火)', holiday: '' });
  assert.equal(headerTitle({ view: 'week', date: d(2026, 10, 4), range: { start: d(2026, 10, 4), end: d(2026, 10, 11) } }).title,
    '2026年10月4日〜10月10日');
  assert.equal(headerTitle({ view: 'week', date: d(2026, 10, 4), weekStart: 1 }).title, '2026年9月28日〜10月4日');
  assert.equal(headerTitle({ view: 'week', date: d(2026, 12, 31) }).title, '2026年12月28日〜2027年1月3日'); // default: Monday start
  assert.equal(headerTitle({ view: 'week', date: d(2026, 12, 31), weekStart: 0 }).title, '2026年12月27日〜2027年1月2日');
  assert.equal(headerTitle({ view: 'month', date: d(2026, 10, 4) }).title, '2026年10月');
  assert.equal(headerTitle({ view: 'month', date: d(2026, 9, 28), range: { monthStart: d(2026, 10, 1) } }).title, '2026年10月');
  assert.equal(headerTitle({ view: 'day', date: 'nope' }).title, '');
  assert.equal(headerTitle().title, '');
});

test('syncIndicatorInfo: the six statuses use the spec texts', () => {
  const texts = Object.fromEntries(['synced', 'syncing', 'pending', 'offline', 'local', 'error']
    .map((s) => [s, syncIndicatorInfo(s).text]));
  assert.deepEqual(texts, {
    synced: '保存済み', syncing: '保存中…', pending: '未送信', offline: 'オフライン', local: 'この端末のみ', error: 'エラー',
  });
  assert.equal(syncIndicatorInfo('weird'), null);
  assert.equal(syncIndicatorInfo(null), null);
  const withMsg = syncIndicatorInfo({ status: 'error', message: '容量不足' });
  assert.equal(withMsg.text, 'エラー');
  assert.match(withMsg.label, /容量不足/);
});

test('authChipInfo / normalizeAuthState', () => {
  assert.equal(authChipInfo({ signedIn: false }).text, 'ログイン');
  assert.equal(authChipInfo('signedOut').text, 'ログイン');
  assert.equal(authChipInfo({ signedIn: true, needsReconnect: true }).text, '再接続');
  assert.equal(authChipInfo('reconnect').text, '再接続');
  assert.equal(authChipInfo({ demo: true }).text, 'お試し');
  const signed = authChipInfo({ signedIn: true, email: 'a@example.com' });
  assert.equal(signed.text, '');
  assert.match(signed.label, /a@example\.com/);
  assert.equal(authChipInfo({ connecting: true }).disabled, true);
  assert.equal(authChipInfo({ signedIn: false, configured: false }).hidden, true);
  assert.equal(authChipInfo({ demo: true, configured: false }).hidden, false);
  assert.deepEqual(normalizeAuthState(undefined), {
    signedIn: false, demo: false, needsReconnect: false, connecting: false, configured: null, email: '',
  });
  assert.equal(normalizeAuthState({ reconnect: true }).needsReconnect, true);
});

test('toolbar helpers', () => {
  assert.equal(normalizePenSize('thin'), 'thin');
  assert.equal(normalizePenSize(3.5), 'medium');
  assert.equal(normalizePenSize(6), 'thick');
  assert.equal(normalizePenSize('huge'), null);
  assert.equal(normalizePenSize('2'), null);
  assert.equal(normalizePenSize(5), null);
  const s0 = { tool: 'pen', penColor: '#1f2937', penSize: 'medium', hlColor: '#fde047', canUndo: false, canRedo: false, collapsed: false };
  const s1 = mergeToolbarState(s0, { tool: 'bogus', penSize: 2, canUndo: 1 });
  assert.equal(s1.tool, 'pen');
  assert.equal(s1.penSize, 'thin');
  assert.equal(s1.canUndo, true);
  assert.equal(s1.canRedo, false);
  assert.equal(mergeToolbarState(s0, { tool: 'event' }).tool, 'event');
  assert.deepEqual(mergeToolbarState(s0, null), s0);
  assert.equal(colorName('#DC2626'), '赤');
  assert.equal(colorName('#123456'), '#123456');
  assert.deepEqual(TOOLS.map((t) => t.label), ['ペン', 'マーカー', '消しゴム', '投げなわ', '予定']);
});

test('placeMenu: above, below, over, clamped', () => {
  const bounds = { left: 8, top: 60, right: 1016, bottom: 700 };
  const size = { width: 300, height: 48 };
  const above = placeMenu({ left: 400, top: 300, right: 600, bottom: 400 }, size, bounds);
  assert.deepEqual(above, { left: 350, top: 242, placement: 'above' });
  const below = placeMenu({ left: 400, top: 80, right: 600, bottom: 200 }, size, bounds);
  assert.deepEqual(below, { left: 350, top: 210, placement: 'below' });
  const over = placeMenu({ left: 400, top: 70, right: 600, bottom: 690 }, size, bounds);
  assert.equal(over.placement, 'over');
  assert.ok(over.top >= bounds.top && over.top + size.height <= bounds.bottom);
  // clamped to the left / right edges
  assert.equal(placeMenu({ left: 0, top: 300, right: 20, bottom: 320 }, size, bounds).left, 8);
  assert.equal(placeMenu({ left: 1000, top: 300, right: 1020, bottom: 320 }, size, bounds).left, 716);
  // DOMRect-like { x, y, width, height }
  assert.deepEqual(toClientRect({ x: 1, y: 2, width: 3, height: 4 }), { left: 1, top: 2, right: 4, bottom: 6 });
  assert.equal(toClientRect({ x: 'a' }), null);
  // selection scrolled off the bottom: still visible
  const off = placeMenu({ left: 400, top: 900, right: 600, bottom: 1000 }, size, bounds);
  assert.ok(off.top + size.height <= bounds.bottom);
  // garbage anchor does not throw
  assert.equal(typeof placeMenu(null, size, bounds).top, 'number');
});

test('settings helpers', () => {
  assert.deepEqual(setCalendarVisible(['a', 'b'], 'a', true), ['b']);
  assert.deepEqual(setCalendarVisible(['b'], 'a', false), ['b', 'a']);
  assert.deepEqual(setCalendarVisible(['a'], 'a', false), ['a'], 'no duplicates');
  assert.deepEqual(setCalendarVisible(null, 'a', false), ['a']);
  const cals = [{ id: 'w', primary: false }, { id: 'p', primary: true }, { id: 'h', holiday: true }];
  assert.equal(defaultCalendarValue(cals, 'p'), null);
  assert.equal(defaultCalendarValue(cals, 'w'), 'w');
  assert.equal(defaultCalendarValue(cals, 'zzz'), null);
  assert.deepEqual(displayableCalendars(cals).map((c) => c.id), ['p', 'w']);
  assert.deepEqual(accountView({ signedIn: true, email: 'x@y' }).actions.map((a) => a.action), ['signOut']);
  assert.deepEqual(accountView({ signedIn: true, missingScopes: ['drive'] }).actions.map((a) => a.action), ['addScopes', 'signOut']);
  assert.deepEqual(accountView({ demo: true }).actions.map((a) => a.action), ['exitDemo']);
  assert.deepEqual(accountView({}).actions.map((a) => a.action), ['signIn', 'enterDemo']);
  assert.deepEqual(accountView({ configured: false }).actions.map((a) => a.action), ['enterDemo']);
  assert.match(accountView({ configured: false }).detail, /SETUP\.md/);
});

// =============================================================================================
// Tiny fake DOM (just what the UI modules use)

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class FakeNode {
  constructor(doc, nodeType) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = [];
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get isConnected() {
    let x = this;
    while (x.parentNode) x = x.parentNode;
    return x === this.ownerDocument;
  }
  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    if (this.nodeType === 3) { this.data = String(v); return; }
    this.replaceChildren();
    if (v != null && v !== '') this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  addEventListener(type, fn, opts) { this.listeners.push({ type, fn, capture: Boolean(opts === true || opts?.capture) }); }
  removeEventListener(type, fn, opts) {
    const capture = Boolean(opts === true || opts?.capture);
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    for (let node = this; node; node = node.parentNode) {
      ev.currentTarget = node;
      for (const l of [...node.listeners]) if (l.type === ev.type) l.fn.call(node, ev);
      if (ev.propagationStopped) break;
    }
    return !ev.defaultPrevented;
  }
}

class FakeStyle {
  constructor() { this.props = {}; this.cssText = ''; }
  setProperty(k, v) { this.props[k] = String(v); }
  getPropertyValue(k) { return this.props[k] ?? ''; }
  removeProperty(k) { delete this.props[k]; }
}

class FakeClassList {
  constructor(el) { this.el = el; }
  get list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  set list(v) { this.el.setAttribute('class', v.join(' ')); }
  add(...c) { this.list = [...new Set([...this.list, ...c])]; }
  remove(...c) { this.list = this.list.filter((x) => !c.includes(x)); }
  contains(c) { return this.list.includes(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.contains(c) : Boolean(force);
    if (on) this.add(c); else this.remove(c);
    return on;
  }
}

class FakeElement extends FakeNode {
  constructor(doc, tag, ns = null) {
    super(doc, 1);
    this.tagName = ns ? tag : tag.toUpperCase();
    this.namespaceURI = ns;
    this.attrs = new Map();
    this.style = new FakeStyle();
    this.dataset = {};
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.offsetWidth = 0;
    this.offsetHeight = 0;
  }
  get type() { return this.getAttribute('type') || ''; }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent(new FakeEvent('click')); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  matches(sel) {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  closest(sel) {
    for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.defaultView = { innerWidth: 1024, innerHeight: 768 };
    this.documentElement = this.createElement('html');
    this.appendChild(this.documentElement);
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(ns, tag) { return new FakeElement(this, tag, ns); }
  createTextNode(text) { const t = new FakeNode(this, 3); t.data = String(text); return t; }
  getElementById(id) { return this.documentElement.querySelectorAll(`#${id}`)[0] || null; }
  querySelector(sel) { return this.documentElement.matches(sel) ? this.documentElement : this.documentElement.querySelector(sel); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
}

/** Fresh document with #app > header, banner, viewport > .page, toolbar, #dialog-root. */
function setupDom() {
  const doc = new FakeDocument();
  globalThis.document = doc;
  const app = doc.createElement('div');
  app.setAttribute('id', 'app');
  const header = doc.createElement('header');
  header.setAttribute('class', 'app-header');
  const banner = doc.createElement('div');
  banner.setAttribute('class', 'banner');
  const viewport = doc.createElement('div');
  viewport.setAttribute('class', 'viewport');
  const page = doc.createElement('div');
  page.setAttribute('class', 'page');
  viewport.appendChild(page);
  const toolbar = doc.createElement('div');
  toolbar.setAttribute('class', 'toolbar');
  const menu = doc.createElement('div');
  menu.setAttribute('class', 'selection-menu');
  const root = doc.createElement('div');
  root.setAttribute('id', 'dialog-root');
  app.append(header, banner, viewport, toolbar, menu, root);
  doc.body.appendChild(app);
  return { doc, app, header, banner, viewport, page, toolbar, menu, root };
}

const all = (el, pred) => {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (pred(c)) out.push(c); walk(c); } };
  walk(el);
  return out;
};
const byClass = (el, cls) => all(el, (c) => c.classList.contains(cls));
const byTag = (el, tag) => all(el, (c) => c.tagName === tag.toUpperCase());
const byText = (el, tag, text) => all(el, (c) => c.tagName === tag.toUpperCase() && c.textContent.trim() === text)[0];
const setValue = (input, value, type = 'change') => { input.value = value; input.dispatchEvent(new FakeEvent(type)); };
const isShown = (el) => { for (let x = el; x && x.nodeType === 1; x = x.parentNode) if (x.hidden) return false; return true; };

const CALS = [
  { id: 'me@example.com', name: '自分', color: '#039be5', writable: true, primary: true, holiday: false },
  { id: 'work', name: '仕事', color: '#33b679', writable: true, primary: false, holiday: false },
  { id: 'ja.japanese#holiday@group.v.calendar.google.com', name: '日本の祝日', color: '#0b8043', writable: false, primary: false, holiday: true },
  { id: 'shared', name: '共有', color: '#8e24aa', writable: false, primary: false, holiday: false },
];

/** Opens the dialog and returns { promise, dialog, backdrop, ... } helpers. */
function openDialog(opts) {
  let result;
  const promise = openEventDialog(opts).then((r) => { result = r; return r; });
  const backdrop = byClass(globalThis.document.getElementById('dialog-root') || globalThis.document.body, 'dialog-backdrop')[0];
  const dialog = byClass(backdrop, 'dialog')[0];
  return { promise, backdrop, dialog, settled: () => result };
}

const tick = () => new Promise((r) => setImmediate(r));

// =============================================================================================
// Components on the fake DOM

test('h(): attributes, properties, events, children; svgIcon(); clear()', () => {
  setupDom();
  let clicked = 0;
  const el = h('button', { class: ['btn', null, 'btn-primary'], type: 'button', disabled: true, dataset: { x: 1 },
    style: { color: 'red', '--k': 2 }, onClick: () => { clicked += 1; }, 'aria-label': 'ok', hiddenAttr: false },
  'a', 1, null, false, [h('span', null, 'b')]);
  assert.equal(el.getAttribute('class'), 'btn btn-primary');
  assert.equal(el.disabled, true);
  assert.equal(el.dataset.x, '1');
  assert.equal(el.style.color, 'red');
  assert.equal(el.style.getPropertyValue('--k'), '2');
  assert.equal(el.getAttribute('aria-label'), 'ok');
  assert.equal(el.hasAttribute('hiddenAttr'), false);
  assert.equal(el.textContent, 'a1b');
  el.click();
  assert.equal(clicked, 1);
  const input = h('input', { value: 'v' });
  assert.equal(input.value, 'v');
  clear(el);
  assert.equal(el.childNodes.length, 0);

  for (const name of ['chevron-left', 'chevron-right', 'plus', 'gear', 'pen', 'highlighter', 'eraser', 'lasso',
    'calendar-plus', 'undo', 'redo', 'cloud-check', 'cloud-upload', 'cloud-off', 'alert', 'user', 'x', 'trash']) {
    assert.ok(ICON_NAMES.includes(name), name);
    const svg = svgIcon(name);
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.ok(svg.children.length > 0, `${name} has shapes`);
  }
  assert.equal(svgIcon('no-such-icon').children.length, 0);
  const gear = svgIcon('gear').children[0].getAttribute('d');
  assert.match(gear, /^M[\d. ]+L/);
  assert.ok(!/NaN/.test(gear));
});

test('event dialog: create → save with prefilled time, default calendar, erase option', async () => {
  const { root, app } = setupDom();
  const opener = h('button', null, 'opener');
  app.appendChild(opener);
  opener.focus();

  const dlg = openDialog({
    mode: 'create', initial: { title: '', description: '', location: '', allDay: false, start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) },
    calendarId: null, calendars: CALS, snapshotUrl: 'data:image/png;base64,AAAA', showEraseOption: true, eraseDefault: true,
  });
  assert.ok(dlg.dialog, 'dialog rendered in #dialog-root');
  assert.ok(root.contains(dlg.backdrop));
  assert.equal(isModalOpen(), true);
  assert.equal(dlg.dialog.getAttribute('role'), 'dialog');
  assert.equal(dlg.dialog.getAttribute('aria-modal'), 'true');
  // never autofocus an input
  assert.equal(globalThis.document.activeElement, dlg.dialog);
  // the rest of the app is inert while open
  assert.ok(byClass(app, 'viewport')[0].hasAttribute('inert'));
  assert.ok(!root.hasAttribute('inert'));

  const title = byClass(dlg.dialog, 'input-title')[0];
  assert.equal(title.getAttribute('placeholder'), 'ここにペンで書くと文字になります');
  assert.equal(title.getAttribute('enterkeyhint'), 'done');
  assert.equal(title.getAttribute('autocomplete'), 'off');
  assert.ok(dlg.dialog.textContent.includes('✏️ Apple Pencil で欄の上に書くと、文字に変換されます（スクリブル）'));
  assert.ok(dlg.dialog.textContent.includes('書いた内容'));
  assert.equal(byTag(dlg.dialog, 'img')[0].getAttribute('src'), 'data:image/png;base64,AAAA');

  // calendar select: writable only, primary preselected
  const select = byTag(dlg.dialog, 'select')[0];
  assert.deepEqual(byTag(select, 'option').map((o) => o.value), ['me@example.com', 'work']);
  assert.equal(select.value, 'me@example.com');
  assert.ok(byTag(select, 'option')[0].textContent.startsWith('●'));
  setValue(select, 'work');

  // times prefilled
  const times = byClass(dlg.dialog, 'input-time');
  assert.deepEqual(times.map((t) => t.value), ['09:00', '10:00']);
  // moving the start keeps the duration
  setValue(times[0], '13:30');
  assert.equal(times[1].value, '14:30');

  setValue(title, '歯医者', 'input');
  const erase = all(dlg.dialog, (c) => c.getAttribute('role') === 'switch')[1];
  assert.equal(erase.checked, true);
  byText(dlg.dialog, 'button', '保存').click();
  const r = await dlg.promise;
  assert.equal(r.action, 'save');
  assert.equal(r.calendarId, 'work');
  assert.equal(r.eraseInk, true);
  assert.equal(r.input.title, '歯医者');
  assert.equal(r.input.allDay, false);
  assert.equal(r.input.start.getTime(), d(2026, 10, 4, 13, 30).getTime());
  assert.equal(r.input.end.getTime(), d(2026, 10, 4, 14, 30).getTime());

  // closed: removed, app no longer inert, focus restored
  assert.equal(byClass(root, 'dialog-backdrop').length, 0);
  assert.equal(isModalOpen(), false);
  assert.ok(!byClass(app, 'viewport')[0].hasAttribute('inert'));
  assert.equal(globalThis.document.activeElement, opener);
});

test('event dialog: empty title blocks saving; Escape cancels', async () => {
  setupDom();
  const dlg = openDialog({ mode: 'create', initial: { start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) }, calendars: CALS });
  byText(dlg.dialog, 'button', '保存').click();
  await tick();
  assert.equal(dlg.settled(), undefined, 'still open');
  const err = byClass(dlg.dialog, 'field-error').find((e) => !e.hidden);
  assert.equal(err.textContent, 'タイトルを入力してください');
  assert.ok(byClass(dlg.dialog, 'field-title')[0].classList.contains('is-shaking'));

  // Esc inside the sheet: cancel, and the key does not reach app-level listeners
  let leaked = 0;
  globalThis.document.addEventListener('keydown', () => { leaked += 1; });
  const ev = new FakeEvent('keydown', { key: 'Escape' });
  dlg.dialog.dispatchEvent(ev);
  assert.deepEqual(await dlg.promise, { action: 'cancel' });
  assert.equal(leaked, 0);
});

test('event dialog: all-day toggle converts inclusive 終了日 to an exclusive end', async () => {
  setupDom();
  const dlg = openDialog({ mode: 'create', initial: { start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) }, calendars: CALS });
  const allDaySwitch = all(dlg.dialog, (c) => c.getAttribute('role') === 'switch')[0];
  const timedGroup = byClass(dlg.dialog, 'field-grid--timed')[0];
  const allDayGroup = byClass(dlg.dialog, 'field-grid--allday')[0];
  assert.equal(isShown(timedGroup), true);
  assert.equal(isShown(allDayGroup), false);
  allDaySwitch.checked = true;
  allDaySwitch.dispatchEvent(new FakeEvent('change'));
  assert.equal(isShown(timedGroup), false);
  assert.equal(isShown(allDayGroup), true);
  const [adStart, adEnd] = byClass(allDayGroup, 'input-date');
  assert.equal(adStart.value, '2026-10-04');
  assert.equal(adEnd.value, '2026-10-04');
  setValue(adEnd, '2026-10-06');
  setValue(adStart, '2026-10-05'); // keeps 3 days
  assert.equal(adEnd.value, '2026-10-07');
  setValue(byClass(dlg.dialog, 'input-title')[0], '合宿', 'input');
  byText(dlg.dialog, 'button', '保存').click();
  const r = await dlg.promise;
  assert.equal(r.input.allDay, true);
  assert.equal(r.input.start.getTime(), d(2026, 10, 5).getTime());
  assert.equal(r.input.end.getTime(), d(2026, 10, 8).getTime());
  assert.equal(r.eraseInk, false, 'no erase option → false');
});

test('event dialog: 終了日 appears only for timed events that end on another day', () => {
  setupDom();
  const dlg = openDialog({ mode: 'create', initial: { start: d(2026, 10, 4, 22), end: d(2026, 10, 4, 23) }, calendars: CALS });
  const endDateField = byClass(dlg.dialog, 'field-end-date')[0];
  assert.equal(isShown(endDateField), false);
  const [startTime] = byClass(dlg.dialog, 'input-time');
  setValue(startTime, '23:30');
  assert.equal(isShown(endDateField), true);
  assert.equal(byClass(endDateField, 'input-date')[0].value, '2026-10-05');
  dlg.dialog.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
});

test('event dialog: the end is corrected when its picker closes, not while it spins', async () => {
  setupDom();
  const dlg = openDialog({ mode: 'create', initial: { title: 'x', start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) }, calendars: CALS });
  const [, endTime] = byClass(dlg.dialog, 'input-time');
  setValue(endTime, '08:00'); // wheel passing an earlier time: left alone
  assert.equal(endTime.value, '08:00');
  endTime.dispatchEvent(new FakeEvent('blur'));
  assert.equal(endTime.value, '10:00', 'start + 1 h');
  setValue(endTime, ''); // cleared picker → previous value restored on blur
  endTime.dispatchEvent(new FakeEvent('blur'));
  assert.equal(endTime.value, '10:00');
  setValue(endTime, '11:45');
  endTime.dispatchEvent(new FakeEvent('blur'));
  byText(dlg.dialog, 'button', '保存').click();
  const r = await dlg.promise;
  assert.equal(r.input.end.getTime(), d(2026, 10, 4, 11, 45).getTime());
});

test('event dialog: edit mode delete (with confirm), recurring note and Google link', async () => {
  setupDom();
  const asked = [];
  globalThis.confirm = (msg) => { asked.push(msg); return asked.length > 1; };
  const event = { id: 'e1', calendarId: 'work', title: '定例', description: '', location: '', allDay: false,
    start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10), editable: true, recurring: true, htmlLink: 'https://calendar.google.com/x' };
  const dlg = openDialog({ mode: 'edit', initial: event, calendarId: 'work', calendars: CALS, recurring: true, htmlLink: event.htmlLink });
  assert.ok(dlg.dialog.textContent.includes('繰り返し予定のうち、この回だけが変更されます'));
  const link = byTag(dlg.dialog, 'a')[0];
  assert.equal(link.getAttribute('href'), 'https://calendar.google.com/x');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel'), /noopener/);
  assert.ok(link.textContent.includes('Googleカレンダーで開く'));
  // editing never moves an event to another calendar
  assert.equal(byTag(dlg.dialog, 'select')[0].disabled, true);
  assert.equal(byTag(dlg.dialog, 'select')[0].value, 'work');

  const del = byText(dlg.dialog, 'button', '削除');
  del.click(); // confirm → false
  await tick();
  assert.equal(dlg.settled(), undefined);
  assert.match(asked[0], /^この予定を削除しますか？/);
  del.click(); // confirm → true
  assert.deepEqual(await dlg.promise, { action: 'delete' });
  delete globalThis.confirm;
});

test('event dialog: read-only event shows only 閉じる', async () => {
  setupDom();
  const dlg = openDialog({ mode: 'edit', initial: { title: '誕生日', allDay: true, start: d(2026, 10, 4), end: d(2026, 10, 5), editable: false },
    calendarId: 'shared', calendars: CALS, htmlLink: 'javascript:alert(1)' });
  const buttons = byTag(byClass(dlg.dialog, 'dialog-footer')[0], 'button').map((b) => b.textContent.trim());
  assert.deepEqual(buttons, ['閉じる']);
  assert.equal(byClass(dlg.dialog, 'input-title')[0].disabled, true);
  assert.equal(byTag(dlg.dialog, 'a').length, 0, 'unsafe link not rendered');
  assert.ok(dlg.dialog.textContent.includes('予定の詳細'));
  byText(dlg.dialog, 'button', '閉じる').click();
  assert.deepEqual(await dlg.promise, { action: 'cancel' });
});

test('event dialog: backdrop taps cancel only when the gesture starts on the backdrop', async () => {
  setupDom();
  const dlg = openDialog({ mode: 'create', initial: { start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) }, calendars: CALS });
  // a stroke that starts in the sheet and ends on the backdrop
  dlg.dialog.dispatchEvent(new FakeEvent('pointerdown'));
  dlg.backdrop.dispatchEvent(new FakeEvent('click', { target: dlg.backdrop }));
  await tick();
  assert.equal(dlg.settled(), undefined);
  // with the keyboard up (title focused), the first tap only blurs
  const title = byClass(dlg.dialog, 'input-title')[0];
  title.focus();
  dlg.backdrop.dispatchEvent(new FakeEvent('pointerdown'));
  dlg.backdrop.dispatchEvent(new FakeEvent('click'));
  await tick();
  assert.equal(dlg.settled(), undefined);
  assert.notEqual(globalThis.document.activeElement, title);
  // a real backdrop tap
  dlg.backdrop.dispatchEvent(new FakeEvent('pointerdown'));
  dlg.backdrop.dispatchEvent(new FakeEvent('click'));
  assert.deepEqual(await dlg.promise, { action: 'cancel' });
});

test('event dialog: onSubmit keeps the sheet open on failure', async () => {
  setupDom();
  let attempts = 0;
  const dlg = openDialog({
    mode: 'create', initial: { title: '会議', start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) }, calendars: CALS,
    onSubmit: async () => { attempts += 1; if (attempts === 1) throw new Error('通信できませんでした'); },
  });
  byText(dlg.dialog, 'button', '保存').click();
  await tick();
  await tick();
  assert.equal(dlg.settled(), undefined);
  const err = byClass(dlg.dialog, 'dialog-error')[0];
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, '通信できませんでした');
  byText(dlg.dialog, 'button', '保存').click();
  const r = await dlg.promise;
  assert.equal(r.action, 'save');
  assert.equal(attempts, 2);
});

test('event dialog: a stalled onSubmit lets the user cancel after stallMs (the request keeps running)', async () => {
  setupDom();
  let release;
  const pending = new Promise((r) => { release = r; });
  const dlg = openDialog({
    mode: 'create', initial: { title: '会議', start: d(2026, 10, 4, 9), end: d(2026, 10, 4, 10) }, calendars: CALS,
    stallMs: 20,
    onSubmit: () => pending,
  });
  byText(dlg.dialog, 'button', '保存').click();
  await tick();
  const cancel = byText(dlg.dialog, 'button', 'キャンセル');
  assert.equal(cancel.disabled, true, 'locked while saving');
  dlg.dialog.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  await tick();
  assert.equal(dlg.settled(), undefined, 'Esc ignored before the stall');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cancel.disabled, false, 'unlocked after the stall');
  assert.equal(byClass(dlg.dialog, 'dialog-error')[0].textContent, DIALOG_TEXT.stalled);
  cancel.click();
  assert.deepEqual(await dlg.promise, { action: 'cancel', pending: true });
  release();
});

test('event dialog: never mounts inside .page; a second dialog replaces the first', async () => {
  const { page, doc } = setupDom();
  const first = openEventDialog({ mode: 'create', initial: {}, calendars: CALS, root: page });
  const backdrops = byClass(doc.body, 'dialog-backdrop');
  assert.equal(backdrops.length, 1);
  assert.equal(page.contains(backdrops[0]), false);
  const second = openDialog({ mode: 'create', initial: {}, calendars: CALS });
  assert.deepEqual(await first, { action: 'cancel' });
  assert.equal(byClass(doc.body, 'dialog-backdrop').length, 1);
  second.dialog.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.deepEqual(await second.promise, { action: 'cancel' });
});

test('openModal: Tab focus trap wraps around', () => {
  const { doc } = setupDom();
  const modal = openModal({ label: 'テスト' });
  const a = h('button', null, 'a');
  const b = h('button', null, 'b');
  const hiddenBtn = h('button', { hidden: true }, 'c');
  modal.dialog.append(a, b, hiddenBtn);
  assert.deepEqual(focusableWithin(modal.dialog), [a, b]);
  b.focus();
  const ev = new FakeEvent('keydown', { key: 'Tab' });
  b.dispatchEvent(ev);
  assert.equal(doc.activeElement, a);
  assert.equal(ev.defaultPrevented, true);
  const back = new FakeEvent('keydown', { key: 'Tab', shiftKey: true });
  a.dispatchEvent(back);
  assert.equal(doc.activeElement, b);
  modal.close();
  assert.equal(isModalOpen(), false);
});

test('settings: edits are returned on 完了, actions close at once', async () => {
  const { doc } = setupDom();
  const settings = { weekStart: 0, allowFinger: false, eraseInkAfterConvert: true, hiddenCalendarIds: ['work'],
    defaultCalendarId: null, demo: false, tool: 'pen', view: 'week' };
  const p = openSettings({ settings, calendars: CALS, auth: { signedIn: true, email: 'me@example.com', configured: true, demo: false }, version: '1.0.0' });
  const dialog = byClass(doc.body, 'dialog')[0];
  const text = dialog.textContent;
  for (const s of ['Googleアカウント', '表示するカレンダー', '予定の登録先',
    '入力', '指・マウスでも書く', '予定にした手書きを消す（初期値）', 'データについて', 'アプリ専用の非表示フォルダ', 'バージョン 1.0.0', 'me@example.com']) {
    assert.ok(text.includes(s), s);
  }
  // holiday calendar is not listed
  assert.ok(!text.includes('日本の祝日'));
  const checks = byClass(dialog, 'check');
  assert.deepEqual(checks.map((c) => c.checked), [true, false, true]); // 自分, 仕事 (hidden), 共有
  checks[1].checked = true;
  checks[1].dispatchEvent(new FakeEvent('change'));
  checks[2].checked = false;
  checks[2].dispatchEvent(new FakeEvent('change'));
  // The week always starts on Monday: there is no 週の始まり choice any more.
  assert.ok(!text.includes('週の始まり'));
  const switches = all(dialog, (c) => c.getAttribute('role') === 'switch');
  switches[0].checked = true;
  switches[0].dispatchEvent(new FakeEvent('change'));
  switches[1].checked = false;
  switches[1].dispatchEvent(new FakeEvent('change'));
  const select = byTag(dialog, 'select')[0];
  setValue(select, 'work');
  byText(dialog, 'button', '完了').click();
  const r = await p;
  assert.equal(r.action, undefined);
  assert.deepEqual(r.settings.hiddenCalendarIds, ['shared']);
  assert.equal(r.settings.weekStart, 0, 'untouched (the store forces Monday)');
  assert.equal(r.settings.allowFinger, true);
  assert.equal(r.settings.eraseInkAfterConvert, false);
  assert.equal(r.settings.defaultCalendarId, 'work');
  assert.equal(r.settings.tool, 'pen', 'other keys untouched');
  assert.deepEqual(settings.hiddenCalendarIds, ['work'], 'input not mutated');

  const p2 = openSettings({ settings, calendars: CALS, auth: { signedIn: true, configured: true }, version: '1.0.0' });
  byText(byClass(doc.body, 'dialog')[0], 'button', 'ログアウト').click();
  const r2 = await p2;
  assert.equal(r2.action, 'signOut');
  assert.deepEqual(r2.settings, { ...settings, hiddenCalendarIds: ['work'] });

  const p3 = openSettings({ settings: {}, calendars: [], auth: { signedIn: false, configured: false }, version: '1.0.0' });
  const d3 = byClass(doc.body, 'dialog')[0];
  assert.ok(d3.textContent.includes('Google連携の設定がまだ済んでいません'));
  d3.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
  assert.deepEqual((await p3).settings.hiddenCalendarIds, []);
});

test('header: title, view switch, sync and auth chips, partial updates', () => {
  const { header } = setupDom();
  const calls = [];
  const hd = createHeader(header, {
    onPrev: () => calls.push('prev'), onNext: () => calls.push('next'), onToday: () => calls.push('today'),
    onView: (v) => calls.push(`view:${v}`), onAddEvent: () => calls.push('add'), onSettings: () => calls.push('settings'),
    onSyncTap: () => calls.push('sync'), onAuthTap: () => calls.push('auth'),
  });
  hd.update({ view: 'day', date: d(2026, 10, 12), sync: 'syncing', auth: { signedIn: false } });
  assert.equal(byClass(header, 'hdr-title-text')[0].textContent, '2026年10月12日(月)');
  const badge = byClass(header, 'hdr-holiday')[0];
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, 'スポーツの日');
  assert.equal(byClass(header, 'sync-text')[0].textContent, '保存中…');
  assert.equal(byClass(header, 'auth-text')[0].textContent, 'ログイン');
  const seg = byClass(header, 'seg')[0];
  assert.equal(byText(seg, 'button', '日').getAttribute('aria-pressed'), 'true');

  // partial update: only the sync status
  hd.update({ syncStatus: 'synced' });
  assert.equal(byClass(header, 'sync-text')[0].textContent, '保存済み');
  assert.equal(byClass(header, 'hdr-title-text')[0].textContent, '2026年10月12日(月)');

  // view change without a range: the title is recomputed from the date
  hd.update({ view: 'month' });
  assert.equal(byClass(header, 'hdr-title-text')[0].textContent, '2026年10月');
  assert.equal(byClass(header, 'hdr-holiday')[0].hidden, true);
  hd.update({ view: 'week', date: d(2026, 10, 4), range: { start: d(2026, 10, 4), end: d(2026, 10, 11) } });
  assert.equal(byClass(header, 'hdr-title-text')[0].textContent, '2026年10月4日〜10月10日');

  hd.update({ auth: 'reconnect' });
  assert.equal(byClass(header, 'auth-text')[0].textContent, '再接続');
  hd.update({ auth: { signedIn: true, email: 'me@example.com' } });
  assert.equal(byClass(header, 'auth-text')[0].textContent, '');
  assert.ok(byClass(header, 'auth-chip')[0].classList.contains('is-icon-only'));
  hd.update({ needsReconnect: true }); // flat keys merge
  assert.equal(byClass(header, 'auth-text')[0].textContent, '再接続');
  hd.update({ canAddEvent: false });
  assert.equal(byClass(header, 'btn-add')[0].hidden, true);
  hd.update({ sync: null });
  assert.equal(byClass(header, 'sync-ind')[0].hidden, true);

  all(header, (c) => c.getAttribute('aria-label') === '前へ')[0].click();
  byText(header, 'button', '今日').click();
  all(header, (c) => c.getAttribute('aria-label') === '次へ')[0].click();
  byText(seg, 'button', '日').click();
  byText(seg, 'button', '週').click(); // already active → no call
  all(header, (c) => c.getAttribute('aria-label') === '設定')[0].click();
  byClass(header, 'auth-chip')[0].click();
  assert.deepEqual(calls, ['prev', 'today', 'next', 'view:day', 'settings', 'auth']);
});

test('toolbar: tools, contextual colors/sizes, undo state, collapse', () => {
  const { toolbar } = setupDom();
  const calls = [];
  const tb = createToolbar(toolbar, {
    onTool: (t) => calls.push(`tool:${t}`), onPenColor: (c) => calls.push(`pen:${c}`), onPenSize: (s) => calls.push(`size:${s}`),
    onHlColor: (c) => calls.push(`hl:${c}`), onUndo: () => calls.push('undo'), onRedo: () => calls.push('redo'),
    onToggleCollapse: (c) => calls.push(`collapsed:${c}`),
  });
  tb.update({ tool: 'pen', penColor: PEN_COLORS[2], penSize: 'thick', hlColor: HIGHLIGHTER_COLORS[1], canUndo: true, canRedo: false });
  const labels = byClass(toolbar, 'tb-label').map((l) => l.textContent);
  assert.deepEqual(labels, ['ペン', 'マーカー', '消しゴム', '投げなわ', '予定']);
  const toolBtn = (id) => byClass(toolbar, 'tb-tool').find((b) => b.dataset.tool === id);
  assert.ok(toolBtn('pen').classList.contains('is-active'));
  assert.equal(byClass(toolbar, 'tb-swatch').length, 6);
  assert.equal(byClass(toolbar, 'tb-size').length, 3);
  assert.equal(byClass(toolbar, 'tb-swatch').filter((s) => s.classList.contains('is-active'))[0].dataset.color, PEN_COLORS[2]);
  assert.equal(byClass(toolbar, 'tb-size').find((s) => s.classList.contains('is-active')).dataset.size, 'thick');
  const [undo] = byClass(byClass(toolbar, 'tb-full')[0], 'tb-undo');
  const [redo] = byClass(byClass(toolbar, 'tb-full')[0], 'tb-redo');
  assert.equal(undo.disabled, false);
  assert.equal(redo.disabled, true);

  byClass(toolbar, 'tb-swatch')[1].click();
  byClass(toolbar, 'tb-size')[0].click();
  toolBtn('highlighter').click();
  tb.update({ tool: 'highlighter' });
  assert.equal(byClass(toolbar, 'tb-swatch').length, 4);
  assert.equal(byClass(toolbar, 'tb-size').length, 0);
  assert.equal(byClass(toolbar, 'tb-swatch').find((s) => s.classList.contains('is-active')).dataset.color, HIGHLIGHTER_COLORS[1]);
  byClass(toolbar, 'tb-swatch')[3].click();
  tb.update({ tool: 'eraser' });
  assert.equal(byClass(toolbar, 'tb-swatch').length, 0);
  assert.equal(byClass(toolbar, 'tb-options')[0].hidden, true);
  undo.click();

  byClass(toolbar, 'tb-collapse')[0].click();
  assert.ok(toolbar.classList.contains('is-collapsed'));
  assert.equal(byClass(toolbar, 'tb-full')[0].hidden, true);
  assert.equal(byClass(toolbar, 'tb-mini')[0].hidden, false);
  byClass(toolbar, 'tb-mini-tool')[0].click();
  assert.ok(!toolbar.classList.contains('is-collapsed'));
  tb.update({ collapsed: true }); // restoring the remembered state does not call back
  assert.ok(toolbar.classList.contains('is-collapsed'));

  assert.deepEqual(calls, [
    `pen:${PEN_COLORS[1]}`, 'size:thin', 'tool:highlighter', `hl:${HIGHLIGHTER_COLORS[3]}`, 'undo',
    'collapsed:true', 'collapsed:false',
  ]);
});

test('selection menu: buttons, show/hide', () => {
  const { menu } = setupDom();
  const calls = [];
  const sm = createSelectionMenu(menu, { onConvert: () => calls.push('convert'), onDelete: () => calls.push('delete'), onDeselect: () => calls.push('deselect') });
  assert.equal(menu.hidden, true);
  assert.deepEqual(byTag(menu, 'button').map((b) => b.textContent), ['予定にする', '削除', '選択解除']);
  sm.show({ left: 100, top: 300, right: 300, bottom: 400 });
  assert.equal(menu.hidden, false);
  assert.match(menu.style.left, /^\d+px$/);
  assert.match(menu.style.top, /^\d+px$/);
  for (const b of byTag(menu, 'button')) b.click();
  sm.hide();
  assert.equal(menu.hidden, true);
  assert.deepEqual(calls, ['convert', 'delete', 'deselect']);
});

test('toast and banner', () => {
  const { doc, banner } = setupDom();
  let acted = 0;
  const t = toast('予定を登録しました');
  const host = byClass(doc.body, 'toast-host')[0];
  assert.ok(host);
  assert.equal(byClass(host, 'toast').length, 1);
  assert.equal(byClass(host, 'toast-text')[0].textContent, '予定を登録しました');
  toast('新しいバージョンがあります', { actionLabel: '更新', onAction: () => { acted += 1; }, duration: 0 });
  const action = byClass(host, 'toast-action')[0];
  assert.equal(action.textContent, '更新');
  assert.equal(byClass(host, 'toast-close').length, 1, 'sticky toast can be closed');
  action.click();
  assert.equal(acted, 1);
  t.dismiss();
  assert.equal(toast('').dismiss(), undefined);
  // onClose: only the × of a sticky toast calls it (not the action button)
  let closed = 0;
  toast('保存できなかった予定があります', { actionLabel: '開く', onAction: () => { acted += 1; }, onClose: () => { closed += 1; }, duration: 0 });
  byClass(host, 'toast-action').at(-1).click();
  assert.equal(closed, 0, 'action does not count as close');
  toast('保存できなかった予定があります', { actionLabel: '開く', onAction: () => {}, onClose: () => { closed += 1; }, duration: 0 });
  const close = byClass(host, 'toast-close').at(-1);
  close.click();
  close.click();
  assert.equal(closed, 1, 'closed once');
  // at most 3 live toasts
  for (let i = 0; i < 5; i += 1) toast(`m${i}`);
  assert.equal(byClass(host, 'toast').filter((x) => !x.classList.contains('is-leaving')).length, 3);

  let retried = 0;
  showBanner(banner, { text: 'Googleへの接続が切れました', actionLabel: 'Googleに再接続', onAction: () => { retried += 1; }, kind: 'warn' });
  assert.equal(banner.hidden, false);
  assert.equal(banner.dataset.kind, 'warn');
  assert.equal(byClass(banner, 'banner-text')[0].textContent, 'Googleへの接続が切れました');
  byClass(banner, 'banner-action')[0].click();
  assert.equal(retried, 1);
  byClass(banner, 'banner-close')[0].click();
  assert.equal(banner.hidden, true);
  assert.equal(banner.childNodes.length, 0);
  showBanner(banner, { text: 'x', kind: 'bogus', closable: false });
  assert.equal(banner.dataset.kind, 'info');
  assert.equal(byClass(banner, 'banner-close').length, 0);
  hideBanner(banner);
  assert.equal(banner.hidden, true);
  showBanner(null, { text: 'no crash' });
  hideBanner(null);
});

test('banner: appearing or closing never moves the page under the Pencil', () => {
  const { banner, viewport, page } = setupDom();
  // Like #app: the banner is an 'auto' row above the viewport, the page scrolls inside the viewport.
  page.getBoundingClientRect = () => {
    const top = 52 + (banner.hidden ? 0 : 44) - (viewport.scrollTop || 0);
    return { left: 0, top, right: 800, bottom: top + 1000, width: 800, height: 1000 };
  };
  hideBanner(banner);
  page.dataset.fit = 'width';
  viewport.scrollTop = 300;
  const top0 = page.getBoundingClientRect().top;

  showBanner(banner, { text: 'Googleへの接続が切れました', kind: 'warn' });
  assert.equal(viewport.scrollTop, 344);
  assert.equal(page.getBoundingClientRect().top, top0);
  showBanner(banner, { text: '別の内容' }); // refilled, same height: no change
  assert.equal(viewport.scrollTop, 344);
  byClass(banner, 'banner-close')[0].click();
  assert.equal(banner.hidden, true);
  assert.equal(viewport.scrollTop, 300);
  assert.equal(page.getBoundingClientRect().top, top0);

  // month (fit 'contain') does not scroll: left alone
  page.dataset.fit = 'contain';
  showBanner(banner, { text: 'x' });
  assert.equal(viewport.scrollTop, 300);
});
