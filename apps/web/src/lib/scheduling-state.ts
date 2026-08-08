/**
 * Pure derivations over a `SchedulingLoop`. No React, no I/O, no clock.
 *
 * Everything the screen says about a slot is computed here, which is what keeps one
 * sentence in one place: the conflict callout the solver produced and the conflict the
 * recruiter creates by picking a busy row are the same function, so they cannot drift
 * into two different phrasings of the same fact.
 */
import {
  validateArrangement,
  type BusyInterval,
  type InterviewStatus,
  type Panelist,
  type Placement,
  type Round,
  type RoundKind,
  type SchedulingLoop,
  type SolveBlocker,
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
 */
export function busyDuring(
  busy: Record<string, BusyInterval[]>,
  panelistId: string,
  startUtc: string,
  endUtc: string,
): boolean {
  return overlaps(busy[panelistId] ?? [], startUtc, endUtc);
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

/** Rounds whose panelist cannot be read at all. Spec §12.3 blocks the send and names them. */
export function disconnectedPanelists(loop: SchedulingLoop): Panelist[] {
  const required = new Set(loop.rounds.flatMap((round) => requiredPanelistIds(round)));
  return loop.panelists.filter((p) => !p.calendarConnected && required.has(p.id));
}

/** "Lin Chen, David Osei and Sam Altmann" — an Oxford-free list for a spoken announcement. */
export function nameList(names: string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
