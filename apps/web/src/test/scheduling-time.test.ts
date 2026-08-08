/**
 * Zone rendering — spec 004 §8. Storage is UTC, the organizer reads a named zone, and
 * neither depends on the machine's own clock settings.
 *
 * The DST cases are here rather than in an integration suite because that is where the
 * bug actually lives: a 10:00 row that renders 11:00 for half the year is a rendering
 * failure, and it humiliates a recruiter in front of a candidate long before any
 * calendar write is involved.
 */
import { describe, expect, it } from 'vitest';
import {
  clockLabel,
  dayLabel,
  hourLabel,
  overlaps,
  plusMinutes,
  sameDay,
  timeLabel,
  zoneLabel,
} from '../lib/scheduling-time';
import { busyDuring, conflictAt, rowsForDay, rowSpans } from '../lib/scheduling-state';
import { loopFor, type SchedulingLoop } from '../lib/scheduling-fixtures';

const CT = 'America/Chicago';
const HOUR = 60 * 60_000;

/**
 * Busy is an overlap, not a match on a start.
 *
 * This is the one derivation in the screen where being wrong books an interview on top
 * of a meeting, so it gets tested directly rather than only through the grid: real
 * calendar events do not begin on the grid's rows, and the fixture's tidy hour blocks
 * would hide a containment check that happens to pass on them.
 */
describe('reading busy intervals against grid rows', () => {
  // The reference day's rows, which are deliberately not a uniform ruler.
  const STARTS = [
    '2026-08-06T15:00:00.000Z', // 10:00
    '2026-08-06T16:00:00.000Z', // 11:00
    '2026-08-06T19:30:00.000Z', // 2:30
  ];

  it('gives the last row an hour and every other row its neighbour', () => {
    expect(rowSpans(STARTS)).toEqual([
      { startUtc: '2026-08-06T15:00:00.000Z', endUtc: '2026-08-06T16:00:00.000Z' },
      { startUtc: '2026-08-06T16:00:00.000Z', endUtc: '2026-08-06T19:30:00.000Z' },
      { startUtc: '2026-08-06T19:30:00.000Z', endUtc: '2026-08-06T20:30:00.000Z' },
    ]);
  });

  it('darkens a row for a meeting that starts in the middle of it', () => {
    // 10:30–11:00 — starts on no row at all. Containment on the row start would read
    // this as free and place the loop straight into it.
    const busy = { maya: [{ startUtc: '2026-08-06T15:30:00.000Z', endUtc: '2026-08-06T16:00:00.000Z' }] };
    const [ten, eleven] = rowSpans(STARTS) as [{ startUtc: string; endUtc: string }, { startUtc: string; endUtc: string }];
    expect(busyDuring(busy, 'maya', ten.startUtc, ten.endUtc)).toBe(true);
    expect(busyDuring(busy, 'maya', eleven.startUtc, eleven.endUtc)).toBe(false);
  });

  it('does not call a meeting that ends where a round starts a clash', () => {
    const iv = [{ startUtc: '2026-08-06T14:00:00.000Z', endUtc: '2026-08-06T15:00:00.000Z' }];
    expect(overlaps(iv, '2026-08-06T15:00:00.000Z', '2026-08-06T16:00:00.000Z')).toBe(false);
    expect(overlaps(iv, '2026-08-06T14:59:00.000Z', '2026-08-06T16:00:00.000Z')).toBe(true);
  });

  it('reads one whole-window interval as every row busy — §4, an unreadable calendar', () => {
    const busy = { maya: [{ startUtc: '2026-08-06T14:00:00.000Z', endUtc: '2026-08-06T22:00:00.000Z' }] };
    expect(rowSpans(STARTS).every((s) => busyDuring(busy, 'maya', s.startUtc, s.endUtc))).toBe(true);
  });

  /*
    The rule this guards, spec §7: "'no intervals' and 'we never read it' must not be the
    same value with opposite meanings." They arrive here as the same value — the key is
    missing — so the direction that cannot double-book anybody has to win. An earlier
    version of this test asserted the opposite and was the defect, not the guard: it
    pinned "absent means free", which is the one reading non-negotiable #6 forbids.
  */
  it('reads a panelist absent from the busy map as busy, never as free', () => {
    expect(busyDuring({}, 'nobody', STARTS[0] as string, STARTS[1] as string)).toBe(true);
    // And an empty array is the value that does mean free, so the two stay distinct.
    expect(busyDuring({ nobody: [] }, 'nobody', STARTS[0] as string, STARTS[1] as string)).toBe(false);
  });
});

