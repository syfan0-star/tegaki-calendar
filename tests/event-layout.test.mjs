// Tests for js/views/event-layout.js (run with TZ=Asia/Tokyo).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allDayRowsForRange,
  eventsOnDay,
  layoutTimedEvents,
  splitAllDay,
} from '../js/views/event-layout.js';

const d = (y, m, day, h = 0, mi = 0) => new Date(y, m - 1, day, h, mi);

/** Timed CalEvent on 2026-10-<day> from hh:mm to hh:mm (end may be on another day via endDay). */
function timed(id, day, sh, sm, eh, em, { endDay = day, title = id } = {}) {
  return {
    id, calendarId: 'primary', title, description: '', location: '', allDay: false,
    start: d(2026, 10, day, sh, sm), end: d(2026, 10, endDay, eh, em),
    color: '#039be5', textColor: '#ffffff', htmlLink: '', recurring: false, editable: true,
  };
}

/** All-day CalEvent covering [startDay, endDayExclusive) in October 2026 (days may exceed 31). */
function allDay(id, startDay, endDayExclusive, title = id) {
  return {
    id, calendarId: 'primary', title, description: '', location: '', allDay: true,
    start: d(2026, 10, startDay), end: d(2026, 10, endDayExclusive),
    color: '#33b679', textColor: '#ffffff', htmlLink: '', recurring: false, editable: true,
  };
}

const ids = (list) => list.map((x) => (x.event ? x.event.id : x.id));
const DAY = d(2026, 10, 4);
const WEEK_DAYS = Array.from({ length: 7 }, (_, i) => d(2026, 10, 4 + i)); // Sun 10/4 – Sat 10/10

/** layoutTimedEvents result as { id: [startMin, endMin, col, cols] }. */
function layoutMap(events, day = DAY) {
  return Object.fromEntries(layoutTimedEvents(events, day)
    .map((it) => [it.event.id, [it.startMin, it.endMin, it.col, it.cols]]));
}

// ---------------------------------------------------------------------------------------------
// eventsOnDay

test('eventsOnDay: overlap with [day, day + 1) and the documented sort order', () => {
  const events = [
    timed('late', 4, 18, 0, 19, 0),
    timed('short9', 4, 9, 0, 9, 30),
    timed('long9', 4, 9, 0, 11, 0),
    timed('b-title', 4, 13, 0, 14, 0, { title: 'いちご' }),
    timed('a-title', 4, 13, 0, 14, 0, { title: 'あめ' }),
    allDay('ad1', 4, 5),
    allDay('adMulti', 2, 6),
    timed('overnight', 3, 22, 0, 2, 0, { endDay: 4 }),
    timed('endsAtMidnight', 3, 20, 0, 0, 0, { endDay: 4 }),
    timed('startsNextDay', 5, 0, 0, 1, 0),
    allDay('adEndsToday', 2, 4),
    allDay('adTomorrow', 5, 6),
  ];
  assert.deepEqual(ids(eventsOnDay(events, d(2026, 10, 4, 15))), [
    'adMulti', // all-day first; earlier start first
    'ad1',
    'overnight',
    'long9', // same start: longer first
    'short9',
    'a-title', // same start and length: by title (あめ < いちご)
    'b-title',
    'late',
  ]);
});

test('eventsOnDay: zero-length events belong to the day containing their instant', () => {
  const atMidnight = timed('zeroMidnight', 4, 0, 0, 0, 0);
  const atNoon = timed('zeroNoon', 4, 12, 0, 12, 0);
  const inverted = timed('inverted', 4, 12, 0, 11, 0);
  const events = [atMidnight, atNoon, inverted];
  assert.deepEqual(ids(eventsOnDay(events, d(2026, 10, 4))), ['zeroMidnight', 'inverted', 'zeroNoon']);
  assert.deepEqual(ids(eventsOnDay(events, d(2026, 10, 3))), []);
  assert.deepEqual(ids(eventsOnDay(events, d(2026, 10, 5))), []);
});

test('eventsOnDay: bad input is ignored, input is not mutated', () => {
  const good = timed('ok', 4, 9, 0, 10, 0);
  const events = [null, undefined, 42, {}, { start: d(2026, 10, 4, 9) }, { start: new Date(NaN), end: d(2026, 10, 4) },
    { start: '2026-10-04', end: '2026-10-05' }, good];
  const copy = events.slice();
  assert.deepEqual(ids(eventsOnDay(events, DAY)), ['ok']);
  assert.deepEqual(events, copy);
  assert.deepEqual(eventsOnDay(null, DAY), []);
  assert.deepEqual(eventsOnDay([good], new Date(NaN)), []);
  assert.deepEqual(eventsOnDay([good], 'today'), []);
});

