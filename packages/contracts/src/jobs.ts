/**
 * Contract: GET /v1/jobs — spec 001 §7.2.
 *
 * Field names are camelCase across the wire, matching the spec's own
 * `stageDistribution` / `inProcessCount` / `nextCursor`. The database is
 * snake_case; the mapping happens in the repository, not here.
 */
import { z } from 'zod';

// Mirrors packages/db jobs.status and jobStages.canonical. Drizzle owns the
// column enums; these must not drift from them.
export const JobStatusSchema = z.enum(['draft', 'active', 'on_hold', 'closing', 'closed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const CanonicalStageSchema = z.enum([
  'applied',
  'screen',
  'onsite',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
]);
export type CanonicalStage = z.infer<typeof CanonicalStageSchema>;

/** Stages a candidate can still move out of — the ones `inProcessCount` counts. */
export const NON_TERMINAL_STAGES = ['applied', 'screen', 'onsite', 'offer'] as const;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const ListJobsQuerySchema = z
  .object({
    // Single value for M0a. The jobs list has one status control, and a repeated
    // param would change the repository's WHERE shape — widen it when a screen
    // actually needs it.
    status: JobStatusSchema.optional(),
    department: z.string().min(1).optional(),
    recruiter_id: z.string().uuid().optional(),
    /** Opaque. Pagination is on `(sort_key, id)` (ARCHITECTURE) — never decode this client-side. */
    cursor: z.string().min(1).optional(),
    // Query params arrive as strings, hence coerce. The max is a real bound, not
    // decoration: an unbounded limit is a one-request denial of service.
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  // A typo'd filter must 400, not silently return unfiltered data that looks right.
  .strict();
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Money crosses the wire as a string of integer cents ("19000000").
 * The columns are `bigint` (§4.9) and `JSON.stringify` throws on a BigInt, so
 * a number here would either lose precision or crash serialization. Digits
 * only — no sign, no decimal point, no thousands separator.
 */
const centsSchema = z.string().regex(/^\d+$/, 'integer cents as a digit string');

export const CompBandSchema = z.object({
  minCents: centsSchema,
  maxCents: centsSchema,
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 alpha-3'),
});
export type CompBand = z.infer<typeof CompBandSchema>;

const stageCount = z.number().int().min(0);

/**
 * Every canonical stage is present, zero included — spec §9 edge case 4 says a
 * job with no applications renders at zero width, "not NaN, not absent". A
 * partial record would let the UI read `undefined` and compute NaN, so presence
 * is enforced here rather than defended against in every consumer.
 */
export const StageDistributionSchema = z.object(
  // Built from the enum rather than listed by hand, so a new canonical stage
  // cannot be added without appearing here.
  Object.fromEntries(CanonicalStageSchema.options.map((s) => [s, stageCount])) as Record<
    CanonicalStage,
    typeof stageCount
  >,
);
export type StageDistribution = z.infer<typeof StageDistributionSchema>;

export const RecruiterSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Avatar fill from the `avatar.1–8` token ramp (DESIGN_SYSTEM §JobRow). */
  avatarColor: z.string().nullable(),
});
export type RecruiterSummary = z.infer<typeof RecruiterSummarySchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  reqCode: z.string(),
  title: z.string(),
  department: z.string(),
  location: z.string(),
  employmentType: z.string().nullable(),
  status: JobStatusSchema,

  /** Applications in a non-terminal stage — the "18 in process" line under the bar. */
  inProcessCount: z.number().int().min(0),
  /** Applications not rejected or withdrawn; includes hired. */
  activeCount: z.number().int().min(0),
  stageDistribution: StageDistributionSchema,

  recruiter: RecruiterSummarySchema.nullable(),
  hiringManagerId: z.string().uuid().nullable(),

  /**
   * Absent and null mean different things and the UI renders them differently:
   * **absent** — the caller lacks `comp:read`, so the field was stripped at
   * serialization (§4.2). Rows render without band data, no error, no empty
   * state (§7.3 Forbidden).
   * **null** — the caller may see comp; this job simply has no band set.
   * Collapsing them would make "you may not see this" indistinguishable from
   * "there is nothing to see".
   */
  compBand: CompBandSchema.nullable().optional(),

  openings: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Job = z.infer<typeof JobSchema>;

export const ListJobsResponseSchema = z.object({
  data: z.array(JobSchema),
  nextCursor: z.string().nullable(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;
