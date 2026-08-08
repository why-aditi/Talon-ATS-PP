/**
 * GET /v1/jobs — spec 001 §7.2.
 *
 * The counts table below is the deliverable: it is the jobs list as the seeded
 * tenant derives it, not as 02-jobs-list@2x.png draws it. ENG-204 reads 8/9 and
 * the screenshot reads 18/38 — a deliberate, recorded divergence (§5.4, open
 * question 5: "the board is the truth"). A change that makes ENG-204 read 18/38
 * has invented rows, not fixed a bug.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { ERROR_TYPES, ListJobsResponseSchema, type Job } from '@talon/contracts';
import { bearer, dedicatedUser, loadFixtures, removeDedicatedUser, startApp, type Fixtures, type Person, type TestApp } from './helpers.js';
import { OWNER_URL } from './urls.js';

let test: TestApp;
let fixtures: Fixtures;
let recruiter: Record<string, string>;
let member: Record<string, string>;
/**
 * This file's OWN user. See `dedicatedUser` — signing in re-provisions, which
 * rewrites `users.external_id`, so a shared row leaves every other suite naming a
 * subject that no longer resolves.
 */
let ownedRecruiter: Person;
let ownedMember: Person;

/**
 * Throwaway jobs for the two edge cases that need a job the seed does not have.
 * Fixed ids beginning ffffffff so they sort after every seeded UUIDv7 job, and
 * so a run that died mid-test can be cleaned up exactly rather than guessed at.
 */
const TEMP_JOBS = [
  { id: 'ffffffff-0000-4000-8000-000000000001', code: 'TMP-001' },
  { id: 'ffffffff-0000-4000-8000-000000000002', code: 'TMP-002' },
] as const;

const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
const removeTempJobs = () =>
  owner`delete from jobs where id in ${owner(TEMP_JOBS.map((job) => job.id))}`;

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  // This file's own pair. The seeded Maya and Lin stay untouched — assertions about
  // a JOB's recruiter still name them, because that is seeded data rather than who
  // is holding the token.
  const r = await dedicatedUser(test, 'jobslistrecruiter', {
    tenantId: fixtures.talon.tenantId,
    role: 'recruiter',
  });
  const m = await dedicatedUser(test, 'jobslistmember', {
    tenantId: fixtures.talon.tenantId,
    role: 'member',
  });
  ownedRecruiter = r.person;
  ownedMember = m.person;
  recruiter = bearer(r.session);
  member = bearer(m.session);
  // Before the counts table is asserted, not after: a leftover job from a
  // crashed run would otherwise show up as a seventh row.
  await removeTempJobs();
});

afterAll(async () => {
  await removeTempJobs();
  await owner.end();
  await removeDedicatedUser(ownedRecruiter);
  await removeDedicatedUser(ownedMember);
  await test.close();
});

const list = (headers: Record<string, string>, query = '') =>
  test.app.inject({ method: 'GET', url: `/v1/jobs${query}`, headers });

const jobs = async (headers: Record<string, string>, query = ''): Promise<Job[]> => {
  const res = await list(headers, query);
  expect(res.statusCode, res.body).toBe(200);
  return ListJobsResponseSchema.parse(res.json()).data;
};

/** reqCode → [inProcessCount, activeCount]. The whole point of the endpoint. */
const EXPECTED_COUNTS: Record<string, [number, number]> = {
  'ENG-204': [8, 9],
  'ENG-209': [8, 21],
  'ENG-198': [3, 12],
  'DES-114': [20, 54],
  'PPL-031': [19, 67],
  'SAL-076': [6, 9],
};

/** The order 02-jobs-list@2x.png draws, top to bottom. */
const SCREEN_ORDER = ['ENG-204', 'ENG-209', 'ENG-198', 'DES-114', 'PPL-031', 'SAL-076'];

it('every job reports in-process and active exactly', async () => {
  const data = await jobs(recruiter, '?limit=100');
  const actual = Object.fromEntries(
    data.map((job) => [job.reqCode, [job.inProcessCount, job.activeCount]]),
  );
  // toEqual, not toMatchObject: a seventh job or a missing one fails here too.
  expect(actual).toEqual(EXPECTED_COUNTS);
});

it('rows come back grouped by department in the order the reference screen shows', async () => {
  const data = await jobs(recruiter, '?limit=100');
  expect(data.map((job) => job.reqCode)).toEqual(SCREEN_ORDER);
  // Departments contiguous and in first-opened order — what the group headers
  // on 02-jobs-list render from.
  expect(data.map((job) => job.department)).toEqual([
    'Engineering',
    'Engineering',
    'Engineering',
    'Design',
    'People',
    'Sales',
  ]);
});

it('a full page costs one query, not one per job', async () => {
  const statements: string[] = [];
  const counted = await startApp({ onQuery: (q) => statements.push(q) });
  try {
    // A second app instance, so a second dedicated user: `signIn` re-provisions, and
    // pointing this at the user the outer app holds a session for would invalidate it
    // mid-file.
    const probe = await dedicatedUser(counted, 'jobslistprobe', {
      tenantId: fixtures.talon.tenantId,
      role: 'recruiter',
    });
    const headers = bearer(probe.session);
    statements.length = 0;
    const res = await counted.app.inject({ method: 'GET', url: '/v1/jobs?limit=100', headers });
    expect(res.statusCode).toBe(200);
    expect(ListJobsResponseSchema.parse(res.json()).data).toHaveLength(6);

    const touching = (table: RegExp) => statements.filter((q) => table.test(q));
    // Six jobs, one statement reading jobs and one reading applications — the
    // same statement. A per-job distribution count would make these 6 and 6.
    expect(touching(/\bfrom jobs\b/i), statements.join('\n---\n')).toHaveLength(1);
    expect(touching(/\bfrom applications\b/i), statements.join('\n---\n')).toHaveLength(1);
  } finally {
    await counted.close();
  }
});

