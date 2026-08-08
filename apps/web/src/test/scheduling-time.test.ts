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
import { busyDuring, rowSpans } from '../lib/scheduling-state';

const CT = 'America/Chicago';

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