describe('rendering an instant in a zone', () => {
  it('renders the reference day exactly as the screen shows it', () => {
    expect(dayLabel('2026-08-06T14:00:00.000Z', CT)).toBe('Thursday, Aug 6');
    expect(timeLabel('2026-08-06T15:00:00.000Z', CT)).toBe('10:00');
    expect(clockLabel('2026-08-06T15:00:00.000Z', CT)).toBe('10:00 AM');
  });

  it('drops the meridiem in the grid but keeps it on the commitment', () => {
    expect(timeLabel('2026-08-06T19:30:00.000Z', CT)).toBe('2:30');
    expect(clockLabel('2026-08-06T19:30:00.000Z', CT)).toBe('2:30 PM');
  });

  it('names the zone generically, so it does not flip at the DST boundary', () => {
    // Same label either side of 1 November 2026, when CDT becomes CST.
    expect(zoneLabel('2026-08-06T15:00:00.000Z', CT)).toBe('CT');
    expect(zoneLabel('2026-12-06T15:00:00.000Z', CT)).toBe('CT');
  });

  it('holds the wall clock across spring forward', () => {
    // 8 March 2026, 02:00 CST → 03:00 CDT. 10:00 local is 16:00Z before and 15:00Z
    // after; both must render as 10:00.
    expect(timeLabel('2026-03-07T16:00:00.000Z', CT)).toBe('10:00');
    expect(timeLabel('2026-03-09T15:00:00.000Z', CT)).toBe('10:00');
  });

  it('renders one instant differently for a candidate in another zone', () => {
    expect(timeLabel('2026-08-06T15:00:00.000Z', 'America/New_York')).toBe('11:00');
    // A half-hour offset, which is where naive hour arithmetic breaks.
    expect(timeLabel('2026-08-06T15:00:00.000Z', 'Asia/Kolkata')).toBe('8:30');
    expect(zoneLabel('2026-08-06T15:00:00.000Z', 'America/New_York')).toBe('ET');
  });

  it('gives the bare hours the candidate window is written in', () => {
    expect(hourLabel('2026-08-06T14:00:00.000Z', CT)).toBe('9');
    expect(hourLabel('2026-08-06T21:00:00.000Z', CT)).toBe('4');
  });
});

