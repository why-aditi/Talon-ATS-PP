/**
 * Contract: CSV import — spec 008 §6.
 *
 * Five steps, each its own request, because each can fail differently and the user has
 * to be able to stop between them. In particular the dry run is a separate call and not
 * a flag on commit: "an import that fails halfway through 500 rows with no preview is
 * worse than no import feature" (§6.1), and a boolean is far too easy to default wrong.
 */
import { z } from 'zod';

/** The async job both imports and bulk actions report progress through (§4). */
export const AsyncJobStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'partial']);
export type AsyncJobStatus = z.infer<typeof AsyncJobStatusSchema>;

export const AsyncJobSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['import', 'bulk_action']),
  status: AsyncJobStatusSchema,
  /**
   * Null until the worker has counted the work — distinct from 0, which means counted
   * and empty. An empty CSV is a valid file, and a progress bar cannot tell the two
   * apart from a single number.
   */
  total: z.number().int().min(0).nullable(),
  processed: z.number().int().min(0),
  failed: z.number().int().min(0),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
});
export type AsyncJob = z.infer<typeof AsyncJobSchema>;

// ---------------------------------------------------------------------------
// Step 1 — create + presign
// ---------------------------------------------------------------------------

export const CreateImportRequestSchema = z
  .object({
    filename: z.string().min(1).max(255),
    /**
     * Declared up front so the presign can carry a content-length condition. A presigned
     * PUT with no size bound is an open door to filling a bucket, and the limit has to be
     * enforced by S3 rather than by us — we never see the upload.
     */
    byteSize: z.number().int().min(1).max(50_000_000),
  })
  .strict();
export type CreateImportRequest = z.infer<typeof CreateImportRequestSchema>;

export const CreateImportResponseSchema = z.object({
  importId: z.string().uuid(),
  uploadUrl: z.string().url(),
  /** Seconds. The client shows a "link expired, start again" state rather than a stall. */
  expiresIn: z.number().int().positive(),
});
export type CreateImportResponse = z.infer<typeof CreateImportResponseSchema>;

// ---------------------------------------------------------------------------
// Step 2 — analyze
// ---------------------------------------------------------------------------

export const DelimiterSchema = z.enum([',', ';', '\t', '|']);
export const EncodingSchema = z.enum(['utf-8', 'utf-8-bom', 'latin-1']);

export const ImportAnalysisSchema = z.object({
  delimiter: DelimiterSchema,
  encoding: EncodingSchema,
  headers: z.array(z.string()),
  /** First 100 rows, for the mapping preview. Not the whole file: §6.1 samples. */
  sampleRows: z.array(z.array(z.string())).max(100),
  /** Data rows, header excluded. */
  rowCount: z.number().int().min(0),
  /**
   * A best-effort mapping the UI pre-selects, from header names. Advisory only — the
   * user confirms it, because guessing wrong silently is worse than not guessing.
   */
  suggested: z.record(z.string(), z.string()),
});
export type ImportAnalysis = z.infer<typeof ImportAnalysisSchema>;

// ---------------------------------------------------------------------------
// Step 3/4 — mapping, dry run
// ---------------------------------------------------------------------------

/**
 * The fields an import can populate. Deliberately small: everything here is either a
 * candidate column or the one join an application needs. Interviews, scorecards and
 * offers are out of scope (§2), and adding them later is additive.
 */
export const ImportFieldSchema = z.enum([
  'name',
  'email',
  'phone',
  'location',
  'current_title',
  'current_company',
  'source',
  'job_ref',
]);
export type ImportField = z.infer<typeof ImportFieldSchema>;

/** Duplicate handling, chosen at import time (§6.2). */
export const DuplicateStrategySchema = z.enum(['skip', 'update', 'create']);
export type DuplicateStrategy = z.infer<typeof DuplicateStrategySchema>;

export const ImportMappingSchema = z
  .object({
    /** CSV header → field. Unmapped columns are ignored, not errors (§8 case 5). */
    columns: z.record(z.string(), ImportFieldSchema),
    duplicateStrategy: DuplicateStrategySchema,
    /**
     * Used when a row has no `job_ref` column or leaves it blank. Spec 008 OQ-5 asked
     * per-row versus whole-file; this is both — a per-row column when mapped, this as
     * the fallback. Null means candidate-only import for rows without one.
     */
    defaultJobId: z.string().uuid().nullable(),
  })
  .strict()
  // `name` is the only truly required field: a candidate row with no name is not a
  // person, and every dedupe path degrades to it when email is absent.
  .refine((m) => Object.values(m.columns).includes('name'), {
    message: 'A column must be mapped to `name`',
    path: ['columns'],
  });
export type ImportMapping = z.infer<typeof ImportMappingSchema>;

export const RowIssueSchema = z.object({
  /** 0-based, header excluded — the same index `import_rows.row_index` stores. */
  rowIndex: z.number().int().min(0),
  message: z.string(),
});
export type RowIssue = z.infer<typeof RowIssueSchema>;

/**
 * A duplicate is surfaced, never merged silently (§6.2). `existingCandidateId` is what
 * the UI needs to offer "look at this person" before the user commits to a strategy.
 */
export const DuplicateMatchSchema = z.object({
  rowIndex: z.number().int().min(0),
  existingCandidateId: z.string().uuid(),
  existingName: z.string(),
  /** `email` is exact; `fuzzy` cleared the 0.8 trigram threshold and needs confirming. */
  matchedOn: z.enum(['email', 'fuzzy']),
  /** 0–1, only meaningful for `fuzzy`. */
  score: z.number().min(0).max(1),
});
export type DuplicateMatch = z.infer<typeof DuplicateMatchSchema>;

export const DryRunReportSchema = z.object({
  total: z.number().int().min(0),
  valid: z.number().int().min(0),
  invalid: z.number().int().min(0),
  issues: z.array(RowIssueSchema),
  duplicates: z.array(DuplicateMatchSchema),
  /**
   * Present when there IS an error CSV to fetch. Null rather than an empty string so a
   * clean dry run cannot render a download button that 404s.
   */
  errorCsvUrl: z.string().url().nullable(),
});
export type DryRunReport = z.infer<typeof DryRunReportSchema>;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export const ImportParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type ImportParams = z.infer<typeof ImportParamsSchema>;

export const CommitImportResponseSchema = z.object({ job: AsyncJobSchema });
export type CommitImportResponse = z.infer<typeof CommitImportResponseSchema>;
