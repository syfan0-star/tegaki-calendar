// Tests for module F1 (js/views/view-common.js, day/week/month views).
// Pure helpers are tested directly; render() is smoke-tested against a tiny fake DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendNowLayer,
  appendTimeAxis,
  applyPageScale,
  collapseAllDayRows,
  computePageScale,
  createPageElements,
  dayClassList,
  dayFlags,
  dayNumberLabel,
  eventAriaLabel,
  eventBoxMode,
  eventColorVars,
  eventTimeText,
  eventTitle,
  fitChips,
  fontLu,
  fontPx,
  gutterLabelLu,
  hexToRgba,
  hourLabel,
  initialScrollFor,
  keepNowLineCurrent,
  keepPageInPlace,
  monthCellMetrics,
  normalizeHex,
  pct,
  readableTextColor,
  rectStyle,
  sanitizeEvents,
  stopNowTicker,
  svgEl,
  timedBoxRect,
  TYPE,
} from '../js/views/view-common.js';

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
      toggle: (c, force) => {
        const on = force === undefined ? !get().includes(c) : !!force;
        if (on) set([...new Set([...get(), c])]); else set(get().filter((x) => x !== c));
        return on;
      },
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
function mountPage(doc, view, spec, width = 820, height = 1000) {
  const viewportEl = doc.createElement('div');
  Object.defineProperty(viewportEl, 'clientWidth', { value: width });
  Object.defineProperty(viewportEl, 'clientHeight', { value: height });
  const stickyEl = doc.createElement('div');
  stickyEl.className = 'sticky-header';
  doc.root.append(stickyEl, viewportEl);
  const { pageEl, gridEl, eventsEl } = createPageElements(viewportEl);
  const layout = applyPageScale({ viewportEl, pageEl, spec });
  return { viewportEl, stickyEl, pageEl, gridEl, eventsEl, layout };
}

// Real sibling modules (A) — they exist alongside this module.
const { PAGE_SPECS, rangeFor } = await import('../js/views/page-geometry.js');
const { layoutTimedEvents } = await import('../js/views/event-layout.js');
const dayView = await import('../js/views/day-view.js');
const weekView = await import('../js/views/week-view.js');
const monthView = await import('../js/views/month-view.js');

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

// ---------------------------------------------------------------------------------------------
// Pure helpers

test('computePageScale: width fit uses the client width, contain fits both and centers', () => {
  const week = computePageScale({ clientWidth: 820, clientHeight: 900, spec: PAGE_SPECS.week });
  assert.equal(week.scale, 820 / 1400);
  assert.equal(week.cssW, 820);
  assert.ok(Math.abs(week.cssH - 1920 * (820 / 1400)) < 1e-9);
  assert.equal(week.offsetX, 0);

  const month = computePageScale({ clientWidth: 1180, clientHeight: 700, spec: PAGE_SPECS.month });
  assert.equal(month.scale, 700 / 1050);
  assert.ok(Math.abs(month.cssH - 700) < 1e-9);
  assert.equal(month.offsetX, Math.floor((1180 - 1400 * (700 / 1050)) / 2));

  const narrow = computePageScale({ clientWidth: 700, clientHeight: 2000, spec: PAGE_SPECS.month });
  assert.equal(narrow.scale, 0.5);
  assert.equal(narrow.offsetX, 0);
});

test('computePageScale: zero / bad sizes never produce a zero scale', () => {
  assert.equal(computePageScale({ clientWidth: 0, clientHeight: 0, spec: PAGE_SPECS.day }).scale, 1);
  assert.equal(computePageScale({ clientWidth: 0, spec: PAGE_SPECS.day, fallbackWidth: 500 }).scale, 0.5);
  // contain with an unlaid-out height uses the width only
  assert.equal(computePageScale({ clientWidth: 700, clientHeight: 0, spec: PAGE_SPECS.month }).scale, 0.5);
  assert.equal(computePageScale({ clientWidth: NaN, clientHeight: 'x', spec: null }).scale, 1);
});

test('pct and rectStyle produce rounded percentages', () => {
  assert.equal(pct(64, 1400), 4.5714);
  assert.equal(pct(1, 0), 0);
  assert.equal(pct('a', 10), 0);
  assert.equal(rectStyle({ x: 100, y: 240, w: 50, h: 120 }, 1000, 2400), 'left:10%;top:10%;width:5%;height:5%;');
});

test('fontPx / fontLu: scale with the page but keep a legible minimum', () => {
  assert.equal(fontPx(TYPE.weekEvent, 1), 13);
  assert.equal(fontPx(TYPE.weekEvent, 0.5), 10); // 6.5px → min 10px
  assert.equal(fontLu(TYPE.weekEvent, 0.5), 20);
  assert.equal(fontPx(TYPE.weekEvent, 0), 13); // bad scale → 1
});

test('gutterLabelLu: legible on iPad, capped so 23:00 fits the gutter on narrow screens', () => {
  assert.equal(gutterLabelLu(TYPE.weekTimeLabel, 820 / 1400, 64), fontLu(TYPE.weekTimeLabel, 820 / 1400));
  const narrow = gutterLabelLu(TYPE.dayTimeLabel, 0.3, 72);
  assert.ok(narrow * 2.9 <= 72 - 10 + 1e-9);
  assert.ok(narrow < fontLu(TYPE.dayTimeLabel, 0.3));
});

test('timedBoxRect: single and overlapping columns', () => {
  const one = timedBoxRect({ colX: 64, colW: 190, startMin: 540, endMin: 600, hourH: 80 });
  assert.deepEqual(one, { x: 66, y: 721, w: 182, h: 78 });

  const a = timedBoxRect({ colX: 64, colW: 190, startMin: 540, endMin: 600, col: 0, cols: 2, hourH: 80 });
  const b = timedBoxRect({ colX: 64, colW: 190, startMin: 540, endMin: 600, col: 1, cols: 2, hourH: 80 });
  assert.equal(a.w, b.w);
  assert.equal(a.w, (182 - 2) / 2);
  assert.equal(b.x, a.x + a.w + 2);
  assert.ok(b.x + b.w <= 64 + 190 - 6 + 1e-9);

  // col is clamped into [0, cols-1]; very short boxes keep a minimum height
  const c = timedBoxRect({ colX: 0, colW: 100, startMin: 0, endMin: 1, col: 9, cols: 3, hourH: 80 });
  assert.ok(c.x + c.w <= 100);
  assert.equal(c.h, 4);
});

