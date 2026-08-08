/**
 * Timezone and DST fixtures — spec 004 §8, §13.
 *
 * "DST is the bug class that humiliates a recruiter in front of a candidate", so these
 * are the three cases the spec names, each asserted twice: once on the conversion, and
 * once on what the solver does with it. Fixed dates, no clock, no network.
 *
 * 2026 transitions used below:
 *   America/Chicago  8 Mar (CST→CDT)   1 Nov (CDT→CST)
 *   Europe/London   29 Mar (GMT→BST)  25 Oct (BST→GMT)
 *   Asia/Kolkata    never — UTC+5:30 all year
 */
import { describe, expect, test } from 'vitest';
import { loopWindowUtc, offsetMsAt, solveLoop, wallClockToUtc, type Constraints } from '../src/index.js';

const HOUR = 3_600_000;
const iso = (d: Date): string => d.toISOString();
const hours = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / HOUR;

const constraints = (over: Partial<Constraints>): Constraints => ({
  rounds: [],
  busy: {},
  windowStart: new Date(0),
  windowEnd: new Date(0),
  maxGapMin: 60,
  maxSpanMin: 480,
  ...over,
});

const round = (id: string, durationMin: number, ...requiredPanelistIds: string[]) => ({
  id,
  durationMin,
  requiredPanelistIds,
});

describe('wallClockToUtc', () => {
  test('an ordinary day', () => {
    expect(iso(wallClockToUtc('2026-08-06', '09:00', 'America/Chicago'))).toBe('2026-08-06T14:00:00.000Z');
    expect(iso(wallClockToUtc('2026-01-06', '09:00', 'America/Chicago'))).toBe('2026-01-06T15:00:00.000Z');
  });

  test('a half-hour zone, which an offset table keyed by whole hours gets wrong', () => {
    expect(iso(wallClockToUtc('2026-08-06', '09:00', 'Asia/Kolkata'))).toBe('2026-08-06T03:30:00.000Z');
    expect(offsetMsAt(Date.UTC(2026, 7, 6), 'Asia/Kolkata')).toBe(5.5 * HOUR);
  });

  test('seconds are accepted, because Postgres hands a `time` back with them', () => {
    expect(iso(wallClockToUtc('2026-08-06', '09:00:00', 'America/Chicago'))).toBe('2026-08-06T14:00:00.000Z');
  });

  test('a wall clock that does not exist resolves forward, to the moment the clock jumps to', () => {
    // 02:30 never happens on 8 March in Chicago. 08:30Z is 03:30 CDT — the instant the
    // clock reads immediately after the jump — so a window can only narrow.
    expect(iso(wallClockToUtc('2026-03-08', '02:30', 'America/Chicago'))).toBe('2026-03-08T08:30:00.000Z');
  });

  test('an ambiguous wall clock resolves to the first occurrence', () => {
    // 01:30 happens twice on 1 November. 06:30Z is the CDT one.
    expect(iso(wallClockToUtc('2026-11-01', '01:30', 'America/Chicago'))).toBe('2026-11-01T06:30:00.000Z');
  });
});

describe('DST fixture 1 — a window spanning spring forward', () => {
  const day = '2026-03-08';
  const zone = 'America/Chicago';

  test('four wall-clock hours across the jump are three real ones', () => {
    const start = wallClockToUtc(day, '01:00', zone);
    const end = wallClockToUtc(day, '05:00', zone);
    expect(iso(start)).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(end)).toBe('2026-03-08T10:00:00.000Z');
    expect(hours(start, end)).toBe(3);
  });

  test('a window that does not contain 02:00 local is unaffected', () => {
    // Spec §8's example says a 10:00–14:00 window is an hour shorter. It is not: the
    // US transition is at 02:00 local, so only a window containing it loses an hour.
    // Recorded here rather than silently ignored — see the report against §8.
    const start = wallClockToUtc(day, '10:00', zone);
    const end = wallClockToUtc(day, '14:00', zone);
    expect(hours(start, end)).toBe(4);
  });

  test('a three-round loop fits the shortened window exactly, and a fourth round does not', () => {
    const window = {
      windowStart: wallClockToUtc(day, '01:00', zone),
      windowEnd: wallClockToUtc(day, '05:00', zone),
    };
    const busy = { a: [], b: [], c: [], d: [] };

    const three = solveLoop(
      constraints({ ...window, busy, rounds: [round('r1', 60, 'a'), round('r2', 60, 'b'), round('r3', 60, 'c')] }),
      { now: () => 0 },
    );
    expect(three.blocker).toBeNull();
    expect(iso(three.arrangements[0]?.start ?? new Date(0))).toBe('2026-03-08T07:00:00.000Z');
    expect(three.arrangements[0]?.spanMin).toBe(180);

    // The recruiter offered "1pm to 5pm, that's four hours". It is not, and the answer
    // has to say so in those terms rather than blaming a panelist.
    const four = solveLoop(
      constraints({
        ...window,
        busy,
        rounds: [round('r1', 60, 'a'), round('r2', 60, 'b'), round('r3', 60, 'c'), round('r4', 60, 'd')],
      }),
      { now: () => 0 },
    );
    expect(four.blocker).toEqual({ reason: 'window_too_narrow', requiredMin: 240, availableMin: 180 });
  });
});

