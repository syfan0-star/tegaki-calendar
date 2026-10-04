// Month page (module F1): a 7×6 grid of day cells. Each cell shows its date number and holiday name.
// All-day events are bars spanning their days in each week row (like Google Calendar) and are ALWAYS
// all shown: when a row has many, its lanes get thinner instead of hiding any. Timed events follow as
// one-line chips, as many as fit in the top ~60% of the cell (the rest: '+n件'), so the lower part
// stays free for handwriting. The sticky header shows the weekday labels aligned with the columns.

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
 * Lane metrics of one week row. Every lane must fit between the date header and the cell bottom:
 * with too many lanes they get thinner (and their text smaller) — all-day events are never hidden.
 * @returns {{ laneLu: number, step: number, fontScale: number }}
 */
export function allDayLaneMetrics(laneCount, m, cellH = CELL_H) {
  const gap = m.gapLu;
  const avail = cellH - m.headerLu - BAR_BOTTOM_PAD;
  let lane = m.chipLu;
  if (laneCount > 0 && laneCount * (lane + gap) - gap > avail) {
    lane = Math.max(1, (avail + gap) / laneCount - gap);
  }
  return { laneLu: lane, step: lane + gap, fontScale: Math.min(1, lane / m.chipLu) };
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

/** One all-day bar of a week row (spanning startCol..endCol of that row). */
function allDayBar(ctx, it, rowIndex, rowCells, m, lm) {
  const ev = it.event;
  const first = rowCells[it.startCol];
  const last = rowCells[it.endCol];
  const cls = ['mc-bar'];
  if (ev.start.getTime() < first.date.getTime()) cls.push('cont-left');
  if (ev.end.getTime() > addDays(last.date, 1).getTime()) cls.push('cont-right');
  if (rowCells.slice(it.startCol, it.endCol + 1).every((c) => !c.inMonth)) cls.push('is-out');
  const bar = htmlEl('div', cls.join(' '));
  bar.dataset.eventId = String(ev.id ?? '');
  bar.dataset.calendarId = String(ev.calendarId ?? '');
  bar.setAttribute('aria-label', eventAriaLabel(ev));
  bar.append(htmlEl('span', 'mc-bar-title', eventTitle(ev)));
  const x = it.startCol * CELL_W + BAR_INSET;
  const w = (it.endCol - it.startCol + 1) * CELL_W - 2 * BAR_INSET;
  const y = rowIndex * CELL_H + m.headerLu + it.row * lm.step;
  bar.style.cssText = `left:${pct(x, SPEC.W)}%;top:${pct(y, SPEC.H)}%;width:${pct(w, SPEC.W)}%;`
    + `height:${pct(lm.laneLu, SPEC.H)}%;${eventColorVars(ev, 1)}`
    + (lm.fontScale < 1 ? `--mc-bar-k:${Math.round(lm.fontScale * 1000) / 1000};` : '');
  onActivate(bar, () => ctx.onEventTap(ev), { ignorePen: true });
  return bar;
}

/** All-day bars of one week row + how many lanes each of its 7 days uses. */
function buildRow(ctx, rowIndex, rowCells, m) {
  const items = safeCall(() => allDayRowsForRange(ctx.events, rowCells.map((c) => c.date)), []);
  const laneCount = items.reduce((mx, it) => Math.max(mx, it.row + 1), 0);
  const lm = allDayLaneMetrics(laneCount, m);
  const lanesUsed = new Array(COLS).fill(0);
  const bars = [];
  for (const it of items) {
    for (let col = it.startCol; col <= it.endCol; col++) lanesUsed[col] = Math.max(lanesUsed[col], it.row + 1);
    bars.push(allDayBar(ctx, it, rowIndex, rowCells, m, lm));
  }
  return { bars, lanesUsed, laneStep: lm.step };
}

function buildCells(ctx, cells) {
  const m = monthCellMetrics(ctx.scale, CELL_H);
  const st = ctx.eventsEl.style;
  st.setProperty('--mc-date-fs', `${m.datePx}px`);
  st.setProperty('--mc-date-box', `${m.dateBoxPx}px`);
  st.setProperty('--mc-chip-fs', `${m.chipPx}px`);
  st.setProperty('--mc-hol-fs', `${m.holidayPx}px`);
  const frag = document.createDocumentFragment();
  const bars = [];
  for (let row = 0; row < ROWS; row++) {
    const rowCells = cells.slice(row * COLS, row * COLS + COLS);
    const r = buildRow(ctx, row, rowCells, m);
    for (const c of rowCells) frag.append(buildCell(ctx, c, m, r.lanesUsed[c.col], r.laneStep));
    bars.push(...r.bars);
  }
  for (const bar of bars) frag.append(bar); // above the cells
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