test('eventBoxMode: short / compact / normal / tall', () => {
  assert.equal(eventBoxMode({ durationMin: 15, heightPx: 100, fontPx: 12 }), 'short');
  assert.equal(eventBoxMode({ durationMin: 29, heightPx: 100, fontPx: 12 }), 'short');
  assert.equal(eventBoxMode({ durationMin: 30, heightPx: 23, fontPx: 10 }), 'compact');
  assert.equal(eventBoxMode({ durationMin: 60, heightPx: 40, fontPx: 12 }), 'normal');
  assert.equal(eventBoxMode({ durationMin: 120, heightPx: 140, fontPx: 12 }), 'tall');
  assert.equal(eventBoxMode({ durationMin: NaN, heightPx: 140, fontPx: 12 }), 'short');
});

test('fitChips: all fit, or (slots-1) chips + more line', () => {
  assert.deepEqual(fitChips(0, 100, 20, 2), { shown: 0, more: 0 });
  assert.deepEqual(fitChips(3, 70, 22, 2), { shown: 3, more: 0 }); // 3*22 + 2*2 = 70
  assert.deepEqual(fitChips(4, 70, 22, 2), { shown: 2, more: 2 });
  assert.deepEqual(fitChips(10, 5, 22, 2), { shown: 0, more: 10 }); // always one line
  assert.deepEqual(fitChips(1, 5, 22, 2), { shown: 1, more: 0 });
  assert.deepEqual(fitChips(2, 100, 0, 0), { shown: 2, more: 0 }); // degenerate chip size
  assert.deepEqual(fitChips(-3, 100, 20), { shown: 0, more: 0 });
});

test('monthCellMetrics: chips stay in the top ~60% and at least 3 lines fit on an iPad', () => {
  for (const s of [820 / 1400, 700 / 1050, 0.8, 1.2]) {
    const m = monthCellMetrics(s);
    assert.ok(m.headerLu > 0 && m.headerLu < m.listBottomLu, `header at scale ${s}`);
    assert.ok(m.listBottomLu <= 175 * 0.65);
    const fit = fitChips(99, m.listBottomLu - m.headerLu, m.chipLu, m.gapLu);
    assert.ok(fit.shown + 1 >= 3, `scale ${s}: ${fit.shown} chips + more`);
    assert.ok(m.chipPx >= TYPE.monthChip.minPx && m.datePx >= TYPE.monthDate.minPx);
  }
});

test('collapseAllDayRows: passes through when few rows', () => {
  const items = [
    { event: {}, startCol: 0, endCol: 2, row: 0 },
    { event: {}, startCol: 1, endCol: 1, row: 1 },
  ];
  const r = collapseAllDayRows(items, 7, 3);
  assert.equal(r.rows, 2);
  assert.equal(r.visible.length, 2);
  assert.deepEqual(r.overflow, [0, 0, 0, 0, 0, 0, 0]);
});