describe('DST fixture 2 — Asia/Kolkata against America/Chicago', () => {
  test('the candidate’s day is partly the organiser’s previous day', () => {
    const start = wallClockToUtc('2026-08-06', '09:00', 'Asia/Kolkata');
    expect(iso(start)).toBe('2026-08-06T03:30:00.000Z');
    expect(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', dateStyle: 'short' }).format(start),
    ).toBe('2026-08-05');
  });

  test('the grid aligns to the window, not to the hour — a 30-minute offset keeps its slots', () => {
    const result = solveLoop(
      constraints({
        windowStart: wallClockToUtc('2026-08-06', '09:00', 'Asia/Kolkata'),
        windowEnd: wallClockToUtc('2026-08-06', '16:00', 'Asia/Kolkata'),
        rounds: [round('r1', 60, 'lin')],
        busy: { lin: [{ start: new Date('2026-08-06T05:00:00.000Z'), end: new Date('2026-08-06T06:00:00.000Z') }] },
      }),
      { now: () => 0 },
    );
    // 03:30Z, not 04:00Z: a grid anchored to the UTC hour would lose the first half hour
    // of every candidate in a half-hour zone.
    expect(iso(result.arrangements[0]?.start ?? new Date(0))).toBe('2026-08-06T03:30:00.000Z');
    for (const arrangement of result.arrangements) {
      expect(
        arrangement.start.getTime() >= Date.parse('2026-08-06T06:00:00.000Z') ||
          arrangement.end.getTime() <= Date.parse('2026-08-06T05:00:00.000Z'),
      ).toBe(true);
    }
  });

  test('a Kolkata candidate and Chicago business hours do not overlap at all, and that is a blocker not a crash', () => {
    const window = loopWindowUtc({
      date: '2026-08-06',
      candidate: { start: '09:00', end: '16:00', zone: 'Asia/Kolkata' },
      business: { start: '09:00', end: '17:00', zone: 'America/Chicago' },
    });
    expect(window.start.getTime()).toBeGreaterThan(window.end.getTime());

    const result = solveLoop(
      constraints({
        windowStart: window.start,
        windowEnd: window.end,
        rounds: [round('r1', 60, 'lin')],
        busy: { lin: [] },
      }),
      { now: () => 0 },
    );
    expect(result.blocker).toEqual({ reason: 'window_too_narrow', requiredMin: 60, availableMin: 0 });
  });

  test('business hours bite when they do overlap', () => {
    const window = loopWindowUtc({
      date: '2026-08-06',
      candidate: { start: '09:00', end: '23:00', zone: 'Asia/Kolkata' },
      business: { start: '09:00', end: '17:00', zone: 'America/Chicago' },
    });
    // Candidate 03:30Z–17:30Z, business 14:00Z–22:00Z.
    expect(iso(window.start)).toBe('2026-08-06T14:00:00.000Z');
    expect(iso(window.end)).toBe('2026-08-06T17:30:00.000Z');
  });
});

describe('DST fixture 3 — a panelist whose DST date is not the organiser’s', () => {
  const chicagoOffset = (utc: string): number => offsetMsAt(Date.parse(utc), 'America/Chicago') / HOUR;
  const londonOffset = (utc: string): number => offsetMsAt(Date.parse(utc), 'Europe/London') / HOUR;

  test('for three weeks in March the gap between the two zones is five hours, not six', () => {
    expect(londonOffset('2026-02-20T12:00:00Z') - chicagoOffset('2026-02-20T12:00:00Z')).toBe(6);
    expect(londonOffset('2026-03-20T12:00:00Z') - chicagoOffset('2026-03-20T12:00:00Z')).toBe(5);
    expect(londonOffset('2026-04-20T12:00:00Z') - chicagoOffset('2026-04-20T12:00:00Z')).toBe(6);
  });

  test('the panelist’s meeting lands where their own clock says, not where a fixed offset would', () => {
    const day = '2026-03-20';
    // David is in London and has 15:00–16:00 blocked in his own calendar. That is
    // 10:00 Chicago on this date and 09:00 Chicago three weeks earlier; a constant
    // six-hour assumption books the loop straight over him.
    const davidBusy = {
      start: wallClockToUtc(day, '15:00', 'Europe/London'),
      end: wallClockToUtc(day, '16:00', 'Europe/London'),
    };
    expect(iso(davidBusy.start)).toBe('2026-03-20T15:00:00.000Z');

    const result = solveLoop(
      constraints({
        windowStart: wallClockToUtc(day, '09:00', 'America/Chicago'), // 14:00Z
        windowEnd: wallClockToUtc(day, '12:00', 'America/Chicago'), // 17:00Z
        rounds: [round('coding', 60, 'lin'), round('system_design', 60, 'david')],
        busy: { lin: [], david: [davidBusy] },
        maxGapMin: 0,
      }),
      { now: () => 0 },
    );

    expect(result.blocker).toBeNull();
    for (const arrangement of result.arrangements) {
      const david = arrangement.rounds.find((r) => r.roundId === 'system_design');
      expect(david?.start.getTime()).toBeGreaterThanOrEqual(davidBusy.end.getTime());
    }
    // Lin at 10:00 Chicago, David at 11:00 — the only back-to-back pair that clears him.
    expect(iso(result.arrangements[0]?.start ?? new Date(0))).toBe('2026-03-20T15:00:00.000Z');
  });
});
