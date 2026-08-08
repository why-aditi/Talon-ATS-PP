/**
 * Pure derivations over a `SchedulingLoop`. No React, no I/O, no clock.
 *
 * Everything the screen says about a slot is computed here, which is what keeps one
 * sentence in one place: the conflict callout the solver produced and the conflict the
 * recruiter creates by picking a busy row are the same function, so they cannot drift
 * into two different phrasings of the same fact.
 */
import {
  validateArrangement as validatePlacement,
  type Constraints,
  type SolveBlocker as DomainBlocker,
} from '@talon/domain';
import type {
  BusyInterval,
  InterviewStatus,
  Panelist,
  Placement,
  Round,
  RoundKind,
  SchedulingLoop,
  SolveBlocker,
} from './scheduling-fixtures';
import { overlaps, plusMinutes, timeLabel } from './scheduling-time';

/* ── Presentation of the wire's enums ──────────────────────────────────────── */

/**
 * `system_design` → "System design".
 *
 * The label is render-time and lives only here. The wire carries the enum because the
 * database check constraint does, and a server that emits "System design" has taken a
 * copy decision on the client's behalf that no migration can later revise.
 */
const ROUND_KIND_LABELS: Record<RoundKind, string> = {
  coding: 'Coding',
  system_design: 'System design',
  values: 'Values',
  hiring_manager: 'Hiring manager',
};

export const roundKindLabel = (kind: RoundKind): string => ROUND_KIND_LABELS[kind];

/**
 * What the round card's status word says, per `interviews.status`.
 *
 * All six, with no default branch: `declined` reaching a fallthrough would render as
 * "Confirmed" and tell a recruiter the panel is set when somebody has said no. §10
 * makes a decline the trigger for a re-solve, so it has to be visible as itself.
 */
const STATUS_LABELS: Record<InterviewStatus, string> = {
  unscheduled: 'Not scheduled',
  pending: 'Pending',
  confirmed: 'Confirmed',
  declined: 'Declined',
  completed: 'Done',
  cancelled: 'Cancelled',
};

export const statusLabel = (status: InterviewStatus): string => STATUS_LABELS[status];

/** A round with no `interview` row has no time yet — that is what `null` means (§5). */
export const roundStatus = (round: Round): InterviewStatus => round.interview?.status ?? 'unscheduled';

/** Every panelist the solver must satisfy. Optional panelists are invited, never blocking. */
export const requiredPanelistIds = (round: Round): string[] =>
  round.panelists.filter((p) => p.isRequired).map((p) => p.userId);

/* ── Availability ──────────────────────────────────────────────────────────── */

export function panelistById(loop: SchedulingLoop, id: string): Panelist | undefined {
  return loop.panelists.find((p) => p.id === id);
}

/**
 * Is this person busy anywhere inside a grid row?
 *
 * Overlap against the row's whole span, not containment of its start: a 10:30 meeting
 * has to darken the 10:00 row. Point containment would leave it looking free, and a
 * loop placed into it is exactly the failure this spec exists to prevent.
 *
 * **A panelist absent from the map is busy, not free** — spec §7's fail-closed rule, and
 * the same direction `SeededCalendarProvider.getBusy` and the solver's grid take. "We
 * have no intervals for this person" and "we never managed to read their calendar" arrive
 * here as the same value, so the one that cannot double-book anybody has to win. A
 * genuinely free panelist is present with an empty array.
 */
export function busyDuring(
  busy: Record<string, BusyInterval[]>,
  panelistId: string,
  startUtc: string,
  endUtc: string,
): boolean {
  const intervals = busy[panelistId];
  if (intervals === undefined) return true;
  return overlaps(intervals, startUtc, endUtc);
}

/**
 * Where each row ends: the next row's start, and for the last one an hour on.
 *
 * The reference grid's rows are not a uniform ruler — 12:00, 1:00, 2:30, 3:30 — so a
 * row's height in time has to be read off its neighbour rather than assumed.
 */
export function rowSpans(starts: string[]): { startUtc: string; endUtc: string }[] {
  return starts.map((startUtc, index) => ({
    startUtc,
    endUtc: starts[index + 1] ?? plusMinutes(startUtc, 60),
  }));
}

/**
 * The busy map for whichever day is on screen.
 *
 * `loop.busy` wins for the loop's own day even though the week array also carries it:
 * a scenario that makes a panelist fully busy (an unreadable calendar, §12.1) edits the
 * loop's map, and preferring the week copy would quietly serve the un-edited one — the
 * screen would say "calendar not connected" while showing that person's ordinary day.
 */