test('collapseAllDayRows: collapses extra rows into per-day counts, promoting lone events', () => {
  const items = [
    { event: 'a', startCol: 0, endCol: 6, row: 0 },
    { event: 'b', startCol: 0, endCol: 3, row: 1 },
    { event: 'c', startCol: 0, endCol: 1, row: 2 }, // shares col 0/1 with d → hidden
    { event: 'd', startCol: 0, endCol: 0, row: 3 },
    { event: 'e', startCol: 5, endCol: 6, row: 2 }, // alone on 5..6 → promoted
    { event: 'x', startCol: 9, endCol: 9, row: 0 }, // out of range → dropped
    null,
  ];
  const r = collapseAllDayRows(items, 7, 3);
  assert.equal(r.rows, 3);
  assert.deepEqual(r.visible.map((it) => it.event).sort(), ['a', 'b', 'e']);
  assert.deepEqual(r.overflow, [2, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(collapseAllDayRows(null, 7).visible, []);
});

test('sanitizeEvents drops malformed entries', () => {
  const good = ev(at(2026, 10, 4, 9), at(2026, 10, 4, 10));
  const out = sanitizeEvents([
    good, null, 'x', { start: 'a', end: 'b' }, { start: new Date(NaN), end: new Date() },
    { start: at(2026, 10, 4, 10), end: at(2026, 10, 4, 9) },
  ]);
  assert.deepEqual(out, [good]);
  assert.deepEqual(sanitizeEvents(undefined), []);
});

test('colors: hex normalization, rgba, readable text, and no CSS injection', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex(' #039BE5 '), '#039be5');
  assert.equal(normalizeHex('red'), null);
  assert.equal(hexToRgba('#ff0000', 0.85), 'rgba(255, 0, 0, 0.85)');
  assert.equal(hexToRgba('bogus', 2), 'rgba(3, 155, 229, 1)');
  assert.equal(readableTextColor('#fbd75b'), '#1d1d1d');
  assert.equal(readableTextColor('#5484ed'), '#ffffff');

  const vars = eventColorVars({ color: 'red;background:url(http://x)', textColor: '}' });
  assert.ok(!vars.includes('url('));
  assert.match(vars, /^--ev:#039be5;--ev-bg:rgba\(3, 155, 229, 0\.85\);--ev-fg:#[0-9a-f]{6};$/);
  assert.equal(eventColorVars({ color: '#fbd75b' }), '--ev:#fbd75b;--ev-bg:rgba(251, 215, 91, 0.85);--ev-fg:#1d1d1d;');
});

test('event text helpers', () => {
  const e = ev(at(2026, 10, 4, 9), at(2026, 10, 4, 10, 30), { title: '  会議 ', location: '会議室A' });
  assert.equal(eventTitle(e), '会議');
  assert.equal(eventTitle({ title: '' }), '(タイトルなし)');
  assert.equal(eventTimeText(e), '9:00〜10:30');
  assert.equal(eventTimeText({ ...e, allDay: true }), '終日');
  assert.equal(eventAriaLabel(e), '会議、9:00〜10:30、会議室A');
});

test('dayFlags / dayClassList: Sunday & holidays red, Saturday blue, holiday wins on Saturday', () => {
  const now = at(2026, 10, 4, 12);
  const sun = dayFlags(at(2026, 10, 4), null, now);
  assert.equal(sun.red, true);
  assert.equal(sun.isToday, true);
  assert.deepEqual(dayClassList(sun), ['is-red', 'is-weekend', 'is-today']);
  const sat = dayFlags(at(2026, 10, 3), null, now);
  assert.equal(sat.blue, true);
  assert.equal(sat.red, false);
  const satHoliday = dayFlags(at(2026, 10, 3), 'テストの日', now);
  assert.equal(satHoliday.red, true);
  assert.equal(satHoliday.blue, false);
  const mon = dayFlags(at(2026, 10, 12), 'スポーツの日', now);
  assert.deepEqual(dayClassList(mon), ['is-red', 'is-holiday', 'is-weekend']);
  assert.equal(dayFlags(at(2026, 10, 7), '', now).weekend, false);
});

test('dayNumberLabel / hourLabel', () => {
  assert.equal(dayNumberLabel(at(2026, 10, 4)), '4');
  assert.equal(dayNumberLabel(at(2026, 11, 1)), '11/1');
  assert.equal(dayNumberLabel(new Date(NaN)), '');
  assert.equal(hourLabel(0), '0:00');
  assert.equal(hourLabel(23), '23:00');
});

test('initialScrollMinutes: now-60 when today is shown, else 7:00', () => {
  const now = at(2026, 10, 4, 14, 20);
  assert.equal(initialScrollFor(true, now), 800);
  assert.equal(initialScrollFor(false, now), 420);
  assert.equal(initialScrollFor(true, at(2026, 10, 4, 0, 30)), 0);

  assert.equal(dayView.initialScrollMinutes({ date: at(2026, 10, 4), now }), 800);
  assert.equal(dayView.initialScrollMinutes({ date: at(2026, 10, 5), now }), 420);

  // week: any day of the week containing today counts (Sun-start week 10/4..10/10)
  assert.equal(weekView.initialScrollMinutes({ date: at(2026, 10, 9), now, weekStart: 0 }), 800);
  assert.equal(weekView.initialScrollMinutes({ date: at(2026, 10, 11), now, weekStart: 0 }), 420);
  // default Monday start: 10/4 (Sun) belongs to 9/28..10/4, so 10/9 is another week
  assert.equal(weekView.initialScrollMinutes({ date: at(2026, 10, 1), now }), 800);
  assert.equal(weekView.initialScrollMinutes({ date: at(2026, 10, 9), now }), 420);
  const monWeek = rangeFor('week', at(2026, 10, 3), 1); // 9/28..10/4
  assert.equal(weekView.initialScrollMinutes({ date: at(2026, 10, 3), now, range: monWeek }), 800);
  assert.equal(weekView.initialScrollMinutes({ date: at(2026, 10, 3), now, weekStart: 1 }), 800);
  assert.equal(weekView.initialScrollMinutes({ date: at(2026, 10, 3), now, weekStart: 0 }), 420); // Sun-start: 9/27..10/3

  assert.equal(monthView.initialScrollMinutes({ date: at(2026, 10, 4), now }), 0);
});

// ---------------------------------------------------------------------------------------------
// DOM: page elements and scale

test('createPageElements clears the viewport and builds page > svg.grid + div.events', () => withDom((doc) => {
  const viewportEl = doc.createElement('div');
  viewportEl.append(doc.createElement('p'));
  const { pageEl, gridEl, eventsEl } = createPageElements(viewportEl);
  assert.equal(viewportEl.childNodes.length, 1);
  assert.equal(viewportEl.childNodes[0], pageEl);
  assert.equal(pageEl.className, 'page');
  assert.deepEqual(pageEl.childNodes, [gridEl, eventsEl]);
  assert.equal(gridEl.namespaceURI, SVG_NS);
  assert.equal(gridEl.getAttribute('class'), 'grid');
  assert.equal(gridEl.getAttribute('preserveAspectRatio'), 'none');
  assert.equal(eventsEl.className, 'events');
  assert.throws(() => createPageElements(null), TypeError);
}));

test('applyPageScale sizes the page and sets --s / centering margin', () => withDom((doc) => {
  const viewportEl = doc.createElement('div');
  Object.defineProperty(viewportEl, 'clientWidth', { value: 1180 });
  Object.defineProperty(viewportEl, 'clientHeight', { value: 700 });
  const { pageEl } = createPageElements(viewportEl);
  const res = applyPageScale({ viewportEl, pageEl, spec: PAGE_SPECS.month });
  assert.equal(pageEl.style.width, `${res.cssW}px`);
  assert.equal(pageEl.style.height, `${res.cssH}px`);
  assert.equal(pageEl.style.getPropertyValue('--s'), String(res.scale));
  assert.equal(pageEl.style.marginLeft, `${res.offsetX}px`);
  assert.equal(pageEl.dataset.fit, 'contain');

  const week = applyPageScale({ viewportEl, pageEl, spec: PAGE_SPECS.week });
  assert.equal(week.cssW, 1180);
  assert.equal(pageEl.style.marginLeft, '');
}));

test('svgEl sets attributes and skips empty values', () => withDom(() => {
  const el = svgEl('rect', { x: 1, y: 0, hidden: false, fill: null, class: 'a' });
  assert.equal(el.getAttribute('x'), '1');
  assert.equal(el.getAttribute('y'), '0');
  assert.equal(el.getAttribute('hidden'), null);
  assert.equal(el.getAttribute('fill'), null);
}));

test('appendTimeAxis draws hour/half-hour paths and 24 labels', () => withDom((doc) => {
  const g = doc.createElement('g');
  appendTimeAxis(g, { x0: 64, x1: 1400, H: 1920, hourH: 80, labelX: 56, labelLu: 12 });
  const labels = g.findTag('text').map((t) => t.textContent);
  assert.equal(labels.length, 24);
  assert.equal(labels[0], '0:00');
  assert.equal(labels[23], '23:00');
  const half = g.findAll('g-half')[0];
  assert.equal(half.getAttribute('vector-effect'), 'non-scaling-stroke');
  assert.match(half.getAttribute('d'), /^M64 40H1400/);
}));

// ---------------------------------------------------------------------------------------------
// DOM: views

function busyWeekEvents(weekStart) {
  const out = [];
  for (let i = 0; i < 200; i++) {
    const day = i % 7;
    const startMin = 6 * 60 + ((i * 37) % (14 * 60));
    const s = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + day, 0, startMin);
    out.push(ev(s, new Date(s.getTime() + (15 + (i % 6) * 15) * 60000)));
  }
  out.push(ev(at(2026, 10, 2), at(2026, 10, 6), { allDay: true, title: '出張' }));
  for (let i = 0; i < 4; i++) out.push(ev(at(2026, 10, 6), at(2026, 10, 7), { allDay: true }));
  return out;
}

