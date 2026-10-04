// Shared building blocks for the day / week / month pages (module F1).
//
// Every page lives in a fixed logical coordinate system (W×H "lu", see page-geometry.js):
//   - grid lines are drawn in ONE <svg class="grid" viewBox="0 0 W H" preserveAspectRatio="none">.
//     The page always keeps its aspect ratio (css size = W*scale × H*scale), so the scaling is uniform
//     and text is not distorted; lines use vector-effect="non-scaling-stroke" to stay hairline-crisp;
//   - HTML overlays (event boxes, month cells) are positioned with percentages of W/H;
//   - text sizes follow the page scale but never drop below a legible size in CSS px. The JS computes
//     them once per render (single source of truth) and hands them to CSS through custom properties.
//
// The pure helpers below (no DOM access) are exported for unit tests. DOM helpers only touch the
// document lazily, inside functions, so this module can be imported in Node.

import { formatTimeJa, formatTimeRangeJa, isSameDay, isValidDate, minutesOfDay, startOfDay } from '../util/date.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Colors the JS needs (everything else lives in styles/views.css). */
export const PALETTE = Object.freeze({
  accent: '#2563eb',
  fallbackEvent: '#039be5', // Google's default "Peacock" when an event has no usable color
  darkText: '#1d1d1d',
  lightText: '#ffffff',
});

/**
 * Text sizes: `lu` is the size in logical units (it scales with the page), `minPx` the smallest
 * on-screen size in CSS px. See fontPx().
 */
export const TYPE = Object.freeze({
  dayEvent: Object.freeze({ lu: 14, minPx: 11 }),
  weekEvent: Object.freeze({ lu: 13, minPx: 10 }),
  dayTimeLabel: Object.freeze({ lu: 13, minPx: 10.5 }),
  weekTimeLabel: Object.freeze({ lu: 12, minPx: 10 }),
  memoLabel: Object.freeze({ lu: 14, minPx: 10.5 }),
  monthDate: Object.freeze({ lu: 17, minPx: 12 }),
  monthChip: Object.freeze({ lu: 12.5, minPx: 10 }),
  monthHoliday: Object.freeze({ lu: 11, minPx: 9 }),
});

/** Event box line height (must match .event { line-height } in views.css). */
export const EVENT_LINE_HEIGHT = 1.25;
/** Month cells keep the area below this fraction of the cell height free for handwriting. */
export const MONTH_LIST_RATIO = 0.62;
/** Week header: all-day rows shown before collapsing the rest into per-day '他n件'. */
export const MAX_ALLDAY_ROWS = 3;
/** Day header: all-day chips shown before the 「他n件」 toggle. */
export const MAX_DAY_ALLDAY_CHIPS = 3;

const UNTITLED = '(タイトルなし)';

// ---------------------------------------------------------------------------------------------
// Pure helpers: numbers, geometry

/** Finite positive number or the fallback. */
function positiveOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A usable page scale (finite, > 0) or 1. */
export function safeScale(scale) {
  return positiveOr(scale, 1);
}

/** Rounds to 4 decimals (keeps generated CSS short without visible error). */
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/** `v` as a percentage of `total` (0 for unusable input), rounded to 4 decimals. */
export function pct(v, total) {
  const r = (Number(v) / Number(total)) * 100;
  return Number.isFinite(r) ? round4(r) : 0;
}

/** CSS text positioning a logical rect { x, y, w, h } inside a W×H box with percentages. */
export function rectStyle(rect, W, H) {
  return `left:${pct(rect.x, W)}%;top:${pct(rect.y, H)}%;width:${pct(rect.w, W)}%;height:${pct(rect.h, H)}%;`;
}

/**
 * On-screen font size (CSS px) of a TYPE entry at a page scale: lu × scale, but at least minPx.
 * @param {{ lu: number, minPx: number }} type
 */
export function fontPx(type, scale) {
  return round4(Math.max(type.lu * safeScale(scale), type.minPx));
}

