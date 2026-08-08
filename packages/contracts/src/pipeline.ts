/**
 * Contract: the pipeline board — spec 004 §6.
 *
 * Migrated from `apps/web/src/mocks/pipeline-contract.ts`, which spec 003 §4.1 shipped
 * as an approved temporary home. The shape is honoured; three changes, each with a
 * reason recorded in spec 004 §6:
 *
 *  - `skills` and `scoreAvg` are gone. There is no `candidate_skills` table and no
 *    scorecards table, so the endpoint cannot populate them, and a field the server
 *    cannot fill does not belong in the contract. They return with their tables.
 *  - `nextAction` stays, now derived from the canonical stage (`@talon/domain`)
 *    rather than invented in a fixture.
 *  - `fromStageId` is required on the move body, not optional.
 */
import { z } from 'zod';
// Imported, not re-declared: jobs.ts already derives this from @talon/domain, and a
// second z.enum over the same list is the drift this file exists to avoid.
import { CanonicalStageSchema, JobStatusSchema } from './jobs.js';

/** Mirrors `applications.source` in packages/db. Deliberately NOT widened to admit the
 *  reference screen's "LinkedIn" tag — the designer was loose with the enum, and the
 *  enum is not widened for a pixel (spec 003 §5.4). */
export const SourceSchema = z.enum(['careers_page', 'outbound', 'referral', 'agency', 'import']);
export type Source = z.infer<typeof SourceSchema>;

export const ApplicationStatusSchema = z.enum(['active', 'hired', 'rejected', 'withdrawn']);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/** Strict, so the board route can never grow a silent filter. */
export const GetBoardParamsSchema = z.object({ jobId: z.string().uuid() }).strict();
export type GetBoardParams = z.infer<typeof GetBoardParamsSchema>;

export const ApplicationParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type ApplicationParams = z.infer<typeof ApplicationParamsSchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const ApplicationCardSchema = z.object({
  /** The application, not the candidate — this is what the mutations address. */
  id: z.string().uuid(),
  /** The avatar hue hashes off the CANDIDATE, so one person keeps one colour across
   *  every job they apply to. */
  candidateId: z.string().uuid(),
  name: z.string(),
  currentTitle: z.string(),
  currentCompany: z.string(),
  source: SourceSchema,
  status: ApplicationStatusSchema,
  /** Elapsed days, `floor(age(stage_entered_at) / 1 day)` — not calendar days in the
   *  viewer's zone. Matches `metrics.test.ts`; spec 004 OQ-5. */
  daysInStage: z.number().int().min(0),
  nextAction: z.string(),
  version: z.number().int().min(1),
});
export type ApplicationCard = z.infer<typeof ApplicationCardSchema>;

/**
 * Computed over `stage_transitions`, never over the cards presently in the column —
 * those have incomplete dwells and are a different population. Spec 004 §4 has the
 * queries and the reason this is stated so loudly.
 */
export const ColumnStatsSchema = z.object({
  /**
   * Cumulative reach: applications that ever got at least this far, over all
   * applications on the job. Funnel depth, NOT a stage-to-stage conversion — the
   * label reads "% pass" and PRD §5.4 calls it a conversion rate, both of which
   * suggest a different formula. ENG-204 derives to 100/56/33/22/11.
   */
  passRatePct: z.number().int().min(0).max(100),
  /** Median of COMPLETED dwells. Null on a terminal stage and null before anyone has
   *  left — nobody leaves Hired, so no completed dwell exists. The UI renders
   *  "closed" for null. */
  medianDaysInStage: z.number().int().min(0).nullable(),
});
export type ColumnStats = z.infer<typeof ColumnStatsSchema>;

export const BoardColumnSchema = z.object({
  stageId: z.string().uuid(),
  name: z.string(),
  canonical: CanonicalStageSchema,
  position: z.number().int().min(0),
  /** Null means the stage has no SLA and therefore cannot stall. */
  slaDays: z.number().int().min(1).nullable(),
  isTerminal: z.boolean(),
  /**
   * The column's TRUE size, which is not always `cards.length`: the board serves at
   * most 200 cards per column. `count > cards.length` is the truncation signal, so no
   * separate flag is carried — the client already renders this number in the header.
   */
  count: z.number().int().min(0),
  stats: ColumnStatsSchema,
  /**
   * Ordered by `board_rank`, capped at 200. `board_rank` itself is deliberately not on
   * the wire: the client reorders by splicing this array and names neighbours by id,
   * so a rank it never reads would be a field to keep in sync for nothing.
   */
  cards: z.array(ApplicationCardSchema).max(200),
});
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

/** The board is a job-scoped resource and carries the job's own header, so the page
 *  header and the columns are not on two loading clocks. */
export const BoardJobSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  reqCode: z.string(),
  status: JobStatusSchema,
  location: z.string(),
  recruiter: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
});
export type BoardJob = z.infer<typeof BoardJobSchema>;

export const BoardSchema = z.object({
  job: BoardJobSchema,
  columns: z.array(BoardColumnSchema),
});
export type Board = z.infer<typeof BoardSchema>;

// ---------------------------------------------------------------------------
// Mutations (ARCHITECTURE §6.1)
// ---------------------------------------------------------------------------

/**
 * Two bodies and two routes, never one with an optional field. The separation is what
 * makes non-negotiable #18 structural rather than conventional: there is no code path
 * on which a reorder reaches the write that bumps `version`.
 */
export const MoveStageBodySchema = z
  .object({
    /**
     * The stage the CLIENT believed the card was in.
     *
     * ARCHITECTURE §6.1's prose requires this and its code block omits it. The prose
     * is right: without it the server cannot know what the client believed, so
     * "someone else already moved it" is undetectable on its own and collapses into
     * the version check — the exact collapse §6.1 spends a paragraph forbidding,
     * because re-applying a stage change corrupts the append-only transition log.
     */
    fromStageId: z.string().uuid(),
    toStageId: z.string().uuid(),
    /** Neighbours by id, never an index: an index is read against a different array on
     *  each side and drifts by a row on every same-column move downward. `beforeId`
     *  wins when both are supplied and both resolve. */
    beforeId: z.string().uuid().nullable().optional(),
    afterId: z.string().uuid().nullable().optional(),
    version: z.number().int().min(1),
    /** Required by a move to a terminal stage (PRD §5.4). The UI does not send it yet,
     *  so it blocks those drops client-side — spec 003 OQ-1. */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type MoveStageBody = z.infer<typeof MoveStageBodySchema>;

/** No `version` in, none out. Position is last-write-wins and is not worth a conflict
 *  dialog (ARCHITECTURE §6.1). */
export const ReorderBodySchema = z
  .object({
    beforeId: z.string().uuid().nullable().optional(),
    afterId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type ReorderBody = z.infer<typeof ReorderBodySchema>;

/**
 * The 409 body. `current` lets the client reconcile without a second round trip, and
 * `currentStageName` because `current` alone does not say WHERE the card now is and
 * the client names the stage in its own sentence.
 */
export const StageConflictSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(409),
  detail: z.string(),
  current: ApplicationCardSchema,
  currentStageName: z.string(),
});
export type StageConflict = z.infer<typeof StageConflictSchema>;