// ---------------------------------------------------------------------------------------------
// layoutTimedEvents

test('layoutTimedEvents: single event and all-day exclusion', () => {
  assert.deepEqual(layoutMap([timed('a', 4, 9, 0, 10, 30), allDay('ad', 4, 5)]), { a: [540, 630, 0, 1] });
  assert.deepEqual(layoutTimedEvents([], DAY), []);
  assert.deepEqual(layoutTimedEvents(undefined, DAY), []);
});

test('layoutTimedEvents: back-to-back events do not overlap', () => {
  assert.deepEqual(layoutMap([timed('a', 4, 9, 0, 10, 0), timed('b', 4, 10, 0, 11, 0), timed('c', 4, 11, 0, 12, 0)]), {
    a: [540, 600, 0, 1], b: [600, 660, 0, 1], c: [660, 720, 0, 1],
  });
});

test('layoutTimedEvents: identical starts — longer first, then title', () => {
  assert.deepEqual(layoutMap([timed('short', 4, 9, 0, 10, 0), timed('long', 4, 9, 0, 11, 0)]), {
    long: [540, 660, 0, 2], short: [540, 600, 1, 2],
  });
  const same = layoutTimedEvents([timed('x2', 4, 9, 0, 10, 0, { title: 'B' }), timed('x1', 4, 9, 0, 10, 0, { title: 'A' })], DAY);
  assert.deepEqual(same.map((it) => [it.event.title, it.col, it.cols]), [['A', 0, 2], ['B', 1, 2]]);
  // Three identical events → three columns.
  const triple = layoutMap(['p', 'q', 'r'].map((id) => timed(id, 4, 14, 0, 15, 0)));
  assert.deepEqual(triple, { p: [840, 900, 0, 3], q: [840, 900, 1, 3], r: [840, 900, 2, 3] });
});

test('layoutTimedEvents: nested events', () => {
  assert.deepEqual(layoutMap([timed('inner', 4, 10, 0, 11, 0), timed('outer', 4, 9, 0, 12, 0)]), {
    outer: [540, 720, 0, 2], inner: [600, 660, 1, 2],
  });
  assert.deepEqual(layoutMap([
    timed('outer', 4, 9, 0, 12, 0), timed('inner1', 4, 10, 0, 11, 0), timed('inner2', 4, 10, 30, 11, 30),
  ]), {
    outer: [540, 720, 0, 3], inner1: [600, 660, 1, 3], inner2: [630, 690, 2, 3],
  });
});

test('layoutTimedEvents: greedy column reuse and transitive clusters', () => {
  // b and c are back-to-back, so c reuses b's column.
  assert.deepEqual(layoutMap([timed('a', 4, 9, 0, 12, 0), timed('b', 4, 9, 0, 10, 0), timed('c', 4, 10, 0, 11, 0)]), {
    a: [540, 720, 0, 2], b: [540, 600, 1, 2], c: [600, 660, 1, 2],
  });
  // Chain a–b–c: a and c do not overlap but share a cluster through b; d is a separate cluster.
  assert.deepEqual(layoutMap([
    timed('a', 4, 9, 0, 10, 0), timed('b', 4, 9, 30, 10, 30), timed('c', 4, 10, 15, 11, 0), timed('d', 4, 11, 0, 12, 0),
  ]), {
    a: [540, 600, 0, 2], b: [570, 630, 1, 2], c: [615, 660, 0, 2], d: [660, 720, 0, 1],
  });
});

test('layoutTimedEvents: events crossing midnight are clipped per day', () => {
  const overnight = timed('overnight', 3, 22, 0, 2, 0, { endDay: 4 });
  assert.deepEqual(layoutMap([overnight], d(2026, 10, 3)), { overnight: [1320, 1440, 0, 1] });
  assert.deepEqual(layoutMap([overnight], d(2026, 10, 4)), { overnight: [0, 120, 0, 1] });
  assert.deepEqual(layoutMap([overnight], d(2026, 10, 5)), {});

  const multi = timed('multi', 3, 12, 0, 12, 0, { endDay: 5 });
  assert.deepEqual(layoutMap([multi], d(2026, 10, 3)), { multi: [720, 1440, 0, 1] });
  assert.deepEqual(layoutMap([multi], d(2026, 10, 4)), { multi: [0, 1440, 0, 1] });
  assert.deepEqual(layoutMap([multi], d(2026, 10, 5)), { multi: [0, 720, 0, 1] });

  const toMidnight = timed('toMidnight', 4, 23, 0, 0, 0, { endDay: 5 });
  assert.deepEqual(layoutMap([toMidnight], d(2026, 10, 4)), { toMidnight: [1380, 1440, 0, 1] });
  assert.deepEqual(layoutMap([toMidnight], d(2026, 10, 5)), {}, 'ending exactly at midnight is not on the next day');

  // The overnight event overlaps an early-morning event on the second day.
  assert.deepEqual(layoutMap([overnight, timed('early', 4, 1, 0, 3, 0)], d(2026, 10, 4)), {
    overnight: [0, 120, 0, 2], early: [60, 180, 1, 2],
  });
});