test('week render: event boxes, sticky header, taps, idempotence', () => withDom((doc) => {
  const spec = PAGE_SPECS.week;
  const m = mountPage(doc, 'week', spec);
  const date = at(2026, 10, 4);
  const now = at(2026, 10, 6, 14, 0);
  const range = rangeFor('week', date, 0);
  const events = busyWeekEvents(range.start);
  const tapped = [];
  const days = [];
  const params = {
    ...m, date, range, events, settings: { weekStart: 0 }, now,
    onEventTap: (e) => tapped.push(e), onDayTap: (d) => days.push(d),
  };

  const t0 = performance.now();
  weekView.render(params);
  const elapsed = performance.now() - t0;

  const expected = range.days.reduce((n, d) => n + layoutTimedEvents(events, d).length, 0);
  const boxes = m.eventsEl.findAll('event');
  assert.equal(boxes.length, expected);
  assert.ok(expected >= 200);
  assert.ok(elapsed < 250, `render took ${elapsed}ms`); // fake DOM; real budget is checked in the browser

  const box = boxes[0];
  assert.match(box.style.cssText, /left:[\d.]+%;top:[\d.]+%;width:[\d.]+%;height:[\d.]+%/);
  assert.equal(box.getAttribute('role'), 'button');
  assert.ok(box.dataset.eventId && box.dataset.calendarId === 'primary');
  assert.ok(box.getAttribute('aria-label'));
  assert.equal(box.style.getPropertyValue('touch-action'), '');

  // finger/mouse click → onEventTap; Pencil click is ink, not a tap
  box.fire('click', { pointerType: 'touch' });
  assert.equal(tapped.length, 1);
  assert.equal(tapped[0].id, box.dataset.eventId);
  box.fire('click', { pointerType: 'pen' });
  assert.equal(tapped.length, 1);
  const key = box.fire('keydown', { key: 'Enter' });
  assert.equal(tapped.length, 2);
  assert.equal(key.defaultPrevented, true);

  // short events show only the title on one line
  const short = boxes.find((b) => b.className.includes('is-short'));
  assert.ok(short);
  assert.equal(short.findAll('ev-time').length, 0);

  // grid: viewBox, today tint; now line in the today column (10/6 = col 2), drawn ABOVE the event boxes
  assert.equal(m.gridEl.getAttribute('viewBox'), '0 0 1400 1920');
  assert.equal(m.gridEl.findAll('g-today').length, 1);
  assert.equal(m.gridEl.findAll('g-weekend').length, 2);
  assert.equal(m.gridEl.findAll('g-now').length, 0);
  const layer = m.eventsEl.childNodes.at(-1);
  assert.equal(layer.getAttribute('class'), 'now-layer');
  assert.equal(layer.namespaceURI, SVG_NS);
  assert.equal(layer.getAttribute('viewBox'), '0 0 1400 1920');
  assert.equal(layer.getAttribute('preserveAspectRatio'), 'none');
  const nowLine = layer.findAll('g-now')[0];
  const line = nowLine.findTag('line')[0];
  assert.equal(Number(line.getAttribute('y1')), (14 * 60 * 80) / 60);
  assert.equal(Number(line.getAttribute('x1')), 64 + 2 * ((1400 - 64) / 7));

  // sticky header: 7 day headers, holiday/today classes, all-day rows
  assert.equal(m.stickyEl.dataset.view, 'week');
  const heads = m.stickyEl.findAll('sh-day');
  assert.equal(heads.length, 7);
  assert.ok(heads[0].className.includes('is-red')); // Sunday 10/4
  assert.ok(heads[6].className.includes('is-blue')); // Saturday 10/10
  assert.ok(heads[2].className.includes('is-today'));
  heads[3].fire('click', {});
  assert.equal(days.length, 1);
  assert.equal(days[0].getDate(), 7);
  const inner = m.stickyEl.findAll('sh-inner')[0];
  assert.equal(inner.style.width, `${m.layout.cssW}px`);
  assert.equal(inner.style.getPropertyValue('--sh-gutter'), `${pct(64, 1400)}%`);
  const chips = m.stickyEl.findAll('ad-chip');
  const trip = chips.find((c) => c.textContent === '出張');
  assert.ok(trip.className.includes('cont-left')); // started 10/2, before this week
  assert.equal(trip.style.gridColumn, '2 / 4'); // 10/4..10/5
  assert.ok(m.stickyEl.findAll('ad-more').length >= 1); // 4 all-day events on 10/6 > 3 rows
  m.stickyEl.findAll('ad-more')[0].fire('click', {});
  assert.equal(days[1].getDate(), 6);

  // idempotent
  weekView.render({ ...params, events: events.slice(0, 10) });
  assert.equal(m.eventsEl.findAll('event').length,
    range.days.reduce((n, d) => n + layoutTimedEvents(events.slice(0, 10), d).length, 0));
  assert.equal(m.stickyEl.findAll('sh-day').length, 7);
  assert.equal(m.eventsEl.findAll('g-now').length, 1);
  assert.equal(m.eventsEl.childNodes.at(-1).getAttribute('class'), 'now-layer');

  // no now line when today is not in range
  weekView.render({ ...params, now: at(2026, 11, 20, 9) });
  assert.equal(m.eventsEl.findAll('g-now').length, 0);
  assert.equal(m.eventsEl.findAll('now-layer').length, 0);
  assert.equal(m.gridEl.findAll('g-today').length, 0);
}));

