/**
 * Contract: scheduling — spec 004 §4, §6, §7, §7a.
 *
 * Read and solve shapes only. Routes, holds and the send path are the next PR; nothing
 * here describes a request body yet.
 *
 * Enums are derived from `@talon/domain`, which mirrors the check constraints in
 * migration 0009. A second `z.enum` over the same words is the drift this avoids.
 *
 * ## Where this differs from the UI's fixture (`scheduling-fixtures.ts`)
 *
 * The screen was built against a fixture while this was being written, and the two agree
 * on everything except four things, each of which is the fixture holding a *rendering*
 * shape the server should not be the source of:
 *
 *  - `Round.kind` is the enum, not the label. "System design" is presentation; the wire
 *    carries `system_design` and the screen maps it, the same way stage names are handled.
 *  - `busy` carries intervals, not grid-row start times. Rows are a property of the grid
 *    the client draws, and a server that emits row starts has to know the row height.
 *  - The scheduled instance is nested (`round.interview`), not flattened onto the round.
 *    That is the distinction migration 0009 is built around: a round with no interview
 *    row is unscheduled, and flattening it loses `manualOverride` and the external event.
 *  - `rows`, `week` and `drift` are absent. The first two are grid rendering, the third
 *    belongs to the send response.
 */
import { z } from 'zod';
import { INTERVIEW_STATUSES, LOOP_STATUSES, ROUND_KINDS } from '@talon/domain';

/** UTC only: `z.string().datetime()` rejects an offset, so `+05:30` cannot reach the
 *  server pretending to be an instant. */
const IsoUtc = z.string().datetime();
const IanaZone = z.string().min(1).max(64);

export const RoundKindSchema = z.enum(ROUND_KINDS);
export type RoundKind = z.infer<typeof RoundKindSchema>;

export const InterviewStatusSchema = z.enum(INTERVIEW_STATUSES);
export type InterviewStatus = z.infer<typeof InterviewStatusSchema>;

export const LoopStatusSchema = z.enum(LOOP_STATUSES);
export type LoopStatus = z.infer<typeof LoopStatusSchema>;

// ---------------------------------------------------------------------------
// Availability (§4, §6)
// ---------------------------------------------------------------------------

/** Merged and sorted by the adapter before it ever reaches the wire (§4). */
export const BusyIntervalSchema = z.object({ startUtc: IsoUtc, endUtc: IsoUtc });
export type BusyInterval = z.infer<typeof BusyIntervalSchema>;

export const TimeWindowSchema = z.object({ startUtc: IsoUtc, endUtc: IsoUtc });
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

export const SchedulingPanelistSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** "Lin C." — the grid header has ~200px and four columns to fit. Computed server-side
   *  so every surface abbreviates a name the same way. */
  shortName: z.string(),
  /**
   * False means the provider could not be read for this person. §4: that is fully busy,
   * never free, and the column has to say so — an unexplained wall of busy is
   * indistinguishable from a genuinely packed day (§12.1, §12.3).
   */
  calendarConnected: z.boolean(),
});
export type SchedulingPanelist = z.infer<typeof SchedulingPanelistSchema>;

// ---------------------------------------------------------------------------
// The solver's structured blocker (§7)
// ---------------------------------------------------------------------------

/**
 * Names and kinds are resolved server-side so the screen composes one sentence from
 * fields rather than being handed prose — *"Maya Reyes is busy at 10:00"* — and the copy
 * cannot drift between the no-arrangement state and a live conflict on a row the
 * recruiter picked themselves.
 *
 * `busyPanelists` is a list because a round can require more than one person; the
 * fixture's single `panelistName` is the common case, not the shape.
 */
const BlockedPanelistSchema = z.object({ id: z.string().uuid(), name: z.string() });

export const SolveBlockerSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('no_rounds') }),
  z.object({
    reason: z.literal('window_too_narrow'),
    requiredMin: z.number().int().min(0),
    availableMin: z.number().int().min(0),
  }),
  z.object({
    reason: z.literal('span_too_short'),
    requiredMin: z.number().int().min(0),
    maxSpanMin: z.number().int().min(0),
  }),
  z.object({
    reason: z.literal('panelist_busy'),
    roundId: z.string().uuid(),
    roundKind: RoundKindSchema,
    atUtc: IsoUtc,
    busyPanelists: z.array(BlockedPanelistSchema).min(1),
  }),
  z.object({
    reason: z.literal('outside_window'),
    roundId: z.string().uuid(),
    roundKind: RoundKindSchema,
    atUtc: IsoUtc,
  }),
  z.object({
    reason: z.literal('rounds_overlap'),
    roundId: z.string().uuid(),
    roundKind: RoundKindSchema,
    otherRoundId: z.string().uuid(),
    atUtc: IsoUtc,
  }),
  z.object({ reason: z.literal('unknown_round'), roundId: z.string().uuid() }),
  z.object({ reason: z.literal('timed_out') }),
]);
export type SolveBlocker = z.infer<typeof SolveBlockerSchema>;

// ---------------------------------------------------------------------------
// Arrangements (§7, §7a)
// ---------------------------------------------------------------------------

export const PlacedRoundSchema = z.object({
  roundId: z.string().uuid(),
  startUtc: IsoUtc,
  endUtc: IsoUtc,
  panelistIds: z.array(z.string().uuid()),
});
export type PlacedRound = z.infer<typeof PlacedRoundSchema>;