it('a member gets no band key at all, on any row', async () => {
  const res = await list(member, '?limit=100');
  expect(res.statusCode).toBe(200);
  // Raw JSON, not the parsed object: a schema that strips would hide the leak.
  expect(res.body).not.toMatch(/cents/i);
  expect(res.body).not.toMatch(/"band"/);
  for (const job of res.json<{ data: Record<string, unknown>[] }>().data) {
    expect('band' in job, `${String(job['reqCode'])} leaked a band key`).toBe(false);
  }
});

it('a comp:read holder gets the band on the job that has one', async () => {
  const data = await jobs(recruiter, '?limit=100');
  const byCode = new Map(data.map((job) => [job.reqCode, job]));
  expect(byCode.get('ENG-204')?.band).toEqual({
    minCents: '19000000',
    maxCents: '22500000',
    currency: 'USD',
  });
  // Absent because the seed sets no band, not because of scope — §6.4 renders
  // the two identically on purpose.
  expect(byCode.get('ENG-209')).not.toHaveProperty('band');
});

describe('filters', () => {
  it('status returns only that status', async () => {
    const data = await jobs(recruiter, '?status=on_hold');
    expect(data.map((job) => job.reqCode)).toEqual(['ENG-198']);
  });

  it('department returns only that department', async () => {
    const data = await jobs(recruiter, '?department=Design');
    expect(data.map((job) => job.reqCode)).toEqual(['DES-114']);
  });

  it('recruiter_id returns only that recruiter’s jobs', async () => {
    const data = await jobs(recruiter, `?recruiter_id=${fixtures.talon.recruiter.id}`);
    expect(data.map((job) => job.reqCode)).toEqual(['ENG-204', 'ENG-198', 'PPL-031']);
    expect(new Set(data.map((job) => job.recruiter?.name))).toEqual(new Set(['Maya Reyes']));
  });

  it('a filter that matches nothing is an empty page, not a 404', async () => {
    const res = await list(recruiter, '?department=Astrophysics');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], nextCursor: null });
  });

  it('an unknown query parameter is 400, not silently ignored', async () => {
    const res = await list(recruiter, '?statuss=active');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.VALIDATION_FAILED);
  });

  it.each(['?limit=0', '?limit=101', '?limit=1e2', '?limit=+5', '?status=archived'])(
    '%s is 400',
    async (query) => {
      expect((await list(recruiter, query)).statusCode).toBe(400);
    },
  );
});

describe('cursor pagination', () => {
  it('pages through every job exactly once, in the unpaginated order', async () => {
    const expected = (await jobs(recruiter, '?limit=100')).map((job) => job.reqCode);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res = await list(recruiter, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = ListJobsResponseSchema.parse(res.json());
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((job) => job.reqCode));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a cursor that this endpoint did not issue is 400', async () => {
    for (const bad of ['not-base64!!', Buffer.from('a:b').toString('base64url')]) {
      const res = await list(recruiter, `?cursor=${encodeURIComponent(bad)}`);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.VALIDATION_FAILED);
    }
  });
});

/** Two jobs in their own department, with no applications and no job_stages. */
describe('jobs with no applications', () => {
  beforeAll(async () => {
    const [template] = await owner<{ id: string }[]>`
      select id from stage_templates where tenant_id = ${fixtures.talon.tenantId}::uuid limit 1`;
    if (!template) throw new Error('seed is missing a stage template');
    for (const temp of TEMP_JOBS) {
      await owner`
        insert into jobs (id, tenant_id, req_code, title, department, location, currency, status, stage_template_id)
        values (${temp.id}::uuid, ${fixtures.talon.tenantId}::uuid, ${temp.code}, 'Throwaway',
                'Temp', 'Nowhere', 'USD', 'draft', ${template.id}::uuid)`;
    }
  });

  it('reports every canonical stage at zero — §9 edge case 4', async () => {
    const [job] = await jobs(recruiter, '?department=Temp&limit=1');
    expect(job?.reqCode).toBe('TMP-001');
    expect(job?.stageDistribution).toEqual({
      applied: 0,
      screen: 0,
      onsite: 0,
      offer: 0,
      hired: 0,
      rejected: 0,
      withdrawn: 0,
    });
    expect(job?.inProcessCount).toBe(0);
    expect(job?.activeCount).toBe(0);
    // An unassigned job still serializes rather than failing the page.
    expect(job?.recruiter).toBeNull();
  });

  it('a cursor whose row was deleted resumes at the next row — §9 edge case 6', async () => {
    const page = ListJobsResponseSchema.parse((await list(recruiter, '?department=Temp&limit=1')).json());
    expect(page.data.map((job) => job.reqCode)).toEqual(['TMP-001']);
    expect(page.nextCursor).not.toBeNull();

    await owner`delete from jobs where id = ${TEMP_JOBS[0].id}::uuid`;

    const res = await list(
      recruiter,
      `?department=Temp&limit=1&cursor=${encodeURIComponent(page.nextCursor as string)}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(ListJobsResponseSchema.parse(res.json()).data.map((job) => job.reqCode)).toEqual([
      'TMP-002',
    ]);
  });
});
