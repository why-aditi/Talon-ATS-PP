/**
 * The ONLY file in this module allowed to touch the database.
 *
 * Every query runs on `tx.sql` — the request's reserved connection, inside its
 * transaction, with `app.tenant_id` set. The RLS policy is what makes another
 * tenant's row unreachable; the explicit `tenant_id` predicate below is the
 * application check on top of it. Removing either one still returns nothing,
 * which is what "belt and braces" means and what
 * `test/rls-independence.test.ts` proves for the database side alone.
 */
import { CanonicalStageSchema, type CanonicalStage, type JobStatus } from '@talon/contracts';
import { newId } from '@talon/db';
import type { TenantTransaction } from '../../request-context.js';

export interface JobRecord {
  id: string;
  reqCode: string;
  title: string;
  department: string;
  location: string;
  status: JobStatus;
  /** Digit strings: int8 columns never round-trip through a JS number (§4.9). */
  bandMinCents: string | null;
  bandMaxCents: string | null;
  currency: string;
  recruiter: { id: string; name: string } | null;
  stageDistribution: Record<CanonicalStage, number>;
  inProcessCount: number;
  activeCount: number;
}

/**
 * The sort key, whole. Pagination is keyset on `(dept_key, id)` and the cursor
 * carries both VALUES rather than a row reference — which is what makes §9 edge
 * case 6 fall out for free: a cursor whose row has since been deleted still
 * compares, so the next page resumes at the following row instead of 500ing on
 * a missing anchor.
 */
export interface JobCursor {
  readonly deptKey: string;
  readonly id: string;
}

export interface JobPage {
  readonly records: JobRecord[];
  /** The last returned row's key, or null when this is the final page. */
  readonly next: JobCursor | null;
}

export interface FindJobsArgs {
  readonly status?: JobStatus | undefined;
  readonly department?: string | undefined;
  readonly recruiterId?: string | undefined;
  readonly after?: JobCursor | undefined;
  readonly limit: number;
}

interface JobRow {
  id: string;
  req_code: string;
  title: string;
  department: string;
  location: string;
  status: JobStatus;
  band_min_cents: string | null;
  band_max_cents: string | null;
  currency: string;
  dept_key: string;
  recruiter_id: string | null;
  recruiter_name: string | null;
  /** Sparse: only the stages this job actually has applications in. */
  distribution: Record<string, number>;
  in_process_count: number;
  active_count: number;
}

const emptyDistribution = (): Record<CanonicalStage, number> =>
  Object.fromEntries(CanonicalStageSchema.options.map((stage) => [stage, 0])) as Record<
    CanonicalStage,
    number
  >;

function toRecord(row: JobRow): JobRecord {
  // Starts at every stage zeroed, so a job with no applications answers with a
  // full distribution rather than an empty object (§9 edge case 4).
  const stageDistribution = emptyDistribution();
  for (const [canonical, count] of Object.entries(row.distribution)) {
    const stage = CanonicalStageSchema.safeParse(canonical);
    // job_stages.canonical is check-constrained to the same set; if it ever
    // isn't, a bar that silently omits a column is worse than a 500.
    if (!stage.success) throw new Error(`job_stages.canonical holds ${canonical}`);
    stageDistribution[stage.data] = count;
  }
  return {
    id: row.id,
    reqCode: row.req_code,
    title: row.title,
    department: row.department,
    location: row.location,
    status: row.status,
    bandMinCents: row.band_min_cents,
    bandMaxCents: row.band_max_cents,
    currency: row.currency,
    recruiter:
      row.recruiter_id && row.recruiter_name
        ? { id: row.recruiter_id, name: row.recruiter_name }
        : null,
    stageDistribution,
    inProcessCount: row.in_process_count,
    activeCount: row.active_count,
  };
}

export interface StageTemplateRecord {
  id: string;
  name: string;
  stages: { name: string; canonical: CanonicalStage; slaDays: number | null; isTerminal: boolean }[];
}

export interface InsertJobArgs {
  readonly reqCode: string;
  readonly title: string;
  readonly department: string;
  readonly location: string;
  readonly employmentType: string | null;
  readonly bandMinCents: string | null;
  readonly bandMaxCents: string | null;
  readonly currency: string;
  readonly status: string;
  readonly recruiterId: string | null;
  readonly hiringManagerId: string | null;
  readonly openings: number;
  readonly stageTemplateId: string;
  /** Already resolved against the template and the caller's overrides. */
  readonly stages: {
    name: string;
    position: number;
    canonical: CanonicalStage;
    slaDays: number | null;
    isTerminal: boolean;
  }[];
}