/**
 * One placement of the whole loop. §7a: a solved arrangement and a hand-built one are
 * this same shape and are indistinguishable downstream — hold, send and the §10
 * re-validation must not try to tell them apart.
 */
export const ArrangementSchema = z.object({
  startUtc: IsoUtc,
  endUtc: IsoUtc,
  spanMin: z.number().int().min(0),
  /** Dead time between rounds. A scoring input, never a hard constraint (§7a). */
  totalGapMin: z.number().int().min(0),
  rounds: z.array(PlacedRoundSchema).min(1),
});
export type Arrangement = z.infer<typeof ArrangementSchema>;

/** `arrangements` is empty exactly when `blocker` is set — §7's "the blocker, not an
 *  empty list". Enforced by the solver and by a domain property test. */
export const SolveResultSchema = z
  .object({
    arrangements: z.array(ArrangementSchema).max(3),
    /** The 200ms box was hit; what is here is the best found so far (§7 step 5). */
    partial: z.boolean(),
    blocker: SolveBlockerSchema.nullable(),
  })
  .refine((r) => (r.arrangements.length === 0) === (r.blocker !== null), {
    message: 'A result with no arrangements must carry a blocker, and one with arrangements must not',
    path: ['blocker'],
  });
export type SolveResult = z.infer<typeof SolveResultSchema>;

// ---------------------------------------------------------------------------
// The loop (§5, §11)
// ---------------------------------------------------------------------------

export const RoundPanelistSchema = z.object({
  userId: z.string().uuid(),
  /** Required panelists are a hard solver constraint; optional ones are invited and
   *  never block a placement. */
  isRequired: z.boolean(),
});
export type RoundPanelist = z.infer<typeof RoundPanelistSchema>;

/**
 * The scheduled INSTANCE of a round — an `interviews` row. Null on the round means
 * unscheduled, which is the whole point of keeping the two apart (migration 0009).
 */
export const ScheduledInterviewSchema = z
  .object({
    id: z.string().uuid(),
    status: InterviewStatusSchema,
    startUtc: IsoUtc.nullable(),
    endUtc: IsoUtc.nullable(),
    /**
     * §7a: a recruiter may place a round over a hard constraint after an explicit
     * confirm. This records that a human chose it, and `acknowledgedBlocker` records what
     * they were shown — the audit trail is worthless without the second half.
     */
    manualOverride: z.boolean(),
    acknowledgedBlocker: SolveBlockerSchema.nullable(),
  })
  // The reverse is allowed: a manual placement that violated nothing overrides nothing.
  .refine((i) => i.acknowledgedBlocker === null || i.manualOverride, {
    message: 'An acknowledged blocker only exists because someone overrode it',
    path: ['manualOverride'],
  });
export type ScheduledInterview = z.infer<typeof ScheduledInterviewSchema>;

/** The TEMPLATE: what the loop must contain. */
export const InterviewRoundSchema = z.object({
  id: z.string().uuid(),
  kind: RoundKindSchema,
  /** A multiple of the solver's 15-minute grid, as `interview_rounds.duration_min` is
   *  DB-checked to be: a 50-minute round cannot be placed exactly and would round. */
  durationMin: z.number().int().min(15).multipleOf(15),
  position: z.number().int().min(0),
  /** Reserved: the M2 solver places rounds in `position` order and ignores this (§7). */
  isSwappable: z.boolean(),
  panelists: z.array(RoundPanelistSchema).min(1),
  interview: ScheduledInterviewSchema.nullable(),
});
export type InterviewRound = z.infer<typeof InterviewRoundSchema>;

/** §12.4 — the second recruiter is told who holds it and until when. */
export const LoopHoldSchema = z.object({
  heldById: z.string().uuid(),
  heldByName: z.string(),
  expiresUtc: IsoUtc,
});
export type LoopHold = z.infer<typeof LoopHoldSchema>;

export const InterviewLoopSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  status: LoopStatusSchema,
  candidate: z.object({
    id: z.string().uuid(),
    name: z.string(),
    /** Their IANA zone. Storage is UTC; this is what the itinerary renders in. */
    zone: IanaZone,
  }),
  jobTitle: z.string(),
  /** Everything on the screen renders in this zone (§8). */
  organizerZone: IanaZone,
  /** `interview_loops.target_date`, a plain calendar date with no zone of its own. */
  targetDate: z.string().date().nullable(),
  /**
   * The candidate's stated availability as instants, already converted from their zone
   * (§6). Null until someone has asked them, which is why the solver refuses to run
   * without it rather than inventing a default.
   */
  candidateWindow: TimeWindowSchema.nullable(),
  /** The window the solver actually searched: the candidate's, intersected with business
   *  hours. Sent because "why is 8am not offered" is otherwise unanswerable on screen. */
  searchWindow: TimeWindowSchema.nullable(),
  panelists: z.array(SchedulingPanelistSchema),
  rounds: z.array(InterviewRoundSchema),
  /** panelistId → busy intervals over `searchWindow`. A disconnected panelist arrives as
   *  one interval covering the whole window, with `calendarConnected: false` saying why. */
  busy: z.record(z.string().uuid(), z.array(BusyIntervalSchema)),
  hold: LoopHoldSchema.nullable(),
  version: z.number().int().min(1),
});
export type InterviewLoop = z.infer<typeof InterviewLoopSchema>;