/** The same font size expressed in logical units (for SVG text and fitting computations). */
export function fontLu(type, scale) {
  return round4(fontPx(type, scale) / safeScale(scale));
}

/**
 * Size (lu) of the gutter time labels: fontLu, but capped so that '23:00' (≈ 2.9 em wide) still fits
 * the gutter on very narrow viewports (e.g. Split View), where the px minimum would overflow.
 */
export function gutterLabelLu(type, scale, gutter) {
  return round4(Math.min(fontLu(type, scale), Math.max(6, (gutter - 10) / 2.9)));
}

/**
 * Page scale for a viewport (SPEC F1 applyPageScale):
 *   fit 'width'   → scale = clientWidth / W (the viewport scrolls vertically)
 *   fit 'contain' → scale = min(clientWidth / W, clientHeight / H), centered horizontally.
 * A zero dimension (element not laid out yet) is ignored; with no usable size at all the
 * fallbackWidth (e.g. window.innerWidth) is used, else scale 1.
 * @returns {{ scale: number, cssW: number, cssH: number, offsetX: number }}
 */
export function computePageScale({ clientWidth, clientHeight, spec, fallbackWidth = 0 } = {}) {
  const W = positiveOr(spec?.W, 1000);
  const H = positiveOr(spec?.H, 1000);
  const cw = positiveOr(clientWidth, 0);
  const ch = positiveOr(clientHeight, 0);
  const contain = spec?.fit === 'contain';

  let scale = 0;
  if (contain) {
    const candidates = [];
    if (cw > 0) candidates.push(cw / W);
    if (ch > 0) candidates.push(ch / H);
    if (candidates.length) scale = Math.min(...candidates);
  } else if (cw > 0) {
    scale = cw / W;
  }
  if (!(scale > 0)) scale = positiveOr(fallbackWidth, 0) > 0 ? fallbackWidth / W : 1;

  const cssW = W * scale;
  const cssH = H * scale;
  // Whole pixels keep the hairline grid crisp.
  const offsetX = contain && cw > cssW ? Math.floor((cw - cssW) / 2) : 0;
  return { scale, cssW, cssH, offsetX };
}

/**
 * Logical rect { x, y, w, h } of a timed event box inside a day column.
 * Overlapping events share the column width equally (col of cols); a small horizontal padding keeps
 * the column edge visible and a 1 lu vertical gap separates back-to-back events.
 */
export function timedBoxRect({
  colX, colW, startMin, endMin, col = 0, cols = 1, hourH, padL = 2, padR = 6, gap = 2, vGap = 1,
}) {
  const n = Math.max(1, Math.floor(Number(cols)) || 1);
  const i = Math.min(n - 1, Math.max(0, Math.floor(Number(col)) || 0));
  const inner = Math.max(1, colW - padL - padR);
  const g = inner / n >= gap * 4 ? gap : 0; // drop the gap when the columns get very narrow
  const w = Math.max(1, (inner - g * (n - 1)) / n);
  const x = colX + padL + i * (w + g);
  const y0 = (startMin * hourH) / 60;
  const y1 = (endMin * hourH) / 60;
  const h = Math.max(4, y1 - y0 - vGap * 2);
  return { x, y: y0 + vGap, w, h };
}

/**
 * How much an event box can show:
 *   'short'   (< 30 min)                 → title only, one line
 *   'compact' (no room for two lines)    → start time + title on one line
 *   'normal'                             → time line + title (2-line clamp)
 *   'tall'    (room for ≥ 4 lines)       → + location line
 */
export function eventBoxMode({ durationMin, heightPx, fontPx: fs }) {
  if (!(durationMin >= 30)) return 'short';
  const line = positiveOr(fs, 12) * EVENT_LINE_HEIGHT;
  const h = Number(heightPx) || 0;
  if (h < line * 2 + 4) return 'compact';
  if (h >= line * 4 + 6) return 'tall';
  return 'normal';
}

/**
 * How many one-line chips fit in `availLu`: all of them, or (slots − 1) chips plus a '+n件' line.
 * At least one line is always used when there is something to show.
 * @returns {{ shown: number, more: number }}
 */
