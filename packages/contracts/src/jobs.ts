/**
 * Contract: GET /v1/jobs
 *
 * Zod schemas for the jobs list endpoint query params, response type,
 * and cursor envelope. Spec 001 §7.2.
 *
 * Money is serialized as string-encoded cents because BigInt is not
 * JSON-serializable. The API layer strips comp fields for callers
 * without the `comp:read` scope — structurally optional here so the
 * TypeScript type reflects what a scopeless caller actually receives.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums — single source of truth for both contract and DB layer
// ---------------------------------------------------------------------------

export const JobStatusSchema = z.enum([
  'draft',
  'active',
  'on_hold',
  'closing',
  'closed',
]);
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
// Query params: GET /v1/jobs?status=&department=&recruiter_id=&cursor=&limit=
// ---------------------------------------------------------------------------

export const ListJobsQuerySchema = z.object({
  status: JobStatusSchema.optional(),
  department: z.string().min(1).optional(),
  recruiter_id: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

// ---------------------------------------------------------------------------
// Comp band — optional; absent when the caller lacks comp:read scope
// ---------------------------------------------------------------------------

export const CompBandSchema = z.object({
  /** String-encoded bigint cents — never a JS number for money. */
  band_min_cents: z.string(),
  /** String-encoded bigint cents. */
  band_max_cents: z.string(),
  /** ISO 4217 currency code, always present alongside cents. */
  currency: z.string().length(3),
});
export type CompBand = z.infer<typeof CompBandSchema>;

// ---------------------------------------------------------------------------
// Stage distribution — counts per canonical stage for the distribution bar
// ---------------------------------------------------------------------------

/** Record<CanonicalStage, number> — every key present, zero if empty. */
export const StageDistributionSchema = z.record(CanonicalStageSchema, z.number().int().min(0));
export type StageDistribution = z.infer<typeof StageDistributionSchema>;

// ---------------------------------------------------------------------------
// Recruiter summary (denormalized onto the job for display)
// ---------------------------------------------------------------------------

export const RecruiterSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  avatar_color: z.string().nullable(),
});
export type RecruiterSummary = z.infer<typeof RecruiterSummarySchema>;

// ---------------------------------------------------------------------------
// Job response type
// ---------------------------------------------------------------------------

export const JobSchema = z.object({
  id: z.string().uuid(),
  req_code: z.string(),
  title: z.string(),
  department: z.string(),
  location: z.string(),
  employment_type: z.string().nullable(),
  status: JobStatusSchema,

  /** Non-terminal application count (active pipeline). */
  in_process_count: z.number().int().min(0),
  /** Total active (non-withdrawn, non-rejected) application count. */
  active_count: z.number().int().min(0),

  /** Counts per canonical stage — drives the distribution bar. */
  stage_distribution: StageDistributionSchema,

  recruiter: RecruiterSummarySchema.nullable(),
  hiring_manager_id: z.string().uuid().nullable(),

  /** Present only for callers with comp:read scope. */
  comp_band: CompBandSchema.optional(),

  openings: z.number().int().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Job = z.infer<typeof JobSchema>;

// ---------------------------------------------------------------------------
// Cursor envelope — spec 001 §7.2, CLAUDE.md §9 (cursor, never OFFSET)
// ---------------------------------------------------------------------------

export const ListJobsResponseSchema = z.object({
  data: z.array(JobSchema),
  next_cursor: z.string().nullable(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;
