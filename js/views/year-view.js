// Year page (module F1, 年間予定表): the 12 months side by side as columns, days 1..31 as rows, like a
// paper year planner — handwriting is allowed everywhere on it. The day numbers 1..31 run down the left
// gutter. Each cell shows its weekday (月火水…; red Sunday/holiday, blue Saturday) small at its top-left,
// the holiday name tiny along its bottom, and the day's all-day events as tiny one-line chips in the right
// ~55% of the cell, so the left part stays free for handwriting. Every all-day event is shown: a day with
// many gets thinner lanes (as on the month page), and a multi-day event appears on every day it covers,
// in the same lane, linked from day to day. Saturdays are tinted pale blue, Sundays and holidays pale
// red, today pale accent with an outline; the cells of dates that do not exist (2/30, 4/31…) are hatched.
// Timed events are not shown here. The sticky header names the months over their columns.

import { PAGE_SPECS, rangeFor, yearCellRect } from './page-geometry.js';
import { allDayRowsForRange, splitAllDay } from './event-layout.js';
import { allDayColumnGroups, allDayLaneMetrics } from './month-view.js';
import {
  WEEKDAYS_JA, addDays, addMonths, daysBetween, formatDateJa, formatMonthJa, isValidDate,
} from '../util/date.js';
import { getHolidayName } from '../util/holidays-jp.js';
import {
  TYPE,
  beginRender,
  dayClassList,
  dayFlags,
  eventAriaLabel,
  eventColorVars,
  eventTitle,
  fontLu,
  fontPx,
  gridPath,
  htmlEl,
  keepNowLineCurrent,
  keepPageInPlace,
  onActivate,
  pct,
  safeCall,
  safeScale,
  stickyShell,
  svgEl,
} from './view-common.js';

const VIEW = 'year';
const SPEC = PAGE_SPECS.year;
const COLS = SPEC.cols; // 12 months
const ROWS = SPEC.rows; // days 1..31
const ROW_H = SPEC.rowH;
const COL_W = (SPEC.W - SPEC.gutter) / COLS;
/** The chips start at this fraction of the cell width: the part left of it is kept for handwriting. */
export const YEAR_CHIP_LEFT = 0.45;
/** Inset of the weekday letter and the chips from the cell edges (lu). */
const PAD = 3;
/** Below this on-screen height (CSS px) a thinned chip is no finger target: a tap opens its day. */
const THIN_CHIP_PX = 16;
/** Scroll target: today's row, with this many rows above it still in view. */
const ROWS_ABOVE_TODAY = 2;
const HATCH_ID = 'yv-hatch';

const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * Cell layout (logical units) at a page scale: font sizes in CSS px (they never get smaller than legible),
 * the chip lane height and gap, and the height of the holiday line at the cell bottom.
 */
export function yearCellMetrics(scale) {
  const s = safeScale(scale);
  const weekdayPx = fontPx(TYPE.yearWeekday, s);
  const chipPx = fontPx(TYPE.yearChip, s);
  const holidayPx = fontPx(TYPE.yearHoliday, s);
  return {
    dayNumLu: fontLu(TYPE.yearDayNum, s),
    weekdayPx,
    chipPx,
    holidayPx,
    padLu: PAD,
    chipLu: round4((chipPx * 1.25) / s),
    gapLu: 1.5,
    holidayLu: round4((holidayPx * 1.2) / s),
  };
}

/** Lowest y (within the cell) the chips of a day may reach: above the holiday line on holidays. */
function chipBottom(info, m) {
  return info.flags.holiday ? ROW_H - m.holidayLu - 1 : ROW_H;
}

/** Jan 1 of the year the page shows. */
function yearStartOf(ctx) {
  const d = isValidDate(ctx.range.yearStart) ? ctx.range.yearStart : ctx.days[0];
  return addMonths(d, -d.getMonth());
}

/** The days of month `monthIndex` with their flags: [{ date, day, flags }]. */
function monthInfos(ctx, yearStart, monthIndex) {
  const first = addMonths(yearStart, monthIndex);
  const len = daysBetween(first, addMonths(first, 1));
  const out = [];
  for (let i = 0; i < len; i++) {
    const date = addDays(first, i);
    out.push({ date, day: i + 1, flags: dayFlags(date, safeCall(() => getHolidayName(date), null), ctx.now) });
  }
  return out;
}

