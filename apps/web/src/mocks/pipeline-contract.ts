/**
 * Contract for the pipeline board — spec 003 §4.
 *
 * ⚠ THIS BELONGS IN `packages/contracts/src/pipeline.ts`. It lives here as an
 * approved deviation from CLAUDE.md §5 (spec 003 §4.1): `packages/contracts` is the
 * api agent's tree and a parallel session is working in it, while this schema has
 * exactly one consumer. Moving it is a single commit — export these from
 * `packages/contracts`, add the two error types to `errors.ts`, and change the
 * imports in `pipeline-handlers.ts` and `board-query.ts`. Nothing else depends on
 * the location.
 *
 * The handlers validate their own responses against these schemas, exactly as
 * `handlers.ts` does with `ListJobsResponseSchema`. That is the property worth
 * keeping: a fixture cannot drift out of the shape the screen is built against.
 */
import { CanonicalStageSchema, JobStatusSchema } from '@talon/contracts';
import { z } from 'zod';

/** Mirrors `applications.source` in packages/db. Deliberately NOT widened to admit
 *  the reference screen's "LinkedIn" tag — see spec 003 §5.4. */
export const SourceSchema = z.enum(['careers_page', 'outbound', 'referral', 'agency', 'import']);
export type Source = z.infer<typeof SourceSchema>;

export const ApplicationStatusSchema = z.enum(['active', 'hired', 'rejected', 'withdrawn']);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const ApplicationCardSchema = z.object({
  id: z.string(),
  /** The avatar hue hashes off the CANDIDATE, not the application — one person keeps
   *  one colour across every job they apply to. */
  candidateId: z.string(),
  name: z.string(),
  currentTitle: z.string(),
  currentCompany: z.string(),
  source: SourceSchema,
  skills: z.array(z.string()),
  status: ApplicationStatusSchema,
  daysInStage: z.number().int().min(0),
  nextAction: z.string(),
  /** Absent — not null — for a caller outside scorecard scope. Spec 003 §7. */
  scoreAvg: z.number().nullable().optional(),
  version: z.number().int().min(1),
});
export type ApplicationCard = z.infer<typeof ApplicationCardSchema>;

/**
 * Computed server-side over `stage_transitions`, never over the cards in the column.
 * `medianDaysInStage` is the median of COMPLETED dwells — candidates who have left
 * this stage — so the four cards visible in Applied contribute nothing to Applied's
 * median. Spec 003 §5.2 has the derivation and the reason this is stated so loudly.
 */
export const ColumnStatsSchema = z.object({
  passRatePct: z.number().int().min(0).max(100),
  /** Null on a terminal stage: nobody leaves, so there is no dwell to take a median of. */
  medianDaysInStage: z.number().int().min(0).nullable(),
});

export const BoardColumnSchema = z.object({
  stageId: z.string(),
  name: z.string(),
  canonical: CanonicalStageSchema,
  position: z.number().int().min(0),
  /** Null means the stage has no SLA and therefore cannot stall. */
  slaDays: z.number().int().min(1).nullable(),
  isTerminal: z.boolean(),
  count: z.number().int().min(0),
  stats: ColumnStatsSchema,
  /** Ordered. `board_rank` is a server implementation detail (ARCHITECTURE §6.1) and
   *  is deliberately not on the wire — the client reorders by splicing this array and
   *  names neighbours by id, so a rank it never reads would be a field to keep in sync
   *  for nothing. */
  cards: z.array(ApplicationCardSchema),
});
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

/**
 * The board is a job-scoped resource, so it carries the job's own header rather than
 * making the screen join a second request for four strings — a separate fetch for the
 * title would put the page header and the columns on different loading clocks, which
 * is a guaranteed flash of a half-rendered screen.
 */
export const BoardJobSchema = z.object({
  id: z.string(),
  title: z.string(),
  reqCode: z.string(),
  status: JobStatusSchema,
  location: z.string(),
  recruiter: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export const BoardSchema = z.object({
  job: BoardJobSchema,
  columns: z.array(BoardColumnSchema),
});
export type Board = z.infer<typeof BoardSchema>;

/* ── Mutations (ARCHITECTURE §6.1) ─────────────────────────────────────────── */

/**
 * Two routes, not one with an optional field. The separation is what makes
 * non-negotiable #18 structural: there is no code path on which a reorder reaches
 * the write that bumps `version`.
 */
export const MoveStageBodySchema = z.object({
  toStageId: z.string(),
  beforeId: z.string().nullable().optional(),
  afterId: z.string().nullable().optional(),
  version: z.number().int().min(1),
  reason: z.string().optional(),
});

/** No `version` in, no `version` out. Position is last-write-wins. */
export const ReorderBodySchema = z.object({
  beforeId: z.string().nullable().optional(),
  afterId: z.string().nullable().optional(),
});

/* ── Errors ────────────────────────────────────────────────────────────────── */

/**
 * Migrates into `packages/contracts/src/errors.ts` with the schemas above (spec 003
 * OQ-3). Until then the client's unknown-type fallback keeps it correct, which is
 * exactly the contract `errors.ts` documents.
 */
export const PIPELINE_ERROR_TYPES = {
  /** The card changed under you. Roll back and refetch the destination column. */
  STAGE_VERSION_CONFLICT: 'urn:talon:error:stage-version-conflict',
  /** Someone already moved it elsewhere. 409s even when `version` matches, because
   *  re-applying a stage change corrupts the append-only transition log. */
  STAGE_MOVED: 'urn:talon:error:stage-moved',
} as const;

export const ConflictProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(409),
  detail: z.string(),
  /** The current server state, so the client reconciles without a second round trip. */
  current: ApplicationCardSchema,
  /** The stage the card actually sits in now. Carried because the client names it in
   *  its own sentence, and `current` alone does not say where the card is. */
  currentStageName: z.string(),
});
export type ConflictProblem = z.infer<typeof ConflictProblemSchema>;

/* ── Display mappings ──────────────────────────────────────────────────────── */

export const SOURCE_LABELS: Record<Source, string> = {
  careers_page: 'Careers page',
  outbound: 'Outbound',
  referral: 'Referral',
  agency: 'Agency',
  import: 'Import',
};

export const STATUS_LABELS: Record<Exclude<ApplicationStatus, 'active'>, string> = {
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};