test('week render tolerates missing/garbage inputs', () => withDom((doc) => {
  const m = mountPage(doc, 'week', PAGE_SPECS.week);
  weekView.render({ ...m, layout: null, date: 'nope', range: null, events: [null, 1, {}], settings: null });
  assert.equal(m.stickyEl.findAll('sh-day').length, 7);
  assert.equal(m.eventsEl.findAll('event').length, 0);
  assert.throws(() => weekView.render({}), TypeError);
}));

test('day render: memo area, timeline events, date header and all-day toggle', () => withDom((doc) => {
  const spec = PAGE_SPECS.day;
  const m = mountPage(doc, 'day', spec, 820, 1000);
  const date = at(2026, 10, 12); // スポーツの日 (Mon)
  const now = at(2026, 10, 12, 9, 30);
  const allDay = Array.from({ length: 5 }, () => ev(at(2026, 10, 12), at(2026, 10, 13), { allDay: true }));
  const timed = [
    ev(at(2026, 10, 12, 9), at(2026, 10, 12, 11), { location: '本社', title: '定例' }),
    ev(at(2026, 10, 12, 9, 30), at(2026, 10, 12, 10)),
    ev(at(2026, 10, 12, 13), at(2026, 10, 12, 13, 15)),
  ];
  const days = [];
  dayView.render({
    ...m, date, range: rangeFor('day', date), events: [...allDay, ...timed], settings: {}, now,
    onEventTap: () => {}, onDayTap: (d) => days.push(d),
  });

  assert.equal(m.pageEl.dataset.view, 'day');
  assert.equal(m.gridEl.getAttribute('viewBox'), '0 0 1000 2400');
  const memo = m.gridEl.findAll('g-memo-label')[0];
  assert.equal(memo.textContent, 'メモ');
  assert.ok(Number(memo.getAttribute('x')) >= spec.timelineRight);
  const rules = m.gridEl.findAll('g-rule')[0].getAttribute('d');
  assert.equal((rules.match(/M/g) || []).length, 2400 / 50 - 1);
  assert.equal(m.gridEl.findAll('g-now').length, 0);
  assert.equal(m.eventsEl.findAll('g-now').length, 1);
  assert.equal(m.eventsEl.childNodes.at(-1).getAttribute('class'), 'now-layer'); // above the boxes

  const boxes = m.eventsEl.findAll('event');
  assert.equal(boxes.length, 3);
  for (const b of boxes) {
    const left = parseFloat(b.style.left);
    const width = parseFloat(b.style.width);
    assert.ok(left >= pct(spec.gutter, spec.W) && left + width <= pct(spec.timelineRight, spec.W) + 1e-6);
  }
  const tall = boxes.find((b) => b.textContent.includes('定例'));
  assert.ok(tall.className.includes('is-tall'));
  assert.ok(tall.textContent.includes('本社'));

  const head = m.stickyEl.findAll('sh-day')[0];
  assert.ok(head.className.includes('is-red') && head.className.includes('is-holiday'));
  assert.ok(head.textContent.includes('スポーツの日'));
  assert.ok(head.textContent.includes('月曜日'));
  head.fire('click', {});
  assert.equal(days.length, 1);

  const items = m.stickyEl.findAll('sh-allday-items')[0];
  assert.equal(items.findAll('ad-chip').length, 5);
  assert.equal(items.findAll('is-extra').length, 2);
  const toggle = items.findAll('ad-toggle')[0];
  assert.equal(toggle.textContent, '他2件');
  toggle.fire('click', {});
  assert.ok(items.className.includes('is-expanded'));
  assert.equal(toggle.textContent, '折りたたむ');
  toggle.fire('click', {});
  assert.ok(!items.className.includes('is-expanded'));
}));

// ---------------------------------------------------------------------------------------------
// The paper never moves under the Pencil when the sticky header changes height

test('keepPageInPlace: scrolls by the header delta on width pages, leaves contain pages alone', () => {
  let header = 50;
  const vp = { scrollTop: 100 };
  const pageEl = { parentNode: vp, getBoundingClientRect: () => ({ top: header - vp.scrollTop }) };
  assert.equal(keepPageInPlace(pageEl, 'width', () => { header = 120; return 'done'; }), 'done');
  assert.equal(vp.scrollTop, 170);
  assert.equal(pageEl.getBoundingClientRect().top, -50); // same on-screen position as before
  keepPageInPlace(pageEl, 'width', () => { header = 50; });
  assert.equal(vp.scrollTop, 100);
  // never scrolls above the top
  vp.scrollTop = 20;
  keepPageInPlace(pageEl, 'width', () => { header = 0; });
  assert.equal(vp.scrollTop, 0);
  // month (contain) does not scroll: untouched
  header = 50;
  keepPageInPlace(pageEl, 'contain', () => { header = 120; });
  assert.equal(vp.scrollTop, 0);
  // still compensates when the render step throws
  header = 50;
  vp.scrollTop = 100;
  assert.throws(() => keepPageInPlace(pageEl, 'width', () => { header = 60; throw new Error('boom'); }), /boom/);
  assert.equal(vp.scrollTop, 110);
  // nothing to measure: just runs fn
  assert.equal(keepPageInPlace({}, 'width', () => 7), 7);
  assert.equal(keepPageInPlace(null, 'width', () => 8), 8);
});