export class JobsRepository {
  async findById(tx: TenantTransaction, id: string): Promise<JobRecord | null> {
    const [row] = await this.#select(tx, { id, limit: 1 });
    return row ? toRecord(row) : null;
  }

  async findPage(tx: TenantTransaction, args: FindJobsArgs): Promise<JobPage> {
    // limit + 1: the extra row answers "is there another page" without a second
    // query, and a count(*) over the whole filtered set would be exactly that.
    const rows = await this.#select(tx, { ...args, limit: args.limit + 1 });
    const page = rows.slice(0, args.limit);
    const last = page.at(-1);
    return {
      records: page.map(toRecord),
      next: rows.length > args.limit && last ? { deptKey: last.dept_key, id: last.id } : null,
    };
  }

  /**
   * One statement, one round trip — for the single-job read and the list alike,
   * so the two can never disagree about what `activeCount` means (CLAUDE.md §4,
   * one path per action).
   *
   * `stageDistribution` and both counts come from ONE grouped aggregate joined
   * to the page (spec 001 §7.2), never a count per job. `test/jobs-list.test.ts`
   * counts the statements a request sends and fails if that becomes N+1.
   *
   * Terminality is read from `job_stages.is_terminal` — per-job data copied from
   * the template at creation (§9 edge case 5), so a hardcoded stage list would be
   * wrong for the first job whose template differs.
   *
   * The optional filters are written as `$n is null or col = $n` rather than
   * composed fragments: the window function below has to see every matching row
   * anyway, so there is no index plan to lose, and the query stays one readable
   * literal instead of a string built at runtime.
   */
  #select(
    tx: TenantTransaction,
    f: {
      id?: string;
      status?: string | undefined;
      department?: string | undefined;
      recruiterId?: string | undefined;
      after?: JobCursor | undefined;
      limit: number;
    },
  ): Promise<JobRow[]> {
    return tx.sql<JobRow[]>`
      with matching as (
        -- dept_key groups the page by department and orders the groups the way
        -- 02-jobs-list does: departments in the order their first job was opened,
        -- jobs within a department in creation order. Ids are UUIDv7 (§5.2), so
        -- ascending id IS creation order. first_value, not min: PostgreSQL has no
        -- min(uuid) aggregate.
        select j.*, first_value(j.id) over (partition by j.department order by j.id) as dept_key
        from jobs j
        where j.tenant_id = ${tx.tenantId}::uuid
          and (${f.id ?? null}::uuid is null or j.id = ${f.id ?? null}::uuid)
          and (${f.status ?? null}::text is null or j.status = ${f.status ?? null}::text)
          and (${f.department ?? null}::text is null or j.department = ${f.department ?? null}::text)
          and (${f.recruiterId ?? null}::uuid is null or j.recruiter_id = ${f.recruiterId ?? null}::uuid)
      ),
      page as (
        -- Keyset, never OFFSET (CLAUDE.md §9). (dept_key, id) is a TOTAL order:
        -- ids are unique, so no two rows tie and no row can be skipped or
        -- repeated across pages.
        select * from matching m
        where ${f.after?.deptKey ?? null}::uuid is null
           or (m.dept_key, m.id) > (${f.after?.deptKey ?? null}::uuid, ${f.after?.id ?? null}::uuid)
        order by m.dept_key, m.id
        limit ${f.limit}
      ),
      per_stage as (
        select a.job_id, s.canonical,
               count(*)::int as n,
               count(*) filter (where not s.is_terminal)::int as in_process
        from applications a
        join job_stages s on s.id = a.current_stage_id
        where a.job_id in (select id from page)
        group by a.job_id, s.canonical
      ),
      rollup as (
        select job_id,
               jsonb_object_agg(canonical, n) as distribution,
               -- active_count is EVERY application on the job, terminal ones
               -- included: the "N active" cell on 02-jobs-list. in_process_count
               -- is the non-terminal subset.
               sum(n)::int as active_count,
               sum(in_process)::int as in_process_count
        from per_stage
        group by job_id
      )
      select p.id, p.req_code, p.title, p.department, p.location, p.status,
             p.band_min_cents, p.band_max_cents, p.currency, p.dept_key,
             u.id as recruiter_id, u.name as recruiter_name,
             -- left join + coalesce, never an inner join: a job with no
             -- applications must still appear, at zero (§9 edge case 4).
             coalesce(r.distribution, '{}'::jsonb) as distribution,
             coalesce(r.active_count, 0) as active_count,
             coalesce(r.in_process_count, 0) as in_process_count
      from page p
      left join users u on u.id = p.recruiter_id
      left join rollup r on r.job_id = p.id
      order by p.dept_key, p.id`;
  }

  /* ── spec 005 §4.2 ─────────────────────────────────────────────────────── */

  async findStageTemplates(tx: TenantTransaction): Promise<StageTemplateRecord[]> {
    const rows = await tx.sql<{ id: string; name: string; stages: unknown }[]>`
      select id, name, stages
      from stage_templates
      where tenant_id = ${tx.tenantId}::uuid
      order by name`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      // The column is jsonb written by the seed, so it is shaped but not typed.
      // Normalised here rather than trusted: a template missing sla_days would
      // otherwise reach the contract as `undefined` and fail validation on the
      // way out, which reads as an api bug rather than as bad data.
      stages: (Array.isArray(row.stages) ? row.stages : []).map((raw) => {
        const s = raw as Record<string, unknown>;
        return {
          name: String(s['name'] ?? ''),
          canonical: CanonicalStageSchema.parse(s['canonical']),
          slaDays: s['sla_days'] === null || s['sla_days'] === undefined ? null : Number(s['sla_days']),
          isTerminal: Boolean(s['is_terminal']),
        };
      }),
    }));
  }

  /**
   * The next req code for a department prefix.
   *
   * The advisory lock is load-bearing, not caution. `max()` sees COMMITTED rows
   * only, so without it every concurrent create in the same department reads the
   * same number — and retrying does not help, because the retry re-reads the
   * same invisible state. A five-way race produced four losers and a 500 before
   * this existed.
   *
   * `pg_advisory_xact_lock` is held to the end of the caller's transaction and
   * released by commit or rollback, so nothing has to unlock it on the error
   * path. It is keyed on the tenant AND the prefix: two departments allocate in
   * parallel, and two tenants never contend at all.
   */
  async nextReqNumber(tx: TenantTransaction, prefix: string): Promise<number> {
    await tx.sql`select pg_advisory_xact_lock(hashtext(${tx.tenantId + ':' + prefix}))`;
    const [row] = await tx.sql<{ next: number }[]>`
      select coalesce(max(substring(req_code from '[0-9]+$')::int), 100) + 1 as next
      from jobs
      where tenant_id = ${tx.tenantId}::uuid
        and req_code like ${prefix + '-%'}`;
    return row?.next ?? 101;
  }

  /**
   * Creates the job AND its stages. One statement each, one transaction, and
   * the caller's — a job with no `job_stages` is a job whose board cannot
   * render and which cannot accept an application, so the two are never
   * separately committed (spec 005 §4.2).
   */
  async insertJob(tx: TenantTransaction, args: InsertJobArgs): Promise<string | null> {
    // Generated here, not by the database: `id` has no default and is UUIDv7 on
    // purpose — the jobs page orders departments by `first_value(id)`, so a
    // random uuid would reorder the list (see newId in @talon/db).
    const jobId = newId();

    const [job] = await tx.sql<{ id: string }[]>`
      insert into jobs (
        id, tenant_id, req_code, title, department, location, employment_type,
        band_min_cents, band_max_cents, currency, status,
        recruiter_id, hiring_manager_id, openings, stage_template_id
      ) values (
        ${jobId}::uuid, ${tx.tenantId}::uuid, ${args.reqCode}, ${args.title}, ${args.department},
        ${args.location}, ${args.employmentType},
        ${args.bandMinCents}::bigint, ${args.bandMaxCents}::bigint, ${args.currency}, ${args.status},
        ${args.recruiterId}::uuid, ${args.hiringManagerId}::uuid, ${args.openings},
        ${args.stageTemplateId}::uuid
      )
      -- Null on a taken req_code, rather than an error.
      --
      -- A unique violation ABORTS the transaction in PostgreSQL, so a caller
      -- that caught 23505 and retried inside the same tx would fail on the next
      -- statement with "current transaction is aborted". ON CONFLICT DO NOTHING
      -- leaves the transaction healthy and lets the service pick the next
      -- number, which is the whole point of it being retryable.
      on conflict (tenant_id, req_code) do nothing
      returning id`;
    if (!job) return null;

    // One statement, one transaction, the caller's. A job with no job_stages
    // renders an empty board and cannot accept an application, so the two are
    // never separately committed (spec 005 §4.2).
    const rows = args.stages.map((stage) => ({
      id: newId(),
      tenant_id: tx.tenantId,
      job_id: jobId,
      name: stage.name,
      position: stage.position,
      canonical: stage.canonical,
      sla_days: stage.slaDays,
      is_terminal: stage.isTerminal,
    }));
    await tx.sql`insert into job_stages ${tx.sql(rows)}`;

    return job.id;
  }
}
