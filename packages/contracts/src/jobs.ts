/**
 * Contract: GET /v1/jobs — spec 001 §7.2.
 *
 * Response bodies are camelCase, matching the spec's own `stageDistribution` /
 * `inProcessCount` / `nextCursor`. Query params stay snake_case (`recruiter_id`)
 * because §7.2 writes the query string that way and URLs are conventionally
 * snake. The database is snake_case throughout; the repository maps.
 */
import { CANONICAL_STAGES } from '@talon/domain';
import { z } from 'zod';

// Mirrors packages/db jobs.status and jobStages.canonical. Drizzle owns the
// column enums; these must not drift from them.
export const JobStatusSchema = z.enum(['draft', 'active', 'on_hold', 'closing', 'closed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

// Derived from the domain list, the way RoleSchema derives from ROLES (auth.ts). The
// literals used to live here as a second copy — spec 001 open question 9 already flags
// that nothing catches drift between the SQL check constraint, the Drizzle column and
// this enum, and a third copy would have been one more place to drift from.
export const CanonicalStageSchema = z.enum(CANONICAL_STAGES);
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
  /**
   * Every application on the job, terminal ones included — the reference
   * screen's "N active" cell. Not "non-rejected": ENG-209 reads 8/21, and 21 is
   * only reachable by counting rejections too.
   */
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

  /**
   * Optimistic concurrency (spec 005 §3.1). Every write returns the new value
   * (CLAUDE.md §9), and `PATCH` requires the one the client last read — which is
   * the whole mechanism, so it is required rather than optional. A client that
   * cannot see a version cannot edit safely.
   */
  version: z.number().int().positive(),
});
export type Job = z.infer<typeof JobSchema>;

export const ListJobsResponseSchema = z.object({
  data: z.array(JobSchema),
  nextCursor: z.string().nullable(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;

// ---------------------------------------------------------------------------
// Stage templates — spec 005 §6.3
//
// A job's pipeline is copied from one of these at creation. The template is
// read-only here: editing one is its own screen and its own spec.
// ---------------------------------------------------------------------------

export const TemplateStageSchema = z.object({
  name: z.string().min(1),
  canonical: CanonicalStageSchema,
  /** Null is "no SLA", which is different from zero and must stay different. */
  slaDays: z.number().int().positive().nullable(),
  isTerminal: z.boolean(),
});
export type TemplateStage = z.infer<typeof TemplateStageSchema>;

export const StageTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  stages: z.array(TemplateStageSchema),
});
export type StageTemplate = z.infer<typeof StageTemplateSchema>;

/**
 * No cursor. A tenant has a handful of templates and the wizard shows all of
 * them at once; paginating a list nothing scrolls would be a cursor to maintain
 * for no reader.
 */
export const ListStageTemplatesResponseSchema = z.object({
  data: z.array(StageTemplateSchema),
});
export type ListStageTemplatesResponse = z.infer<typeof ListStageTemplatesResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/jobs — spec 005 §4.2
// ---------------------------------------------------------------------------

/**
 * Per-stage SLA overrides, keyed by POSITION rather than by a stage id: the
 * `job_stages` rows do not exist until the transaction that reads this creates
 * them, so there is no id to name yet.
 */
export const StageOverrideSchema = z.object({
  position: z.number().int().min(0),
  slaDays: z.number().int().positive().max(365).nullable(),
});
export type StageOverride = z.infer<typeof StageOverrideSchema>;

/**
 * Cents arrive as digit strings, not numbers. `bigint` has no JSON
 * representation, and a number would reinstate the 2^53 precision class that
 * CLAUDE.md §4.9 abolishes outright.
 */
const CentsSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, 'Cents must be a positive integer, as a string');