export function fitChips(count, availLu, chipLu, gapLu = 0) {
  const n = Math.max(0, Math.floor(Number(count)) || 0);
  if (n === 0) return { shown: 0, more: 0 };
  const step = Number(chipLu) + Math.max(0, Number(gapLu) || 0);
  if (!(step > 0)) return { shown: n, more: 0 };
  const slots = Math.max(1, Math.floor((Number(availLu) + Math.max(0, Number(gapLu) || 0)) / step + 1e-9));
  if (n <= slots) return { shown: n, more: 0 };
  const shown = slots - 1;
  return { shown, more: n - shown };
}

/**
 * Month cell layout (logical units of a 200×175 cell) at a page scale: header row with the date
 * number, then one-line chips from headerLu down to listBottomLu (the top ~60% of the cell).
 */
export function monthCellMetrics(scale, cellH = 175) {
  const s = safeScale(scale);
  const datePx = fontPx(TYPE.monthDate, s);
  const chipPx = fontPx(TYPE.monthChip, s);
  const holidayPx = fontPx(TYPE.monthHoliday, s);
  const dateBoxPx = round4(datePx * 1.5); // circle behind today's number
  const padTopLu = 2;
  const headerLu = round4(padTopLu + dateBoxPx / s + 2);
  const chipLu = round4((chipPx * 1.35) / s);
  const gapLu = 1.5;
  const listBottomLu = round4(cellH * MONTH_LIST_RATIO);
  return { datePx, chipPx, holidayPx, dateBoxPx, padTopLu, headerLu, chipLu, gapLu, listBottomLu };
}

/**
 * Collapses week all-day rows (from allDayRowsForRange) to at most maxRows rows. When there are more,
 * the first maxRows − 1 rows are kept, and the last row shows per-column '他n件' counts — except
 * that an event of that row is still shown when it is the only hidden event on every day it spans.
 * @returns {{ visible: object[], overflow: number[], rows: number }}
 */
export function collapseAllDayRows(items, colCount, maxRows = MAX_ALLDAY_ROWS) {
  const cols = Math.max(0, Math.floor(Number(colCount)) || 0);
  const list = (Array.isArray(items) ? items : []).filter((it) => it
    && Number.isInteger(it.row) && it.row >= 0
    && Number.isInteger(it.startCol) && Number.isInteger(it.endCol)
    && it.endCol >= it.startCol && it.startCol < cols && it.endCol >= 0);
  const overflow = new Array(cols).fill(0);
  const rowCount = list.reduce((m, it) => Math.max(m, it.row + 1), 0);
  const limit = Math.max(1, Math.floor(Number(maxRows)) || 1);
  if (rowCount <= limit) return { visible: list, overflow, rows: rowCount };

  const keepRows = limit - 1;
  const visible = [];
  const hidden = [];
  for (const it of list) (it.row < keepRows ? visible : hidden).push(it);
  const span = (it) => {
    const out = [];
    for (let c = Math.max(0, it.startCol); c <= Math.min(cols - 1, it.endCol); c++) out.push(c);
    return out;
  };
  for (const it of hidden) for (const c of span(it)) overflow[c]++;
  // Promote events of the first hidden row that are alone on all of their days.
  for (const it of hidden) {
    if (it.row !== keepRows) continue;
    const cs = span(it);
    if (cs.length && cs.every((c) => overflow[c] === 1)) {
      visible.push({ ...it, row: keepRows });
      for (const c of cs) overflow[c] = 0;
    }
  }
  return { visible, overflow, rows: limit };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers: events, colors, days

/** Keeps only objects with valid Date start/end (end ≥ start); anything else is dropped. */
export function sanitizeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.filter((ev) => ev && typeof ev === 'object'
    && isValidDate(ev.start) && isValidDate(ev.end) && ev.end.getTime() >= ev.start.getTime());
}

/** '#rrggbb' (lowercase) for '#rgb' / '#rrggbb' input, else the fallback. */
export function normalizeHex(color, fallback = null) {
  if (typeof color !== 'string') return fallback;
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  return fallback;
}

