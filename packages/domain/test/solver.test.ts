import { describe, expect, test } from 'vitest';
import {
  buildBusyBitmap,
  solveLoop,
  validateArrangement,
  type Arrangement,
  type BusyInterval,
  type Constraints,
  type SolverRound,
} from '../src/index.js';

const D = '2026-08-06T';
const t = (iso: string): Date => new Date(`${D}${iso}:00.000Z`);
const interval = (from: string, to: string): BusyInterval => ({ start: t(from), end: t(to) });

/** Never advances, so the 200ms box is never hit and the result is deterministic. */
const frozen = { now: () => 0 };

const LIN = 'lin';
const MAYA = 'maya';

const round = (id: string, durationMin: number, ...requiredPanelistIds: string[]): SolverRound => ({
  id,
  durationMin,
  requiredPanelistIds,
});

const constraints = (over: Partial<Constraints> = {}): Constraints => ({
  rounds: [round('r1', 60, LIN), round('r2', 60, MAYA)],
  busy: { [LIN]: [], [MAYA]: [] },
  windowStart: t('14:00'),
  windowEnd: t('18:00'),
  maxGapMin: 60,
  maxSpanMin: 240,
  ...over,
});

/** A hand-placed arrangement, as §7a's manual placement produces. `spanMin` and
 *  `totalGapMin` are scoring output, not input, so they are filled in loosely here. */
const byHand = (c: Constraints, placements: Record<string, string>): Arrangement => {
  const rounds = Object.entries(placements).map(([roundId, at]) => {
    const template = c.rounds.find((r) => r.id === roundId);
    const start = t(at);
    return {
      roundId,
      start,
      end: new Date(start.getTime() + (template?.durationMin ?? 60) * 60_000),
      panelistIds: [...(template?.requiredPanelistIds ?? [])],
    };
  });
  const start = rounds[0]?.start ?? t('14:00');
  const end = rounds[rounds.length - 1]?.end ?? t('14:00');
  const spanMin = (end.getTime() - start.getTime()) / 60_000;
  return { start, end, spanMin, totalGapMin: 0, rounds };
};

describe('buildBusyBitmap', () => {
  const origin = t('14:00').getTime();

  test('a busy interval covering any part of a slot blocks the whole slot', () => {
    // 14:20–14:40 touches the 14:15 and 14:30 slots and neither one is on a boundary.
    expect([...buildBusyBitmap([interval('14:20', '14:40')], origin, 8)]).toEqual([
      0, 1, 1, 0, 0, 0, 0, 0,
    ]);
  });

  test('an exactly aligned interval blocks exactly its own slots', () => {
    expect([...buildBusyBitmap([interval('14:30', '15:00')], origin, 8)]).toEqual([
      0, 0, 1, 1, 0, 0, 0, 0,
    ]);
  });

  test('intervals outside the window are clamped, not wrapped', () => {
    // Ends at 14:20, which is inside the second slot, so the second slot goes too.
    expect([...buildBusyBitmap([interval('09:00', '14:20')], origin, 4)]).toEqual([1, 1, 0, 0]);
    expect([...buildBusyBitmap([interval('17:00', '23:00')], origin, 4)]).toEqual([0, 0, 0, 0]);
  });

  test('overlapping intervals are idempotent', () => {
    expect([
      ...buildBusyBitmap([interval('14:00', '14:30'), interval('14:15', '14:45')], origin, 4),
    ]).toEqual([1, 1, 1, 0]);
  });
});

