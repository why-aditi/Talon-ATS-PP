import { z } from 'zod';

/**
 * PROVISIONAL — a local mirror of `GET /v1/jobs` as specified in spec 001 §7.2.
 *
 * ponytail: `packages/contracts` is still a placeholder while the API stream builds
 * step 4, and the UI stream may not edit it. This file exists so the fixtures are
 * validated against *something* rather than trusted. When the real schema lands,
 * delete this file and re-point `jobs-query.ts` and `mocks/fixtures.ts` at
 * `@talon/contracts`; the fixture test is what proves the swap is clean.
 */

export const JOB_STATUSES = ['draft', 'active', 'on_hold', 'closing', 'closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Canonical stages, in pipeline order. Terminal stages sit at the end. */
export const CANONICAL_STAGES = ['applied', 'screen', 'onsite', 'offer', 'hired', 'rejected', 'withdrawn'] as const;
export type CanonicalStage = (typeof CANONICAL_STAGES)[number];

const count = z.number().int().nonnegative();

export const stageDistributionSchema = z.object({
  applied: count,
  screen: count,
  onsite: count,
  offer: count,
  hired: count,
  rejected: count,
  withdrawn: count,
});

export const jobSchema = z.object({
  id: z.uuid(),
  reqCode: z.string().min(1),
  title: z.string().min(1),
  department: z.string().min(1),
  location: z.string().min(1),
  status: z.enum(JOB_STATUSES),
  recruiter: z.object({ id: z.uuid(), name: z.string().min(1) }),
  /** Counts per canonical stage — one grouped aggregate server-side, never N+1. */
  stageDistribution: stageDistributionSchema,
  /** Applications currently in a non-terminal stage. */
  inProcessCount: count,
  /** Total applications ever received — the reference screen's "N active" cell. */
  activeCount: count,
  currency: z.string().length(3),
  // Money is bigint cents (CLAUDE.md #9), so it crosses JSON as a string, never a
  // float. Both fields are absent — not null — without the `comp:read` scope.
  bandMinCents: z.string().regex(/^\d+$/).optional(),
  bandMaxCents: z.string().regex(/^\d+$/).optional(),
});

export const jobListResponseSchema = z.object({
  data: z.array(jobSchema),
  nextCursor: z.string().nullable(),
});

export type Job = z.infer<typeof jobSchema>;
export type JobListResponse = z.infer<typeof jobListResponseSchema>;
export type StageDistribution = z.infer<typeof stageDistributionSchema>;