/**
 * Fake layout like #app: the viewport's top edge sits right below the sticky header (whose height is
 * computed from its content by `headerHeight`), and the page scrolls inside the viewport.
 */
function simulateStickyLayout(m, headerHeight) {
  let scrollTop = 0;
  Object.defineProperty(m.viewportEl, 'scrollTop', {
    get: () => scrollTop, set: (v) => { scrollTop = Math.max(0, Number(v)); }, configurable: true,
  });
  m.pageEl.getBoundingClientRect = () => ({
    left: 0, top: 52 + headerHeight(m.stickyEl) - scrollTop, width: m.layout.cssW, height: m.layout.cssH,
  });
  return () => m.pageEl.getBoundingClientRect().top;
}

test('week render: all-day rows arriving with the events do not move the page under the Pencil', () => withDom((doc) => {
  const m = mountPage(doc, 'week', PAGE_SPECS.week);
  const rows = (sticky) => {
    const ad = sticky.findAll('sh-allday')[0];
    return ad ? Number(/repeat\((\d+)/.exec(ad.style.gridTemplateRows)?.[1] || 0) : 0;
  };
  const pageTop = simulateStickyLayout(m, (sticky) => 48 + (rows(sticky) ? 8 + rows(sticky) * 24 : 0));
  const date = at(2026, 10, 4);
  const base = { ...m, date, range: rangeFor('week', date, 0), settings: { weekStart: 0 }, now: at(2026, 10, 6, 9) };

  weekView.render({ ...base, events: [] }); // first visit: nothing cached yet
  m.viewportEl.scrollTop = 400;
  const top0 = pageTop();

  const allDay = [
    ev(at(2026, 10, 5), at(2026, 10, 6), { allDay: true }),
    ev(at(2026, 10, 5), at(2026, 10, 7), { allDay: true }),
  ];
  weekView.render({ ...base, events: allDay }); // the fetch lands: 2 all-day rows appear
  assert.equal(rows(m.stickyEl), 2);
  assert.equal(m.viewportEl.scrollTop, 400 + 8 + 2 * 24);
  assert.equal(pageTop(), top0);

  const many = [...allDay, ...Array.from({ length: 4 }, () => ev(at(2026, 10, 5), at(2026, 10, 6), { allDay: true }))];
  weekView.render({ ...base, events: many }); // collapsed to 3 rows
  assert.equal(rows(m.stickyEl), 3);
  assert.equal(pageTop(), top0);

  weekView.render({ ...base, events: [] }); // removed elsewhere (periodic refresh)
  assert.equal(m.viewportEl.scrollTop, 400);
  assert.equal(pageTop(), top0);
}));

test('day render: the 他n件 toggle and new all-day events keep the page in place', () => withDom((doc) => {
  const m = mountPage(doc, 'day', PAGE_SPECS.day);
  const headerHeight = (sticky) => {
    const items = sticky.findAll('sh-allday-items')[0];
    if (!items) return 52;
    const open = items.className.includes('is-expanded');
    const chips = items.findAll('ad-chip').filter((c) => open || !c.className.includes('is-extra')).length;
    return 52 + 8 + (chips + items.findAll('ad-toggle').length) * 24;
  };
  const pageTop = simulateStickyLayout(m, headerHeight);
  const date = at(2026, 10, 13);
  const base = { ...m, date, range: rangeFor('day', date), settings: {}, now: at(2026, 10, 13, 9) };
  const allDay = Array.from({ length: 5 }, () => ev(at(2026, 10, 13), at(2026, 10, 14), { allDay: true }));

  dayView.render({ ...base, events: [] });
  m.viewportEl.scrollTop = 300;
  const top0 = pageTop();
  dayView.render({ ...base, events: allDay });
  assert.equal(m.viewportEl.scrollTop, 300 + 8 + 4 * 24); // 3 chips + toggle
  assert.equal(pageTop(), top0);

  const toggle = m.stickyEl.findAll('ad-toggle')[0];
  toggle.fire('click', {});
  assert.equal(toggle.textContent, '折りたたむ');
  assert.equal(m.viewportEl.scrollTop, 300 + 8 + 6 * 24);
  assert.equal(pageTop(), top0);
  toggle.fire('click', {});
  assert.equal(m.viewportEl.scrollTop, 300 + 8 + 4 * 24);
  assert.equal(pageTop(), top0);
}));

// ---------------------------------------------------------------------------------------------
// Midnight: the today marker follows the clock without any outside re-render

test('keepNowLineCurrent: moves the line, and at midnight removes it and asks for a re-render', (t) => withDom((doc) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const m = mountPage(doc, 'week', PAGE_SPECS.week);
  let clock = at(2026, 10, 6, 23, 58);
  let changes = 0;
  const nowLine = appendNowLayer(m.eventsEl, PAGE_SPECS.week, { x1: 64, x2: 254, y: 10, dotR: 5 });
  const y1 = () => Number(nowLine.g.findTag('line')[0].getAttribute('y1'));
  keepNowLineCurrent({
    gridEl: m.gridEl, nowLine, renderedAt: clock, yOfMinutes: (min) => min,
    onDayChange: () => { changes += 1; }, clock: () => clock,
  });
  clock = at(2026, 10, 6, 23, 59);
  t.mock.timers.tick(30000);
  assert.equal(y1(), 23 * 60 + 59);
  assert.equal(changes, 0);
  clock = at(2026, 10, 7, 0, 0);
  t.mock.timers.tick(30000);
  assert.equal(nowLine.g.isConnected, false); // yesterday's line is gone
  assert.equal(changes, 1);
  t.mock.timers.tick(60000);
  assert.equal(changes, 1); // stopped: the re-render arms a new ticker

  // pages without a now line (another day, month) still watch for midnight
  keepNowLineCurrent({ gridEl: m.gridEl, renderedAt: clock, onDayChange: () => { changes += 1; }, clock: () => clock });
  t.mock.timers.tick(30000);
  assert.equal(changes, 1);
  // the page is gone: stops silently
  m.viewportEl.remove();
  clock = at(2026, 10, 8, 0, 1);
  t.mock.timers.tick(30000);
  assert.equal(changes, 1);
}));

