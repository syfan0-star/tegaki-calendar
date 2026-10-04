// Tests for the year page (js/views/year-view.js, 年間予定表): render() against a tiny fake DOM (the same
// minimal DOM as tests/views.test.mjs), cell metrics and the initial scroll position.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PAGE_SPECS, rangeFor, yearCellRect } from '../js/views/page-geometry.js';
import { applyPageScale, createPageElements, pct, stopNowTicker, TYPE } from '../js/views/view-common.js';
import { WEEKDAYS_JA, formatDateJa, toYMD } from '../js/util/date.js';
import { getHolidayName, getHolidaysInRange } from '../js/util/holidays-jp.js';
import * as yearView from '../js/views/year-view.js';

// ---------------------------------------------------------------------------------------------
// Minimal fake DOM (just what the views use)

const SVG_NS = 'http://www.w3.org/2000/svg';
const kebab = (k) => (k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));

function makeStyle() {
  const props = new Map();
  const parse = (text) => {
    props.clear();
    for (const part of String(text).split(';')) {
      const i = part.indexOf(':');
      if (i > 0) props.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  };
  const api = {
    setProperty: (k, v) => props.set(k, String(v)),
    getPropertyValue: (k) => props.get(k) ?? '',
    removeProperty: (k) => props.delete(k),
  };
  return new Proxy(api, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'cssText') return [...props].map(([a, b]) => `${a}:${b}`).join(';');
      return typeof k === 'string' ? props.get(kebab(k)) ?? '' : undefined;
    },
    set(t, k, v) {
      if (k === 'cssText') parse(v);
      else if (v === '' || v === null) props.delete(kebab(k));
      else props.set(kebab(k), String(v));
      return true;
    },
  });
}

class FakeNode {
  constructor(doc, tag, ns = null, isFragment = false) {
    this.ownerDocument = doc;
    this.tagName = ns ? tag : tag.toUpperCase();
    this.namespaceURI = ns;
    this.isFragment = isFragment;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.style = makeStyle();
    this.dataset = {};
    this.listeners = {};
    this.text = '';
    this.tabIndex = -1;
  }

