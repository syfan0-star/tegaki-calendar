// Month page (module F1): a 7×6 grid of day cells. Each cell shows its date number and holiday name.
// All-day events are bars spanning their days in each week row (like Google Calendar) and are ALWAYS
// all shown: where days have many, the lanes of those days get thinner instead of hiding any (only
// the days linked to the busy one by bars; the rest of the week keeps full-size bars). A thinned bar
// is too small for a finger, so a tap on it opens that day's page, where every event is large.
// Timed events follow as one-line chips, as many as fit in the top ~60% of the cell (the rest:
// '+n件'), so the lower part stays free for handwriting. The sticky header shows the weekday labels
// aligned with the columns.

import { PAGE_SPECS, monthCellRect, rangeFor } from './page-geometry.js';
import { allDayRowsForRange, eventsOnDay } from './event-layout.js';
import { WEEKDAYS_JA, addDays, formatDateJa, formatTimeJa, isValidDate, startOfMonth } from '../util/date.js';
import { getHolidayName } from '../util/holidays-jp.js';
import {
  beginRender,
  dayClassList,
  dayFlags,
  dayNumberLabel,
  eventAriaLabel,
  eventColorVars,
  eventTitle,
  fitChips,
  gridPath,
  htmlEl,
  keepNowLineCurrent,
  monthCellMetrics,
  onActivate,
  pct,
  safeCall,
  stickyShell,
  svgEl,
} from './view-common.js';

const VIEW = 'month';
const SPEC = PAGE_SPECS.month;
const COLS = SPEC.cols;
const ROWS = SPEC.rows;
const CELL_W = SPEC.W / COLS;
const CELL_H = SPEC.H / ROWS;

function cellRect(row, col) {
  return monthCellRect(row, col) || { x: col * CELL_W, y: row * CELL_H, w: CELL_W, h: CELL_H };
}

/** The 42 cells: { date, row, col, inMonth, flags }. */
function cellInfos(ctx) {
  const ms = isValidDate(ctx.range.monthStart) ? ctx.range.monthStart : startOfMonth(ctx.date);
  const days = ctx.days.slice(0, COLS * ROWS);
  while (days.length < COLS * ROWS) days.push(addDays(days[days.length - 1], 1));
  return days.map((date, i) => ({
    date,
    row: Math.floor(i / COLS),
    col: i % COLS,
    inMonth: date.getFullYear() === ms.getFullYear() && date.getMonth() === ms.getMonth(),
    flags: dayFlags(date, safeCall(() => getHolidayName(date), null), ctx.now),
  }));
}

function buildGrid(ctx, cells) {
  const frag = document.createDocumentFragment();
  for (const c of cells) {
    const cls = c.flags.isToday ? 'g-today' : !c.inMonth ? 'g-out' : c.flags.weekend ? 'g-weekend' : null;
    if (!cls) continue;
    const r = cellRect(c.row, c.col);
    frag.append(svgEl('rect', { class: cls, x: r.x, y: r.y, width: r.w, height: r.h }));
  }
  let d = '';
  for (let col = 1; col < COLS; col++) d += `M${col * CELL_W} 0V${SPEC.H}`;
  for (let row = 1; row < ROWS; row++) d += `M0 ${row * CELL_H}H${SPEC.W}`;
  frag.append(gridPath('g-vline', d));
  ctx.gridEl.replaceChildren(frag);
}

/** Time text of a timed chip on `day` ('9:00', '〜11:00' for the tail of an overnight event). */
function chipTime(ev, day) {
  if (ev.start.getTime() >= day.getTime()) return formatTimeJa(ev.start);
  const next = addDays(day, 1);
  return ev.end.getTime() < next.getTime() ? `〜${formatTimeJa(ev.end)}` : '';
}

function eventChip(ev, day, onEventTap) {
  const chip = htmlEl('div', `mc-chip ${ev.allDay ? 'is-allday' : 'is-timed'}`);
  chip.dataset.eventId = String(ev.id ?? '');
  chip.dataset.calendarId = String(ev.calendarId ?? '');
  chip.setAttribute('aria-label', eventAriaLabel(ev));
  if (ev.allDay) {
    chip.append(htmlEl('span', 'mc-title', eventTitle(ev)));
  } else {
    const time = chipTime(ev, day);
    chip.append(htmlEl('span', 'mc-dot'));
    if (time) chip.append(htmlEl('span', 'mc-time', time));
    chip.append(htmlEl('span', 'mc-title', eventTitle(ev)));
  }
  onActivate(chip, () => onEventTap(ev), { ignorePen: true });
  return chip;
}