describe('solveLoop — arrangements', () => {
  test('places rounds back to back from the top of the window', () => {
    const result = solveLoop(constraints(), frozen);
    expect(result.blocker).toBeNull();
    expect(result.partial).toBe(false);
    const [best] = result.arrangements;
    expect(best?.start.toISOString()).toBe(t('14:00').toISOString());
    expect(best?.totalGapMin).toBe(0);
    expect(best?.rounds.map((r) => r.start.toISOString())).toEqual([
      t('14:00').toISOString(),
      t('15:00').toISOString(),
    ]);
  });

  test('returns at most three, each at a different start time', () => {
    const result = solveLoop(constraints({ windowEnd: t('22:00') }), frozen);
    expect(result.arrangements).toHaveLength(3);
    expect(new Set(result.arrangements.map((a) => a.start.getTime())).size).toBe(3);
  });

  test('honours maxResults', () => {
    expect(solveLoop(constraints({ windowEnd: t('22:00') }), { ...frozen, maxResults: 1 })
      .arrangements).toHaveLength(1);
  });

  // Lin is only free before 15:00 and Maya is booked until 16:00, so the one placement
  // that exists needs an hour of dead time in the middle.
  const needsAGap = {
    busy: { [LIN]: [interval('15:00', '18:00')], [MAYA]: [interval('15:00', '16:00')] },
  };

  test('never places a round over a required panelist, and gaps over it when allowed', () => {
    const result = solveLoop(constraints(needsAGap), frozen);
    expect(result.arrangements).toHaveLength(1);
    const [best] = result.arrangements;
    expect(best?.rounds.map((r) => r.start.toISOString())).toEqual([
      t('14:00').toISOString(),
      t('16:00').toISOString(),
    ]);
    expect(best?.totalGapMin).toBe(60);
  });

  test('respects maxGapMin — a gap it cannot open is a gap it will not take', () => {
    const result = solveLoop(constraints({ ...needsAGap, maxGapMin: 15 }), frozen);
    expect(result.arrangements).toEqual([]);
    expect(result.blocker).toMatchObject({ reason: 'panelist_busy', roundId: 'r2' });
  });

  test('every arrangement lies inside the candidate window', () => {
    const c = constraints({ windowEnd: t('22:00') });
    for (const a of solveLoop(c, frozen).arrangements) {
      expect(a.start.getTime()).toBeGreaterThanOrEqual(c.windowStart.getTime());
      expect(a.end.getTime()).toBeLessThanOrEqual(c.windowEnd.getTime());
    }
  });

  test('is deterministic for a given input', () => {
    const c = constraints({ windowEnd: t('21:00'), busy: { [LIN]: [interval('16:00', '17:00')], [MAYA]: [] } });
    expect(solveLoop(c, frozen)).toEqual(solveLoop(c, frozen));
  });
});

describe('solveLoop — blockers (§7, §12)', () => {
  test('no rounds at all is its own answer, not an empty list', () => {
    expect(solveLoop(constraints({ rounds: [] }), frozen)).toEqual({
      arrangements: [],
      partial: false,
      blocker: { reason: 'no_rounds' },
    });
  });

  test('a window narrower than the loop states that, not whoever happened to be busy (§12.2)', () => {
    const result = solveLoop(constraints({ windowEnd: t('15:00') }), frozen);
    expect(result.blocker).toEqual({ reason: 'window_too_narrow', requiredMin: 120, availableMin: 60 });
  });

  test('a loop longer than its allowed span says so before searching', () => {
    const result = solveLoop(constraints({ maxSpanMin: 60 }), frozen);
    expect(result.blocker).toEqual({ reason: 'span_too_short', requiredMin: 120, maxSpanMin: 60 });
  });

  test('the reference screen’s conflict: the round that failed, when, and who was busy', () => {
    // Ana is available 9–13 Chicago (14:00–18:00Z). Lin's coding round places at 9:00,
    // and Maya — required for Values — is booked solid from 10:00 on.
    const result = solveLoop(
      constraints({
        rounds: [round('coding', 60, LIN), round('values', 45, MAYA)],
        busy: { [LIN]: [], [MAYA]: [interval('15:00', '18:00')] },
        maxGapMin: 0,
      }),
      frozen,
    );
    expect(result.arrangements).toEqual([]);
    expect(result.blocker).toEqual({
      reason: 'panelist_busy',
      roundId: 'values',
      at: t('15:00'), // 10:00 America/Chicago — the time the screen names
      busyPanelistIds: [MAYA],
    });
  });

  test('reports the deepest round reached, not the first one tried', () => {
    // Round 1 places everywhere; round 2 never does. Sending the recruiter to fix
    // round 1 would be sending them to fix the wrong thing.
    const result = solveLoop(
      constraints({ busy: { [LIN]: [], [MAYA]: [interval('14:00', '18:00')] } }),
      frozen,
    );
    expect(result.blocker).toMatchObject({ reason: 'panelist_busy', roundId: 'r2' });
  });

  test('a fully busy required panelist on the first round blocks from the top of the window', () => {
    const result = solveLoop(
      constraints({ busy: { [LIN]: [interval('14:00', '18:00')], [MAYA]: [] } }),
      frozen,
    );
    expect(result.blocker).toEqual({
      reason: 'panelist_busy',
      roundId: 'r1',
      at: t('14:00'),
      busyPanelistIds: [LIN],
    });
  });

  test('a panelist missing from the busy map is fully busy, never silently free (#6)', () => {
    const result = solveLoop(constraints({ busy: { [LIN]: [] } }), frozen);
    expect(result.arrangements).toEqual([]);
    expect(result.blocker).toMatchObject({ reason: 'panelist_busy', busyPanelistIds: [MAYA] });
  });
});