  get className() { return this.attrs.get('class') ?? ''; }
  set className(v) { this.attrs.set('class', String(v)); }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    const set = (list) => { this.className = list.join(' '); };
    return {
      add: (...c) => set([...new Set([...get(), ...c])]),
      remove: (...c) => set(get().filter((x) => !c.includes(x))),
      contains: (c) => get().includes(c),
    };
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n.isFragment) {
        const kids = [...n.childNodes];
        n.childNodes = [];
        for (const k of kids) { k.parentNode = null; this.append(k); }
        continue;
      }
      n.remove();
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.text = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.childNodes = p.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, props = {}) {
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument.root;
  }
  get textContent() { return this.text + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); this.text = String(v); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  /** All descendants having every class in `cls` ('a.b' style, no tag). */
  findAll(cls) {
    const want = cls.split('.').filter(Boolean);
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        const have = c.className.split(/\s+/);
        if (want.every((w) => have.includes(w))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  findTag(tag) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) { if (c.tagName === tag) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

function makeDocument() {
  const doc = {
    createElement: (tag) => new FakeNode(doc, tag),
    createElementNS: (ns, tag) => new FakeNode(doc, tag, ns),
    createDocumentFragment: () => new FakeNode(doc, '#fragment', null, true),
  };
  doc.root = new FakeNode(doc, 'html');
  return doc;
}

function withDom(fn) {
  const prev = globalThis.document;
  const doc = makeDocument();
  globalThis.document = doc;
  try {
    return fn(doc);
  } finally {
    stopNowTicker();
    if (prev === undefined) delete globalThis.document; else globalThis.document = prev;
  }
}

/** viewport (connected) + page + sticky header, laid out like main.js would. */
function mountYear(doc, width = 820, height = 1000) {
  const viewportEl = doc.createElement('div');
  Object.defineProperty(viewportEl, 'clientWidth', { value: width });
  Object.defineProperty(viewportEl, 'clientHeight', { value: height });
  const stickyEl = doc.createElement('div');
  stickyEl.className = 'sticky-header';
  doc.root.append(stickyEl, viewportEl);
  const { pageEl, gridEl, eventsEl } = createPageElements(viewportEl);
  const layout = applyPageScale({ viewportEl, pageEl, spec: PAGE_SPECS.year });
  return { viewportEl, stickyEl, pageEl, gridEl, eventsEl, layout };
}

let seq = 0;
function ev(start, end, extra = {}) {
  seq += 1;
  return {
    id: `e${seq}`, calendarId: 'primary', title: `予定${seq}`, description: '', location: '',
    allDay: false, start, end, color: '#039be5', textColor: '#ffffff', htmlLink: '',
    recurring: false, editable: true, ...extra,
  };
}
const at = (y, m, d, h = 0, mi = 0, sec = 0) => new Date(y, m - 1, d, h, mi, sec);
const allDay = (y, m, d, days = 1, extra = {}) => ev(at(y, m, d), at(y, m, d + days), { allDay: true, ...extra });

const SPEC = PAGE_SPECS.year;
const LU_EPS = 1e-3; // pct() rounds to 4 decimals of a percent

/** Logical box of an absolutely positioned overlay (% of the page). */
function box(el) {
  const left = (parseFloat(el.style.left) / 100) * SPEC.W;
  const top = (parseFloat(el.style.top) / 100) * SPEC.H;
  const width = (parseFloat(el.style.width) / 100) * SPEC.W;
  const height = (parseFloat(el.style.height) / 100) * SPEC.H;
  return { left, top, right: left + width, bottom: top + height, width, height };
}
/** Number of rects in a path written as 'M x y h w v h h -w z' per rect. */
const rectCount = (path) => (path ? (path.getAttribute('d').match(/M/g) || []).length : 0);
const cellOf = (date) => yearCellRect(date.getMonth(), date.getDate());
const render = (m, extra) => yearView.render({
  ...m, date: at(2026, 10, 4), range: rangeFor('year', at(2026, 10, 4)), events: [], settings: {}, now: at(2026, 10, 4, 10), ...extra,
});

// ---------------------------------------------------------------------------------------------

test('year render: grid of 12 months × 31 days — tints, hatched non-dates, today, day numbers', () => withDom((doc) => {
  const m = mountYear(doc);
  render(m);
  assert.equal(m.pageEl.dataset.view, 'year');
  assert.equal(m.pageEl.dataset.fit, 'width');
  assert.equal(m.gridEl.getAttribute('viewBox'), '0 0 1400 1860');

  const year = rangeFor('year', at(2026, 1, 1)).days;
  const holiday = (d) => !!getHolidayName(d);
  const today = at(2026, 10, 4);
  const notToday = year.filter((d) => d.getTime() !== today.getTime());
  const sat = notToday.filter((d) => d.getDay() === 6 && !holiday(d)).length;
  const red = notToday.filter((d) => d.getDay() === 0 || holiday(d)).length;
  assert.equal(rectCount(m.gridEl.findAll('g-sat')[0]), sat);
  assert.equal(rectCount(m.gridEl.findAll('g-sun')[0]), red);
  assert.ok(sat >= 50 && red >= 60);
  // today (a Sunday): pale accent and an outline, not the Sunday tint
  assert.equal(rectCount(m.gridEl.findAll('g-today')[0]), 1);
  assert.match(m.gridEl.findAll('g-today')[0].getAttribute('d'), new RegExp(`^M${cellOf(today).x} ${cellOf(today).y}h112v60`));
  const ring = m.gridEl.findAll('g-today-ring')[0];
  assert.ok(Number(ring.getAttribute('x')) >= cellOf(today).x && Number(ring.getAttribute('y')) >= cellOf(today).y);
  assert.equal(ring.getAttribute('vector-effect'), 'non-scaling-stroke');
  // the dates that do not exist (2/29–31, 4/31, 6/31, 9/31, 11/31) are hatched
  const hatched = m.gridEl.findAll('g-void')[0];
  assert.equal(rectCount(hatched), 7);
  assert.equal(hatched.getAttribute('fill'), 'url(#yv-hatch)');
  const pattern = m.gridEl.findTag('pattern')[0];
  assert.equal(pattern.getAttribute('id'), 'yv-hatch');
  assert.equal(pattern.parentNode.tagName, 'defs');
  for (const [mo, day] of [[1, 29], [1, 30], [1, 31], [3, 31], [5, 31], [8, 31], [10, 31]]) {
    const c = yearCellRect(mo, day);
    assert.ok(hatched.getAttribute('d').includes(`M${c.x} ${c.y}h`), `${mo + 1}/${day}`);
  }
  // hairlines between the days (across the gutter), stronger lines between the months
  assert.equal((m.gridEl.findAll('g-hline')[0].getAttribute('d').match(/M/g) || []).length, 30);
  assert.match(m.gridEl.findAll('g-hline')[0].getAttribute('d'), /^M0 60H1400/);
  const seps = m.gridEl.findAll('g-sep')[0].getAttribute('d');
  assert.equal((seps.match(/M/g) || []).length, 11);
  assert.ok(seps.startsWith(`M${56 + 112} 0V1860`));
  assert.equal(m.gridEl.findAll('g-axis')[0].getAttribute('d'), 'M56 0V1860');
  // day numbers 1..31 centred in the gutter, on their rows; today's highlighted
  const nums = m.gridEl.findAll('g-daynum');
  assert.deepEqual(nums.map((t) => t.textContent), Array.from({ length: 31 }, (_, i) => String(i + 1)));
  for (const [i, t] of nums.entries()) {
    assert.equal(Number(t.getAttribute('x')), 28);
    const y = Number(t.getAttribute('y'));
    assert.ok(y > i * 60 && y < (i + 1) * 60, `day ${i + 1} on its row`);
  }
  assert.deepEqual(m.gridEl.findAll('g-daynum.is-today').map((t) => t.textContent), ['4']);
  assert.ok(Number(m.gridEl.findAll('g-daynums')[0].getAttribute('font-size')) * m.layout.scale >= TYPE.yearDayNum.minPx - 1e-9);
}));

test('year render: a leap year hatches six cells and shows 2/29', () => withDom((doc) => {
  const m = mountYear(doc);
  render(m, { date: at(2028, 3, 1), range: rangeFor('year', at(2028, 3, 1)) });
  assert.equal(rectCount(m.gridEl.findAll('g-void')[0]), 6);
  const labels = m.eventsEl.findAll('yc-wd');
  assert.equal(labels.length, 366);
  assert.ok(labels.some((l) => l.getAttribute('aria-label').startsWith('2028年2月29日(火)')));
  // no today on another year's page
  assert.equal(m.gridEl.findAll('g-today').length, 0);
  assert.equal(m.gridEl.findAll('g-today-ring').length, 0);
  assert.equal(m.gridEl.findAll('g-daynum.is-today').length, 0);
}));

test('year render: weekday letter at each cell\'s top-left, red/blue, tap opens the day', () => withDom((doc) => {
  const m = mountYear(doc);
  const days = [];
  render(m, { onDayTap: (d) => days.push(d) });
  const labels = m.eventsEl.findAll('yc-wd');
  const year = rangeFor('year', at(2026, 1, 1)).days;
  assert.equal(labels.length, 365);
  // DOM order: month by month, day by day
  labels.forEach((l, i) => {
    const date = year[i];
    assert.equal(l.textContent, WEEKDAYS_JA[date.getDay()]);
    const b = box(l);
    const c = cellOf(date);
    assert.ok(Math.abs(b.left - (c.x + 3)) < LU_EPS && Math.abs(b.top - (c.y + 3)) < LU_EPS, toYMD(date));
    const hol = getHolidayName(date);
    assert.equal(l.classList.contains('is-red'), date.getDay() === 0 || !!hol, `${toYMD(date)} red`);
    assert.equal(l.classList.contains('is-blue'), date.getDay() === 6 && !hol, `${toYMD(date)} blue`);
    assert.equal(l.getAttribute('aria-label'), `${formatDateJa(date)}${hol ? ` ${hol}` : ''}（日表示へ）`);
    assert.equal(l.getAttribute('role'), 'button');
  });
  const oct4 = labels[year.findIndex((d) => toYMD(d) === '2026-10-04')];
  assert.ok(oct4.classList.contains('is-today'));
  // finger / mouse tap → the day; the Pencil writes instead; Enter works too
  oct4.fire('click', { pointerType: 'touch' });
  assert.equal(toYMD(days.at(-1)), '2026-10-04');
  oct4.fire('click', { pointerType: 'pen' });
  assert.equal(days.length, 1);
  labels[0].fire('keydown', { key: 'Enter' });
  assert.equal(toYMD(days.at(-1)), '2026-01-01');
  // font sizes reach CSS through custom properties
  assert.ok(parseFloat(m.eventsEl.style.getPropertyValue('--yc-wd-fs')) >= TYPE.yearWeekday.minPx);
  assert.ok(parseFloat(m.eventsEl.style.getPropertyValue('--yc-chip-fs')) >= TYPE.yearChip.minPx);
  assert.ok(parseFloat(m.eventsEl.style.getPropertyValue('--yc-hol-fs')) >= TYPE.yearHoliday.minPx);
}));

test('year render: holiday names tiny along the cell bottom', () => withDom((doc) => {
  const m = mountYear(doc);
  render(m);
  const hols = m.eventsEl.findAll('yc-hol');
  const expected = getHolidaysInRange(at(2026, 1, 1), at(2027, 1, 1));
  assert.equal(hols.length, expected.length);
  assert.deepEqual(hols.map((h) => h.textContent), expected.map((h) => h.name));
  const sports = hols[expected.findIndex((h) => h.date === '2026-10-12')];
  assert.equal(sports.textContent, 'スポーツの日');
  assert.equal(sports.getAttribute('aria-hidden'), 'true');
  const b = box(sports);
  const c = cellOf(at(2026, 10, 12));
  assert.ok(b.left >= c.x && b.right <= c.x + c.w + LU_EPS, 'inside the cell horizontally');
  assert.ok(b.bottom <= c.y + c.h + LU_EPS && b.top > c.y + c.h / 2, 'in the bottom half');
  // the holiday's weekday label names it
  const labels = m.eventsEl.findAll('yc-wd');
  assert.ok(labels.some((l) => l.getAttribute('aria-label') === '2026年10月12日(月) スポーツの日（日表示へ）'));
}));

test('year render: all-day events as chips in the right part of the cell; timed events are not shown', () => withDom((doc) => {
  const m = mountYear(doc);
  const tapped = [];
  const days = [];
  const birthday = allDay(2026, 5, 20, 1, { title: '誕生日', color: '#fbd75b', textColor: '#1d1d1d' });
  const meeting = ev(at(2026, 5, 20, 9), at(2026, 5, 20, 10), { title: '会議' });
  const longTimed = ev(at(2026, 5, 21, 9), at(2026, 5, 23, 10), { title: '長い時間指定' });
  render(m, { events: [birthday, meeting, longTimed], onEventTap: (e) => tapped.push(e), onDayTap: (d) => days.push(d) });
  const chips = m.eventsEl.findAll('yc-chip');
  assert.equal(chips.length, 1);
  const chip = chips[0];
  assert.equal(chip.textContent, '誕生日');
  assert.equal(chip.dataset.eventId, birthday.id);
  assert.equal(chip.style.getPropertyValue('--ev'), '#fbd75b');
  assert.equal(chip.getAttribute('aria-label'), '誕生日、終日、2026年5月20日(水)');
  const b = box(chip);
  const c = cellOf(at(2026, 5, 20));
  assert.ok(b.left >= c.x + c.w * 0.45 - LU_EPS, 'the left part of the cell stays free for handwriting');
  assert.ok(b.right <= c.x + c.w + LU_EPS && b.top >= c.y && b.bottom <= c.y + c.h + LU_EPS);
  assert.ok(Math.abs(b.left - (c.x + c.w * yearView.YEAR_CHIP_LEFT)) < LU_EPS);
  // the chip comes right after its day's weekday label (reading order)
  const kids = m.eventsEl.childNodes;
  const i = kids.indexOf(chip);
  assert.ok(kids[i - 1].classList.contains('yc-wd'));
  assert.ok(kids[i - 1].getAttribute('aria-label').startsWith('2026年5月20日'));
  assert.ok(kids[i - 1].getAttribute('aria-label').includes('終日の予定1件'));
  // taps
  chip.fire('click', { pointerType: 'touch' });
  assert.equal(tapped.at(-1), birthday);
  chip.fire('click', { pointerType: 'pen' });
  assert.equal(tapped.length, 1);
  chip.fire('keydown', { key: ' ' });
  assert.equal(tapped.length, 2);
  assert.equal(days.length, 0);
  assert.ok(!chip.classList.contains('is-thin'));
}));

test('year render: a multi-day event is on every day it covers, in one lane, linked within a month column', () => withDom((doc) => {
  const m = mountYear(doc);
  const trip = allDay(2026, 1, 30, 4, { title: '旅行' }); // 1/30 .. 2/2
  const day = allDay(2026, 2, 1, 1, { title: '日曜の用事' });
  render(m, { events: [day, trip] });
  const chips = m.eventsEl.findAll('yc-chip').filter((c) => c.textContent === '旅行');
  assert.equal(chips.length, 4);
  const dates = [at(2026, 1, 30), at(2026, 1, 31), at(2026, 2, 1), at(2026, 2, 2)];
  const cls = chips.map((c) => ['cont-top', 'cont-bottom', 'link-down'].filter((k) => c.classList.contains(k)));
  assert.deepEqual(cls, [
    ['cont-bottom', 'link-down'],
    ['cont-top', 'cont-bottom'], // 1/31 is the end of the January column: no link down past the page
    ['cont-top', 'cont-bottom', 'link-down'],
    ['cont-top'],
  ]);
  chips.forEach((c, i) => {
    const b = box(c);
    const cell = cellOf(dates[i]);
    assert.ok(b.top >= cell.y && b.bottom <= cell.y + cell.h + LU_EPS, `chip ${i} in the cell of ${toYMD(dates[i])}`);
  });
  // the same lane on consecutive days of a column: the same offset inside the cell
  const off = (c, d) => box(c).top - cellOf(d).y;
  assert.ok(Math.abs(off(chips[0], dates[0]) - off(chips[1], dates[1])) < LU_EPS);
  assert.ok(Math.abs(off(chips[2], dates[2]) - off(chips[3], dates[3])) < LU_EPS);
  // the link reaches exactly the next day's chip: --yc-link = gap / chip height
  const b0 = box(chips[0]);
  const link = Number(chips[0].style.getPropertyValue('--yc-link'));
  assert.ok(Math.abs(b0.bottom + link * b0.height - box(chips[1]).top) < 0.01);
  assert.equal(chips[1].style.getPropertyValue('--yc-link'), '');
  // the trip (longer) takes the first lane on 2/1, the one-day event the next
  const other = m.eventsEl.findAll('yc-chip').find((c) => c.textContent === '日曜の用事');
  assert.ok(box(other).top > box(chips[2]).top);
}));

test('year render: a busy day shows every all-day event in thinner lanes; a thin chip opens the day', () => withDom((doc) => {
  const m = mountYear(doc); // portrait iPad: cells ≈ 66 × 35 px
  const tapped = [];
  const days = [];
  const busy = Array.from({ length: 9 }, (_, i) => allDay(2026, 6, 10, 1, { title: `タスク${i + 1}` }));
  const linked = allDay(2026, 6, 9, 2, { title: '前日から' }); // 6/9–6/10: shares the busy day
  const calm = allDay(2026, 6, 15, 1, { title: '別の日' });
  render(m, { events: [...busy, linked, calm], onEventTap: (e) => tapped.push(e), onDayTap: (d) => days.push(d) });
  const chips = m.eventsEl.findAll('yc-chip');
  assert.equal(chips.length, 9 + 2 + 1, 'nothing hidden');
  const metrics = yearView.yearCellMetrics(m.layout.scale);
  const cell = cellOf(at(2026, 6, 10));
  const onBusy = chips.filter((c) => box(c).top >= cell.y && box(c).top < cell.y + cell.h);
  assert.equal(onBusy.length, 10);
  const sorted = onBusy.map(box).sort((p, q) => p.top - q.top);
  for (const [i, b] of sorted.entries()) {
    assert.ok(b.bottom <= cell.y + cell.h + LU_EPS, 'inside the cell');
    assert.ok(b.height < metrics.chipLu, 'thinned');
    if (i) assert.ok(b.top >= sorted[i - 1].bottom - LU_EPS, 'lanes do not overlap');
  }
  for (const c of onBusy) {
    assert.ok(c.classList.contains('is-thin'));
    assert.ok(Number(c.style.getPropertyValue('--yc-k')) < 1);
    assert.ok(c.getAttribute('aria-label').endsWith('（日表示へ）'));
  }
  // 6/9 is linked to the busy day by the two-day event: thinned too, in the same lane as on 6/10
  const prev = chips.find((c) => c.textContent === '前日から' && box(c).top < cell.y);
  assert.ok(prev.classList.contains('is-thin'));
  // an unrelated day keeps a full-size chip
  const calmChip = chips.find((c) => c.textContent === '別の日');
  assert.ok(Math.abs(box(calmChip).height - metrics.chipLu) < LU_EPS);
  assert.ok(!calmChip.classList.contains('is-thin'));
  // a thin chip is no finger target: it opens the day; the keyboard opens the event
  onBusy[3].fire('click', { pointerType: 'touch' });
  assert.equal(toYMD(days.at(-1)), '2026-06-10');
  assert.equal(tapped.length, 0);
  onBusy[3].fire('keydown', { key: 'Enter' });
  assert.equal(tapped.length, 1);
  assert.equal(tapped[0].title, onBusy[3].textContent);
}));

test('year render: on a holiday the chips stay above the holiday name', () => withDom((doc) => {
  const m = mountYear(doc);
  const many = Array.from({ length: 5 }, (_, i) => allDay(2026, 11, 3, 1, { title: `文化${i}` })); // 文化の日
  render(m, { events: many });
  const hol = m.eventsEl.findAll('yc-hol').find((h) => h.textContent === '文化の日');
  const chips = m.eventsEl.findAll('yc-chip');
  assert.equal(chips.length, 5);
  for (const c of chips) assert.ok(box(c).bottom <= box(hol).top + LU_EPS, `${c.textContent} above the holiday line`);
}));

test('year render: 100 all-day events on one day stay inside the cell', () => withDom((doc) => {
  const m = mountYear(doc, 1180, 800);
  const lots = Array.from({ length: 100 }, (_, i) => allDay(2026, 12, 31, 1, { title: `予定${i}` }));
  render(m, { events: lots });
  const chips = m.eventsEl.findAll('yc-chip');
  assert.equal(chips.length, 100);
  const cell = cellOf(at(2026, 12, 31));
  for (const c of chips) {
    const b = box(c);
    assert.ok(b.height > 0 && b.top >= cell.y - LU_EPS && b.bottom <= cell.y + cell.h + LU_EPS, 'never past the page bottom');
  }
}));

test('yearCellMetrics: legible minimum sizes; three full chips fit an ordinary cell on an iPad', () => {
  for (const scale of [820 / 1400, 1180 / 1400, 1366 / 1400, 1]) {
    const mt = yearView.yearCellMetrics(scale);
    assert.ok(mt.chipPx >= TYPE.yearChip.minPx && mt.weekdayPx >= TYPE.yearWeekday.minPx && mt.holidayPx >= TYPE.yearHoliday.minPx);
    assert.ok(mt.padLu + 3 * mt.chipLu + 2 * mt.gapLu <= 60 - 2 + 1e-9, `scale ${scale}: 3 chips`);
    assert.ok(mt.holidayLu > 0 && mt.holidayLu < 30);
    assert.ok(mt.dayNumLu * 1.2 < SPEC.gutter, 'two-digit day numbers fit the gutter');
  }
  assert.deepEqual(yearView.yearCellMetrics(0), yearView.yearCellMetrics(1), 'bad scale → 1');
});

test('year render: sticky header names the months over their columns; a tap opens the month', () => withDom((doc) => {
  const m = mountYear(doc);
  const months = [];
  render(m, { onMonthTap: (d) => months.push(d) });
  assert.equal(m.stickyEl.dataset.view, 'year');
  const inner = m.stickyEl.findAll('sh-inner')[0];
  assert.equal(inner.style.width, `${m.layout.cssW}px`);
  assert.equal(inner.style.getPropertyValue('--sh-gutter'), `${pct(56, 1400)}%`);
  assert.equal(m.stickyEl.style.paddingLeft, `${m.layout.offsetX}px`);
  const row = m.stickyEl.findAll('sh-months')[0];
  assert.ok(row.childNodes[0].classList.contains('sh-corner'));
  const btns = m.stickyEl.findAll('sh-month');
  assert.deepEqual(btns.map((b) => b.textContent), Array.from({ length: 12 }, (_, i) => `${i + 1}月`));
  assert.deepEqual(btns.map((b) => b.classList.contains('is-current')), Array.from({ length: 12 }, (_, i) => i === 9));
  assert.equal(btns[2].getAttribute('aria-label'), '2026年3月（月表示へ）');
  assert.equal(btns[2].tagName, 'BUTTON');
  btns[2].fire('click', {});
  assert.equal(months.at(-1).getTime(), at(2026, 3, 1).getTime());
  btns[11].fire('click', {});
  assert.equal(months.at(-1).getTime(), at(2026, 12, 1).getTime());
  // another year: no current month
  render(m, { date: at(2027, 6, 1), range: rangeFor('year', at(2027, 6, 1)) });
  assert.equal(m.stickyEl.findAll('sh-month.is-current').length, 0);
  // without onMonthTap nothing breaks
  m.stickyEl.findAll('sh-month')[0].fire('click', {});
}));

test('year render: idempotent, tolerant of garbage, and fast', () => withDom((doc) => {
  const m = mountYear(doc);
  const events = [];
  for (let i = 0; i < 300; i++) {
    const mo = 1 + (i % 12);
    const d = 1 + ((i * 7) % 28);
    events.push(allDay(2026, mo, d, 1 + (i % 4), { title: `終日${i}` }));
  }
  for (let i = 0; i < 2000; i++) events.push(ev(at(2026, 1 + (i % 12), 1 + (i % 28), 9), at(2026, 1 + (i % 12), 1 + (i % 28), 10)));
  render(m, { events }); // warm-up
  const t0 = performance.now();
  render(m, { events });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 150, `render took ${elapsed}ms`); // fake DOM; the 30 ms budget is for the browser
  const count = m.eventsEl.findAll('yc-chip').length;
  assert.ok(count >= 300);
  render(m, { events });
  assert.equal(m.eventsEl.findAll('yc-chip').length, count);
  assert.equal(m.eventsEl.findAll('yc-wd').length, 365);
  assert.equal(m.gridEl.findAll('g-daynum').length, 31);
  assert.equal(m.stickyEl.findAll('sh-month').length, 12);

  render(m, { events: [null, 1, {}, { start: 'x', end: 'y' }], range: null, date: 'nope', layout: null, settings: null });
  assert.equal(m.eventsEl.findAll('yc-wd').length >= 365, true);
  assert.equal(m.eventsEl.findAll('yc-chip').length, 0);
  assert.throws(() => yearView.render({}), TypeError);
}));

test('year render: after midnight the today tint moves to the new day', (t) => withDom((doc) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: at(2026, 10, 6, 23, 59, 50) });
  const m = mountYear(doc);
  yearView.render({ ...m, date: at(2026, 10, 1), range: rangeFor('year', at(2026, 10, 1)), events: [], settings: {}, now: new Date() });
  const todayPath = () => m.gridEl.findAll('g-today')[0].getAttribute('d');
  assert.ok(todayPath().startsWith(`M${cellOf(at(2026, 10, 6)).x} ${cellOf(at(2026, 10, 6)).y}h`));
  t.mock.timers.tick(30000);
  assert.ok(todayPath().startsWith(`M${cellOf(at(2026, 10, 7)).x} ${cellOf(at(2026, 10, 7)).y}h`));
  assert.deepEqual(m.gridEl.findAll('g-daynum.is-today').map((x) => x.textContent), ['7']);
}));

