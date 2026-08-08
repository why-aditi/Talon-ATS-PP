/**
 * Solver property tests — spec 004 §7, §13.
 *
 * The four properties the spec names, plus the two invariants the callers depend on:
 * a result never carries an empty list with nothing to say about it, and everything the
 * solver returns passes the same `validateArrangement` that hold and send will run.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  SLOT_MIN,
  solveLoop,
  validateArrangement,
  type BusyInterval,
  type Constraints,
} from '../src/index.js';

const SLOT_MS = SLOT_MIN * 60_000;
const ORIGIN = Date.UTC(2026, 7, 6, 14, 0, 0);
const PANELISTS = ['p1', 'p2', 'p3'] as const;

/** Never advances: the time box is never hit, so every run is reproducible. */
const frozen = { now: () => 0 };

const slot = (index: number): Date => new Date(ORIGIN + index * SLOT_MS);

/** Slot-aligned so "no overlap" can be asserted exactly rather than approximately; the
 *  bitmap's conservative rounding is covered by its own unit test. */
const arbBusy = fc
  .array(fc.record({ from: fc.integer({ min: 0, max: 40 }), lengthSlots: fc.integer({ min: 1, max: 8 }) }), {
    maxLength: 4,
  })
  .map((intervals) => intervals.map((b) => ({ start: slot(b.from), end: slot(b.from + b.lengthSlots) })));

const arbConstraints = fc
  .record({
    slots: fc.integer({ min: 1, max: 40 }),
    rounds: fc.array(
      fc.record({
        lengthSlots: fc.integer({ min: 1, max: 4 }),
        panelists: fc.subarray([...PANELISTS]),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    // A tuple rather than a dictionary: every panelist must be present, because absent
    // means fully busy and that is a different property (below).
    busy: fc.tuple(arbBusy, arbBusy, arbBusy),
    maxGapMin: fc.constantFrom(0, 15, 30, 60),
    maxSpanMin: fc.constantFrom(60, 240, 480),
  })
  .map(
    ({ slots, rounds, busy, maxGapMin, maxSpanMin }): Constraints => ({
      rounds: rounds.map((r, i) => ({
        id: `r${i}`,
        durationMin: r.lengthSlots * SLOT_MIN,
        requiredPanelistIds: r.panelists,
      })),
      busy: Object.fromEntries(PANELISTS.map((id, i) => [id, busy[i] ?? []])),
      windowStart: slot(0),
      windowEnd: slot(slots),
      maxGapMin,
      maxSpanMin,
    }),
  );

const overlaps = (a: { start: Date; end: Date }, b: BusyInterval): boolean =>
  a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

describe('solveLoop properties', () => {
  test('no arrangement ever overlaps a required panelist’s busy interval', () => {
    fc.assert(
      fc.property(arbConstraints, (c) => {
        for (const arrangement of solveLoop(c, frozen).arrangements) {
          for (const placed of arrangement.rounds) {
            const round = c.rounds.find((r) => r.id === placed.roundId);
            for (const panelistId of round?.requiredPanelistIds ?? []) {
              for (const busy of c.busy[panelistId] ?? []) {
                expect(overlaps(placed, busy)).toBe(false);
              }
            }
          }
        }
      }),
    );
  });

  test('every arrangement lies inside the candidate window', () => {
    fc.assert(
      fc.property(arbConstraints, (c) => {
        for (const arrangement of solveLoop(c, frozen).arrangements) {
          expect(arrangement.start.getTime()).toBeGreaterThanOrEqual(c.windowStart.getTime());
          expect(arrangement.end.getTime()).toBeLessThanOrEqual(c.windowEnd.getTime());
          for (const placed of arrangement.rounds) {
            expect(placed.start.getTime()).toBeGreaterThanOrEqual(c.windowStart.getTime());
            expect(placed.end.getTime()).toBeLessThanOrEqual(c.windowEnd.getTime());
          }
        }
      }),
    );
  });

  test('a fully busy required panelist always yields zero arrangements', () => {
    fc.assert(
      fc.property(arbConstraints, fc.constantFrom(...PANELISTS), (c, blocked) => {
        // Only meaningful when somebody actually needs that person.
        fc.pre(c.rounds.some((r) => r.requiredPanelistIds.includes(blocked)));
        const result = solveLoop(
          { ...c, busy: { ...c.busy, [blocked]: [{ start: c.windowStart, end: c.windowEnd }] } },
          frozen,
        );
        expect(result.arrangements).toEqual([]);
        expect(result.blocker).not.toBeNull();
      }),
    );
  });

  test('a panelist missing from the busy map is as blocking as one who is fully busy', () => {
    fc.assert(
      fc.property(arbConstraints, fc.constantFrom(...PANELISTS), (c, absent) => {
        fc.pre(c.rounds.some((r) => r.requiredPanelistIds.includes(absent)));
        const rest = Object.fromEntries(Object.entries(c.busy).filter(([id]) => id !== absent));
        expect(solveLoop({ ...c, busy: rest }, frozen).arrangements).toEqual([]);
      }),
    );
  });

  test('is deterministic for a given input', () => {
    fc.assert(
      fc.property(arbConstraints, (c) => {
        expect(solveLoop(c, frozen)).toEqual(solveLoop(c, frozen));
      }),
    );
  });

  test('an empty list always carries a blocker, and a non-empty one never does', () => {
    fc.assert(
      fc.property(arbConstraints, (c) => {
        const result = solveLoop(c, frozen);
        expect(result.arrangements.length === 0).toBe(result.blocker !== null);
        expect(result.arrangements.length).toBeLessThanOrEqual(3);
      }),
    );
  });

  test('everything the solver returns validates clean (§7a — one predicate, two callers)', () => {
    fc.assert(
      fc.property(arbConstraints, (c) => {
        for (const arrangement of solveLoop(c, frozen).arrangements) {
          expect(validateArrangement(arrangement, c)).toBeNull();
        }
      }),
    );
  });

  test('arrangements keep the rounds in position order, within span, within gap', () => {
    fc.assert(
      fc.property(arbConstraints, (c) => {
        for (const arrangement of solveLoop(c, frozen).arrangements) {
          expect(arrangement.rounds.map((r) => r.roundId)).toEqual(c.rounds.map((r) => r.id));
          expect(arrangement.spanMin).toBeLessThanOrEqual(c.maxSpanMin);
          for (let i = 1; i < arrangement.rounds.length; i++) {
            const gapMin =
              ((arrangement.rounds[i]?.start.getTime() ?? 0) -
                (arrangement.rounds[i - 1]?.end.getTime() ?? 0)) /
              60_000;
            expect(gapMin).toBeGreaterThanOrEqual(0);
            expect(gapMin).toBeLessThanOrEqual(c.maxGapMin);
          }
        }
      }),
    );
  });

  test('the top arrangement is never beaten on the spec’s ordering', () => {
    fc.assert(
      fc.property(arbConstraints, (c) => {
        const { arrangements } = solveLoop(c, frozen);
        for (let i = 1; i < arrangements.length; i++) {
          const [a, b] = [arrangements[i - 1], arrangements[i]];
          if (!a || !b) continue;
          expect(a.totalGapMin <= b.totalGapMin).toBe(true);
          if (a.totalGapMin === b.totalGapMin) expect(a.end.getTime()).toBeLessThanOrEqual(b.end.getTime());
        }
      }),
    );
  });
});