/** Inset of an all-day bar from the cell edges (lu). */
const BAR_INSET = 4;
/** Free space kept under the last all-day lane (lu). */
const BAR_BOTTOM_PAD = 2;
/**
 * On-screen height (CSS px) below which a thinned all-day bar is no reliable finger target: a tap on
 * it opens the day under the finger instead of one event (neighbours are only ~1px away).
 */
const THIN_BAR_PX = 16;

/**
 * Lane metrics of one group of all-day lanes. Every lane must fit between the date header and the
 * cell bottom: with too many lanes they get thinner (and their text smaller), and when the lanes get
 * very thin the gaps too (at most a third of a step) — all-day events are never hidden, and the stack
 * never reaches the next week row: laneCount × step − gapLu ≤ the space below the header. No minimum
 * size: a floor would push the last lanes out of the cell.
 * @returns {{ laneLu: number, step: number, gapLu: number, fontScale: number }}
 */
export function allDayLaneMetrics(laneCount, m, cellH = CELL_H) {
  const gap = m.gapLu;
  const avail = Math.max(0, cellH - m.headerLu - BAR_BOTTOM_PAD);
  let lane = m.chipLu;
  let g = gap;
  if (laneCount > 0 && laneCount * (lane + gap) - gap > avail) {
    // n·step − g = avail, with g = min(gap, step / 3).
    let step = (avail + gap) / laneCount;
    if (step < 3 * gap) {
      step = avail / (laneCount - 1 / 3);
      g = step / 3;
    }
    lane = step - g;
  }
  return { laneLu: lane, step: lane + g, gapLu: g, fontScale: Math.min(1, lane / m.chipLu) };
}

/**
 * Splits the all-day bars of a week row into groups of columns linked by overlapping bars (maximal
 * runs of columns; a new group starts where no earlier bar reaches). Each group gets its own lane
 * size, and bars of different groups never share a column. Groups and their bars in column order.
 * @param {{ startCol: number, endCol: number, row: number }[]} items  from allDayRowsForRange
 * @returns {object[][]}
 */
export function allDayColumnGroups(items) {
  const sorted = (Array.isArray(items) ? items.filter(Boolean) : [])
    .sort((p, q) => (p.startCol - q.startCol) || (p.row - q.row));
  const groups = [];
  let maxEnd = -Infinity;
  for (const it of sorted) {
    if (it.startCol > maxEnd) groups.push([]);
    groups[groups.length - 1].push(it);
    maxEnd = Math.max(maxEnd, it.endCol);
  }
  return groups;
}

/**
 * Timed chips of a cell below its all-day lanes: they use the space down to the ~60% line (or one
 * chip below the lanes when the lanes reach further), never past the cell bottom.
 * @returns {{ top: number, shown: number, more: number, slots: number }}
 */
export function timedChipLayout(count, lanesUsed, laneStep, m, cellH = CELL_H) {
  const top = m.headerLu + lanesUsed * laneStep;
  const step = m.chipLu + m.gapLu;
  const bottom = Math.min(cellH - 1, Math.max(m.listBottomLu, top + step));
  const slots = Math.max(0, Math.floor((bottom - top + m.gapLu) / step + 1e-9));
  if (count <= 0) return { top, shown: 0, more: 0, slots };
  if (slots === 0) return { top, shown: 0, more: count, slots };
  const { shown, more } = fitChips(count, bottom - top, m.chipLu, m.gapLu);
  return { top, shown, more, slots };
}