/** 'rgba(r, g, b, a)' for a hex color (fallback event color if unusable). */
export function hexToRgba(hex, alpha = 1) {
  const c = normalizeHex(hex, PALETTE.fallbackEvent);
  const n = parseInt(c.slice(1), 16);
  const a = Math.min(1, Math.max(0, Number.isFinite(Number(alpha)) ? Number(alpha) : 1));
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Dark or white text for a background color (perceived brightness, YIQ). */
export function readableTextColor(bg) {
  const c = normalizeHex(bg, PALETTE.fallbackEvent);
  const n = parseInt(c.slice(1), 16);
  const yiq = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return yiq >= 150 ? PALETTE.darkText : PALETTE.lightText;
}

/**
 * CSS custom properties for an event's colors: --ev (full color), --ev-bg (color at bgAlpha),
 * --ev-fg (event.textColor, or a readable fallback). Only validated hex values reach the CSS text.
 */
export function eventColorVars(ev, bgAlpha = 0.85) {
  const color = normalizeHex(ev?.color, PALETTE.fallbackEvent);
  const fg = normalizeHex(ev?.textColor, null) || readableTextColor(color);
  return `--ev:${color};--ev-bg:${hexToRgba(color, bgAlpha)};--ev-fg:${fg};`;
}

/** Display title ('(タイトルなし)' when empty). */
export function eventTitle(ev) {
  const t = typeof ev?.title === 'string' ? ev.title.trim() : '';
  return t || UNTITLED;
}

/** '終日' or '9:00〜10:30'. */
export function eventTimeText(ev) {
  if (ev?.allDay) return '終日';
  return formatTimeRangeJa(ev?.start, ev?.end);
}

/** Accessible name of an event box/chip: 'タイトル、9:00〜10:00、場所'. */
export function eventAriaLabel(ev) {
  const loc = typeof ev?.location === 'string' ? ev.location.trim() : '';
  return [eventTitle(ev), eventTimeText(ev), loc].filter(Boolean).join('、');
}

/**
 * Coloring flags of a day. Holidays count as red even on Saturdays.
 * @returns {{ dow: number, holiday: string|null, isToday: boolean, red: boolean, blue: boolean, weekend: boolean }}
 */
export function dayFlags(date, holidayName, now) {
  const dow = isValidDate(date) ? date.getDay() : -1;
  const holiday = typeof holidayName === 'string' && holidayName ? holidayName : null;
  const red = dow === 0 || !!holiday;
  return {
    dow,
    holiday,
    isToday: isSameDay(date, now),
    red,
    blue: dow === 6 && !red,
    weekend: red || dow === 6,
  };
}

/** CSS classes for a day's flags. */
export function dayClassList(flags) {
  const out = [];
  if (flags.red) out.push('is-red');
  if (flags.blue) out.push('is-blue');
  if (flags.holiday) out.push('is-holiday');
  if (flags.weekend) out.push('is-weekend');
  if (flags.isToday) out.push('is-today');
  return out;
}

/** Date number label: '4', or '10/1' on the first of a month (helps across month boundaries). */
export function dayNumberLabel(date) {
  if (!isValidDate(date)) return '';
  const d = date.getDate();
  return d === 1 ? `${date.getMonth() + 1}/${d}` : String(d);
}

/** Initial scroll position (minutes): an hour before now when today is shown, else 7:00. */
export function initialScrollFor(showsToday, now) {
  if (!showsToday) return 7 * 60;
  const m = minutesOfDay(now);
  if (!Number.isFinite(m)) return 7 * 60;
  return Math.min(1440, Math.max(0, m - 60));
}

/** Hour label of the time gutter: '0:00' … '23:00'. */
export function hourLabel(h) {
  return `${h}:00`;
}

// ---------------------------------------------------------------------------------------------
// DOM helpers

/** createElementNS helper; attributes with null/undefined/false values are skipped. */
export function svgEl(tag, attrs, doc = globalThis.document) {
  const el = doc.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, String(v));
    }
  }
  return el;
}

