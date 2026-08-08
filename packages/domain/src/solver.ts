/**
 * The loop solver — spec 004 §7 — and the shared placement predicate of §7a.
 *
 * Pure. No I/O, no database, and the only clock is the one the caller injects for the
 * time box (see `SolveOptions.now`). Everything it needs about calendars has already
 * been normalised into `BusyInterval[]` by an adapter.
 *
 * ## One predicate, two callers
 *
 * The solver asks one question over and over — *does this round fit at this start, for
 * every required panelist* — and §7a's manual placement asks exactly the same question
 * one round at a time. `busyPanelistsIn` is that question and nothing else in the
 * codebase answers it, so a hand-placed round and a solved one cannot disagree about who
 * is busy (non-negotiable #5 at function scope). `validateArrangement` is the same check
 * over a whole arrangement, and is what hold and send re-run server-side.
 */
import type { BusyInterval } from './calendar.js';

/** The grid granularity. `interview_rounds.duration_min` is DB-checked to a multiple of
 *  this, because a 50-minute round cannot be placed exactly on a 15-minute grid. */
export const SLOT_MIN = 15;
const SLOT_MS = SLOT_MIN * 60_000;
const MIN_MS = 60_000;

export type SolverRound = {
  id: string;
  durationMin: number;
  /** Required panelists only. An optional panelist is invited and never blocks a
   *  placement (§5), so the caller filters on `is_required` before we see it. */
  requiredPanelistIds: readonly string[];
};

export type Constraints = {
  /** In `position` order. M2 places them in that order and does not permute; `is_swappable`
   *  is deliberately not an input here yet (§7, deferred). */
  rounds: readonly SolverRound[];
  /**
   * panelistId → busy intervals, UTC, merged and sorted by the adapter (§4).
   *
   * A panelist ABSENT from this map is treated as fully busy, not free — same rule, same
   * reason, as `SeededCalendarProvider.getBusy`. A genuinely free panelist is present
   * with an empty array.
   */
  busy: Readonly<Record<string, readonly BusyInterval[]>>;
  /** The candidate window and business hours already intersected into one UTC window —
   *  `loopWindowUtc` in timezone.ts does that. Both are hard bounds, so by the time they
   *  reach the solver they are one bound and no zone is involved. */
  windowStart: Date;
  windowEnd: Date;
  /** Largest gap tolerated between consecutive rounds. */
  maxGapMin: number;
  /** Largest first-start-to-last-end span for the whole loop. */
  maxSpanMin: number;
};

export type PlacedRound = {
  roundId: string;
  start: Date;
  end: Date;
  panelistIds: string[];
};

/**
 * A whole loop, placed. Solved and hand-built arrangements are this same type and are
 * indistinguishable downstream (§7a) — hold, send and the §10 re-validation must not try
 * to tell them apart.
 */
export type Arrangement = {
  start: Date;
  end: Date;
  spanMin: number;
  totalGapMin: number;
  rounds: PlacedRound[];
};

/**
 * Why nothing could be placed — §7's "the blocker, not an empty list". Every variant
 * names something a recruiter can act on; there is deliberately no generic "no
 * availability found", which tells them nothing about what to change.
 */
export type SolveBlocker =
  | { reason: 'no_rounds' }
  /** The loop is longer than the time available, so no search could help (§12.2). */
  | { reason: 'window_too_narrow'; requiredMin: number; availableMin: number }
  | { reason: 'span_too_short'; requiredMin: number; maxSpanMin: number }
  /** The reference screen's message: this round, at this time, blocked by these people. */
  | { reason: 'panelist_busy'; roundId: string; at: Date; busyPanelistIds: string[] }
  /** Manual placement only: a round put outside the candidate window (§7a). */
  | { reason: 'outside_window'; roundId: string; at: Date }
  /** Manual placement only: two rounds over the same minutes. */
  | { reason: 'rounds_overlap'; roundId: string; otherRoundId: string; at: Date }
  /** Manual placement only: an arrangement naming a round this loop does not have. */
  | { reason: 'unknown_round'; roundId: string }
  /** The 200ms box was hit before anything was found (§12.11). */
  | { reason: 'timed_out' };

