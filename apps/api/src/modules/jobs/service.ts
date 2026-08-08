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
  UpdateJobRequest,
} from '@talon/contracts';
import { ERROR_TYPES } from '@talon/contracts';
import { hasScope } from '@talon/domain';
import { HttpProblem, badRequest, forbidden, notFound } from '../../errors.js';
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
  return stages.map((stage, index) => ({
    name: stage.name,
    // 1-based, matching the seed (`position: i + 1`). Overrides stay keyed on the
    // 0-based template index, so the client contract is unchanged and the two
    // conventions meet in exactly this one line rather than across the codebase.
    position: index + 1,
    canonical: stage.canonical,
    // Keyed on the 0-based template index, which is what the client sent.
    slaDays: byPosition.has(index) ? (byPosition.get(index) ?? null) : stage.slaDays,
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
    // Not comp-gated: everyone who can read the job needs it to edit safely.
    version: record.version,
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

  /**
   * Edit a job. Spec 005 §4.3.
   *
   * The patch is merged over the CURRENT record here, not in SQL, so
   * absent-means-untouched lives in exactly one place. `'key' in input` is the
   * test — not `!== undefined` — because `{ currency: null }` and `{}` must
   * behave differently and `undefined` cannot tell them apart.
   */
  async updateJob(
    tx: TenantTransaction,
    user: AuthenticatedUser,
    id: string,
    input: UpdateJobRequest,
  ): Promise<Job> {
    const canReadComp = hasScope(user.role, 'comp:read');

    // Checked before anything is read, and it covers null too. A caller who may
    // not SEE a band may not clear one either — read-gating a field while
    // leaving it writable is not access control (#2).
    if (('bandMinCents' in input || 'bandMaxCents' in input || 'currency' in input) && !canReadComp) {
      throw forbidden('You do not have permission to change a compensation band.');
    }

    const current = await this.#repository.findById(tx, id);
    // 404, never 403 — another tenant's job and an id never issued answer the
    // same way (§6.4).
    if (!current) throw notFound('No job with that id exists in this tenant.');

    const pick = <K extends keyof UpdateJobRequest>(key: K, fallback: NonNullable<unknown> | null) =>
      key in input ? (input[key] as unknown) : fallback;

    const bandMinCents = pick('bandMinCents', current.bandMinCents) as string | null;
    const bandMaxCents = pick('bandMaxCents', current.bandMaxCents) as string | null;
    const currency = pick('currency', current.currency) as string | null;

    /*
      Checked on the MERGED result, not on the patch.

      The contract can only see what was sent, so `{ bandMinCents: null }` alone
      passes it — and the row then keeps a maximum with no minimum, which is half
      a band and not a thing. Only here is the outcome known, so only here can it
      be refused.
    */
    if ((bandMinCents === null) !== (bandMaxCents === null)) {
      throw badRequest('A band needs both a minimum and a maximum, or neither.');
    }
    if (bandMinCents !== null && BigInt(bandMaxCents ?? '0') < BigInt(bandMinCents)) {
      throw badRequest('Band maximum must be at least the minimum.');
    }

    // The currency goes with them. A currency left on a job with no amounts is a
    // row that lies about itself, and the column is NOT NULL so there is nowhere
    // to put "none" but the empty string.
    const clearing = bandMinCents === null;
    if (!clearing && currency === null) {
      throw badRequest('A currency is required when a band is set.');
    }

    const updated = await this.#repository.updateJob(tx, id, input.version, {
      title: (pick('title', current.title) as string).trim(),
      department: (pick('department', current.department) as string).trim(),
      location: (pick('location', current.location) as string).trim(),
      employmentType: pick('employmentType', null) as string | null,
      bandMinCents,
      bandMaxCents,
      currency: clearing ? '' : (currency ?? ''),
      status: pick('status', current.status) as string,
      recruiterId: pick('recruiterId', current.recruiter?.id ?? null) as string | null,
      hiringManagerId: pick('hiringManagerId', null) as string | null,
      openings: pick('openings', 1) as number,
    });

    // Zero rows updated: the row exists (we just read it) but its version moved,
    // so somebody else wrote in between. Re-read so the client is told WHAT it
    // is conflicting with rather than only that it lost.
    if (!updated) {
      const now = await this.#repository.findById(tx, id);
      if (!now) throw notFound('No job with that id exists in this tenant.');
      throw new HttpProblem(
        409,
        ERROR_TYPES.JOB_VERSION_CONFLICT,
        `${now.title} has changed`,
        'Someone else edited this job while you were working on it.',
        // An RFC 9457 extension member, not a header — the client reads it from
        // the body to show what it is conflicting with.
        { current: toJob(now, canReadComp) },
      );
    }

    const after = await this.#repository.findById(tx, id);
    if (!after) throw new Error('updated job could not be read back');
    return toJob(after, canReadComp);
  }
}