/** Small HTML element helper: htmlEl('div', 'a b', 'text'). */
export function htmlEl(tag, className, text, doc = globalThis.document) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null && text !== '') el.textContent = String(text);
  return el;
}

/**
 * Clears viewportEl and creates the page: div.page > svg.grid (z1) + div.events (z2).
 * The ink surface adds its canvases (z3–5) later.
 */
export function createPageElements(viewportEl) {
  if (!viewportEl || typeof viewportEl.appendChild !== 'function') {
    throw new TypeError('createPageElements: viewportEl must be an element');
  }
  const doc = viewportEl.ownerDocument || globalThis.document;
  viewportEl.replaceChildren();
  const pageEl = htmlEl('div', 'page', null, doc);
  const gridEl = svgEl('svg', {
    class: 'grid', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
  }, doc);
  const eventsEl = htmlEl('div', 'events', null, doc);
  pageEl.append(gridEl, eventsEl);
  viewportEl.appendChild(pageEl);
  return { pageEl, gridEl, eventsEl };
}

/**
 * Sizes the page for the viewport (see computePageScale) and sets the CSS var --s = scale.
 * @returns {{ scale: number, cssW: number, cssH: number, offsetX: number }}
 */
export function applyPageScale({ viewportEl, pageEl, spec }) {
  const res = computePageScale({
    clientWidth: viewportEl?.clientWidth,
    clientHeight: viewportEl?.clientHeight,
    spec,
    fallbackWidth: globalThis.innerWidth,
  });
  const st = pageEl?.style;
  if (st) {
    st.width = `${res.cssW}px`;
    st.height = `${res.cssH}px`;
    st.marginLeft = res.offsetX ? `${res.offsetX}px` : '';
    st.setProperty('--s', String(res.scale));
    if (pageEl.dataset) pageEl.dataset.fit = spec?.fit === 'contain' ? 'contain' : 'width';
  }
  return res;
}

/**
 * Makes an element activate a handler on click (finger tap, mouse) and, for non-buttons, on
 * Enter/Space. Never stops propagation: the ink surface listens on the page.
 * ignorePen: inside the page a Pencil tap is ink, not a tap (SPEC §7), so pen clicks are ignored.
 */
export function onActivate(el, handler, { ignorePen = false } = {}) {
  if (typeof handler !== 'function') return;
  el.addEventListener('click', (e) => {
    if (ignorePen && e.pointerType === 'pen') return;
    handler(e);
  });
  if (el.tagName !== 'BUTTON') {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      handler(e);
    });
  }
}

/** Grid line path element (hairline, crisp). */
export function gridPath(cls, d) {
  return svgEl('path', {
    class: cls, d, 'vector-effect': 'non-scaling-stroke', 'shape-rendering': 'crispEdges',
  });
}

/**
 * Hour grid of a timeline: solid hour lines and dashed half-hour lines over [x0, x1), and the
 * '0:00'…'23:00' labels right-aligned in the gutter, just below each hour line.
 */
export function appendTimeAxis(parent, { x0, x1, H, hourH, labelX, labelLu }) {
  let hours = '';
  let halves = '';
  for (let h = 1; h < 24; h++) hours += `M${x0} ${h * hourH}H${x1}`;
  for (let h = 0; h < 24; h++) halves += `M${x0} ${h * hourH + hourH / 2}H${x1}`;
  parent.append(gridPath('g-half', halves), gridPath('g-hour', hours));

  const labels = svgEl('g', { class: 'g-labels', 'font-size': labelLu, 'text-anchor': 'end' });
  for (let h = 0; h < 24; h++) {
    const y = Math.min(H - 2, h * hourH + 3 + labelLu * 0.92);
    const t = svgEl('text', { class: 'g-label', x: labelX, y: round4(y) });
    t.textContent = hourLabel(h);
    labels.append(t);
  }
  parent.append(labels);
}