/** Kept in step with the union above by a contracts test that compares the two lists. */
export const BLOCKER_REASONS = [
  'no_rounds',
  'window_too_narrow',
  'span_too_short',
  'panelist_busy',
  'outside_window',
  'rounds_overlap',
  'unknown_round',
  'timed_out',
] as const;
export type BlockerReason = (typeof BLOCKER_REASONS)[number];

/** Invariant, asserted by a property test: `arrangements` is empty exactly when
 *  `blocker` is set. There is never an empty list with nothing to say about it. */
export type SolveResult = {
  arrangements: Arrangement[];
  /** The search was cut short by the time box; what is here is the best found so far. */
  partial: boolean;
  blocker: SolveBlocker | null;
};

export type SolveOptions = {
  maxResults?: number;
  timeBudgetMs?: number;
  /**
   * Injected so the time box can be tested and so property tests are deterministic.
   * Purity here means "same input, same output" — a wall-clock read that decides only
   * *when to stop* would break that, hence the seam.
   */
  now?: () => number;
};

/**
 * One bit per 15-minute slot from `originMs`, 1 = busy.
 *
 * The bitmap is what makes overlap a lookup instead of interval arithmetic (§7 step 1):
 * every boundary question is answered once, here, rather than at each of the dozen
 * places that would otherwise compare two pairs of instants.
 *
 * A busy interval covering ANY part of a slot blocks the whole slot — floor on the way
 * in, ceil on the way out. That over-blocks by up to 14 minutes at each edge, which is
 * the direction non-negotiable #6 requires: the alternative rounds a 10:05 meeting away
 * and offers the 10:00 row as free.
 */
export function buildBusyBitmap(
  intervals: readonly BusyInterval[],
  originMs: number,
  slotCount: number,
): Uint8Array {
  const bitmap = new Uint8Array(Math.max(0, slotCount));
  for (const interval of intervals) {
    const from = Math.max(0, Math.floor((interval.start.getTime() - originMs) / SLOT_MS));
    const to = Math.min(bitmap.length, Math.ceil((interval.end.getTime() - originMs) / SLOT_MS));
    for (let i = from; i < to; i++) bitmap[i] = 1;
  }
  return bitmap;
}

type Grid = {
  origin: number;
  slots: number;
  bitmapFor: (panelistId: string) => Uint8Array;
  at: (slot: number) => Date;
};

function grid(c: Constraints): Grid {
  const origin = c.windowStart.getTime();
  const slots = Math.max(0, Math.floor((c.windowEnd.getTime() - origin) / SLOT_MS));
  const missing: BusyInterval[] = [{ start: c.windowStart, end: c.windowEnd }];
  const cache = new Map<string, Uint8Array>();
  return {
    origin,
    slots,
    bitmapFor(panelistId) {
      let bitmap = cache.get(panelistId);
      if (!bitmap) {
        bitmap = buildBusyBitmap(c.busy[panelistId] ?? missing, origin, slots);
        cache.set(panelistId, bitmap);
      }
      return bitmap;
    },
    at: (slot) => new Date(origin + slot * SLOT_MS),
  };
}

/**
 * THE fit check. Which of the round's required panelists are busy during
 * [fromSlot, toSlot)? Empty means the round fits there.
 *
 * Out-of-range slots count as busy: off the grid is off the candidate's window, and
 * "we have no information" is never "free".
 */
function busyPanelistsIn(g: Grid, round: SolverRound, fromSlot: number, toSlot: number): string[] {
  const busy: string[] = [];
  for (const panelistId of round.requiredPanelistIds) {
    const bitmap = g.bitmapFor(panelistId);
    for (let i = fromSlot; i < toSlot; i++) {
      if (i < 0 || i >= g.slots || bitmap[i]) {
        busy.push(panelistId);
        break;
      }
    }
  }
  return busy;
}

const slotsFor = (durationMin: number): number => Math.ceil(durationMin / SLOT_MIN);