/** 'M x y h w v h h -w z' for each logical rect (one path per tint keeps the SVG small). */
function rectsPath(rects) {
  let d = '';
  for (const r of rects) d += `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`;
  return d;
}

function buildGrid(ctx, yearStart, months, m) {
  const { W, H, gutter } = SPEC;
  const frag = document.createDocumentFragment();

  // Hatch for the dates that do not exist (2/30, 4/31…).
  const defs = svgEl('defs');
  const pattern = svgEl('pattern', {
    id: HATCH_ID, width: 10, height: 10, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  });
  pattern.append(svgEl('rect', { class: 'g-hatch-bg', width: 10, height: 10 }), svgEl('path', { class: 'g-hatch-line', d: 'M0 0V10' }));
  defs.append(pattern);
  frag.append(defs);

  const tints = { sat: [], sun: [], today: [], void: [] };
  let todayRect = null;
  months.forEach((infos, mo) => {
    for (const info of infos) {
      const r = yearCellRect(mo, info.day);
      if (info.flags.isToday) {
        tints.today.push(r);
        todayRect = r;
      } else if (info.flags.red) {
        tints.sun.push(r);
      } else if (info.flags.blue) {
        tints.sat.push(r);
      }
    }
    for (let day = infos.length + 1; day <= ROWS; day++) tints.void.push(yearCellRect(mo, day));
  });
  if (tints.sat.length) frag.append(svgEl('path', { class: 'g-sat', d: rectsPath(tints.sat) }));
  if (tints.sun.length) frag.append(svgEl('path', { class: 'g-sun', d: rectsPath(tints.sun) }));
  if (tints.today.length) frag.append(svgEl('path', { class: 'g-today', d: rectsPath(tints.today) }));
  if (tints.void.length) frag.append(svgEl('path', { class: 'g-void', d: rectsPath(tints.void), fill: `url(#${HATCH_ID})` }));

  // Hairlines between the days, stronger lines between the months, the gutter line.
  let rows = '';
  for (let day = 1; day < ROWS; day++) rows += `M0 ${day * ROW_H}H${W}`;
  let seps = '';
  for (let mo = 1; mo < COLS; mo++) seps += `M${gutter + mo * COL_W} 0V${H}`;
  frag.append(gridPath('g-hline', rows), gridPath('g-sep', seps), gridPath('g-axis', `M${gutter} 0V${H}`));
  if (todayRect) {
    frag.append(svgEl('rect', {
      class: 'g-today-ring', x: todayRect.x + 1, y: todayRect.y + 1, width: todayRect.w - 2, height: todayRect.h - 2,
      'vector-effect': 'non-scaling-stroke',
    }));
  }

  // Day numbers 1..31 down the gutter (today's in the accent color).
  const todayDay = yearOf(ctx.now) === yearStart.getFullYear() ? ctx.now.getDate() : 0;
  const labels = svgEl('g', { class: 'g-daynums', 'font-size': m.dayNumLu, 'text-anchor': 'middle' });
  for (let day = 1; day <= ROWS; day++) {
    const t = svgEl('text', {
      class: day === todayDay ? 'g-daynum is-today' : 'g-daynum',
      x: gutter / 2,
      y: round4((day - 0.5) * ROW_H + m.dayNumLu * 0.36),
    });
    t.textContent = String(day);
    labels.append(t);
  }
  frag.append(labels);
  ctx.gridEl.replaceChildren(frag);
}

function yearOf(d) {
  return isValidDate(d) ? d.getFullYear() : NaN;
}

/** The weekday letter at the cell's top-left: the finger's way into that day. */
function weekdayLabel(ctx, info, mo, chipCount) {
  const r = yearCellRect(mo, info.day);
  const el = htmlEl('div', ['yc-wd', ...dayClassList(info.flags)].join(' '), WEEKDAYS_JA[info.flags.dow] ?? '');
  el.style.cssText = `left:${pct(r.x + PAD, SPEC.W)}%;top:${pct(r.y + PAD, SPEC.H)}%;`;
  const label = [formatDateJa(info.date), info.flags.holiday, chipCount ? `終日の予定${chipCount}件` : '']
    .filter(Boolean).join(' ');
  el.setAttribute('aria-label', `${label}（日表示へ）`);
  onActivate(el, () => ctx.onDayTap(info.date), { ignorePen: true });
  return el;
}

