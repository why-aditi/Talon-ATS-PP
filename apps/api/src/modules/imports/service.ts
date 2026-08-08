/**
 * CSV import — spec 008 §6.
 *
 * The single most important thing in this file is what it does NOT do: it never writes
 * a candidate, an application or a stage transition itself. Every committed row goes
 * through `ApplicationsService.createApplication`, the same method the intake modal
 * calls (non-negotiable #5).
 *
 * That is also how §6.3 — "the thing that will be got wrong" — is answered. An imported
 * application must carry its first `stage_transitions` row or it is invisible to every
 * funnel and median on the reports screen, silently, for its whole life. Reusing intake
 * means the transition is written by the code that already had to get it right, rather
 * than by a second implementation that has to remember to.
 */
import type {
  AsyncJob,
  CreateApplicationBody,
  DryRunReport,
  DuplicateMatch,
  ImportAnalysis,
  ImportMapping,
  RowIssue,
  Source,
} from '@talon/contracts';
import { UnsupportedEncodingError, decodeCsv, normaliseHeader, sniffDelimiter, writeCsv } from '@talon/domain';
import { parse } from 'csv-parse/sync';
import { ERROR_TYPES } from '@talon/contracts';
import { HttpProblem, badRequest, notFound } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import { DOWNLOAD_TTL_SECONDS, type FileStore, errorCsvKey, uploadKey } from './file-store.js';
import { naturalKey, readRow, resolveColumns, rowHash, validateRow } from './mapper.js';
import type { ImportsRepository } from './repository.js';

/** Above this, commit is handed to the worker rather than run in the request (§5.4). */
export const SYNC_ROW_LIMIT = 50;

const SAMPLE_ROWS = 100;

/** The intake capability imports need, without coupling two module internals. */
interface ApplicationWriter {
  createApplication(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    body: CreateApplicationBody,
  ): Promise<{ application: { id: string; candidateId: string } }>;
}

/** Header names we can map without asking. Advisory — the user still confirms (§6.1). */
const SUGGESTIONS: Record<string, string> = {
  name: 'name',
  'full name': 'name',
  'candidate name': 'name',
  email: 'email',
  'email address': 'email',
  phone: 'phone',
  'phone number': 'phone',
  location: 'location',
  city: 'location',
  title: 'current_title',
  'current title': 'current_title',
  company: 'current_company',
  'current company': 'current_company',
  source: 'source',
  job: 'job_ref',
  'job ref': 'job_ref',
  req: 'job_ref',
};

export class ImportsService {
  readonly #repository: ImportsRepository;
  readonly #files: FileStore;
  readonly #applications: ApplicationWriter;

  constructor({
    importsRepository,
    fileStore,
    applicationsService,
  }: {
    importsRepository: ImportsRepository;
    fileStore: FileStore;
    applicationsService: ApplicationWriter;
  }) {
    this.#repository = importsRepository;
    this.#files = fileStore;
    this.#applications = applicationsService;
  }

