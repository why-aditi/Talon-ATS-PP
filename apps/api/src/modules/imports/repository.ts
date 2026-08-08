/**
 * The ONLY file in this module allowed to touch the database.
 *
 * Every query runs on the request's reserved connection inside its transaction, with
 * `app.tenant_id` set. RLS makes another tenant's row unreachable; the explicit
 * `tenant_id` predicates are the application check on top, matching the jobs and
 * applications repositories.
 */
import type { AsyncJobStatus, DuplicateMatch } from '@talon/contracts';
import { newId } from '@talon/db';
import type { TenantTransaction } from '../../request-context.js';

export interface AsyncJobRow {
  id: string;
  kind: 'import' | 'bulk_action';
  status: AsyncJobStatus;
  total: number | null;
  processed: number;
  failed: number;
  params: Record<string, unknown>;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Fuzzy matches at or above this similarity are surfaced for confirmation (§6.2). */
export const FUZZY_THRESHOLD = 0.8;

export class ImportsRepository {
  async create(
    tx: TenantTransaction,
    createdBy: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const id = newId();
    await tx.sql`
      insert into jobs_async (id, tenant_id, kind, status, params, created_by)
      values (${id}, ${tx.tenantId}, 'import', 'pending', ${tx.sql.json(params as never)}, ${createdBy})`;
    return id;
  }

  async find(tx: TenantTransaction, id: string): Promise<AsyncJobRow | null> {
    const [row] = await tx.sql<AsyncJobRow[]>`
      select id, kind, status, total, processed, failed, params,
             created_at as "createdAt", finished_at as "finishedAt"
      from jobs_async
      where tenant_id = ${tx.tenantId} and id = ${id} and kind = 'import'`;
    return row ?? null;
  }

  async patch(
    tx: TenantTransaction,
    id: string,
    patch: { status?: AsyncJobStatus; total?: number; processed?: number; failed?: number; result?: unknown },
  ): Promise<void> {
    // Written as one statement with coalesce rather than a built string: a dynamic
    // SET list is where injection and "updated zero rows" bugs live, and there are
    // only five columns.
    await tx.sql`
      update jobs_async set
        status = coalesce(${patch.status ?? null}, status),
        total = coalesce(${patch.total ?? null}, total),
        processed = coalesce(${patch.processed ?? null}, processed),
        failed = coalesce(${patch.failed ?? null}, failed),
        result = coalesce(${patch.result === undefined ? null : tx.sql.json(patch.result as never)}, result),
        finished_at = case when ${patch.status ?? null} in ('succeeded','failed','partial')
                           then now() else finished_at end
      where tenant_id = ${tx.tenantId} and id = ${id}`;
  }

  /**
   * Exact email first (§6.2). `candidates.email` is citext, so this is already
   * case-insensitive at the column rather than by lowering in the predicate — which
   * would also throw away the index.
   */
  async findByEmail(tx: TenantTransaction, email: string): Promise<{ id: string; name: string } | null> {
    const [row] = await tx.sql<{ id: string; name: string }[]>`
      select id, name from candidates
      where tenant_id = ${tx.tenantId} and email = ${email} and anonymized_at is null
      limit 1`;
    return row ?? null;
  }

  /**
   * The fuzzy second pass. Surfaced for confirmation, never merged silently.
   *
   * `similarity(...) >= threshold` rather than the `%` operator so the threshold is
   * explicit in the query instead of depending on `pg_trgm.similarity_threshold`,
   * which is a session GUC somebody else can change.
   */
  async findSimilar(
    tx: TenantTransaction,
    name: string,
    company: string,
  ): Promise<{ id: string; name: string; score: number } | null> {
    const needle = `${name} ${company}`.trim();
    const [row] = await tx.sql<{ id: string; name: string; score: number }[]>`
      select id, name,
             similarity(name || ' ' || coalesce(current_company, ''), ${needle}) as score
      from candidates
      where tenant_id = ${tx.tenantId}
        and anonymized_at is null
        and similarity(name || ' ' || coalesce(current_company, ''), ${needle}) >= ${FUZZY_THRESHOLD}
      order by score desc
      limit 1`;
    return row ?? null;
  }

  /** Row indices already committed, so a resumed run skips them (§6.2). */
  async committedIndices(tx: TenantTransaction, jobId: string): Promise<Set<number>> {
    const rows = await tx.sql<{ row_index: number }[]>`
      select row_index from import_rows
      where tenant_id = ${tx.tenantId} and job_id = ${jobId}`;
    return new Set(rows.map((r) => r.row_index));
  }

  /** Rebuilds durable progress after a retry or a process crash. */
  async rowCounts(
    tx: TenantTransaction,
    jobId: string,
  ): Promise<{ processed: number; failed: number }> {
    const [row] = await tx.sql<{ processed: number; failed: number }[]>`
      select
        count(*) filter (where status = 'committed')::int as processed,
        count(*) filter (where status = 'failed')::int as failed
      from import_rows
      where tenant_id = ${tx.tenantId} and job_id = ${jobId}`;
    return row ?? { processed: 0, failed: 0 };
  }

  async recordRow(
    tx: TenantTransaction,
    jobId: string,
    row: {
      rowIndex: number;
      rowHash: string;
      status: 'committed' | 'skipped' | 'failed';
      candidateId?: string | null;
      applicationId?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    // `on conflict do nothing` on the primary key: a concurrent retry of the same row
    // is a no-op rather than a 23505 that aborts the surrounding batch. The index is
    // what enforces once-only; this just makes the second attempt quiet (§8 case 12).
    await tx.sql`
      insert into import_rows (tenant_id, job_id, row_index, row_hash, status, candidate_id, application_id, error)
      values (${tx.tenantId}, ${jobId}, ${row.rowIndex}, ${row.rowHash}, ${row.status},
              ${row.candidateId ?? null}, ${row.applicationId ?? null}, ${row.error ?? null})
      on conflict do nothing`;
  }

  async failedRows(
    tx: TenantTransaction,
    jobId: string,
  ): Promise<{ row_index: number; error: string | null }[]> {
    return tx.sql<{ row_index: number; error: string | null }[]>`
      select row_index, error from import_rows
      where tenant_id = ${tx.tenantId} and job_id = ${jobId} and status = 'failed'
      order by row_index`;
  }

  /** Resolves a job by its req code, for a per-row `job_ref` column (spec 008 OQ-5). */
  async findJobByRef(tx: TenantTransaction, reqCode: string): Promise<{ id: string } | null> {
    const [row] = await tx.sql<{ id: string }[]>`
      select id from jobs where tenant_id = ${tx.tenantId} and req_code = ${reqCode} limit 1`;
    return row ?? null;
  }
}

export type { DuplicateMatch };