export function solveLoop(c: Constraints, options: SolveOptions = {}): SolveResult {
  const maxResults = options.maxResults ?? 3;
  const timeBudgetMs = options.timeBudgetMs ?? 200;
  const now = options.now ?? Date.now;

  if (c.rounds.length === 0) {
    return { arrangements: [], partial: false, blocker: { reason: 'no_rounds' } };
  }

  const totalMin = c.rounds.reduce((sum, r) => sum + r.durationMin, 0);
  if (totalMin > c.maxSpanMin) {
    return {
      arrangements: [],
      partial: false,
      blocker: { reason: 'span_too_short', requiredMin: totalMin, maxSpanMin: c.maxSpanMin },
    };
  }

  const g = grid(c);
  const availableMin = g.slots * SLOT_MIN;
  const tooNarrow: SolveResult = {
    arrangements: [],
    partial: false,
    blocker: { reason: 'window_too_narrow', requiredMin: totalMin, availableMin },
  };
  // Checked before any search: §12.2 wants "the window is shorter than the loop" as the
  // stated reason, and a search would instead report whoever happened to be busy first.
  if (totalMin > availableMin) return tooNarrow;

  const lens = c.rounds.map((r) => slotsFor(r.durationMin));
  const maxGapSlots = Math.floor(c.maxGapMin / SLOT_MIN);
  const startedAt = now();

  // A holder rather than three `let`s: TypeScript does not track assignments made inside
  // the closures below and would narrow a plain `let` to its initialiser at the read.
  // `round: -1` means nothing was ever blocked by a person.
  const state = { partial: false, round: -1, slot: 0 };

  const outOfTime = (): boolean => {
    if (!state.partial && now() - startedAt > timeBudgetMs) state.partial = true;
    return state.partial;
  };

  // The deepest round reached is the one to report: if rounds 1–3 place fine and round 4
  // never does, telling the recruiter about round 1 sends them to fix the wrong thing.
  // Ties go to the earliest time attempted, which is what §7 asks for and what makes the
  // blocker deterministic.
  const note = (round: number, slot: number): void => {
    if (round > state.round || (round === state.round && slot < state.slot)) {
      state.round = round;
      state.slot = slot;
    }
  };

  /** The best tail for rounds `i..n`, starting no earlier than `earliest`. */
  const place = (i: number, earliest: number, first: number): { starts: number[]; gaps: number } | null => {
    if (i === c.rounds.length) return { starts: [], gaps: 0 };
    if (outOfTime()) return null;

    const round = c.rounds[i] as SolverRound;
    const len = lens[i] as number;
    let best: { starts: number[]; gaps: number } | null = null;

    for (let gap = 0; gap <= maxGapSlots; gap++) {
      const start = earliest + gap;
      // Later gaps only push further out, so both bounds end the loop rather than skip.
      if (start + len > g.slots) break;
      if ((start + len - first) * SLOT_MIN > c.maxSpanMin) break;

      if (busyPanelistsIn(g, round, start, start + len).length > 0) {
        note(i, start);
        continue;
      }
      const rest = place(i + 1, start + len, first);
      if (rest && (best === null || gap + rest.gaps < best.gaps)) {
        best = { starts: [start, ...rest.starts], gaps: gap + rest.gaps };
      }
      // Nothing beats back-to-back, and the time box is better spent on other starts.
      if (best?.gaps === 0) break;
      if (state.partial) break;
    }
    return best;
  };

  const build = (starts: readonly number[]): Arrangement => {
    const rounds = starts.map((slot, i) => ({
      roundId: (c.rounds[i] as SolverRound).id,
      start: g.at(slot),
      end: g.at(slot + (lens[i] as number)),
      panelistIds: [...(c.rounds[i] as SolverRound).requiredPanelistIds],
    }));
    const start = (rounds[0] as PlacedRound).start;
    const end = (rounds[rounds.length - 1] as PlacedRound).end;
    const spanMin = (end.getTime() - start.getTime()) / MIN_MS;
    return { start, end, spanMin, totalGapMin: spanMin - totalMin, rounds };
  };

  const arrangements: Arrangement[] = [];
  const firstRound = c.rounds[0] as SolverRound;
  const firstLen = lens[0] as number;
  for (let start = 0; start + firstLen <= g.slots; start++) {
    if (outOfTime()) break;
    // Round 0 is pinned to the grid start being tried, so each start yields at most one
    // arrangement and the top three are three genuinely different times rather than
    // three shuffles of the same one.
    if (busyPanelistsIn(g, firstRound, start, start + firstLen).length > 0) {
      note(0, start);
      continue;
    }
    const rest = place(1, start + firstLen, start);
    if (rest) arrangements.push(build([start, ...rest.starts]));
  }

  // §7 step 3, in that order. Worth stating the consequence of "fewer gaps" being the
  // primary key: a back-to-back loop at 3pm outranks one at 9am with a fifteen-minute
  // gap. That is the spec's ordering, and the screen's primary button names the first
  // arrangement, so it is not quietly re-weighted here.
  arrangements.sort(
    (a, b) =>
      a.totalGapMin - b.totalGapMin ||
      a.end.getTime() - b.end.getTime() ||
      a.spanMin - b.spanMin,
  );

  const top = arrangements.slice(0, maxResults);
  if (top.length > 0) return { arrangements: top, partial: state.partial, blocker: null };
  if (state.partial) return { arrangements: [], partial: true, blocker: { reason: 'timed_out' } };
  // Nobody was ever the obstacle: every attempt ran off the end of the window or the
  // span instead. The honest answer is that there was not enough room.
  if (state.round < 0) return tooNarrow;

  const round = c.rounds[state.round] as SolverRound;
  return {
    arrangements: [],
    partial: false,
    blocker: {
      reason: 'panelist_busy',
      roundId: round.id,
      at: g.at(state.slot),
      busyPanelistIds: busyPanelistsIn(g, round, state.slot, state.slot + (lens[state.round] as number)),
    },
  };
}