  async create(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    body: { filename: string; byteSize: number },
  ): Promise<{ importId: string; uploadUrl: string; expiresIn: number }> {
    const importId = await this.#repository.create(tx, user.id, {
      filename: body.filename,
      byteSize: body.byteSize,
    });
    // The key is derived from ids we control, never from the client's filename — a
    // supplied key is a path-traversal and an overwrite primitive at once.
    const { url, expiresIn } = await this.#files.presignUpload(
      uploadKey(tx.tenantId, importId),
      body.byteSize,
    );
    return { importId, uploadUrl: url, expiresIn };
  }

  /**
   * Confirms the import is this tenant's BEFORE any storage access.
   *
   * Not merely tidy. The object key is built from `tx.tenantId`, so a hostile caller
   * naming somebody else's import id would read a key under their OWN prefix, miss,
   * and get "file no longer available" — a 404 for the wrong reason, after a pointless
   * round trip to S3. Answering from the row is both correct and cheaper, and it makes
   * the isolation gate assert tenancy rather than a storage miss.
   */
  async #requireJob(tx: TenantTransaction, importId: string): Promise<void> {
    if (!(await this.#repository.find(tx, importId))) {
      throw notFound('No import with that id exists in this tenant.');
    }
  }

  /** Reads the uploaded file once and reports what it looks like. */
  async analyze(tx: TenantTransaction, importId: string): Promise<ImportAnalysis> {
    await this.#requireJob(tx, importId);
    const { rows, headers, encoding, delimiter } = await this.#read(tx, importId);

    const suggested: Record<string, string> = {};
    for (const header of headers) {
      const field = SUGGESTIONS[normaliseHeader(header)];
      if (field) suggested[header] = field;
    }

    return {
      delimiter,
      encoding,
      headers,
      sampleRows: rows.slice(0, SAMPLE_ROWS),
      rowCount: rows.length,
      suggested,
    };
  }

  /**
   * Validates every row and reports, without writing anything.
   *
   * Not skippable and not a flag on commit (§6.1). The error CSV it produces is the
   * original rows plus an `_error` column, so the fix-and-reupload loop works on the
   * same file shape the user already has.
   */
  async dryRun(tx: TenantTransaction, importId: string, mapping: ImportMapping): Promise<DryRunReport> {
    await this.#requireJob(tx, importId);
    const { rows, headers } = await this.#read(tx, importId);
    const columns = resolveColumns(headers, mapping);

    const issues: RowIssue[] = [];
    const duplicates: DuplicateMatch[] = [];
    const failedRows: string[][] = [];
    let valid = 0;

    for (const [rowIndex, values] of rows.entries()) {
      const fields = readRow(values, columns);
      const rowIssues = validateRow(fields, rowIndex);

      if (rowIssues.length > 0) {
        issues.push(...rowIssues);
        failedRows.push([...values, rowIssues.map((i) => i.message).join('; ')]);
        continue;
      }
      valid++;

      const match = await this.#findDuplicate(tx, fields);
      if (match) duplicates.push({ ...match, rowIndex });
    }

    let errorCsvUrl: string | null = null;
    if (failedRows.length > 0) {
      // Every cell escaped, echoed originals included — §6.2a. The rows in this
      // document came from the uploaded file, so they are attacker-controlled.
      const csv = writeCsv([...headers, '_error'], failedRows);
      const key = errorCsvKey(tx.tenantId, importId);
      await this.#files.write(key, csv, 'text/csv');
      ({ url: errorCsvUrl } = await this.#files.presignDownload(key, 'import-errors.csv'));
    }

    await this.#repository.patch(tx, importId, { total: rows.length });

    return {
      total: rows.length,
      valid,
      invalid: rows.length - valid,
      issues,
      duplicates,
      errorCsvUrl,
    };
  }

  /**
   * Commits the file.
   *
   * Small files run inline; larger ones are left `pending` for the worker to pick up
   * (§5.4). The row loop is identical either way — the worker calls this same method —
   * so a 49-row import and a 51-row import cannot behave differently.
   */
  async commit(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    importId: string,
    mapping: ImportMapping,
  ): Promise<{ processed: number; failed: number; deferred: boolean }> {
    const job = await this.#repository.find(tx, importId);
    if (!job) throw notFound('No import with that id exists in this tenant.');

    // `total` is first persisted by dry-run. Apart from being a cheap state marker,
    // this makes the preview a real workflow gate instead of optional UI ceremony.
    if (job.total === null) {
      throw new HttpProblem(
        409,
        ERROR_TYPES.IMPORT_DRY_RUN_REQUIRED,
        'Dry run required',
        'Run and review the dry run before committing this import.',
      );
    }

    const { rows, headers } = await this.#read(tx, importId);

    if (rows.length > SYNC_ROW_LIMIT) {
      await this.#repository.patch(tx, importId, { status: 'pending', total: rows.length });
      return { processed: 0, failed: 0, deferred: true };
    }

    const columns = resolveColumns(headers, mapping);
    // Resume, rather than restart. A commit that died at row 4,000 must not re-create
    // the first 3,999 people (§6.2).
    const done = await this.#repository.committedIndices(tx, importId);

    for (const [rowIndex, values] of rows.entries()) {
      if (done.has(rowIndex)) continue;

      const fields = readRow(values, columns);
      const hash = rowHash(importId, rowIndex, naturalKey(fields));
      const issues = validateRow(fields, rowIndex);

      if (issues.length > 0) {
        await this.#repository.recordRow(tx, importId, {
          rowIndex,
          rowHash: hash,
          status: 'failed',
          error: issues.map((i) => i.message).join('; '),
        });
        continue;
      }

      try {
        await this.#commitRow(tx, user, importId, mapping, fields, rowIndex, hash);
      } catch (error) {
        // One bad row does not abort the file. `partial` is a first-class outcome (§4),
        // and the recruiter needs the other 499.
        await this.#repository.recordRow(tx, importId, {
          rowIndex,
          rowHash: hash,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Derive final counters from durable row receipts, not this attempt's local
    // counters. A retry which finds every index already done must preserve progress,
    // and a crash after recordRow but before this patch must repair it.
    const totals = await this.#repository.rowCounts(tx, importId);
    await this.#repository.patch(tx, importId, {
      status: totals.failed === 0 ? 'succeeded' : totals.processed === 0 ? 'failed' : 'partial',
      processed: totals.processed,
      failed: totals.failed,
    });

    return { ...totals, deferred: false };
  }

  async #commitRow(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    importId: string,
    mapping: ImportMapping,
    fields: ReturnType<typeof readRow>,
    rowIndex: number,
    hash: string,
  ): Promise<'committed' | 'skipped'> {
    const existing = await this.#findDuplicate(tx, fields);

    if (existing && mapping.duplicateStrategy === 'skip') {
      await this.#repository.recordRow(tx, importId, {
        rowIndex,
        rowHash: hash,
        status: 'skipped',
        candidateId: existing.existingCandidateId,
      });
      return 'skipped';
    }

    const jobId = await this.#resolveJob(tx, fields.job_ref, mapping.defaultJobId);
    if (!jobId) throw badRequest('No job for this row, and no default job was chosen.');

    // The one write path (#5). Everything this row becomes — candidate, application,
    // FIRST stage transition, audit row, outbox event — happens in here.
    const body: CreateApplicationBody = {
      jobId,
      source: (fields.source as Source | undefined) ?? 'import',
      ...(existing && mapping.duplicateStrategy === 'update'
        ? { candidateId: existing.existingCandidateId }
        : {
            candidate: {
              name: fields.name ?? '',
              // Required by the contract and genuinely empty here: a CSV has no column
              // shape for links, and inventing one would be a mapping the user never
              // confirmed.
              links: {},
              ...(fields.email ? { email: fields.email } : {}),
              ...(fields.phone ? { phone: fields.phone } : {}),
              ...(fields.location ? { location: fields.location } : {}),
              ...(fields.current_title ? { currentTitle: fields.current_title } : {}),
              ...(fields.current_company ? { currentCompany: fields.current_company } : {}),
            },
          }),
    };

    const created = await this.#applications.createApplication(tx, user, body);

    await this.#repository.recordRow(tx, importId, {
      rowIndex,
      rowHash: hash,
      status: 'committed',
      candidateId: created.application.candidateId,
      applicationId: created.application.id,
    });
    return 'committed';
  }

  async #resolveJob(
    tx: TenantTransaction,
    ref: string | undefined,
    fallback: string | null,
  ): Promise<string | null> {
    if (!ref) return fallback;
    const job = await this.#repository.findJobByRef(tx, ref);
    // A named-but-unknown req is an error for that row, not a silent fall back to the
    // default — the user said which job they meant.
    if (!job) throw badRequest(`No job with reference ${ref}.`);
    return job.id;
  }

  async #findDuplicate(
    tx: TenantTransaction,
    fields: ReturnType<typeof readRow>,
  ): Promise<Omit<DuplicateMatch, 'rowIndex'> | null> {
    if (fields.email) {
      const exact = await this.#repository.findByEmail(tx, fields.email);
      if (exact) {
        return { existingCandidateId: exact.id, existingName: exact.name, matchedOn: 'email', score: 1 };
      }
    }
    if (!fields.name) return null;
    const similar = await this.#repository.findSimilar(tx, fields.name, fields.current_company ?? '');
    return similar
      ? {
          existingCandidateId: similar.id,
          existingName: similar.name,
          matchedOn: 'fuzzy',
          score: similar.score,
        }
      : null;
  }

  /** Fetch, decode, sniff, parse — the four steps every phase starts from. */
  async #read(
    tx: TenantTransaction,
    importId: string,
  ): Promise<{
    rows: string[][];
    headers: string[];
    encoding: ImportAnalysis['encoding'];
    delimiter: ImportAnalysis['delimiter'];
  }> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#files.read(uploadKey(tx.tenantId, importId));
    } catch {
      /*
        §8 case 11 — the object is gone between steps, or was never PUT.

        Deliberately NOT a 404. The import exists and the caller may see it; what is
        missing is its file, and collapsing the two makes "you may not have this" and
        "this is not ready" indistinguishable to the client and to the isolation gate.
        409 says the resource is in a state that does not allow the step, which is
        exactly true and is resumable by re-uploading.
      */
      throw new HttpProblem(
        409,
        ERROR_TYPES.IMPORT_FILE_MISSING,
        'Uploaded file not available',
        'The uploaded file is not available. Upload it again to continue.',
      );
    }

    let decoded;
    try {
      decoded = decodeCsv(bytes);
    } catch (error) {
      if (error instanceof UnsupportedEncodingError) throw badRequest(error.message);
      throw error;
    }

    const delimiter = sniffDelimiter(decoded.text);

    let records: string[][];
    try {
      // `relax_column_count` because a ragged row is a row-level problem, not a reason
      // to reject the file — the validator reports it per row and the rest still import.
      records = parse(decoded.text, { delimiter, relax_column_count: true, bom: false }) as string[][];
    } catch (error) {
      // Structural failure rejects the whole file before anything is written (§6.2).
      throw badRequest(
        `This file could not be parsed as CSV: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const [headers, ...rows] = records;
    if (!headers) throw badRequest('This file is empty.');

    return { rows, headers, encoding: decoded.encoding, delimiter };
  }

  /** The async job as the contract shapes it — the shared progress surface (§4). */
  async status(tx: TenantTransaction, importId: string): Promise<AsyncJob> {
    const job = await this.#repository.find(tx, importId);
    if (!job) throw notFound('No import with that id exists in this tenant.');
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      total: job.total,
      processed: job.processed,
      failed: job.failed,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    };
  }

  /** Re-presigns the error report, which expires faster than a user reads a page. */
  async errorCsvUrl(tx: TenantTransaction, importId: string): Promise<{ url: string; expiresIn: number }> {
    const failed = await this.#repository.failedRows(tx, importId);
    if (failed.length === 0) throw notFound('This import produced no errors.');
    return this.#files.presignDownload(errorCsvKey(tx.tenantId, importId), 'import-errors.csv');
  }
}

export { DOWNLOAD_TTL_SECONDS };