export const CreateJobRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    department: z.string().trim().min(1).max(100),
    location: z.string().trim().min(1).max(100),
    employmentType: z.string().trim().max(50).optional(),

    bandMinCents: CentsSchema.optional(),
    bandMaxCents: CentsSchema.optional(),
    /** Required whenever a band is present — never defaulted (§4.9). */
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),

    recruiterId: z.string().uuid().nullable().default(null),
    hiringManagerId: z.string().uuid().nullable().default(null),
    openings: z.number().int().min(1).max(999).default(1),
    stageTemplateId: z.string().uuid(),
    stageOverrides: z.array(StageOverrideSchema).max(20).default([]),

    /** The wizard creates drafts; publishing is a separate, deliberate act. */
    status: z.enum(['draft', 'active']).default('draft'),
  })
  // .strict(): an unexpected key is a client that thinks it is sending
  // something, and dropping it silently is worse than a 400.
  .strict()
  .refine((v) => (v.bandMinCents === undefined) === (v.bandMaxCents === undefined), {
    message: 'Band minimum and maximum must be provided together',
    path: ['bandMaxCents'],
  })
  .refine((v) => v.bandMinCents === undefined || v.currency !== undefined, {
    message: 'A currency is required when a band is set',
    path: ['currency'],
  })
  .refine(
    (v) =>
      v.bandMinCents === undefined ||
      v.bandMaxCents === undefined ||
      BigInt(v.bandMaxCents) >= BigInt(v.bandMinCents),
    { message: 'Band maximum must be at least the minimum', path: ['bandMaxCents'] },
  );
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/jobs/:id — spec 005 §4.3
// ---------------------------------------------------------------------------

/**
 * Absent and null are DIFFERENT, and the difference is security-relevant.
 *
 *   key absent       -> leave the column alone
 *   key present null -> clear the column
 *
 * Band is scope-gated (#2), so a caller without `comp:read` never receives it
 * and their client cannot send a band it never saw. If absent meant "clear",
 * saving a job title would destroy a salary band the editor was never allowed to
 * look at. Absent-means-untouched is what makes that impossible; the API
 * enforces the other half by refusing a band from a caller without the scope,
 * even a null one — read-gating a field while leaving it writable is not access
 * control.
 *
 * `reqCode` is not here and never will be: it is on offer letters and in
 * people's inboxes. Stages are not here either — changing a pipeline moves live
 * applications between stages and is its own spec.
 */
export const UpdateJobRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    department: z.string().trim().min(1).max(100).optional(),
    location: z.string().trim().min(1).max(100).optional(),
    employmentType: z.string().trim().max(50).nullable().optional(),

    bandMinCents: CentsSchema.nullable().optional(),
    bandMaxCents: CentsSchema.nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),

    recruiterId: z.string().uuid().nullable().optional(),
    hiringManagerId: z.string().uuid().nullable().optional(),
    openings: z.number().int().min(1).max(999).optional(),
    status: JobStatusSchema.optional(),

    /** The version the client last read. Required — this is the mechanism. */
    version: z.number().int().positive(),
  })
  .strict()
  .refine(
    // Cleared together or set together. Half a band is not a band, and a
    // currency left behind on a job with no amounts is a lie about the row.
    (v) =>
      !('bandMinCents' in v) ||
      !('bandMaxCents' in v) ||
      (v.bandMinCents === null) === (v.bandMaxCents === null),
    { message: 'Band minimum and maximum must be set together, or cleared together', path: ['bandMaxCents'] },
  )
  .refine(
    (v) =>
      v.bandMinCents == null ||
      v.bandMaxCents == null ||
      BigInt(v.bandMaxCents) >= BigInt(v.bandMinCents),
    { message: 'Band maximum must be at least the minimum', path: ['bandMaxCents'] },
  );
export type UpdateJobRequest = z.infer<typeof UpdateJobRequestSchema>;

/**
 * The 409 body, shaped like the board's (`StageConflictSchema`) on purpose —
 * one conflict idiom, not two.
 *
 * `current` is what makes the conflict actionable: "somebody else changed this"
 * with no indication of WHAT changed forces the user to discard their edit
 * blind. With the current resource in hand the client can show the difference
 * and offer reload-or-overwrite.
 */
export const JobConflictSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.literal(409),
  detail: z.string(),
  current: JobSchema,
});
export type JobConflict = z.infer<typeof JobConflictSchema>;
