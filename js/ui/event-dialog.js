// Event create/edit dialog (module F2b).
//
// openEventDialog({ mode, initial, calendarId, calendars, snapshotUrl, showEraseOption, eraseDefault,
//                   recurring, htmlLink })
//   → Promise<{ action: 'save', input, calendarId, eraseInk } | { action: 'delete' } | { action: 'cancel' }>
//
//   mode       'create' | 'edit' ('view' / 'readonly' are accepted as read-only edit)
//   initial    EventInput-like ({ title, description, location, allDay, start, end }); a CalEvent works too
//              (initial.editable === false → read-only: fields disabled, only 「閉じる」 + Google link)
//   calendars  CalInfo[]; the select lists writable, non-holiday calendars only
//
// Extra options (optional): readOnly (boolean), root (modal host element), onSubmit(result) — when given,
// the dialog stays open while the returned promise is pending and shows its error message if it rejects
// (so a failed save does not lose what the user wrote). A request can stall (WebKit fetch may hang for
// about a minute): after stallMs (default 15 s) 「キャンセル」, Esc and the backdrop work again and resolve
// { action: 'cancel', pending: true } — the onSubmit promise keeps running and the caller reports its
// outcome later.
//
// Form model (pure, exported for tests): strings exactly as the inputs hold them.
//   { title, location, description, allDay,
//     startDate 'YYYY-MM-DD'   timed: 日付 / all-day: 開始日
//     endDate   'YYYY-MM-DD'   timed: date of the end instant / all-day: 終了日 (INCLUSIVE, as shown)
//     startTime 'HH:MM', endTime 'HH:MM'   (timed; kept while all-day so toggling back restores them) }
// EventInput all-day end is EXCLUSIVE (SPEC §2): inclusive 終了日 + 1 day.

import { h, svgIcon, openModal, switchControl, uid, replayClass } from './dom.js';
import {
  addDays, atMinutes, daysBetween, isValidDate, parseHM, parseYMD, startOfDay, toHM, toYMD,
} from '../util/date.js';

const HOUR_MS = 60 * 60 * 1000;
const SUBMIT_STALL_MS = 15 * 1000;
const DEFAULT_START_TIME = '09:00';
const DEFAULT_END_TIME = '10:00';

export const DIALOG_TEXT = Object.freeze({
  titleCreate: '予定を追加',
  titleEdit: '予定を編集',
  titleView: '予定の詳細',
  titlePlaceholder: 'ここにペンで書くと文字になります',
  titleHint: '✏️ Apple Pencil で欄の上に書くと、文字に変換されます（スクリブル）',
  snapshotCaption: '書いた内容',
  recurringNote: '繰り返し予定のうち、この回だけが変更されます',
  confirmDelete: 'この予定を削除しますか？',
  googleLink: 'Googleカレンダーで開く',
  erase: 'この手書きを消す',
  errTitle: 'タイトルを入力してください',
  errStart: '開始日を入力してください',
  errStartTime: '開始時刻を入力してください',
  errEnd: '終了日を入力してください',
  errEndTime: '終了時刻を入力してください',
  errEndBeforeStart: '終了は開始より後にしてください',
  errEndDayBeforeStart: '終了日は開始日以降にしてください',
  saveFailed: '保存できませんでした',
  stalled: '通信に時間がかかっています。「キャンセル」で閉じられます（結果はあとでお知らせします）',
});

// ---------------------------------------------------------------------------------------------
// Pure form logic

