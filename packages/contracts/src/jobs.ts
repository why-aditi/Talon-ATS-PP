/**
 * Contract: GET /v1/jobs — spec 001 §7.2.
 *
 * Response bodies are camelCase, matching the spec's own `stageDistribution` /
 * `inProcessCount` / `nextCursor`. Query params stay snake_case (`recruiter_id`)
 * because §7.2 writes the query string that way and URLs are conventionally
 * snake. The database is snake_case throughout; the repository maps.
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

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const ListJobsQuerySchema = z
  .object({
    // Single value for M0a. The jobs list has one status control, and a repeated
    // param would change the repository's WHERE shape — widen it when a screen
    // actually needs it.
    status: JobStatusSchema.optional(),
    // Trimmed: a whitespace-only filter would render "No jobs match this filter"
    // for what is effectively no filter at all.
    department: z.string().trim().min(1).optional(),
    recruiter_id: z.string().uuid().optional(),
    /** Opaque. Pagination is on `(sort_key, id)` (ARCHITECTURE) — never decode this client-side. */
    cursor: z.string().min(1).max(512).optional(),
    // Digits only, deliberately not z.coerce: coerce is Number(), which quietly
    // accepts "0x10" (16), "1e2" (100), "+50" and " 100 ". The max is a real
    // bound, not decoration — an unbounded limit is a one-request denial of service.
    limit: z
      .union([z.number().int(), z.string().regex(/^\d+$/, 'digits only').transform(Number)])
      .pipe(z.number().int().min(1).max(100))
      .default(50),
  })
  // A typo'd filter must 400, not silently return unfiltered data that looks right.
  .strict();
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

/** GET /v1/jobs/:id. Strict so `/v1/jobs/:id` can never grow a silent filter. */
export const GetJobParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type GetJobParams = z.infer<typeof GetJobParamsSchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Money crosses the wire as a string of integer cents ("19000000").
 * The columns are `bigint` (§4.9) and `JSON.stringify` throws on a BigInt, so
 * a number here would either lose precision or crash serialization. Digits
 * only — no sign, no decimal point, no thousands separator.
 */
// Canonical form only: no leading zeros, so one amount has exactly one wire
// representation and string equality matches value equality. Range-checked
// against the int8 ceiling rather than a digit count — 19 digits reaches
// 9999999999999999999, which the bigint column cannot store.
const INT8_MAX = 9223372036854775807n;
// One predicate, not a regex plus a refine: zod still runs a refinement after a
// failed regex, so a separate BigInt() step would throw on "190.00" instead of
// reporting it. The && short-circuits before BigInt ever sees a non-digit.
const isCents = (v: string) => /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= INT8_MAX;
const centsSchema = z.string().refine(isCents, 'canonical integer cents within bigint range');

export const CompBandSchema = z
  .object({
    minCents: centsSchema,
    maxCents: centsSchema,
    /** Shape-checked only — alpha-3, not validated against the ISO 4217 register. */
    currency: z.string().regex(/^[A-Z]{3}$/, 'alpha-3 currency code'),
  })
  // Catches a repository mapping that swapped the two columns. Skipped when a
  // field is already invalid — that error is the one worth reporting.
  .refine((b) => !isCents(b.minCents) || !isCents(b.maxCents) || BigInt(b.minCents) <= BigInt(b.maxCents), {
    message: 'minCents must not exceed maxCents',
    path: ['minCents'],
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

// No avatar color: the UI hashes the id over the avatar.1–8 token ramp
// (DESIGN_SYSTEM §JobRow). A hex value from the API would be a raw color
// outside packages/tokens, which §4.8 forbids.
export const RecruiterSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type RecruiterSummary = z.infer<typeof RecruiterSummarySchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  reqCode: z.string(),
  title: z.string(),
  department: z.string(),
  location: z.string(),
  status: JobStatusSchema,

  // Nullable because `jobs.recruiter_id` is: an unassigned job must serialize,
  // not fail the whole page.
  recruiter: RecruiterSummarySchema.nullable(),

  stageDistribution: StageDistributionSchema,
  /** Applications in a non-terminal stage — the "18 in process" line under the bar. */
  inProcessCount: z.number().int().min(0),
  /** Applications not rejected or withdrawn; includes hired. */
  activeCount: z.number().int().min(0),

  /**
   * Omitted entirely for callers without `comp:read` (spec §6.4), and for jobs
   * with no band set. One nested optional rather than three loose fields, so a
   * band can never arrive missing its currency — presence is atomic.
   *
   * The strip happens because the route declares
   * `response: { 200: ListJobsResponseSchema }`; a route without a response
   * schema is not comp-gated, whatever the service returns.
   */
  band: CompBandSchema.optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const ListJobsResponseSchema = z.object({
  data: z.array(JobSchema),
  nextCursor: z.string().nullable(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;