test('layoutTimedEvents: 15-minute visual minimum (and it counts for overlap)', () => {
  assert.deepEqual(layoutMap([timed('tiny', 4, 9, 0, 9, 5)]), { tiny: [540, 555, 0, 1] });
  assert.deepEqual(layoutMap([timed('zero', 4, 9, 0, 9, 0)]), { zero: [540, 555, 0, 1] });
  assert.deepEqual(layoutMap([timed('inverted', 4, 9, 0, 8, 0)]), { inverted: [540, 555, 0, 1] });
  // Near midnight the box stays inside the day.
  assert.deepEqual(layoutMap([timed('lateZero', 4, 23, 55, 23, 55)]), { lateZero: [1425, 1440, 0, 1] });
  assert.deepEqual(layoutMap([timed('lateShort', 4, 23, 50, 0, 0, { endDay: 5 })]), { lateShort: [1425, 1440, 0, 1] });
  // The 5-minute event is drawn 15 minutes tall, so it collides visually with one starting at 9:10.
  assert.deepEqual(layoutMap([timed('tiny', 4, 9, 0, 9, 5), timed('next', 4, 9, 10, 10, 0)]), {
    tiny: [540, 555, 0, 2], next: [550, 600, 1, 2],
  });
  // ...but not with one starting at 9:15.
  assert.deepEqual(layoutMap([timed('tiny', 4, 9, 0, 9, 5), timed('next', 4, 9, 15, 10, 0)]), {
    tiny: [540, 555, 0, 1], next: [555, 600, 0, 1],
  });
});

test('layoutTimedEvents: output order and immutability', () => {
  const events = [timed('c', 4, 15, 0, 16, 0), timed('a', 4, 8, 0, 9, 0), timed('b', 4, 8, 30, 9, 30)];
  const before = JSON.stringify(events);
  const out = layoutTimedEvents(events, DAY);
  assert.deepEqual(ids(out), ['a', 'b', 'c']);
  assert.equal(out[0].event, events[1], 'items reference the original event objects');
  assert.equal(JSON.stringify(events), before);
});

/** mulberry32 PRNG for property tests. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('layoutTimedEvents: random schedules never produce visual collisions', () => {
  const rand = prng(42);
  for (let round = 0; round < 300; round++) {
    const n = 1 + Math.floor(rand() * 12);
    const events = Array.from({ length: n }, (_, i) => {
      const startMin = Math.floor(rand() * 96) * 15 - 120; // may start the previous day
      const len = Math.floor(rand() * 16) * 15;            // may be zero-length
      const start = new Date(2026, 9, 4, 0, startMin);
      return { ...timed(`e${i}`, 4, 0, 0, 0, 0), start, end: new Date(start.getTime() + len * 60000) };
    });
    const out = layoutTimedEvents(events, DAY);
    for (const it of out) {
      assert.ok(it.startMin >= 0 && it.endMin <= 1440 && it.endMin - it.startMin >= 15);
      assert.ok(Number.isInteger(it.col) && it.col >= 0 && it.col < it.cols);
    }
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (a.startMin < b.endMin && b.startMin < a.endMin) {
          assert.notEqual(a.col, b.col, `round ${round}: ${a.event.id} and ${b.event.id} collide`);
          assert.equal(a.cols, b.cols, 'overlapping events share a cluster');
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// splitAllDay

test('splitAllDay keeps order and drops unusable entries', () => {
  const a = allDay('a', 4, 5);
  const t1 = timed('t1', 4, 9, 0, 10, 0);
  const b = allDay('b', 1, 3);
  const t2 = timed('t2', 4, 8, 0, 9, 0);
  assert.deepEqual(splitAllDay([a, t1, null, b, { allDay: true }, t2]), { allDay: [a, b], timed: [t1, t2] });
  assert.deepEqual(splitAllDay(null), { allDay: [], timed: [] });
});

// ---------------------------------------------------------------------------------------------
// allDayRowsForRange

/** allDayRowsForRange result as { id: [startCol, endCol, row] }. */
function rowsMap(events, days = WEEK_DAYS) {
  return Object.fromEntries(allDayRowsForRange(events, days).map((it) => [it.event.id, [it.startCol, it.endCol, it.row]]));
}