export function busyForDay(loop: SchedulingLoop, dayUtc: string): Record<string, BusyInterval[]> {
  if (dayUtc === loop.dayUtc) return loop.busy;
  return loop.week.find((d) => d.dayUtc === dayUtc)?.busy ?? loop.busy;
}

/** Row starts shifted onto another day, keeping the wall-clock times of the reference day. */
export function rowsForDay(loop: SchedulingLoop, dayUtc: string): string[] {
  const offset = new Date(dayUtc).getTime() - new Date(loop.rows[0]?.startUtc ?? dayUtc).getTime();
  return loop.rows.map((row) => new Date(new Date(row.startUtc).getTime() + offset).toISOString());
}

/* ── Placement ─────────────────────────────────────────────────────────────── */

/**
 * What the solver proposes: every round hung off one loop start.
 *
 * The reference screen highlights all four panelists on the 10:00 row rather than a
 * staircase, so the loop start is the placement in M2 and manual placement (§7a) is
 * what moves a single round off it.
 */
export function solvedArrangement(loop: SchedulingLoop, startUtc: string): Placement {
  return Object.fromEntries(loop.rounds.map((round) => [round.id, startUtc]));
}

const DAY_MS = 24 * 60 * 60_000;
const MIN_MS = 60_000;

/**
 * The loop as `@talon/domain`'s `Constraints` — spec §7a.
 *
 * The screen owns no placement rule of its own. Durations and required panelists come off
 * the loop, availability comes off the busy map, and everything about *whether a round
 * fits* is answered by the domain predicate the solver, the hold and the send all use.
 *
 * Two things are worth stating because they are easy to get wrong here:
 *
 * - The busy map is copied key for key. A panelist ABSENT stays absent, because the
 *   domain's grid reads absence as fully busy (§7) — filling the gap with `[]` here would
 *   turn "we never read this calendar" into "this person is free all day".
 * - The candidate window travels to the day on screen. The fixture states one window, on
 *   the reference day, and `rowsForDay` derives the other days' rows from it by the same
 *   offset; leaving the window pinned would make every row of every other day report
 *   `outside_window` and the Week toggle useless. Whole-day arithmetic, which is exact
 *   inside one DST period and is view-model only — the endpoint will send a window per
 *   day and this shift goes with it.
 */
function constraintsFor(
  loop: SchedulingLoop,
  busy: Record<string, BusyInterval[]>,
  placement: Placement,
): Constraints {
  const anchor = arrangementStart(placement) ?? loop.dayUtc;
  const shift = Math.round((Date.parse(anchor) - Date.parse(loop.dayUtc)) / DAY_MS) * DAY_MS;
  const windowStart = Date.parse(loop.candidateWindow.startUtc) + shift;
  const windowEnd = Date.parse(loop.candidateWindow.endUtc) + shift;

  return {
    rounds: loop.rounds.map((round) => ({
      id: round.id,
      durationMin: round.durationMin,
      requiredPanelistIds: requiredPanelistIds(round),
    })),
    busy: Object.fromEntries(
      Object.entries(busy).map(([id, intervals]) => [
        id,
        intervals.map((iv) => ({ start: new Date(iv.startUtc), end: new Date(iv.endUtc) })),
      ]),
    ),
    windowStart: new Date(windowStart),
    windowEnd: new Date(windowEnd),
    // Soft constraints, and `validateArrangement` reads neither — gaps, span and a late
    // finish were only ever scoring inputs (§7a). The whole window is the only honest
    // value the screen has for them, so nothing here can quietly become a hard bound.
    maxGapMin: (windowEnd - windowStart) / MIN_MS,
    maxSpanMin: (windowEnd - windowStart) / MIN_MS,
  };
}

/**
 * The domain's blocker, in the shape the wire and the copy layer use.
 *
 * The domain names ids because it knows nothing about names or labels; the screen needs
 * "Maya Reyes" and "System design" to write a sentence. That translation is all this is —
 * no rule is applied and no reason is added or dropped, so a ninth reason in the domain
 * fails the typecheck here rather than rendering as blank.
 */