function buildCell(ctx, c, m, lanesUsed, laneStep) {
  const r = cellRect(c.row, c.col);
  const cell = htmlEl('div', ['mc', ...dayClassList(c.flags), c.inMonth ? '' : 'is-out'].filter(Boolean).join(' '));
  cell.style.cssText = `left:${pct(r.x, SPEC.W)}%;top:${pct(r.y, SPEC.H)}%;width:${pct(r.w, SPEC.W)}%;height:${pct(r.h, SPEC.H)}%;`;

  const list = safeCall(() => eventsOnDay(ctx.events, c.date), []);
  const timed = list.filter((ev) => !ev.allDay);

  const head = htmlEl('div', 'mc-head');
  head.style.height = `${pct(m.headerLu, CELL_H)}%`;
  const num = htmlEl('div', 'mc-date', dayNumberLabel(c.date));
  const label = [formatDateJa(c.date), c.flags.holiday, list.length ? `予定${list.length}件` : '']
    .filter(Boolean).join(' ');
  num.setAttribute('aria-label', `${label}（日表示へ）`);
  onActivate(num, () => ctx.onDayTap(c.date), { ignorePen: true });
  head.append(num);
  if (c.flags.holiday) head.append(htmlEl('span', 'mc-hol', c.flags.holiday));
  cell.append(head);

  const lay = timedChipLayout(timed.length, lanesUsed, laneStep, m);
  const step = m.chipLu + m.gapLu;
  const place = (el, i) => {
    el.style.top = `${pct(lay.top + i * step, CELL_H)}%`;
    el.style.height = `${pct(m.chipLu, CELL_H)}%`;
  };
  for (let i = 0; i < lay.shown; i++) {
    const ev = timed[i];
    const chip = eventChip(ev, c.date, ctx.onEventTap);
    chip.style.cssText = eventColorVars(ev, 1);
    place(chip, i);
    cell.append(chip);
  }
  if (lay.more > 0) {
    const moreEl = htmlEl('div', 'mc-more', `+${lay.more}件`);
    moreEl.setAttribute('aria-label', `${formatDateJa(c.date)} の予定 他${lay.more}件（日表示へ）`);
    onActivate(moreEl, () => ctx.onDayTap(c.date), { ignorePen: true });
    if (lay.slots > 0) {
      place(moreEl, lay.shown);
      cell.append(moreEl);
    } else {
      // The all-day lanes fill the cell: the count goes next to the date number.
      moreEl.classList.add('is-badge');
      head.append(moreEl);
    }
  }
  return cell;
}

/**
 * Day of a week row under a tap on an all-day bar: from the tap's x within the bar's box (the bar is
 * inset by BAR_INSET at both ends). The bar's first day when the point or the box is unknown.
 */
function dayUnderTap(bar, e, it, rowCells) {
  let col = it.startCol;
  try {
    const r = bar.getBoundingClientRect();
    const x = Number(e?.clientX);
    if (r && r.width > 0 && Number.isFinite(x)) {
      const w = (it.endCol - it.startCol + 1) * CELL_W - 2 * BAR_INSET;
      const lu = it.startCol * CELL_W + BAR_INSET + ((x - r.left) / r.width) * w;
      col = Math.min(it.endCol, Math.max(it.startCol, Math.floor(lu / CELL_W)));
    }
  } catch {
    col = it.startCol;
  }
  return rowCells[col].date;
}

/**
 * One all-day bar of a week row (spanning startCol..endCol of that row), sized by its group's lane
 * metrics `lm`. A thinned bar below THIN_BAR_PX on screen is no reliable finger target: a click on it
 * (finger or mouse) opens the day under the tap point; Enter/Space still open the event. Pencil taps
 * are ignored as on every chip (the 予定 tool finds events itself).
 */
function allDayBar(ctx, it, rowIndex, rowCells, m, lm) {
  const ev = it.event;
  const first = rowCells[it.startCol];
  const last = rowCells[it.endCol];
  // Full-size bars are as tall as the timed chips (the month page's normal tap target); only bars
  // thinned below that AND below THIN_BAR_PX count as thin.
  const thin = lm.laneLu < m.chipLu && lm.laneLu * ctx.scale < THIN_BAR_PX;
  const cls = ['mc-bar'];
  if (ev.start.getTime() < first.date.getTime()) cls.push('cont-left');
  if (ev.end.getTime() > addDays(last.date, 1).getTime()) cls.push('cont-right');
  if (rowCells.slice(it.startCol, it.endCol + 1).every((c) => !c.inMonth)) cls.push('is-out');
  if (thin) cls.push('is-thin');
  const bar = htmlEl('div', cls.join(' '));
  bar.dataset.eventId = String(ev.id ?? '');
  bar.dataset.calendarId = String(ev.calendarId ?? '');
  const dates = `${formatDateJa(first.date)}${it.endCol > it.startCol ? `〜${formatDateJa(last.date)}` : ''}`;
  bar.setAttribute('aria-label', `${eventAriaLabel(ev)}、${dates}${thin ? '（日表示へ）' : ''}`);
  bar.append(htmlEl('span', 'mc-bar-title', eventTitle(ev)));
  const x = it.startCol * CELL_W + BAR_INSET;
  const w = (it.endCol - it.startCol + 1) * CELL_W - 2 * BAR_INSET;
  const y = rowIndex * CELL_H + m.headerLu + it.row * lm.step;
  bar.style.cssText = `left:${pct(x, SPEC.W)}%;top:${pct(y, SPEC.H)}%;width:${pct(w, SPEC.W)}%;`
    + `height:${pct(lm.laneLu, SPEC.H)}%;${eventColorVars(ev, 1)}`
    + (lm.fontScale < 1 ? `--mc-bar-k:${Math.round(lm.fontScale * 1000) / 1000};` : '');
  onActivate(bar, (e) => {
    if (thin && e?.type !== 'keydown') ctx.onDayTap(dayUnderTap(bar, e, it, rowCells));
    else ctx.onEventTap(ev);
  }, { ignorePen: true });
  return bar;
}