test('initialScrollY: today\'s row with two rows above it in this year, else the top', () => {
  const range = rangeFor('year', at(2026, 1, 1));
  assert.equal(yearView.initialScrollY({ date: at(2026, 1, 1), now: at(2026, 10, 20, 9), range }), (20 - 3) * 60);
  assert.equal(yearView.initialScrollY({ date: at(2026, 1, 1), now: at(2026, 10, 2), range }), 0, 'clamped at the top');
  assert.equal(yearView.initialScrollY({ date: at(2026, 1, 1), now: at(2026, 12, 31, 23), range }), 28 * 60);
  assert.equal(yearView.initialScrollY({ date: at(2027, 1, 1), now: at(2026, 10, 20), range: rangeFor('year', at(2027, 1, 1)) }), 0);
  // without a range: the year of `date`
  assert.equal(yearView.initialScrollY({ date: at(2026, 3, 3), now: at(2026, 10, 20) }), 17 * 60);
  assert.equal(yearView.initialScrollY({ date: at(2025, 3, 3), now: at(2026, 10, 20) }), 0);
  assert.equal(yearView.initialScrollY({ now: at(2026, 10, 20) }), 17 * 60, 'no date → this year');
  assert.equal(yearView.initialScrollY({ date: at(2026, 3, 3), now: new Date(NaN) }), 0);
  assert.equal(yearView.initialScrollY(), Math.max(0, (new Date().getDate() - 3) * 60));
  const y = yearView.initialScrollY({ date: at(2026, 1, 1), now: at(2026, 10, 20), range });
  assert.ok(y >= 0 && y <= SPEC.H);
});