function toWireBlocker(loop: SchedulingLoop, blocker: DomainBlocker): SolveBlocker {
  const kindOf = (roundId: string): RoundKind | undefined =>
    loop.rounds.find((round) => round.id === roundId)?.kind;
  // Unreachable in practice: the domain answers a round it does not know with
  // `unknown_round` before it can name one in any other reason. Stated rather than
  // defaulted, because a fabricated kind would put the wrong words in a callout.
  const unknown = (roundId: string): SolveBlocker => ({ reason: 'unknown_round', roundId });

  switch (blocker.reason) {
    case 'no_rounds':
    case 'timed_out':
      return blocker;
    case 'window_too_narrow':
      return {
        reason: 'window_too_narrow',
        requiredMin: blocker.requiredMin,
        availableMin: blocker.availableMin,
      };
    case 'span_too_short':
      return { reason: 'span_too_short', requiredMin: blocker.requiredMin, maxSpanMin: blocker.maxSpanMin };
    case 'unknown_round':
      return unknown(blocker.roundId);
    case 'panelist_busy': {
      const kind = kindOf(blocker.roundId);
      if (kind === undefined) return unknown(blocker.roundId);
      return {
        reason: 'panelist_busy',
        roundId: blocker.roundId,
        roundKind: kind,
        atUtc: blocker.at.toISOString(),
        busyPanelists: blocker.busyPanelistIds.map((id) => ({
          id,
          name: panelistById(loop, id)?.name ?? 'someone on the panel',
        })),
      };
    }
    case 'outside_window': {
      const kind = kindOf(blocker.roundId);
      if (kind === undefined) return unknown(blocker.roundId);
      return { reason: 'outside_window', roundId: blocker.roundId, roundKind: kind, atUtc: blocker.at.toISOString() };
    }
    case 'rounds_overlap': {
      const kind = kindOf(blocker.roundId);
      if (kind === undefined) return unknown(blocker.roundId);
      return {
        reason: 'rounds_overlap',
        roundId: blocker.roundId,
        roundKind: kind,
        otherRoundId: blocker.otherRoundId,
        atUtc: blocker.at.toISOString(),
      };
    }
  }
}

/**
 * Is this placement placeable? `null` means yes — spec §7a, and the predicate is the
 * domain's, not a second copy of it.
 *
 * One round at a time, in `position` order, because the screen's `Placement` is a
 * *rendering* co-location: M2 hangs every round off one loop start and the reference
 * screen highlights all four panelist columns on the 10:00 row rather than a staircase.
 * Handing that whole set to the domain at once would answer `rounds_overlap` for the very
 * state the reference shows, so each round is asked the one question the client is
 * actually asking — *does this round fit here, for its required panelists, inside the
 * candidate's window*. Consequence, stated because it is a real gap and not a preference:
 * `rounds_overlap` is unreachable from this view-model, and the candidate-can't-be-in-two-
 * places check belongs to the real arrangement that hold and send re-validate server-side
 * (§7a — "the client-side check is for feedback speed, not for correctness").
 */
export function validateArrangement(
  loop: SchedulingLoop,
  busy: Record<string, BusyInterval[]>,
  placement: Placement,
): SolveBlocker | null {
  const c = constraintsFor(loop, busy, placement);
  const byId = new Map(loop.rounds.map((round) => [round.id, round]));
  // The loop's own order, so the blocker names the first round that fails rather than
  // whichever key the object happened to be built with. Ids the loop does not have sort
  // last and the domain answers them with `unknown_round`.
  const ids = Object.keys(placement).sort(
    (a, b) =>
      (byId.get(a)?.position ?? Number.MAX_SAFE_INTEGER) - (byId.get(b)?.position ?? Number.MAX_SAFE_INTEGER),
  );

  for (const roundId of ids) {
    const round = byId.get(roundId);
    const start = new Date(placement[roundId] as string);
    // The duration is only the `Arrangement` shape's; the predicate reads its own from
    // `c.rounds`, which is what stops a caller shrinking a round past a conflict.
    const end = new Date(start.getTime() + (round?.durationMin ?? 0) * MIN_MS);
    const blocker = validatePlacement(
      {
        start,
        end,
        spanMin: round?.durationMin ?? 0,
        totalGapMin: 0,
        rounds: [{ roundId, start, end, panelistIds: round ? requiredPanelistIds(round) : [] }],
      },
      c,
    );
    if (blocker) return toWireBlocker(loop, blocker);
  }
  return null;
}

/**
 * The first round that does not fit if the whole loop starts at `startUtc`.
 *
 * One line, because it is the *same* question manual placement asks: the loop start is
 * just the placement that puts every round on one row. Two implementations of "does
 * this fit" would eventually answer differently.
 */