/**
 * Current-time line (red, with a dot at its left end) appended to an SVG parent in page units.
 * Returns a handle to move it. The views draw it through appendNowLayer (above the event boxes).
 * @returns {{ g: Element, setY(y: number): void }}
 */
export function appendNowLine(parent, { x1, x2, y, dotR }) {
  const g = svgEl('g', { class: 'g-now' });
  const line = svgEl('line', { x1, x2, y1: y, y2: y, 'vector-effect': 'non-scaling-stroke' });
  const dot = svgEl('circle', { cx: x1, cy: y, r: dotR });
  g.append(line, dot);
  parent.append(g);
  return {
    g,
    setY(v) {
      line.setAttribute('y1', String(v));
      line.setAttribute('y2', String(v));
      dot.setAttribute('cy', String(v));
    },
  };
}

/**
 * Current-time line drawn ABOVE the event boxes: an SVG overlay with the page's viewBox, appended last
 * to eventsEl (z2), so the box of an ongoing event does not hide it (the grid SVG is below the boxes).
 * The overlay is not hit-testable; it disappears with the next eventsEl.replaceChildren (re-render).
 * @returns {{ g: Element, setY(y: number): void }}
 */
export function appendNowLayer(eventsEl, spec, line) {
  const svg = svgEl('svg', {
    class: 'now-layer', viewBox: `0 0 ${spec.W} ${spec.H}`, preserveAspectRatio: 'none',
    'aria-hidden': 'true', focusable: 'false',
  });
  const handle = appendNowLine(svg, line);
  eventsEl.append(svg);
  return handle;
}

// Only one page is visible at a time, so one module-level ticker is enough.
let nowTimer = null;

/** Stops the current-time ticker (every render calls this first). */
export function stopNowTicker() {
  if (nowTimer !== null) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
}

/**
 * Keeps the page current while it stays on screen. Every intervalMs (30 s):
 *   - the now-line (if any) moves to the current minute;
 *   - once the clock is past the day of `renderedAt` (default: `day`), i.e. midnight has passed, the
 *     line is removed, the ticker stops and onDayChange() is called, so the view can re-render its
 *     today marker / tint / now line for the new day (nothing else re-renders while the iPad stays
 *     awake and offline).
 * Stops once the page is gone (gridEl disconnected) or the line was removed by a re-render.
 * Without a now-line the ticker only runs when there is an onDayChange to call.
 */
export function keepNowLineCurrent({
  gridEl, nowLine = null, day = null, yOfMinutes = null, renderedAt = null, onDayChange = null,
  intervalMs = 30000, clock = () => new Date(),
} = {}) {
  stopNowTicker();
  const dayChange = typeof onDayChange === 'function' ? onDayChange : null;
  if (typeof setInterval !== 'function' || !gridEl || (!nowLine && !dayChange)) return;
  const since = isValidDate(renderedAt) ? renderedAt : isValidDate(day) ? day : clock();
  const id = setInterval(() => {
    let keep = false;
    let changed = false;
    try {
      if (gridEl.isConnected && (!nowLine || nowLine.g.isConnected)) {
        const t = clock();
        if (isSameDay(t, since)) {
          if (nowLine && typeof yOfMinutes === 'function') nowLine.setY(round4(yOfMinutes(minutesOfDay(t))));
          keep = true;
        } else {
          if (nowLine) nowLine.g.remove();
          changed = true;
        }
      }
    } catch {
      keep = false;
    }
    if (!keep && nowTimer === id) stopNowTicker();
    // After stopping: the re-render arms a fresh ticker for the new day.
    if (changed && dayChange) safeCall(dayChange);
  }, intervalMs);
  if (id && typeof id.unref === 'function') id.unref(); // never keeps Node (tests) alive
  nowTimer = id;
}