test('week render: after midnight today\'s column, header circle and now line move to the new day', (t) => withDom((doc) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: at(2026, 10, 6, 23, 59, 40) });
  const m = mountPage(doc, 'week', PAGE_SPECS.week);
  const date = at(2026, 10, 4);
  weekView.render({
    ...m, date, range: rangeFor('week', date, 0), events: [], settings: { weekStart: 0 }, now: new Date(),
  });
  const todayCols = () => m.stickyEl.findAll('sh-day')
    .map((h, i) => (h.className.includes('is-today') ? i : -1)).filter((i) => i >= 0);
  const colW = (1400 - 64) / 7;
  const lineX = () => Number(m.eventsEl.findAll('g-now')[0].findTag('line')[0].getAttribute('x1'));
  assert.deepEqual(todayCols(), [2]);
  assert.equal(lineX(), 64 + 2 * colW);

  t.mock.timers.tick(30000); // 0:00:10 on 10/7 — no fetch, no visibility change
  assert.deepEqual(todayCols(), [3]);
  assert.equal(m.gridEl.findAll('g-today').length, 1);
  assert.equal(m.eventsEl.findAll('g-now').length, 1);
  assert.equal(lineX(), 64 + 3 * colW);
  assert.equal(Number(m.eventsEl.findAll('g-now')[0].findTag('line')[0].getAttribute('y1')), 0);
}));

test('day render: the next day\'s page gets its today marker and now line at midnight', (t) => withDom((doc) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: at(2026, 10, 6, 23, 59, 50) });
  const m = mountPage(doc, 'day', PAGE_SPECS.day);
  const date = at(2026, 10, 7);
  dayView.render({ ...m, date, range: rangeFor('day', date), events: [], settings: {}, now: new Date() });
  assert.equal(m.eventsEl.findAll('g-now').length, 0);
  assert.ok(!m.stickyEl.findAll('sh-day')[0].className.includes('is-today'));
  t.mock.timers.tick(30000);
  assert.equal(m.eventsEl.findAll('g-now').length, 1);
  assert.ok(m.stickyEl.findAll('sh-day')[0].className.includes('is-today'));
  assert.equal(m.gridEl.findAll('g-today').length, 1);
}));

test('month render: after midnight the today circle moves to the new day', (t) => withDom((doc) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: at(2026, 10, 6, 23, 59, 50) });
  const m = mountPage(doc, 'month', PAGE_SPECS.month, 820, 900);
  const date = at(2026, 10, 1);
  const range = rangeFor('month', date, 0);
  monthView.render({ ...m, date, range, events: [], settings: { weekStart: 0 }, now: new Date() });
  const todayLabel = () => m.eventsEl.findAll('mc').filter((c) => c.className.includes('is-today'))
    .map((c) => c.findAll('mc-date')[0].textContent);
  assert.deepEqual(todayLabel(), ['6']);
  t.mock.timers.tick(30000);
  assert.deepEqual(todayLabel(), ['7']);
}));

test('month render: 42 cells, chips fit the top of the cell, +n件, taps', () => withDom((doc) => {
  const spec = PAGE_SPECS.month;
  const m = mountPage(doc, 'month', spec, 820, 900);
  const date = at(2026, 10, 1);
  const range = rangeFor('month', date, 0);
  const now = at(2026, 10, 4, 10);
  const busy = Array.from({ length: 8 }, (_, i) => ev(at(2026, 10, 15, 8 + i), at(2026, 10, 15, 9 + i)));
  const events = [
    ...busy,
    ev(at(2026, 10, 20), at(2026, 10, 21), { allDay: true, title: '記念日', color: '#fbd75b', textColor: '#1d1d1d' }),
    ev(at(2026, 10, 21, 23), at(2026, 10, 22, 1), { title: '夜行' }),
  ];
  const tapped = [];
  const days = [];
  monthView.render({
    ...m, date, range, events, settings: { weekStart: 0 }, now,
    onEventTap: (e) => tapped.push(e), onDayTap: (d) => days.push(d),
  });

  const cells = m.eventsEl.findAll('mc');
  assert.equal(cells.length, 42);
  assert.equal(m.gridEl.getAttribute('viewBox'), '0 0 1400 1050');
  assert.equal(m.gridEl.findAll('g-today').length, 1);
  assert.equal(m.gridEl.findAll('g-now').length, 0);
  assert.equal(m.eventsEl.findAll('g-now').length, 0);

  const idx = (d) => range.days.findIndex((x) => x.getTime() === d.getTime());
  const busyCell = cells[idx(at(2026, 10, 15))];
  const chips = busyCell.findAll('mc-chip');
  const more = busyCell.findAll('mc-more')[0];
  assert.ok(chips.length >= 2 && chips.length < 8);
  assert.equal(more.textContent, `+${8 - chips.length}件`);
  const metrics = monthCellMetrics(m.layout.scale);
  const bottom = parseFloat(more.style.top) + parseFloat(more.style.height);
  assert.ok(bottom <= pct(metrics.listBottomLu, 175) + 1e-6, 'chips stay in the top part of the cell');
  more.fire('click', {});
  assert.equal(days.at(-1).getDate(), 15);

  // all-day events are bars over the cells (not chips inside them)
  assert.equal(cells[idx(at(2026, 10, 20))].findAll('mc-chip').filter((c) => c.className.includes('is-allday')).length, 0);
  const bars = m.eventsEl.findAll('mc-bar');
  assert.equal(bars.length, 1);
  assert.ok(bars[0].textContent.includes('記念日'));
  assert.equal(bars[0].style.getPropertyValue('--ev'), '#fbd75b');
  bars[0].fire('click', { pointerType: 'mouse' });
  assert.equal(tapped.at(-1).title, '記念日');

  // overnight event: start time on day 1, '〜1:00' on day 2
  assert.equal(cells[idx(at(2026, 10, 21))].findAll('mc-time')[0].textContent, '23:00');
  assert.equal(cells[idx(at(2026, 10, 22))].findAll('mc-time')[0].textContent, '〜1:00');

  // date number tap, out-of-month and today classes
  const todayCell = cells[idx(at(2026, 10, 4))];
  assert.ok(todayCell.className.includes('is-today'));
  todayCell.findAll('mc-date')[0].fire('click', {});
  assert.equal(days.at(-1).getDate(), 4);
  assert.ok(cells[0].className.includes('is-out')); // 9/27
  assert.equal(cells[idx(at(2026, 10, 1))].findAll('mc-date')[0].textContent, '10/1');
  assert.ok(cells[idx(at(2026, 10, 12))].textContent.includes('スポーツの日'));

  // sticky: weekday labels in column order
  const labels = m.stickyEl.findAll('sh-wdcell').map((c) => c.textContent);
  assert.deepEqual(labels, ['日', '月', '火', '水', '木', '金', '土']);
  assert.equal(m.stickyEl.style.paddingLeft, `${m.layout.offsetX}px`);

  // Monday-start grid
  const monRange = rangeFor('month', date, 1);
  monthView.render({ ...m, date, range: monRange, events, settings: { weekStart: 1 }, now });
  const monLabels = m.stickyEl.findAll('sh-wdcell');
  assert.equal(monLabels[0].textContent, '月');
  assert.ok(monLabels[6].className.includes('is-red'));
}));