/** The holiday name, tiny, along the bottom of the cell (its full name is in the weekday's label). */
function holidayLabel(info, mo, m) {
  const r = yearCellRect(mo, info.day);
  const el = htmlEl('div', 'yc-hol', info.flags.holiday);
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `left:${pct(r.x + PAD, SPEC.W)}%;top:${pct(r.y + ROW_H - m.holidayLu - 1, SPEC.H)}%;`
    + `width:${pct(r.w - 2 * PAD, SPEC.W)}%;height:${pct(m.holidayLu, SPEC.H)}%;`;
  return el;
}

/**
 * One all-day chip of a day: lane `it.row` of its group (lane metrics `lm`) in the right part of the cell.
 * A multi-day event gets a chip on each of its days: cont-top / cont-bottom square off the continuing
 * side, and link-down draws its color down to the next day's chip (same lane, same group).
 * A chip thinned below THIN_CHIP_PX on screen opens its day on a finger/mouse tap (Enter/Space still
 * open the event), like the month page's thin bars; Pencil taps are ignored (they are ink).
 */
function yearChip(ctx, it, info, mo, monthLen, m, lm) {
  const ev = it.event;
  const day = info.date;
  const next = addDays(day, 1);
  const thin = lm.laneLu < m.chipLu && lm.laneLu * ctx.scale < THIN_CHIP_PX;
  const cls = ['yc-chip'];
  if (ev.start.getTime() < day.getTime()) cls.push('cont-top');
  if (ev.end.getTime() > next.getTime()) {
    cls.push('cont-bottom');
    if (info.day < monthLen) cls.push('link-down');
  }
  if (thin) cls.push('is-thin');
  const chip = htmlEl('div', cls.join(' '));
  chip.dataset.eventId = String(ev.id ?? '');
  chip.dataset.calendarId = String(ev.calendarId ?? '');
  chip.setAttribute('aria-label', `${eventAriaLabel(ev)}、${formatDateJa(day)}${thin ? '（日表示へ）' : ''}`);
  chip.append(htmlEl('span', 'yc-chip-title', eventTitle(ev)));

  const r = yearCellRect(mo, info.day);
  const x = r.x + r.w * YEAR_CHIP_LEFT;
  const w = r.w * (1 - YEAR_CHIP_LEFT) - PAD;
  const y = r.y + m.padLu + it.row * lm.step;
  chip.style.cssText = `left:${pct(x, SPEC.W)}%;top:${pct(y, SPEC.H)}%;width:${pct(w, SPEC.W)}%;`
    + `height:${pct(lm.laneLu, SPEC.H)}%;${eventColorVars(ev, 1)}`
    + (lm.fontScale < 1 ? `--yc-k:${Math.round(lm.fontScale * 1000) / 1000};` : '')
    + (cls.includes('link-down') ? `--yc-link:${round4((ROW_H - lm.laneLu) / lm.laneLu)};` : '');
  onActivate(chip, (e) => {
    if (thin && e?.type !== 'keydown') ctx.onDayTap(day);
    else ctx.onEventTap(ev);
  }, { ignorePen: true });
  return chip;
}

/**
 * All-day chips of one month column, per day (in lane order). The month's days are laid out like a week
 * row of the month page turned on its side: allDayRowsForRange gives each event one lane over all of its
 * days, and lanes are thinned per group of days linked by multi-day events so every chip fits its cell
 * (above the holiday line on holidays).
 */
function monthChipLayout(allDay, infos, m) {
  const perDay = infos.map(() => []);
  const items = safeCall(() => allDayRowsForRange(allDay, infos.map((i) => i.date)), []);
  for (const group of allDayColumnGroups(items)) {
    let lanes = 0;
    let bottom = ROW_H;
    for (const it of group) {
      lanes = Math.max(lanes, it.row + 1);
      for (let d = it.startCol; d <= it.endCol; d++) bottom = Math.min(bottom, chipBottom(infos[d], m));
    }
    const lm = allDayLaneMetrics(lanes, { headerLu: m.padLu, chipLu: m.chipLu, gapLu: m.gapLu }, bottom);
    for (const it of group) {
      for (let d = it.startCol; d <= it.endCol; d++) perDay[d].push({ it, lm });
    }
  }
  for (const list of perDay) list.sort((p, q) => p.it.row - q.it.row);
  return perDay;
}