describe('solveLoop — the time box (§7 step 5, §12.11)', () => {
  test('a clock past the budget stops the search and flags the result partial', () => {
    let calls = 0;
    const result = solveLoop(constraints({ windowEnd: t('22:00') }), {
      now: () => (calls++ === 0 ? 0 : 10_000),
    });
    expect(result.partial).toBe(true);
    expect(result.arrangements).toEqual([]);
    expect(result.blocker).toEqual({ reason: 'timed_out' });
  });

  test('whatever it did find is still returned, and is still valid', () => {
    let calls = 0;
    const c = constraints({ windowEnd: t('22:00') });
    const result = solveLoop(c, { now: () => (calls++ < 12 ? 0 : 10_000) });
    expect(result.partial).toBe(true);
    for (const a of result.arrangements) expect(validateArrangement(a, c)).toBeNull();
    if (result.arrangements.length === 0) expect(result.blocker).toEqual({ reason: 'timed_out' });
    else expect(result.blocker).toBeNull();
  });
});

describe('validateArrangement (§7a) — one predicate, two callers', () => {
  test('every arrangement the solver returns validates clean', () => {
    const c = constraints({
      windowEnd: t('22:00'),
      busy: { [LIN]: [interval('16:00', '17:00')], [MAYA]: [interval('15:00', '15:30')] },
    });
    const result = solveLoop(c, frozen);
    expect(result.arrangements.length).toBeGreaterThan(0);
    for (const a of result.arrangements) expect(validateArrangement(a, c)).toBeNull();
  });

  test('a hand-placed overlap produces the identical blocker the solver would', () => {
    const c = constraints({
      rounds: [round('coding', 60, LIN), round('values', 45, MAYA)],
      busy: { [LIN]: [], [MAYA]: [interval('15:00', '18:00')] },
      maxGapMin: 0,
    });
    const solved = solveLoop(c, frozen).blocker;
    const placed = validateArrangement(byHand(c, { coding: '14:00', values: '15:00' }), c);
    expect(placed).toEqual(solved);
    expect(placed).toEqual({
      reason: 'panelist_busy',
      roundId: 'values',
      at: t('15:00'),
      busyPanelistIds: [MAYA],
    });
  });

  test('the duration and the panelists come from the template, never from the wire', () => {
    const c = constraints({ busy: { [LIN]: [], [MAYA]: [interval('15:00', '16:00')] } });
    // A client claiming the round is fifteen minutes long with nobody required.
    const forged: Arrangement = {
      start: t('15:00'),
      end: t('15:15'),
      spanMin: 15,
      totalGapMin: 0,
      rounds: [{ roundId: 'r2', start: t('15:00'), end: t('15:15'), panelistIds: [] }],
    };
    expect(validateArrangement(forged, c)).toMatchObject({
      reason: 'panelist_busy',
      roundId: 'r2',
      busyPanelistIds: [MAYA],
    });
  });

  test('a round placed outside the candidate window is refused', () => {
    const c = constraints();
    expect(validateArrangement(byHand(c, { r1: '13:00' }), c)).toEqual({
      reason: 'outside_window',
      roundId: 'r1',
      at: t('13:00'),
    });
    expect(validateArrangement(byHand(c, { r1: '17:30' }), c)).toMatchObject({
      reason: 'outside_window',
    });
  });

  test('two rounds over the same minutes are refused — the candidate is one person', () => {
    const c = constraints();
    expect(validateArrangement(byHand(c, { r1: '14:00', r2: '14:30' }), c)).toEqual({
      reason: 'rounds_overlap',
      roundId: 'r2',
      otherRoundId: 'r1',
      at: t('14:30'),
    });
  });

  test('a round this loop does not have is refused', () => {
    const c = constraints();
    expect(validateArrangement(byHand(c, { ghost: '14:00' }), c)).toEqual({
      reason: 'unknown_round',
      roundId: 'ghost',
    });
  });

  test('soft constraints place silently — a gap past maxGapMin is not a blocker (§7a)', () => {
    const c = constraints({ windowEnd: t('22:00'), maxGapMin: 0 });
    expect(validateArrangement(byHand(c, { r1: '14:00', r2: '20:00' }), c)).toBeNull();
  });

  test('a partial arrangement validates what is there — completeness is hold’s question', () => {
    const c = constraints();
    expect(validateArrangement(byHand(c, { r1: '14:00' }), c)).toBeNull();
  });
});