/**
 * Runs fn (a render step that may change the sticky header's height) without moving the paper on
 * screen. The sticky header is the 'auto' grid row right above the scroll container, so a header that
 * grows (all-day rows arriving with the events, the day page's 「他n件」 toggle…) pushes the viewport —
 * and the page under the Pencil — down; a stroke in progress would jump by that amount, and the next
 * characters would land offset from the previous ones. For scrolling pages (fit 'width') the viewport is
 * scrolled by the same delta, so the page keeps its exact on-screen position. 'contain' pages (month)
 * do not scroll and are left alone.
 */
export function keepPageInPlace(pageEl, fit, fn) {
  // Right after a page is first shown (main.js sets data-settling until the first touch/scroll), nobody
  // is writing yet: keep the initial scroll (the hour before now) at the top instead of compensating.
  const settling = pageEl?.dataset?.settling === '1';
  const vp = fit === 'contain' || settling ? null : pageEl?.parentNode;
  const topOf = () => {
    const r = pageEl.getBoundingClientRect();
    return Number(r?.top);
  };
  let top0 = NaN;
  if (vp && typeof pageEl.getBoundingClientRect === 'function') top0 = safeCall(topOf, NaN);
  try {
    return fn();
  } finally {
    if (Number.isFinite(top0)) {
      safeCall(() => {
        const d = topOf() - top0;
        if (!Number.isFinite(d) || Math.abs(d) < 0.5) return;
        // A header taller by d also makes the viewport shorter by d, so the new scrollTop stays in range.
        vp.scrollTop = Math.max(0, (Number(vp.scrollTop) || 0) + d);
      });
    }
  }
}

/** Normalized layout (falls back to the page's own size when the caller passed nothing usable). */
function normalizeLayout(layout, spec, pageEl) {
  let scale = Number(layout?.scale);
  if (!(Number.isFinite(scale) && scale > 0)) {
    const w = parseFloat(pageEl?.style?.width);
    scale = Number.isFinite(w) && w > 0 ? w / spec.W : 1;
  }
  const cssW = positiveOr(layout?.cssW, spec.W * scale);
  const cssH = positiveOr(layout?.cssH, spec.H * scale);
  const ox = Number(layout?.offsetX);
  return { scale, cssW, cssH, offsetX: Number.isFinite(ox) && ox > 0 ? ox : 0 };
}

const noop = () => {};

/**
 * Validates and normalizes render() parameters; also resets per-render state (ticker, viewBox,
 * data-view). computeRange(date) is used when `range` is missing or malformed.
 */
export function beginRender(params, view, spec, computeRange) {
  const p = params || {};
  const { pageEl, gridEl, eventsEl } = p;
  if (!pageEl || !gridEl || !eventsEl) {
    throw new TypeError(`${view}-view render: pageEl, gridEl and eventsEl are required`);
  }
  stopNowTicker();
  const now = isValidDate(p.now) ? p.now : new Date();
  const date = isValidDate(p.date) ? startOfDay(p.date) : startOfDay(now);
  let range = p.range;
  if (!range || !Array.isArray(range.days) || range.days.length === 0 || !range.days.every(isValidDate)) {
    range = computeRange(date);
  }
  const layout = normalizeLayout(p.layout, spec, pageEl);

  if (pageEl.dataset) pageEl.dataset.view = view;
  gridEl.setAttribute('viewBox', `0 0 ${spec.W} ${spec.H}`);
  gridEl.setAttribute('preserveAspectRatio', 'none');
  eventsEl.style.cssText = '';

  return {
    view,
    spec,
    pageEl,
    gridEl,
    eventsEl,
    stickyEl: p.stickyEl || null,
    date,
    range,
    days: range.days,
    now,
    layout,
    scale: layout.scale,
    events: sanitizeEvents(p.events),
    settings: p.settings && typeof p.settings === 'object' ? p.settings : {},
    onEventTap: typeof p.onEventTap === 'function' ? p.onEventTap : noop,
    onDayTap: typeof p.onDayTap === 'function' ? p.onDayTap : noop,
  };
}

/**
 * Left padding that puts the sticky header's content exactly above the page: measured from the
 * live layout (robust against paddings/safe areas around the viewport), else layout.offsetX.
 */