test('allDayRowsForRange: columns (endCol inclusive) and clipping to the week', () => {
  assert.deepEqual(rowsMap([allDay('single', 6, 7)]), { single: [2, 2, 0] });
  assert.deepEqual(rowsMap([allDay('before', 1, 6)]), { before: [0, 1, 0] }, 'starts before the week');
  assert.deepEqual(rowsMap([allDay('after', 9, 15)]), { after: [5, 6, 0] }, 'continues after the week');
  assert.deepEqual(rowsMap([allDay('whole', 1, 20)]), { whole: [0, 6, 0] });
  assert.deepEqual(rowsMap([allDay('endsAtStart', 3, 4), allDay('startsAtEnd', 11, 12)]), {}, 'exclusive ends');
  assert.deepEqual(rowsMap([allDay('lastDay', 10, 11)]), { lastDay: [6, 6, 0] });
});

test('allDayRowsForRange: only all-day events (long timed events are excluded)', () => {
  const twoDays = timed('48h', 4, 0, 0, 0, 0, { endDay: 6 });
  assert.deepEqual(rowsMap([twoDays, allDay('ad', 5, 6)]), { ad: [1, 1, 0] });
});

test('allDayRowsForRange: rows stack overlapping spans and reuse free rows', () => {
  assert.deepEqual(rowsMap([
    allDay('A', 5, 8), // cols 1–3
    allDay('B', 6, 7), // col 2 → overlaps A
    allDay('C', 8, 9), // col 4 → fits in row 0 after A
    allDay('D', 7, 8), // col 3 → row 0 busy (A), row 1 free after B
  ]), {
    A: [1, 3, 0], B: [2, 2, 1], D: [3, 3, 1], C: [4, 4, 0],
  });
  // Adjacent spans share a row.
  assert.deepEqual(rowsMap([allDay('X', 4, 6), allDay('Y', 6, 8)]), { X: [0, 1, 0], Y: [2, 3, 0] });
});

test('allDayRowsForRange: longer span first when starting in the same column', () => {
  const out = allDayRowsForRange([allDay('short', 4, 5), allDay('long', 4, 8), allDay('mid', 4, 6)], WEEK_DAYS);
  assert.deepEqual(out.map((it) => [it.event.id, it.row]), [['long', 0], ['mid', 1], ['short', 2]]);
  // A multi-day event clipped at the week start counts from column 0.
  const clipped = allDayRowsForRange([allDay('today', 4, 5), allDay('since', 1, 6)], WEEK_DAYS);
  assert.deepEqual(clipped.map((it) => [it.event.id, it.startCol, it.endCol, it.row]), [['since', 0, 1, 0], ['today', 0, 0, 1]]);
});

test('allDayRowsForRange: sorted by row then column; bad input', () => {
  const out = allDayRowsForRange([allDay('r0b', 9, 10), allDay('r1', 4, 6), allDay('r0a', 4, 7), null, {}], WEEK_DAYS);
  assert.deepEqual(out.map((it) => [it.event.id, it.row, it.startCol]), [['r0a', 0, 0], ['r0b', 0, 5], ['r1', 1, 0]]);
  assert.deepEqual(allDayRowsForRange([allDay('a', 4, 5)], []), []);
  assert.deepEqual(allDayRowsForRange([allDay('a', 4, 5)], null), []);
  assert.deepEqual(allDayRowsForRange([allDay('a', 4, 5)], [new Date(NaN)]), []);
  assert.deepEqual(allDayRowsForRange(null, WEEK_DAYS), []);
  // An inverted all-day event is treated as a single day.
  const inverted = { ...allDay('inv', 6, 7), end: d(2026, 10, 5) };
  assert.deepEqual(rowsMap([inverted]), { inv: [2, 2, 0] });
});

test('allDayRowsForRange: single-day range (day view header) and random no-overlap check', () => {
  assert.deepEqual(rowsMap([allDay('a', 1, 10), allDay('b', 4, 5)], [d(2026, 10, 4)]), { a: [0, 0, 0], b: [0, 0, 1] });

  const rand = prng(7);
  for (let round = 0; round < 300; round++) {
    const events = Array.from({ length: 1 + Math.floor(rand() * 10) }, (_, i) => {
      const s = 1 + Math.floor(rand() * 14);
      return allDay(`e${i}`, s, s + 1 + Math.floor(rand() * 5));
    });
    const out = allDayRowsForRange(events, WEEK_DAYS);
    for (const it of out) assert.ok(it.startCol >= 0 && it.startCol <= it.endCol && it.endCol <= 6);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (a.row === b.row) assert.ok(a.endCol < b.startCol || b.endCol < a.startCol, `round ${round}`);
      }
    }
  }
});