function str(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

/** The next full hour after `now` (default start for a dialog without times). */
function nextHour(now) {
  const base = isValidDate(now) ? now : new Date();
  const d = new Date(base.getTime());
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** Timed start/end instants of a form (Invalid Date when a field is unusable). */
function timedInstants(form) {
  const sd = parseYMD(form.startDate);
  const ed = parseYMD(form.endDate);
  const sm = parseHM(form.startTime);
  const em = parseHM(form.endTime);
  return {
    start: sd && sm != null ? atMinutes(sd, sm) : new Date(NaN),
    end: ed && em != null ? atMinutes(ed, em) : new Date(NaN),
  };
}

function setTimedEnd(form, end) {
  return { ...form, endDate: toYMD(end), endTime: toHM(end) };
}

/**
 * EventInput (or CalEvent) → form strings. Bad or missing dates fall back to the next full hour (1 h).
 * All-day: the exclusive end becomes the inclusive last day; times default to 09:00–10:00.
 */
export function formFromInput(input, now = new Date()) {
  const src = input && typeof input === 'object' ? input : {};
  const allDay = Boolean(src.allDay);
  const start = isValidDate(src.start) ? src.start : nextHour(now);
  let end = isValidDate(src.end) ? src.end : null;
  const form = {
    title: str(src.title),
    location: str(src.location),
    description: str(src.description),
    allDay,
    startDate: '', endDate: '', startTime: DEFAULT_START_TIME, endTime: DEFAULT_END_TIME,
  };
  if (allDay) {
    const s = startOfDay(start);
    // Exclusive end at a midnight; a non-midnight end (bad data) still covers its own day.
    let e = end ? startOfDay(end) : null;
    if (e && end.getTime() !== e.getTime()) e = addDays(e, 1);
    if (!e || e.getTime() <= s.getTime()) e = addDays(s, 1);
    form.startDate = toYMD(s);
    form.endDate = toYMD(addDays(e, -1));
    return form;
  }
  if (!end || end.getTime() <= start.getTime()) end = new Date(start.getTime() + HOUR_MS);
  form.startDate = toYMD(start);
  form.startTime = toHM(start);
  form.endDate = toYMD(end);
  form.endTime = toHM(end);
  return form;
}

/**
 * Form → EventInput with validation.
 * @returns {{ ok: true, input: object, errors: {} } | { ok: false, errors: { title?, start?, end? } }}
 */
export function inputFromForm(form) {
  const f = form && typeof form === 'object' ? form : {};
  const errors = {};
  const title = str(f.title).trim();
  if (!title) errors.title = DIALOG_TEXT.errTitle;

  let start;
  let end;
  const sd = parseYMD(str(f.startDate));
  const ed = parseYMD(str(f.endDate));
  if (!sd) errors.start = DIALOG_TEXT.errStart;
  if (f.allDay) {
    if (!ed) errors.end = DIALOG_TEXT.errEnd;
    else if (sd && ed.getTime() < sd.getTime()) errors.end = DIALOG_TEXT.errEndDayBeforeStart;
    if (sd && ed) {
      start = sd;
      end = addDays(ed, 1);
    }
  } else {
    const sm = parseHM(str(f.startTime));
    const em = parseHM(str(f.endTime));
    if (sd && sm == null) errors.start = DIALOG_TEXT.errStartTime;
    if (!ed) errors.end = DIALOG_TEXT.errEnd;
    else if (em == null) errors.end = DIALOG_TEXT.errEndTime;
    if (sd && sm != null && ed && em != null) {
      start = atMinutes(sd, sm);
      end = atMinutes(ed, em);
      if (!(end.getTime() > start.getTime())) errors.end = DIALOG_TEXT.errEndBeforeStart;
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    input: {
      title,
      description: str(f.description).replace(/\s+$/, ''),
      location: str(f.location).trim(),
      allDay: Boolean(f.allDay),
      start,
      end,
    },
  };
}

/** Toggles 終日, converting the end between "timed end instant" and "inclusive last day". */
export function toggleAllDay(form, on) {
  const allDay = Boolean(on);
  if (allDay === Boolean(form.allDay)) return { ...form };
  if (allDay) {
    const { start, end } = timedInstants(form);
    const sd = parseYMD(form.startDate);
    let last = isValidDate(end) ? startOfDay(end) : sd;
    // An end exactly at midnight does not touch that day (23:00–24:00 is a one-day event).
    if (isValidDate(end) && isValidDate(start) && end.getTime() === last.getTime() && end > start) {
      last = addDays(last, -1);
    }
    if (!last || (sd && last.getTime() < sd.getTime())) last = sd;
    return { ...form, allDay: true, endDate: last ? toYMD(last) : form.startDate };
  }
  // all-day → timed: the remembered times on the start day; end ≤ start → start + 1 h.
  const sd = parseYMD(form.startDate);
  if (!sd) return { ...form, allDay: false };
  const startTime = parseHM(form.startTime) != null ? form.startTime : DEFAULT_START_TIME;
  const endTime = parseHM(form.endTime) != null ? form.endTime : DEFAULT_END_TIME;
  const start = atMinutes(sd, parseHM(startTime));
  let end = atMinutes(sd, parseHM(endTime));
  if (!(end > start)) end = new Date(start.getTime() + HOUR_MS);
  return { ...form, allDay: false, startTime, endDate: toYMD(end), endTime: toHM(end) };
}

/** Moves the start (startDate/startTime) and keeps the duration (timed: exact ms; all-day: whole days). */
function moveStart(form, field, value) {
  const next = { ...form, [field]: value };
  if (form.allDay) {
    if (field !== 'startDate') return next;
    const newStart = parseYMD(value);
    if (!newStart) return { ...form }; // unusable value (e.g. cleared): keep the previous one
    const oldStart = parseYMD(form.startDate);
    const oldEnd = parseYMD(form.endDate);
    const days = oldStart && oldEnd && oldEnd >= oldStart ? daysBetween(oldStart, oldEnd) : 0;
    return { ...next, endDate: toYMD(addDays(newStart, days)) };
  }
  const old = timedInstants(form);
  const duration = isValidDate(old.start) && isValidDate(old.end) && old.end > old.start
    ? old.end.getTime() - old.start.getTime()
    : HOUR_MS;
  const { start } = timedInstants(next);
  if (!isValidDate(start)) return { ...form };
  return setTimedEnd(next, new Date(start.getTime() + duration));
}

/** Sets the end (endDate/endTime); an end not after the start is auto-corrected (timed: start + 1 h). */
function moveEnd(form, field, value) {
  const next = { ...form, [field]: value };
  if (form.allDay) {
    if (field !== 'endDate') return next;
    const s = parseYMD(next.startDate);
    const e = parseYMD(value);
    if (!e) return { ...form };
    return s && e < s ? { ...next, endDate: next.startDate } : next;
  }
  const { start, end } = timedInstants(next);
  if (!isValidDate(end)) return { ...form };
  if (isValidDate(start) && !(end > start)) return setTimedEnd(next, new Date(start.getTime() + HOUR_MS));
  return next;
}

/**
 * Applies one user edit to the form (pure). Start changes keep the duration; an end before the start is
 * auto-corrected; an unusable date/time value (cleared picker) is rejected (previous value kept).
 * @param {object} form
 * @param {'title'|'location'|'description'|'allDay'|'startDate'|'startTime'|'endDate'|'endTime'} field
 */
export function applyFieldChange(form, field, value) {
  switch (field) {
    case 'title':
    case 'location':
    case 'description':
      return { ...form, [field]: str(value) };
    case 'allDay':
      return toggleAllDay(form, value);
    case 'startDate':
    case 'startTime':
      return moveStart(form, field, str(value));
    case 'endDate':
    case 'endTime':
      return moveEnd(form, field, str(value));
    default:
      return { ...form };
  }
}

/** Whether the timed form needs a separate 終了日 field (the end falls on another day). */
export function needsEndDate(form) {
  return !form.allDay && Boolean(form.endDate) && form.endDate !== form.startDate;
}

/** Calendars that may receive new events: writable and not a holiday calendar. */
export function writableCalendars(calendars) {
  return (Array.isArray(calendars) ? calendars : [])
    .filter((c) => c && typeof c.id === 'string' && c.writable && !c.holiday);
}

/** The calendar to preselect: preferred id if writable, else the writable primary, else the first writable. */
export function pickCalendarId(calendars, preferredId) {
  const list = writableCalendars(calendars);
  if (preferredId && list.some((c) => c.id === preferredId)) return preferredId;
  const primary = list.find((c) => c.primary);
  if (primary) return primary.id;
  return list.length ? list[0].id : (preferredId || null);
}

/** Only http(s) links are shown (never javascript: or data: URLs). */
export function safeHttpUrl(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

// ---------------------------------------------------------------------------------------------
// DOM

function field(labelText, control, { id, className = '', error } = {}) {
  return h('div', { class: ['field', className] },
    h('label', { class: 'field-label', for: id }, labelText),
    control,
    error || null);
}

function errorEl() {
  return h('p', { class: 'field-error', role: 'alert', hidden: true });
}

function setError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

/**
 * Opens the event dialog. See the file header for the contract.
 * @returns {Promise<{ action: 'save', input: object, calendarId: string|null, eraseInk: boolean }
 *                   | { action: 'delete' } | { action: 'cancel', pending?: true }>}
 */
export function openEventDialog(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const mode = o.mode === 'edit' || o.mode === 'view' || o.mode === 'readonly' ? 'edit' : 'create';
  const initial = o.initial && typeof o.initial === 'object' ? o.initial : {};
  const calendars = Array.isArray(o.calendars) ? o.calendars : [];
  const readOnly = Boolean(o.readOnly) || o.mode === 'view' || o.mode === 'readonly' || initial.editable === false;
  const isEdit = mode === 'edit';
  const recurring = Boolean(o.recurring ?? initial.recurring);
  const htmlLink = safeHttpUrl(o.htmlLink ?? initial.htmlLink);
  const showErase = Boolean(o.showEraseOption) && !readOnly;
  const onSubmit = typeof o.onSubmit === 'function' ? o.onSubmit : null;
  const stallMs = Number(o.stallMs) > 0 ? Number(o.stallMs) : SUBMIT_STALL_MS;

  let form = formFromInput(initial);
  const writable = writableCalendars(calendars);
  // Editing never moves an event to another calendar (that would need the Calendar "move" API).
  let calendarId = isEdit ? (o.calendarId ?? initial.calendarId ?? null) : pickCalendarId(calendars, o.calendarId);

  return new Promise((resolve) => {
    let settled = false;
    let busy = false;
    let stalled = false;   // the pending onSubmit took longer than stallMs: the user may close the sheet
    let stallTimer = null;
    const titleId = uid('evd-title');
    const ids = {
      title: uid('evd-name'), startDate: uid('evd-sd'), startTime: uid('evd-st'), endDate: uid('evd-ed'),
      endTime: uid('evd-et'), adStart: uid('evd-ads'), adEnd: uid('evd-ade'), cal: uid('evd-cal'),
      loc: uid('evd-loc'), memo: uid('evd-memo'),
    };

    const modal = openModal({
      root: o.root,
      className: 'dialog--event',
      labelledBy: titleId,
      // While an onSubmit call is pending, Esc/backdrop are ignored (the save may still succeed) — until it
      // has stalled for stallMs.
      onDismiss: (reason) => { if (!busy || stalled || reason === 'replaced') cancel(); },
    });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearStallTimer();
      modal.close();
      resolve(result);
    }

    function cancel() {
      finish(busy ? { action: 'cancel', pending: true } : { action: 'cancel' });
    }

    function clearStallTimer() {
      if (stallTimer) globalThis.clearTimeout(stallTimer);
      stallTimer = null;
    }

    // ---- inputs
    const titleInput = h('input', {
      id: ids.title, type: 'text', class: 'input input-title', enterkeyhint: 'done', autocomplete: 'off',
      autocapitalize: 'off', spellcheck: 'false', placeholder: DIALOG_TEXT.titlePlaceholder,
      value: form.title, disabled: readOnly, 'aria-describedby': `${ids.title}-hint`,
      onInput: () => { form = applyFieldChange(form, 'title', titleInput.value); setError(titleErr, ''); },
      onKeydown: (e) => {
        // 「完了」/Enter closes the keyboard; it never submits (IME conversion uses Enter too).
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          titleInput.blur();
        }
      },
    });
    const titleErr = errorEl();

    const dateInput = (id, value) => h('input', { id, type: 'date', class: 'input input-date', value, disabled: readOnly, required: true });
    const timeInput = (id, value) => h('input', { id, type: 'time', class: 'input input-time', value, step: '300', disabled: readOnly, required: true });

    const startDateIn = dateInput(ids.startDate, form.startDate);
    const startTimeIn = timeInput(ids.startTime, form.startTime);
    const endTimeIn = timeInput(ids.endTime, form.endTime);
    const endDateIn = dateInput(ids.endDate, form.endDate);
    const adStartIn = dateInput(ids.adStart, form.startDate);
    const adEndIn = dateInput(ids.adEnd, form.endDate);
    const startErr = errorEl();
    const endErr = errorEl();

    const endDateField = field('終了日', endDateIn, { id: ids.endDate, className: 'field-end-date' });
    const timedGroup = h('div', { class: 'field-grid field-grid--timed' },
      field('日付', startDateIn, { id: ids.startDate, className: 'field-date' }),
      field('開始', startTimeIn, { id: ids.startTime, className: 'field-time' }),
      field('終了', endTimeIn, { id: ids.endTime, className: 'field-time' }),
      endDateField);
    const allDayGroup = h('div', { class: 'field-grid field-grid--allday' },
      field('開始日', adStartIn, { id: ids.adStart }),
      field('終了日', adEndIn, { id: ids.adEnd }));

    const allDaySwitch = switchControl('終日', {
      checked: form.allDay, disabled: readOnly,
      onChange: (on) => { form = applyFieldChange(form, 'allDay', on); syncDates(); },
    });

    // Date/time pickers: every change goes through the pure model, then all inputs are re-synced.
    const bindStart = (input, name) => input.addEventListener('change', () => {
      form = applyFieldChange(form, name, input.value);
      syncDates();
    });
    // iPadOS updates the value live while the picker wheel spins: correcting an end that is (for the
    // moment) before the start would fight the user, so the raw value is kept on change and the
    // end-before-start correction runs when the picker closes (blur).
    const bindEnd = (input, name) => {
      input.addEventListener('change', () => {
        const usable = name === 'endTime' ? parseHM(input.value) != null : parseYMD(input.value) != null;
        if (usable) form = { ...form, [name]: input.value };
        endDateField.hidden = !needsEndDate(form);
      });
      input.addEventListener('blur', () => {
        form = applyFieldChange(form, name, input.value);
        syncDates();
      });
    };
    bindStart(startDateIn, 'startDate');
    bindStart(startTimeIn, 'startTime');
    bindEnd(endTimeIn, 'endTime');
    bindEnd(endDateIn, 'endDate');
    bindStart(adStartIn, 'startDate');
    bindEnd(adEndIn, 'endDate');

    function syncDates() {
      const setVal = (input, v) => { if (input.value !== v) input.value = v; };
      setVal(startDateIn, form.startDate);
      setVal(startTimeIn, form.startTime);
      setVal(endTimeIn, form.endTime);
      setVal(endDateIn, form.endDate);
      setVal(adStartIn, form.startDate);
      setVal(adEndIn, form.endDate);
      timedGroup.hidden = form.allDay;
      allDayGroup.hidden = !form.allDay;
      endDateField.hidden = !needsEndDate(form);
      setError(startErr, '');
      setError(endErr, '');
    }

    // ---- calendar select (create: writable calendars; edit/read-only: the event's calendar, fixed).
    // Options read '● name' (an <option> cannot be colored on iPad); the select's left edge shows the color.
    let calendarField = null;
    const tint = (select, id) => {
      const color = calendars.find((c) => c && c.id === id)?.color;
      select.classList.toggle('has-cal', Boolean(color));
      if (color) select.style.setProperty('--cal', color);
    };
    if (isEdit || readOnly) {
      const cal = calendars.find((c) => c && c.id === calendarId);
      if (cal) {
        const select = h('select', { id: ids.cal, class: 'input select', disabled: true },
          h('option', { value: cal.id, selected: true }, `● ${cal.name || cal.id}`));
        select.value = cal.id;
        tint(select, cal.id);
        calendarField = field('カレンダー', select, { id: ids.cal });
      }
    } else if (writable.length) {
      const select = h('select', {
        id: ids.cal, class: 'input select', disabled: writable.length < 2,
        onChange: () => { calendarId = select.value; tint(select, calendarId); },
      }, writable.map((c) => h('option', { value: c.id, selected: c.id === calendarId }, `● ${c.name || c.id}`)));
      if (calendarId) select.value = calendarId;
      tint(select, calendarId);
      calendarField = field('カレンダー', select, { id: ids.cal });
    }

    const locInput = h('input', {
      id: ids.loc, type: 'text', class: 'input', autocomplete: 'off', enterkeyhint: 'done', value: form.location,
      disabled: readOnly, onInput: () => { form = applyFieldChange(form, 'location', locInput.value); },
    });
    const memoInput = h('textarea', {
      id: ids.memo, class: 'input textarea', rows: '3', disabled: readOnly,
      onInput: () => { form = applyFieldChange(form, 'description', memoInput.value); },
    });
    memoInput.value = form.description;

    const eraseSwitch = showErase ? switchControl(DIALOG_TEXT.erase, { checked: o.eraseDefault !== false }) : null;

    // ---- body
    const body = h('div', { class: 'dialog-body' },
      o.snapshotUrl && typeof o.snapshotUrl === 'string'
        ? h('figure', { class: 'snapshot' },
          h('img', { src: o.snapshotUrl, alt: '選択した手書き', draggable: 'false' }),
          h('figcaption', null, DIALOG_TEXT.snapshotCaption))
        : null,
      h('div', { class: 'field field-title' },
        h('label', { class: 'field-label', for: ids.title }, 'タイトル'),
        titleInput,
        readOnly ? null : h('p', { class: 'hint', id: `${ids.title}-hint` }, DIALOG_TEXT.titleHint),
        titleErr),
      h('div', { class: 'card-group' }, allDaySwitch.row),
      timedGroup,
      allDayGroup,
      startErr,
      endErr,
      calendarField,
      field('場所', locInput, { id: ids.loc }),
      field('メモ', memoInput, { id: ids.memo }),
      eraseSwitch ? h('div', { class: 'card-group' }, eraseSwitch.row) : null,
      recurring && isEdit && !readOnly
        ? h('p', { class: 'note' }, svgIcon('repeat', { size: 18 }), h('span', null, DIALOG_TEXT.recurringNote))
        : null,
      htmlLink
        ? h('a', { class: 'link-external', href: htmlLink, target: '_blank', rel: 'noopener noreferrer' },
          h('span', null, DIALOG_TEXT.googleLink), svgIcon('external', { size: 16 }))
        : null);

    // ---- footer
    const footerError = h('p', { class: 'dialog-error', role: 'alert', hidden: true });
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => save() }, '保存');
    const cancelBtn = h('button', { type: 'button', class: 'btn', onClick: () => cancel() },
      readOnly ? '閉じる' : 'キャンセル');
    const deleteBtn = isEdit && !readOnly
      ? h('button', { type: 'button', class: 'btn btn-danger', onClick: () => remove() },
        svgIcon('trash', { size: 18 }), h('span', null, '削除'))
      : null;
    const footer = h('div', { class: 'dialog-footer' },
      footerError,
      h('div', { class: 'dialog-actions' },
        deleteBtn,
        h('span', { class: 'dialog-actions-spacer' }),
        cancelBtn,
        readOnly ? null : saveBtn));

    const heading = readOnly ? DIALOG_TEXT.titleView : (isEdit ? DIALOG_TEXT.titleEdit : DIALOG_TEXT.titleCreate);
    modal.dialog.append(
      h('div', { class: 'dialog-header' }, h('h2', { class: 'dialog-title', id: titleId }, heading)),
      body,
      footer);
    syncDates();

    // Desktop nicety: ⌘/Ctrl + Enter saves.
    modal.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !readOnly) {
        e.preventDefault();
        save();
      }
    });

    function setBusy(on, action) {
      busy = on;
      stalled = false;
      clearStallTimer();
      for (const b of [saveBtn, cancelBtn, deleteBtn]) if (b) b.disabled = on;
      saveBtn.textContent = on && action === 'save' ? '保存中…' : '保存';
      if (!on) return;
      stallTimer = globalThis.setTimeout(() => {
        stallTimer = null;
        if (!busy || settled) return;
        stalled = true;
        cancelBtn.disabled = false;
        setError(footerError, DIALOG_TEXT.stalled);
      }, stallMs);
      if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref();
    }

    async function submit(result) {
      if (!onSubmit) {
        finish(result);
        return;
      }
      setBusy(true, result.action);
      setError(footerError, '');
      try {
        await onSubmit(result);
        finish(result);
      } catch (err) {
        setBusy(false);
        const msg = err && typeof err.message === 'string' && err.message ? err.message : DIALOG_TEXT.saveFailed;
        setError(footerError, msg);
      }
    }

    function save() {
      if (busy || settled || readOnly) return;
      // Re-read the text fields (Scribble/autocorrect may not always fire input events).
      form = applyFieldChange(form, 'title', titleInput.value);
      form = applyFieldChange(form, 'location', locInput.value);
      form = applyFieldChange(form, 'description', memoInput.value);
      const res = inputFromForm(form);
      if (!res.ok) {
        setError(titleErr, res.errors.title || '');
        setError(startErr, res.errors.start || '');
        setError(endErr, res.errors.end || '');
        if (res.errors.title) {
          replayClass(titleInput.parentElement, 'is-shaking');
          titleInput.focus();
        }
        return;
      }
      submit({
        action: 'save',
        input: res.input,
        calendarId: calendarId ?? null,
        eraseInk: eraseSwitch ? Boolean(eraseSwitch.input.checked) : false,
      });
    }

    function remove() {
      if (busy || settled) return;
      const ask = globalThis.confirm;
      const message = recurring
        ? `${DIALOG_TEXT.confirmDelete}\n（繰り返し予定のうち、この回だけが削除されます）`
        : DIALOG_TEXT.confirmDelete;
      if (typeof ask === 'function' && !ask(message)) return;
      submit({ action: 'delete' });
    }
  });
}
