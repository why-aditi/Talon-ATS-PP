/**
 * Lexorank, property-tested (CLAUDE.md §6 names `fast-check` for exactly this).
 *
 * Example tests are the wrong tool here: the failure mode is not "a wrong answer on a
 * case someone imagined", it is "after 400 real insertions in one column, two keys
 * collide and the board silently stops ordering". Only generated sequences reach that.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FIRST_RANK, between, rebalance } from '../src/lexorank.js';

/**
 * Keys satisfying the invariant `between` is total over: lowercase base-36, never
 * ending in the lowest digit.
 *
 * The filter DEFINES the domain here; it is not a convenience. An earlier version used
 * the same filter to make a totality property pass while `between` was silently
 * returning keys above their upper bound for exactly the excluded inputs. That class
 * now has its own test below, asserting the throw.
 */
const key = () =>
  fc
    .stringMatching(/^[0-9a-z]{1,8}$/)
    .filter((s) => s.length > 0 && !s.endsWith('0'));

describe('between', () => {
  it('lands strictly between two ordered keys', () => {
    fc.assert(
      fc.property(key(), key(), (a, b) => {
        fc.pre(a < b);
        const mid = between(a, b);
        expect(a < mid).toBe(true);
        expect(mid < b).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('lands after a key when there is no upper bound, and before one when there is no lower', () => {
    fc.assert(
      fc.property(key(), (a) => {
        expect(a < between(a, null)).toBe(true);
        expect(between(null, a) < a).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('refuses an inverted or equal pair rather than guessing', () => {
    fc.assert(
      fc.property(key(), key(), (a, b) => {
        fc.pre(a >= b);
        expect(() => between(a, b)).toThrow(RangeError);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * The one that matters. Repeatedly inserting at the same spot is the worst case —
   * each key has to fit in the gap the last one left — and it is exactly what a
   * recruiter dragging the same card to the top of a column all morning produces.
   */
  it('survives 500 insertions into the same gap', () => {
    let lo = FIRST_RANK;
    const hi = between(lo, null);
    const seen = new Set<string>([lo, hi]);

    for (let i = 0; i < 500; i += 1) {
      const mid = between(lo, hi);
      expect(lo < mid).toBe(true);
      expect(mid < hi).toBe(true);
      expect(seen.has(mid)).toBe(false);
      seen.add(mid);
      lo = mid;
    }
  });

  it('keeps a whole column ordered under random insertions', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 60 }), { minLength: 1, maxLength: 60 }), (positions) => {
        const ranks: string[] = [FIRST_RANK];
        for (const raw of positions) {
          // Insert at an arbitrary position, including either end.
          const at = raw % (ranks.length + 1);
          const before = at === 0 ? null : (ranks[at - 1] as string);
          const after = at === ranks.length ? null : (ranks[at] as string);
          ranks.splice(at, 0, between(before, after));
        }
        // Still strictly increasing, and every key distinct.
        expect(ranks).toEqual([...ranks].sort());
        expect(new Set(ranks).size).toBe(ranks.length);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * The class the generator excludes. There is genuinely no string between 'a' and
   * 'a0' — every extension of 'a' begins with a digit and '0' is the smallest — so the
   * only honest answers are to throw or to never generate such a key. This module does
   * both.
   */
  it('refuses bounds whose upper key ends in the lowest digit, rather than exceeding it', () => {
    for (const [a, b] of [['a', 'a0'], ['1', '10'], ['ab', 'ab0'], [null, '000']] as [string | null, string][]) {
      expect(() => between(a, b)).toThrow(RangeError);
    }
  });

  it('never emits a key ending in the lowest digit', () => {
    // Not cosmetic: a trailing '0' is the one shape that leaves no room below it
    // without growing a place, and the midpoint rule is what avoids it.
    fc.assert(
      fc.property(key(), key(), (a, b) => {
        fc.pre(a < b);
        expect(between(a, b).endsWith('0')).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('rebalance', () => {
  it('produces strictly increasing, distinct keys', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), (count) => {
        const keys = rebalance(count);
        expect(keys).toHaveLength(count);
        expect(keys).toEqual([...keys].sort());
        expect(new Set(keys).size).toBe(count);
      }),
      { numRuns: 200 },
    );
  });

  it('leaves room to insert between every rebalanced pair', () => {
    // A rebalance that packed keys adjacently would force the very next drag to grow a
    // place, which defeats the point of rebalancing at all.
    const keys = rebalance(200);
    for (let i = 1; i < keys.length; i += 1) {
      const mid = between(keys[i - 1] as string, keys[i] as string);
      expect((keys[i - 1] as string) < mid).toBe(true);
      expect(mid < (keys[i] as string)).toBe(true);
    }
  });

  it('never emits one ending in the lowest digit either', () => {
    // It used to: rebalance(36) contained '20'. A key of that shape has no room
    // beneath it, so the very next drag above it would throw.
    for (const count of [1, 35, 36, 37, 200, 1296]) {
      for (const k of rebalance(count)) expect(k.endsWith('0')).toBe(false);
    }
  });

  it('stays insertable everywhere afterwards', () => {
    const keys = rebalance(300);
    expect(() => between(null, keys[0] as string)).not.toThrow();
    expect(() => between(keys.at(-1) as string, null)).not.toThrow();
    for (let i = 1; i < keys.length; i += 1) {
      expect(() => between(keys[i - 1] as string, keys[i] as string)).not.toThrow();
    }
  });

  it('returns nothing for an empty column and refuses nonsense', () => {
    expect(rebalance(0)).toEqual([]);
    expect(() => rebalance(-1)).toThrow(RangeError);
    expect(() => rebalance(1.5)).toThrow(RangeError);
  });
});