/*
  Non-negotiable 7: any scheduling change ships with a DST-boundary test. The change is the
  whole-day UTC arithmetic that carries a day onto another day — `rowsForDay` moves the rows
  by the exact gap between the two days, and `constraintsFor` moves the candidate window by
  that gap ROUNDED to whole days. Two things about that pair are worth pinning, because both
  are currently true by accident of the fixture rather than by construction:

  1. The rows and the window travel by the same offset, so they stay mutually consistent. A
     week that crosses a DST boundary yields a grid whose labels are an hour off, which is a
     known consequence of whole-day arithmetic and stated as such in `constraintsFor` — what
     it must never yield is a window that disagrees with the rows drawn inside it, because
     that turns every row of the other four days into `outside_window`.
  2. `Math.round` snaps onto the wrong day only once a row sits more than 12h from
     `loop.dayUtc`. The reference rows span 6.5h, so it cannot today.
*/
describe('carrying a day onto another day across a DST boundary', () => {
  /**
   * The reference loop with its day, rows and window all moved to `dayUtc`.
   *
   * Moved together and exactly, so the synthetic loop is internally consistent before the
   * arithmetic under test runs — anything inconsistent afterwards was produced here.
   */
  function loopOn(dayUtc: string): SchedulingLoop {
    const base = loopFor('default');
    const shift = Date.parse(dayUtc) - Date.parse(base.dayUtc);
    const move = (iso: string) => new Date(Date.parse(iso) + shift).toISOString();
    return {
      ...base,
      dayUtc,
      rows: base.rows.map((row) => ({ startUtc: move(row.startUtc) })),
      candidateWindow: {
        startUtc: move(base.candidateWindow.startUtc),
        endUtc: move(base.candidateWindow.endUtc),
      },
      // Everyone genuinely free, so `outside_window` is the only blocker these cases can
      // produce. An absent key reads as fully busy (§7) and would answer `panelist_busy`
      // first, hiding whatever the window arithmetic did.
      busy: Object.fromEntries(base.panelists.map((p) => [p.id, []])),
    };
  }

  const firstRow = (loop: SchedulingLoop, dayUtc: string) => rowsForDay(loop, dayUtc)[0] as string;

  it('labels the far side of fall-back an hour early, and moves the window with it', () => {
    // Friday 30 October 2026, 9:00 CDT, and the Monday three whole UTC days later — by
    // which time CDT has become CST (1 November), so 14:00Z reads 8:00 rather than 9:00.
    const loop = loopOn('2026-10-30T14:00:00.000Z');
    const monday = '2026-11-02T14:00:00.000Z';
    expect(timeLabel(loop.dayUtc, CT)).toBe('9:00');
    expect(timeLabel(firstRow(loop, monday), CT)).toBe('8:00');

    // The window moved by the same three days, so the row that opens Monday is inside it.
    // A window left pinned on Friday answers `outside_window` here and makes the Week
    // toggle useless; a window that moved by a different amount answers it one row later.
    expect(conflictAt(loop, loop.busy, firstRow(loop, monday))).toBeNull();
    // The edge is still an edge, and it sits exactly on that row — one minute earlier is
    // outside. That is what "the same offset" means, checked rather than asserted in prose.
    const minuteBefore = new Date(Date.parse(firstRow(loop, monday)) - 60_000).toISOString();
    expect(conflictAt(loop, loop.busy, minuteBefore)?.reason).toBe('outside_window');
    // And a row 4h into Monday still rounds onto Monday, not onto its neighbour.
    expect(conflictAt(loop, loop.busy, rowsForDay(loop, monday)[4] as string)).toBeNull();
  });

  it('labels the far side of spring-forward an hour late, and moves the window with it', () => {
    // The mirror image: Friday 6 March 2026 is CST, and the Monday after 8 March is CDT,
    // so the same 15:00Z reads 10:00 instead of 9:00. The direction of the label error
    // flips; the consistency between rows and window must not.
    const loop = loopOn('2026-03-06T15:00:00.000Z');
    const monday = '2026-03-09T15:00:00.000Z';
    expect(timeLabel(loop.dayUtc, CT)).toBe('9:00');
    expect(timeLabel(firstRow(loop, monday), CT)).toBe('10:00');

    expect(conflictAt(loop, loop.busy, firstRow(loop, monday))).toBeNull();
    const minuteBefore = new Date(Date.parse(firstRow(loop, monday)) - 60_000).toISOString();
    expect(conflictAt(loop, loop.busy, minuteBefore)?.reason).toBe('outside_window');
  });

  /*
    Bound 2, as an assertion rather than a guard — deliberately.

    A guard would have to answer "which day does this instant belong to", and the view-model
    has no input for that: it is handed one day's rows and one day's window and infers the
    rest. The rounding is correct exactly while no row is further than 12h from
    `loop.dayUtc`, which is a property of the row set, so the row set is what gets checked.
    Add a 9:00 PM row (13h out) and this fails here, loudly, instead of quietly placing the
    candidate's window a day off in the Week view. It goes away entirely when the endpoint
    sends a window per day, which is the note already in `constraintsFor`.
  */
  /*
    Bound 1 has a precondition of its own, and it is the wire's, not the screen's.

    `rowsForDay` shifts the rows by the EXACT gap between the two days; `constraintsFor`
    shifts the window by that gap rounded to whole days. The two are one offset only while
    the gap IS a whole number of UTC days, which is what the fixture's week is. A wire that
    anchored each day to local 9:00 instead would send a 71h gap across fall-back — rows at
    +71h, window at +72h — and the first row of that day would read `outside_window` for a
    reason no recruiter can see on screen. Pinned here so that change fails a test.
  */
  it('takes its week as whole UTC days from the loop day, which is what makes the two offsets one', () => {
    const loop = loopFor('default');
    for (const day of loop.week) {
      expect(Math.abs((Date.parse(day.dayUtc) - Date.parse(loop.dayUtc)) % (24 * HOUR))).toBe(0);
    }
  });

  it('keeps every row inside the 12h that makes the whole-day rounding exact', () => {
    const loop = loopFor('default');
    const worst = Math.max(
      ...loop.rows.map((row) => Math.abs(Date.parse(row.startUtc) - Date.parse(loop.dayUtc))),
    );
    expect(worst).toBe(6.5 * HOUR);
    expect(worst).toBeLessThan(12 * HOUR);
  });
});

describe('instant arithmetic', () => {
  it('adds minutes in UTC, not in wall clock', () => {
    expect(plusMinutes('2026-08-06T15:00:00.000Z', 45)).toBe('2026-08-06T15:45:00.000Z');
  });

  it('answers same-day in the given zone, not in UTC', () => {
    // 00:30Z on 7 August is still 6 August in Chicago.
    expect(sameDay('2026-08-06T15:00:00.000Z', '2026-08-07T00:30:00.000Z', CT)).toBe(true);
    expect(sameDay('2026-08-06T15:00:00.000Z', '2026-08-07T00:30:00.000Z', 'UTC')).toBe(false);
  });
});