function stickyOffset(stickyEl, pageEl, fallback) {
  try {
    if (!stickyEl.isConnected || !pageEl.isConnected) return fallback;
    const pr = pageEl.getBoundingClientRect();
    const sr = stickyEl.getBoundingClientRect();
    if (!(pr.width > 0) || !(sr.width > 0)) return fallback;
    const view = stickyEl.ownerDocument?.defaultView;
    const border = view ? parseFloat(view.getComputedStyle(stickyEl).borderLeftWidth) || 0 : 0;
    const v = pr.left - sr.left - border;
    return Number.isFinite(v) && v >= 0 ? round4(v) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Prepares the sticky header for this render: data-view, padding-left aligned with the page, and a
 * fresh div.sh-inner exactly as wide as the page (so % columns match the page's % geometry).
 * Returns the inner element (to be filled, then installed with stickyEl.replaceChildren(inner)).
 */
export function stickyShell(ctx, vars = {}) {
  const { stickyEl, pageEl, layout } = ctx;
  if (stickyEl.dataset) stickyEl.dataset.view = ctx.view;
  stickyEl.style.paddingLeft = `${stickyOffset(stickyEl, pageEl, layout.offsetX)}px`;
  const inner = htmlEl('div', 'sh-inner');
  inner.style.width = `${round4(layout.cssW)}px`;
  for (const [k, v] of Object.entries(vars)) inner.style.setProperty(k, String(v));
  return inner;
}

/**
 * Timed event box (div.event) positioned with % of the page.
 * @param {object} ev  CalEvent
 * @param {{ rect, spec, scale, fontPx: number, durationMin: number, now: Date, onEventTap: Function }} o
 */
export function createEventBox(ev, { rect, spec, scale, fontPx: fs, durationMin, now, onEventTap }) {
  const mode = eventBoxMode({ durationMin, heightPx: rect.h * safeScale(scale), fontPx: fs });
  const box = htmlEl('div', `event is-${mode}`);
  if (ev.end.getTime() <= now.getTime()) box.classList.add('is-past');
  box.style.cssText = rectStyle(rect, spec.W, spec.H) + eventColorVars(ev);
  box.dataset.eventId = String(ev.id ?? '');
  box.dataset.calendarId = String(ev.calendarId ?? '');
  box.setAttribute('aria-label', eventAriaLabel(ev));

  const title = eventTitle(ev);
  if (mode === 'short' || mode === 'compact') {
    const line = htmlEl('div', 'ev-line');
    if (mode === 'compact') line.append(htmlEl('span', 'ev-time', formatTimeJa(ev.start)));
    line.append(htmlEl('span', 'ev-title', title));
    box.append(line);
  } else {
    box.append(htmlEl('div', 'ev-time', eventTimeText(ev)), htmlEl('div', 'ev-title', title));
    const loc = typeof ev.location === 'string' ? ev.location.trim() : '';
    if (mode === 'tall' && loc) box.append(htmlEl('div', 'ev-loc', loc));
  }
  onActivate(box, () => onEventTap(ev), { ignorePen: true });
  return box;
}

/**
 * All-day chip for the sticky header (filled with the event color). `cont` marks an event that
 * continues before/after the visible days (square corners on that side).
 */
export function createAllDayChip(ev, onEventTap, { contLeft = false, contRight = false } = {}) {
  const chip = htmlEl('div', 'ad-chip');
  if (contLeft) chip.classList.add('cont-left');
  if (contRight) chip.classList.add('cont-right');
  chip.style.cssText = eventColorVars(ev, 1);
  chip.dataset.eventId = String(ev.id ?? '');
  chip.dataset.calendarId = String(ev.calendarId ?? '');
  chip.setAttribute('aria-label', eventAriaLabel(ev));
  chip.textContent = eventTitle(ev);
  onActivate(chip, () => onEventTap(ev));
  return chip;
}

/** Calls fn, returning fallback if it throws (keeps a bad helper from blanking the whole page). */
export function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (err) {
    if (globalThis.console) console.warn('[views]', err);
    return fallback;
  }
}
