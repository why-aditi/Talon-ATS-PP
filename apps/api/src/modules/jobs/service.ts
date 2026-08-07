/**
 * Orchestration; the only place transactions begin. Permission scopes are
 * checked here, never in components and never in a route handler.
 */
import type { Job, ListJobsQuery, ListJobsResponse } from '@talon/contracts';
import { hasScope } from '@talon/domain';
import { badRequest, notFound } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import type { JobCursor, JobRecord, JobsRepository } from './repository.js';

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

/**
 * The cursor is opaque to clients and stays that way: base64url of the two sort
 * key values, nothing else. No tenant, no filter state — the query is
 * tenant-scoped regardless, and re-encoding the filters would let a client
 * change them by editing a cursor.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (c: JobCursor): string =>
  Buffer.from(`${c.deptKey}:${c.id}`).toString('base64url');

function decodeCursor(raw: string): JobCursor {
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split(':');
  const [deptKey, id] = parts;
  // Shape-checked before it reaches a uuid cast: an unparseable cursor is a bad
  // request, not a 500 from the database.
  if (parts.length !== 2 || !deptKey || !id || !UUID.test(deptKey) || !UUID.test(id)) {
    throw badRequest('The cursor is not one this endpoint issued.');
  }
  return { deptKey, id };
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

  async listJobs(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    query: ListJobsQuery,
  ): Promise<ListJobsResponse> {
    const page = await this.#repository.findPage(tx, {
      status: query.status,
      department: query.department,
      recruiterId: query.recruiter_id,
      after: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit: query.limit,
    });
    // The same strip as getJob, through the same function: one path per action,
    // so a list can never expose a band the single read hides.
    const canReadComp = hasScope(user.role, 'comp:read');
    return {
      data: page.records.map((record) => toJob(record, canReadComp)),
      nextCursor: page.next === null ? null : encodeCursor(page.next),
    };
  }
}
