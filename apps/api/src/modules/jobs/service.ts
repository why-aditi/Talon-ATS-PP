/**
 * Orchestration; the only place transactions begin. Permission scopes are
 * checked here, never in components and never in a route handler.
 */
import type { Job } from '@talon/contracts';
import { hasScope } from '@talon/domain';
import { notFound } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import type { JobRecord, JobsRepository } from './repository.js';

function toJob(record: JobRecord, canReadComp: boolean): Job {
  const base = {
    id: record.id,
    reqCode: record.reqCode,
    title: record.title,
    department: record.department,
    location: record.location,
    status: record.status,
    recruiter: record.recruiter,
    stageDistribution: record.stageDistribution,
    inProcessCount: record.inProcessCount,
    activeCount: record.activeCount,
  };
  // Spec 001 §6.4 acceptance 4: no `band` key at all — not null, not an empty
  // object. A caller without comp:read and a job with no band set are
  // indistinguishable on the wire, deliberately: §7.3 renders both the same way,
  // so a discriminator would be a distinction no consumer acts on.
  if (!canReadComp) return base;
  if (record.bandMinCents === null || record.bandMaxCents === null) return base;
  return {
    ...base,
    band: {
      minCents: record.bandMinCents,
      maxCents: record.bandMaxCents,
      currency: record.currency,
    },
  };
}

export class JobsService {
  readonly #repository: JobsRepository;

  constructor({ jobsRepository }: { jobsRepository: JobsRepository }) {
    this.#repository = jobsRepository;
  }

  async getJob(tx: TenantTransaction, user: AuthenticatedUser, id: string): Promise<Job> {
    const record = await this.#repository.findById(tx, id);
    // 404, never 403: a 403 confirms the id exists, which is the leak (§6.4).
    // Another tenant's job and an id that was never issued answer identically.
    if (!record) throw notFound('No job with that id exists in this tenant.');
    return toJob(record, hasScope(user.role, 'comp:read'));
  }
}
