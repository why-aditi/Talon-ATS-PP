/**
 * Orchestration; the only place transactions begin. Permission scopes are
 * checked here, never in components and never in a route handler.
 */
import type {
  CanonicalStage,
  CreateJobRequest,
  Job,
  ListJobsQuery,
  ListJobsResponse,
  ListStageTemplatesResponse,
} from '@talon/contracts';
import { hasScope } from '@talon/domain';
import { badRequest, forbidden, notFound } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import type { JobCursor, JobRecord, JobsRepository } from './repository.js';

/**
 * Department → req-code prefix.
 *
 * A table with a rule behind it, not a rule alone: the seed uses `PPL` for
 * People, which "first three letters" would render `PEO`. Spec 005 §15 OQ3 asks
 * whether this should be a stored column on a first-class departments table —
 * it should, eventually. Until then the exceptions live in one visible place
 * rather than as a surprise inside a string function.
 */
const REQ_PREFIXES: Record<string, string> = { people: 'PPL' };

export function reqPrefix(department: string): string {
  const key = department.trim().toLowerCase();
  const known = REQ_PREFIXES[key];
  if (known) return known;
  const letters = department.replace(/[^a-zA-Z]/g, '').toUpperCase();
  // Padded rather than left short: a two-letter department would otherwise
  // produce `HR-101` and `HR2-101` style collisions across similar names.
  return (letters.slice(0, 3) || 'JOB').padEnd(3, 'X');
}

/**
 * The template's stages with the caller's SLA overrides applied, keyed by
 * position.
 *
 * An override wins even when it is null. "No SLA" is a choice a recruiter can
 * make, and falling back to the template default on null — which `??` would do —
 * would silently refuse it.
 */
export function applyOverrides(
  stages: readonly { name: string; canonical: CanonicalStage; slaDays: number | null; isTerminal: boolean }[],
  overrides: readonly { position: number; slaDays: number | null }[],
): { name: string; position: number; canonical: CanonicalStage; slaDays: number | null; isTerminal: boolean }[] {
  const byPosition = new Map(overrides.map((o) => [o.position, o.slaDays]));
  return stages.map((stage, position) => ({
    name: stage.name,
    position,
    canonical: stage.canonical,
    slaDays: byPosition.has(position) ? (byPosition.get(position) ?? null) : stage.slaDays,
    isTerminal: stage.isTerminal,
  }));
}

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

  /* ── spec 005 ──────────────────────────────────────────────────────────── */

  async listStageTemplates(tx: TenantTransaction): Promise<ListStageTemplatesResponse> {
    return { data: await this.#repository.findStageTemplates(tx) };
  }

  /**
   * Creates a job and its stages.
   *
   * The band is scope-gated on the way IN as well as on the way out (§4.2).
   * Hiding a field in a response while leaving it writable is not access
   * control — a caller without `comp:read` sending a band is refused rather
   * than silently obeyed.
   */
  async createJob(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    input: CreateJobRequest,
  ): Promise<Job> {
    const sendsComp =
      input.bandMinCents !== undefined ||
      input.bandMaxCents !== undefined ||
      input.currency !== undefined;
    if (sendsComp && !hasScope(user.role, 'comp:read')) {
      throw forbidden('You do not have permission to set a compensation band.');
    }

    // Verified before the insert so a bad id is a 404 about the template rather
    // than a foreign-key violation surfacing as a 500. 404 and not 403: another
    // tenant's template id must be indistinguishable from one never issued.
    const templates = await this.#repository.findStageTemplates(tx);
    const template = templates.find((t) => t.id === input.stageTemplateId);
    if (!template) throw notFound('No stage template with that id exists in this tenant.');
    // A job with no stages renders an empty board and cannot accept an
    // application, so it is refused at creation rather than discovered later.
    if (template.stages.length === 0) {
      throw badRequest('That pipeline has no stages, so a job cannot be created from it.');
    }

    const prefix = reqPrefix(input.department);

    /*
      `nextReqNumber` serialises allocation with an advisory lock, so under
      normal operation this loop runs once. It stays as the backstop for the one
      case the lock cannot cover: a req code written by something that did not
      take the lock — a migration, a bulk import, a psql session.

      The insert answers null rather than raising, because a unique violation
      aborts the transaction and would make the retry fail on its next
      statement. Bounded at three: a fourth collision is not contention, it is a
      bug, and looping forever would turn one into an outage.
    */
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = await this.#repository.nextReqNumber(tx, prefix);
      const id = await this.#repository.insertJob(tx, {
          reqCode: `${prefix}-${next}`,
          title: input.title,
          department: input.department,
          location: input.location,
          employmentType: input.employmentType ?? null,
          bandMinCents: input.bandMinCents ?? null,
          bandMaxCents: input.bandMaxCents ?? null,
          // Never defaulted (§4.9). The contract refuses a band without one, so
          // reaching here with cents and no currency is impossible; the empty
          // string is for the bandless case, where the column is still NOT NULL.
          currency: input.currency ?? '',
          status: input.status,
          recruiterId: input.recruiterId,
          hiringManagerId: input.hiringManagerId,
          openings: input.openings,
          stageTemplateId: input.stageTemplateId,
        stages: applyOverrides(template.stages, input.stageOverrides),
      });
      if (id === null) continue; // Req code taken; take the next number.

      const record = await this.#repository.findById(tx, id);
      if (!record) throw new Error('created job could not be read back');
      return toJob(record, hasScope(user.role, 'comp:read'));
    }
    // Three losses in a row against the same prefix is not contention worth
    // waiting out. 500, loudly, rather than a fourth attempt.
    throw new Error(`could not allocate a req code for ${prefix} after 3 attempts`);
  }
}
