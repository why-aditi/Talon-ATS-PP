import { describe, expect, it } from 'vitest';
import { CANONICAL_STAGES, isStalled, isTerminalStage, nextActionFor } from '../src/index.js';

describe('nextActionFor', () => {
  it('reproduces the reference exactly where no qualifier is involved', () => {
    // The four Applied cards and Sofia in Offer — 5 of the 9 reference cards.
    expect(nextActionFor('applied')).toBe('Review');
    expect(nextActionFor('offer')).toBe('Offer out');
  });

  it('gives the bare verb until scheduling and offers can supply the detail', () => {
    // Recorded regression (spec 004 §5): "Call Tue" → "Call", "Loop Thu" → "Loop",
    // "Starts Sep 1" → "Hired". Asserted so the loss is deliberate and visible, not
    // something discovered in a screenshot diff later.
    expect(nextActionFor('screen')).toBe('Call');
    expect(nextActionFor('onsite')).toBe('Loop');
    expect(nextActionFor('hired')).toBe('Hired');
  });

  it('takes the reference shape once a qualifier exists', () => {
    expect(nextActionFor('screen', 'Tue')).toBe('Call Tue');
    expect(nextActionFor('onsite', 'Thu')).toBe('Loop Thu');
    // `hired` replaces rather than appends — the reference reads "Starts Sep 1".
    expect(nextActionFor('hired', 'Sep 1')).toBe('Starts Sep 1');
  });

  it('ignores a qualifier on a stage that cannot use one', () => {
    // "Review Tue" is not a thing; appending blindly would invent copy.
    expect(nextActionFor('applied', 'Tue')).toBe('Review');
    expect(nextActionFor('rejected', 'Tue')).toBe('Rejected');
  });

  it('answers for every canonical stage', () => {
    // A stage added to the enum without a verb would return undefined and render as
    // an empty footer rather than failing anywhere visible.
    for (const stage of CANONICAL_STAGES) {
      expect(nextActionFor(stage)).toMatch(/\S/);
    }
  });
});

describe('stage helpers', () => {
  it('treats hired, rejected and withdrawn as terminal', () => {
    expect(CANONICAL_STAGES.filter(isTerminalStage)).toEqual(['hired', 'rejected', 'withdrawn']);
  });

  it('stalls strictly past the SLA, never at it', () => {
    // Elena at 8d against 5 is stalled; Marcus at exactly 5 is not. That boundary is
    // the whole evidence for `>` over `>=` and it came off the reference, not a doc.
    expect(isStalled(8, 5)).toBe(true);
    expect(isStalled(5, 5)).toBe(false);
    expect(isStalled(6, 5)).toBe(true);
  });

  it('never stalls a stage with no SLA', () => {
    expect(isStalled(400, null)).toBe(false);
  });
});
