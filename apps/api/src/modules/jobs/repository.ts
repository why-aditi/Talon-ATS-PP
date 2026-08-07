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
  recruiter_id: string | null;
  recruiter_name: string | null;
}

interface DistributionRow {
  canonical: string;
  total: number;
  in_process: number;
  active: number;
}

const emptyDistribution = (): Record<CanonicalStage, number> =>
  Object.fromEntries(CanonicalStageSchema.options.map((stage) => [stage, 0])) as Record<
    CanonicalStage,
    number
  >;

export class JobsRepository {
  async findById(tx: TenantTransaction, id: string): Promise<JobRecord | null> {
    const [job] = await tx.sql<JobRow[]>`
      select j.id, j.req_code, j.title, j.department, j.location, j.status,
             j.band_min_cents, j.band_max_cents, j.currency,
             u.id as recruiter_id, u.name as recruiter_name
      from jobs j
      left join users u on u.id = j.recruiter_id
      where j.id = ${id}::uuid and j.tenant_id = ${tx.tenantId}::uuid`;
    if (!job) return null;

    // One grouped aggregate, not a count per stage. `is_terminal` is per-job data
    // (spec 001 §7.2) — a hardcoded terminal-stage list would be wrong the moment
    // a job's template differs.
    const distribution = await tx.sql<DistributionRow[]>`
      select s.canonical,
             count(*)::int as total,
             count(*) filter (where not s.is_terminal)::int as in_process,
             count(*) filter (where a.status in ('active', 'hired'))::int as active
      from applications a
      join job_stages s on s.id = a.current_stage_id
      where a.job_id = ${id}::uuid
      group by s.canonical`;

    const stageDistribution = emptyDistribution();
    let inProcessCount = 0;
    let activeCount = 0;
    for (const row of distribution) {
      const stage = CanonicalStageSchema.safeParse(row.canonical);
      // job_stages.canonical is check-constrained to the same set; if it ever
      // isn't, a bar that silently omits a column is worse than a 500.
      if (!stage.success) throw new Error(`job_stages.canonical holds ${row.canonical}`);
      stageDistribution[stage.data] += row.total;
      inProcessCount += row.in_process;
      activeCount += row.active;
    }

    return {
      id: job.id,
      reqCode: job.req_code,
      title: job.title,
      department: job.department,
      location: job.location,
      status: job.status,
      bandMinCents: job.band_min_cents,
      bandMaxCents: job.band_max_cents,
      currency: job.currency,
      recruiter:
        job.recruiter_id && job.recruiter_name
          ? { id: job.recruiter_id, name: job.recruiter_name }
          : null,
      stageDistribution,
      inProcessCount,
      activeCount,
    };
  }
}
