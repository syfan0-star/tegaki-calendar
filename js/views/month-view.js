// Month page (module F1): a 7×6 grid of day cells. Each cell shows its date number, holiday name and
// as many one-line event chips as fit in its top ~60%; the lower part stays free for handwriting.
// The sticky header shows the weekday labels aligned with the columns.

import { PAGE_SPECS, monthCellRect, rangeFor } from './page-geometry.js';
import { eventsOnDay } from './event-layout.js';
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

function buildCell(ctx, c, m) {
  const r = cellRect(c.row, c.col);
  const cell = htmlEl('div', ['mc', ...dayClassList(c.flags), c.inMonth ? '' : 'is-out'].filter(Boolean).join(' '));
  cell.style.cssText = `left:${pct(r.x, SPEC.W)}%;top:${pct(r.y, SPEC.H)}%;width:${pct(r.w, SPEC.W)}%;height:${pct(r.h, SPEC.H)}%;`;

  const list = safeCall(() => eventsOnDay(ctx.events, c.date), []);

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

  const { shown, more } = fitChips(list.length, m.listBottomLu - m.headerLu, m.chipLu, m.gapLu);
  const step = m.chipLu + m.gapLu;
  const place = (el, i) => {
    el.style.top = `${pct(m.headerLu + i * step, CELL_H)}%`;
    el.style.height = `${pct(m.chipLu, CELL_H)}%`;
  };
  for (let i = 0; i < shown; i++) {
    const ev = list[i];
    const chip = eventChip(ev, c.date, ctx.onEventTap);
    chip.style.cssText = eventColorVars(ev, 1);
    place(chip, i);
    cell.append(chip);
  }
  if (more > 0) {
    const moreEl = htmlEl('div', 'mc-more', `+${more}件`);
    moreEl.setAttribute('aria-label', `${formatDateJa(c.date)} の予定 他${more}件（日表示へ）`);
    place(moreEl, shown);
    onActivate(moreEl, () => ctx.onDayTap(c.date), { ignorePen: true });
    cell.append(moreEl);
  }
  return cell;
}

function buildCells(ctx, cells) {
  const m = monthCellMetrics(ctx.scale, CELL_H);
  const st = ctx.eventsEl.style;
  st.setProperty('--mc-date-fs', `${m.datePx}px`);
  st.setProperty('--mc-date-box', `${m.dateBoxPx}px`);
  st.setProperty('--mc-chip-fs', `${m.chipPx}px`);
  st.setProperty('--mc-hol-fs', `${m.holidayPx}px`);
  const frag = document.createDocumentFragment();
  for (const c of cells) frag.append(buildCell(ctx, c, m));
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
  const ctx = beginRender(params, VIEW, SPEC, (date) => rangeFor(VIEW, date, params?.settings?.weekStart ?? 0));
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