/**
 * Is this arrangement placeable? `null` means yes — spec 004 §7a.
 *
 * Called by the solver's tests on everything it returns, by the client for immediate
 * feedback on a manual placement, and by hold and send server-side against freshly
 * fetched availability. **The server never trusts a client-supplied arrangement**: the
 * duration and the required panelists come from `c.rounds`, never from the wire, so a
 * client cannot shrink a round or empty its panelist list to walk past a conflict.
 *
 * Only HARD constraints are checked. Gaps, span and finish time were only ever scoring
 * inputs, and §7a places over them silently.
 *
 * A partial arrangement is valid: manual placement fills rounds in one at a time, and
 * "every round has a slot" is hold and send's question, not this one's.
 */
export function validateArrangement(arrangement: Arrangement, c: Constraints): SolveBlocker | null {
  const g = grid(c);
  const byId = new Map(c.rounds.map((r) => [r.id, r]));
  const placed = [...arrangement.rounds].sort((a, b) => a.start.getTime() - b.start.getTime());

  let previousEnd = Number.NEGATIVE_INFINITY;
  let previousId = '';

  for (const p of placed) {
    const round = byId.get(p.roundId);
    if (!round) return { reason: 'unknown_round', roundId: p.roundId };

    const startMs = p.start.getTime();
    const endMs = startMs + round.durationMin * MIN_MS;
    // Same conservative rounding as the bitmap, so an off-grid start is judged over
    // every slot it touches rather than the one it nominally begins in.
    const fromSlot = Math.floor((startMs - g.origin) / SLOT_MS);
    const toSlot = Math.ceil((endMs - g.origin) / SLOT_MS);

    if (fromSlot < 0 || toSlot > g.slots) {
      return { reason: 'outside_window', roundId: round.id, at: p.start };
    }
    if (startMs < previousEnd) {
      return { reason: 'rounds_overlap', roundId: round.id, otherRoundId: previousId, at: p.start };
    }
    const busy = busyPanelistsIn(g, round, fromSlot, toSlot);
    if (busy.length > 0) {
      return { reason: 'panelist_busy', roundId: round.id, at: p.start, busyPanelistIds: busy };
    }
    previousEnd = endMs;
    previousId = round.id;
  }
  return null;
}