/**
 * All-day bars of one week row (in column order), and per day column how many lanes it uses and the
 * step of those lanes. Lanes are thinned per group of columns linked by bars, not for the whole row:
 * a day with many all-day events only thins the bars that share its columns (directly or through
 * other bars). Columns without bars keep the normal step for the timed chips below.
 */
function buildRow(ctx, rowIndex, rowCells, m) {
  const items = safeCall(() => allDayRowsForRange(ctx.events, rowCells.map((c) => c.date)), []);
  const lanesUsed = new Array(COLS).fill(0);
  const laneStep = new Array(COLS).fill(m.chipLu + m.gapLu);
  const bars = [];
  for (const group of allDayColumnGroups(items)) {
    const lm = allDayLaneMetrics(group.reduce((mx, it) => Math.max(mx, it.row + 1), 0), m);
    for (const it of group) {
      for (let col = it.startCol; col <= it.endCol; col++) {
        lanesUsed[col] = Math.max(lanesUsed[col], it.row + 1);
        laneStep[col] = lm.step;
      }
      bars.push(allDayBar(ctx, it, rowIndex, rowCells, m, lm));
    }
  }
  return { bars, lanesUsed, laneStep };
}

function buildCells(ctx, cells) {
  const m = monthCellMetrics(ctx.scale, CELL_H);
  const st = ctx.eventsEl.style;
  st.setProperty('--mc-date-fs', `${m.datePx}px`);
  st.setProperty('--mc-date-box', `${m.dateBoxPx}px`);
  st.setProperty('--mc-chip-fs', `${m.chipPx}px`);
  st.setProperty('--mc-hol-fs', `${m.holidayPx}px`);
  const frag = document.createDocumentFragment();
  for (let row = 0; row < ROWS; row++) {
    const rowCells = cells.slice(row * COLS, row * COLS + COLS);
    const r = buildRow(ctx, row, rowCells, m);
    for (const c of rowCells) frag.append(buildCell(ctx, c, m, r.lanesUsed[c.col], r.laneStep[c.col]));
    // The row's bars right after its 7 cells: above them (the cells clip their contents, so nothing
    // of the next row reaches up here), and read by VoiceOver / Tab together with their week.
    for (const bar of r.bars) frag.append(bar);
  }
  ctx.eventsEl.replaceChildren(frag);
}

function buildSticky(ctx, cells) {
  if (!ctx.stickyEl) return;
  const inner = stickyShell(ctx);
  const row = htmlEl('div', 'sh-weekdays');
  for (let col = 0; col < COLS; col++) {
    const dow = cells[col].date.getDay();
    const cls = dow === 0 ? 'is-red' : dow === 6 ? 'is-blue' : '';
    row.append(htmlEl('div', `sh-wdcell ${cls}`.trim(), WEEKDAYS_JA[dow]));
  }
  inner.append(row);
  ctx.stickyEl.replaceChildren(inner);
}

/**
 * Renders the month page (grid, day cells with event chips, weekday header). Idempotent.
 * See SPEC §4 F1 for the parameters.
 */
export function render(params) {
  const ctx = beginRender(params, VIEW, SPEC, (date) => rangeFor(VIEW, date, params?.settings?.weekStart ?? 1));
  const cells = cellInfos(ctx);
  buildGrid(ctx, cells);
  buildCells(ctx, cells);
  buildSticky(ctx, cells);
  // No now line here, but after midnight the today circle / tint must move to the new day.
  keepNowLineCurrent({
    gridEl: ctx.gridEl,
    renderedAt: ctx.now,
    onDayChange: () => render({ ...params, now: new Date() }),
  });
}

/** The month page does not scroll; exported for API symmetry with the day/week views. */
export function initialScrollMinutes() {
  return 0;
}