test('month: every all-day event is shown as a bar — many lanes get thinner, multi-day bars span and continue', () => withDom((doc) => {
  const spec = PAGE_SPECS.month;
  const m = mountPage(doc, 'month', spec, 820, 900);
  const date = at(2026, 10, 1);
  const range = rangeFor('month', date, 1); // Monday start: 9/28 .. 11/8
  const now = at(2026, 10, 4, 10);
  const many = Array.from({ length: 9 }, (_, i) => ev(at(2026, 10, 14), at(2026, 10, 15), { allDay: true, title: `タスク${i + 1}` }));
  const trip = ev(at(2026, 10, 9), at(2026, 10, 14), { allDay: true, title: '旅行' }); // Fri 10/9 .. Tue 10/13
  const timed = ev(at(2026, 10, 14, 9), at(2026, 10, 14, 10), { title: '会議' });
  const tapped = [];
  monthView.render({
    ...m, date, range, events: [...many, trip, timed], settings: { weekStart: 1 }, now,
    onEventTap: (e) => tapped.push(e), onDayTap: () => {},
  });
  const bars = m.eventsEl.findAll('mc-bar');
  const titles = bars.map((b) => b.textContent);
  for (let i = 1; i <= 9; i++) assert.ok(titles.includes(`タスク${i}`), `タスク${i} shown`);
  // the trip crosses the week boundary (Sun 10/11 → Mon 10/12): two bars, continuing
  const tripBars = bars.filter((b) => b.textContent === '旅行');
  assert.equal(tripBars.length, 2);
  assert.ok(tripBars[0].className.includes('cont-right'));
  assert.ok(tripBars[1].className.includes('cont-left'));
  // all 9 + the trip's 10/13 lane fit inside the row: thinner lanes, smaller text
  const metrics = monthCellMetrics(m.layout.scale);
  const lm = monthView.allDayLaneMetrics(10, metrics);
  assert.ok(lm.fontScale < 1);
  assert.ok(metrics.headerLu + 10 * lm.step - metrics.gapLu <= 175 - 2 + 1e-6);
  const rowTop = 2 * 175; // 10/14 is in the third row
  for (const b of bars.filter((x) => x.textContent.startsWith('タスク'))) {
    const top = parseFloat(b.style.top) / 100 * 1050;
    const bottom = top + parseFloat(b.style.height) / 100 * 1050;
    assert.ok(top >= rowTop && bottom <= rowTop + 175 + 1e-6, 'bar stays inside its row');
  }
  // the timed event of that day cannot fit any more: '+1件' next to the date number
  const idx = range.days.findIndex((x) => x.getTime() === at(2026, 10, 14).getTime());
  const cell = m.eventsEl.findAll('mc')[idx];
  const badge = cell.findAll('mc-more')[0];
  assert.equal(badge.textContent, '+1件');
  assert.ok(badge.className.includes('is-badge'));
  bars[0].fire('click', { pointerType: 'mouse' });
  assert.equal(tapped.length, 1);
}));

test('month layout helpers: lanes keep their size when they fit; timed chips use the space below', () => {
  const metrics = monthCellMetrics(0.6);
  const one = monthView.allDayLaneMetrics(1, metrics);
  assert.equal(one.laneLu, metrics.chipLu);
  assert.equal(one.fontScale, 1);
  const none = monthView.timedChipLayout(0, 0, one.step, metrics);
  assert.equal(none.shown, 0);
  const free = monthView.timedChipLayout(2, 0, one.step, metrics);
  assert.deepEqual([free.shown, free.more], [2, 0]);
  assert.equal(free.top, metrics.headerLu);
  const below = monthView.timedChipLayout(2, 2, one.step, metrics);
  assert.equal(below.top, metrics.headerLu + 2 * one.step);
  const full = monthView.timedChipLayout(3, 20, one.step, metrics);
  assert.deepEqual([full.shown, full.more, full.slots], [0, 3, 0]);
});