export function conflictAt(
  loop: SchedulingLoop,
  busy: Record<string, BusyInterval[]>,
  startUtc: string,
): SolveBlocker | null {
  return validateArrangement(loop, busy, solvedArrangement(loop, startUtc));
}

/** The round sitting in this panelist's column on this row, if any. */
export function roundPlacedAt(
  loop: SchedulingLoop,
  placement: Placement,
  panelistId: string,
  startUtc: string,
): Round | undefined {
  return loop.rounds.find(
    (round) => placement[round.id] === startUtc && requiredPanelistIds(round).includes(panelistId),
  );
}

/** The loop's start: the earliest round in the placement. `null` when nothing is placed. */
export function arrangementStart(placement: Placement): string | null {
  const starts = Object.values(placement).sort();
  return starts[0] ?? null;
}

/**
 * Where the bulk of the loop sits — the most common start, earliest wins a tie.
 *
 * This is what a round card compares itself against, and it is deliberately not the
 * loop's *start*: move one round earlier than the rest and the start moves with it,
 * so every other card would announce itself as "moved" when nothing of the sort
 * happened. The useful fact is which round is away from the others.
 */
export function commonStart(placement: Placement): string | null {
  const counts = new Map<string, number>();
  for (const start of Object.values(placement)) counts.set(start, (counts.get(start) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/* ── Copy ──────────────────────────────────────────────────────────────────── */

/** "3h 30m" / "45m" — durations in a blocker, where the number is the whole point. */
function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * The blocker, as one sentence naming the specific problem and the next move.
 *
 * `panelist_busy` is the reference screen's — *"Maya Reyes is busy at 10:00. Pick a
 * clear row or the loop needs a gap."* — and the other seven get the same treatment
 * rather than a shared fallback, because "No availability found" is exactly the
 * sentence DESIGN_SYSTEM §6 forbids. The switch is exhaustive on purpose: a ninth
 * reason on the wire has to fail the typecheck here rather than render as blank.
 */
export function blockerSentence(blocker: SolveBlocker, zone: string): string {
  switch (blocker.reason) {
    case 'panelist_busy': {
      const who = nameList(blocker.busyPanelists.map((p) => p.name));
      const verb = blocker.busyPanelists.length === 1 ? 'is' : 'are';
      return `${who} ${verb} busy at ${timeLabel(blocker.atUtc, zone)}. Pick a clear row or the loop needs a gap.`;
    }
    case 'no_rounds':
      return 'This loop has no rounds yet. Add rounds to the interview template, then Talon can place them.';
    case 'window_too_narrow':
      return `The loop needs ${duration(blocker.requiredMin)} and only ${duration(
        blocker.availableMin,
      )} is free in the candidate's window. Ask for a wider window, or drop a round.`;
    case 'span_too_short':
      return `The loop needs ${duration(blocker.requiredMin)} and this day allows ${duration(
        blocker.maxSpanMin,
      )}. Split it across two days, or drop a round.`;
    case 'outside_window':
      return `${roundKindLabel(blocker.roundKind)} at ${timeLabel(
        blocker.atUtc,
        zone,
      )} falls outside the window the candidate gave. Pick a time inside it.`;
    case 'rounds_overlap':
      return `${roundKindLabel(blocker.roundKind)} at ${timeLabel(
        blocker.atUtc,
        zone,
      )} runs into another round. Move one of them.`;
    case 'unknown_round':
      return 'That round is no longer part of this loop. Reload the schedule and place it again.';
    case 'timed_out':
      return 'The search ran out of time before it found a fit. Try another day, or drop a round.';
  }
}

/** The people a blocker is about — empty for the reasons that are about time, not people. */
export function blockerPanelists(blocker: SolveBlocker): { id: string; name: string }[] {
  return blocker.reason === 'panelist_busy' ? blocker.busyPanelists : [];
}

/**
 * A conflict the recruiter chose to keep (§7a).
 *
 * Deliberately not the same sentence as `blockerSentence`: that one ends in advice, and
 * repeating advice someone has already declined is nagging. This states the fact, says
 * who owns the decision, and names the consequence.
 */
export function overrideSentence(blocker: SolveBlocker, zone: string): string {
  if (blocker.reason !== 'panelist_busy') {
    return `${blockerSentence(blocker, zone)} You placed it there anyway, so it stays.`;
  }
  const who = nameList(blocker.busyPanelists.map((p) => p.name));
  return `${roundKindLabel(blocker.roundKind)} sits at ${timeLabel(
    blocker.atUtc,
    zone,
  )} over ${who}'s calendar. You placed it there, so it stays and they will see the clash.`;
}

/** Panelists with a required round who are free through `[startUtc, endUtc)`. */
export function freeFor(
  loop: SchedulingLoop,
  busy: Record<string, BusyInterval[]>,
  startUtc: string,
  endUtc: string,
): Panelist[] {
  return loop.rounds
    .flatMap((round) => requiredPanelistIds(round))
    .filter((id, index, all) => all.indexOf(id) === index)
    .filter((id) => !busyDuring(busy, id, startUtc, endUtc))
    .map((id) => panelistById(loop, id))
    .filter((p): p is Panelist => p !== undefined);
}

/* ── Calendars we could not read ───────────────────────────────────────────── */

/**
 * Why a panelist's column reads as fully busy when it is not their own packed day.
 *
 * Two reasons, not one, because they have different next moves: `not_connected` is fixed
 * by connecting a calendar, `not_read` by trying again. Both fail the same direction —
 * fully busy (§4) — and both have to be *said*, because a wall of busy with no
 * explanation is indistinguishable from a genuinely full day (§11, §12.1).
 */
export type CalendarUnreadable = 'not_connected' | 'not_read';

/** `null` when this person's availability is real, whatever it says. */
export function unreadableCalendar(
  loop: SchedulingLoop,
  busy: Record<string, BusyInterval[]>,
  panelistId: string,
): CalendarUnreadable | null {
  const panelist = panelistById(loop, panelistId);
  // Somebody the loop does not list at all: we have nothing to read, so we read nothing.
  if (!panelist) return 'not_read';
  if (!panelist.calendarConnected) return 'not_connected';
  // A key that never arrived. `[]` is a free day; absent is a calendar we never read, and
  // `busyDuring` has already turned it into every row busy.
  return busy[panelistId] === undefined ? 'not_read' : null;
}

/**
 * Required panelists whose availability we cannot read, grouped by why.
 *
 * Required only: §12.3 blocks the send on the people a round cannot happen without, and an
 * optional panelist is invited and never blocks anything (§7).
 */
export function unreadableGroups(
  loop: SchedulingLoop,
  busy: Record<string, BusyInterval[]>,
): { reason: CalendarUnreadable; panelists: Panelist[] }[] {
  const required = new Set(loop.rounds.flatMap((round) => requiredPanelistIds(round)));
  const reasons: CalendarUnreadable[] = ['not_connected', 'not_read'];
  return reasons
    .map((reason) => ({
      reason,
      panelists: loop.panelists.filter(
        (p) => required.has(p.id) && unreadableCalendar(loop, busy, p.id) === reason,
      ),
    }))
    .filter((group) => group.panelists.length > 0);
}

/** The grid column header's note, and the round card's status word. Short: it sits at `meta`. */
export const unreadableNote = (reason: CalendarUnreadable): string =>
  reason === 'not_connected' ? 'Calendar not connected' : "Availability didn't load";

/** The tail of a cell's description, after "Maya Reyes reads as busy at 10:00 — ". */
export const unreadableWhy = (reason: CalendarUnreadable): string =>
  reason === 'not_connected' ? 'their calendar is not connected' : "Talon couldn't read their calendar";

/** The callout: what is wrong, why every row looks busy, and the two ways out. */
export function unreadableSentence(names: string[], reason: CalendarUnreadable): string {
  const rounds = names.length === 1 ? 'that round' : 'those rounds';
  if (reason === 'not_connected') {
    return `${nameList(names)} ${
      names.length === 1 ? "hasn't" : "haven't"
    } connected a calendar, so every row reads as busy. Connect it, or drop ${rounds} before sending.`;
  }
  return `${nameList(names)}'s availability didn't load, so every row reads as busy. Reload the schedule, or drop ${rounds} before sending.`;
}

/** The one-line reason the send is refused. The move stays in the callout above it. */
export function unreadableBlocker(names: string[], reason: CalendarUnreadable): string {
  if (reason === 'not_connected') {
    return `${nameList(names)} ${names.length === 1 ? 'has' : 'have'} no calendar connected.`;
  }
  return `${nameList(names)}'s availability didn't load.`;
}

/** "Lin Chen, David Osei and Sam Altmann" — an Oxford-free list for a spoken announcement. */
export function nameList(names: string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