function buildCells(ctx, months, m) {
  const st = ctx.eventsEl.style;
  st.setProperty('--yc-wd-fs', `${m.weekdayPx}px`);
  st.setProperty('--yc-chip-fs', `${m.chipPx}px`);
  st.setProperty('--yc-hol-fs', `${m.holidayPx}px`);
  const { allDay } = splitAllDay(ctx.events);
  const frag = document.createDocumentFragment();
  // DOM (reading / Tab) order: month by month, day by day: weekday, holiday, that day's chips.
  months.forEach((infos, mo) => {
    const perDay = monthChipLayout(allDay, infos, m);
    infos.forEach((info, i) => {
      frag.append(weekdayLabel(ctx, info, mo, perDay[i].length));
      if (info.flags.holiday) frag.append(holidayLabel(info, mo, m));
      for (const { it, lm } of perDay[i]) frag.append(yearChip(ctx, it, info, mo, infos.length, m, lm));
    });
  });
  ctx.eventsEl.replaceChildren(frag);
}

/** Sticky header: '1月'…'12月' over the 12 columns (after the gutter); a tap opens that month's page. */
function buildSticky(ctx, yearStart) {
  if (!ctx.stickyEl) return;
  const inner = stickyShell(ctx, { '--sh-gutter': `${pct(SPEC.gutter, SPEC.W)}%` });
  const row = htmlEl('div', 'sh-months');
  row.append(htmlEl('div', 'sh-corner'));
  const now = ctx.now;
  for (let mo = 0; mo < COLS; mo++) {
    const first = addMonths(yearStart, mo);
    const current = now.getFullYear() === first.getFullYear() && now.getMonth() === mo;
    const btn = htmlEl('button', current ? 'sh-month is-current' : 'sh-month', `${mo + 1}月`);
    btn.type = 'button';
    btn.setAttribute('aria-label', `${formatMonthJa(first)}（月表示へ）`);
    onActivate(btn, () => ctx.onMonthTap(first));
    row.append(btn);
  }
  inner.append(row);
  ctx.stickyEl.replaceChildren(inner);
}

/**
 * Renders the year page (grid with tints and day numbers, weekday letters, holiday names, all-day chips,
 * month header). Idempotent: clears and redraws. Parameters as the other views (SPEC §4 F1), plus
 * onMonthTap(firstOfMonth) for the month names of the sticky header.
 */
export function render(params) {
  const ctx = beginRender(params, VIEW, SPEC, (date) => rangeFor(VIEW, date));
  const yearStart = yearStartOf(ctx);
  const months = Array.from({ length: COLS }, (_, mo) => monthInfos(ctx, yearStart, mo));
  const m = yearCellMetrics(ctx.scale);
  // The sticky header keeps its height, but the page must never move under the Pencil anyway.
  keepPageInPlace(ctx.pageEl, SPEC.fit, () => {
    buildGrid(ctx, yearStart, months, m);
    buildCells(ctx, months, m);
    buildSticky(ctx, yearStart);
  });
  // No now line; after midnight the today tint / outline move to the new day.
  keepNowLineCurrent({
    gridEl: ctx.gridEl,
    renderedAt: ctx.now,
    onDayChange: () => render({ ...params, now: new Date() }),
  });
}

/**
 * Logical y to scroll to when the year page is first shown: today's row with ROWS_ABOVE_TODAY rows above
 * it in view when today is in that year, else 0 (the top).
 */
export function initialScrollY({ date, now = new Date(), range = null } = {}) {
  if (!isValidDate(now)) return 0;
  let start = isValidDate(range?.yearStart) ? range.yearStart : null;
  if (!start && Array.isArray(range?.days) && isValidDate(range.days[0])) start = range.days[0];
  if (!start) start = isValidDate(date) ? date : now;
  if (start.getFullYear() !== now.getFullYear()) return 0;
  return Math.max(0, (now.getDate() - 1 - ROWS_ABOVE_TODAY) * ROW_H);
}
