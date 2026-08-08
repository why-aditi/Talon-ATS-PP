/**
 * POST /v1/applications — spec 005 §4.5.
 *
 * The rules worth asserting are the ones that are invisible until they break:
 *
 *  - the first `stage_transitions` row exists, with `from_stage_id` null. Every
 *    pipeline metric derives from that table (#4), so an application created
 *    without it is invisible to time-in-stage and conversion for its whole life.
 *  - comp expectation is scope-gated on the way in, not only on the way out.
 *  - a stage from another job is refused, and a partial write leaves nothing.
 *
 * Everything created here is removed in afterAll: `board.test.ts` counts the
 * cards on ENG-204 exactly, and a leftover row makes which file fails depend on
 * vitest's run order.
 */
import { CreateApplicationResponseSchema, ERROR_TYPES } from '@talon/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  bearer,
  deleteApplications,
  loadFixtures,
  signIn,
  startApp,
  type Fixtures,
  type TestApp,
} from './helpers.js';
import { OWNER_URL } from './urls.js';

let test: TestApp;
let fixtures: Fixtures;
let recruiter: Record<string, string>;
let member: Record<string, string>;

const created: string[] = [];

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  recruiter = bearer(await signIn(test, fixtures.talon.recruiter));
  member = bearer(await signIn(test, fixtures.talon.member));
});

afterAll(async () => {
  await deleteApplications(created);
  await test.close();
});

let n = 0;
const body = (over: Record<string, unknown> = {}) => ({
  jobId: fixtures.talon.jobId,
  candidate: { name: `Intake Probe ${(n += 1)}` },
  source: 'outbound',
  ...over,
});

async function post(headers: Record<string, string>, payload: Record<string, unknown>) {
  const res = await test.app.inject({ method: 'POST', url: '/v1/applications', headers, payload });
  if (res.statusCode === 201) created.push((res.json() as { application: { id: string } }).application.id);
  return res;
}

/** Reads rows the API deliberately does not expose. */
async function owned<T extends Record<string, unknown>>(
  query: (sql: postgres.Sql) => Promise<T[]>,
): Promise<T[]> {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    return await query(sql);
  } finally {
    await sql.end();
  }
}

it('creates the candidate, the application, and lands it on the first stage', async () => {
  const res = await post(recruiter, body());

  expect(res.statusCode, res.body).toBe(201);
  const { application, stageId } = CreateApplicationResponseSchema.parse(res.json());
  expect(application.name).toMatch(/^Intake Probe/);
  expect(application.status).toBe('active');
  // Brand new, so nothing has elapsed yet.
  expect(application.daysInStage).toBe(0);
  expect(res.headers['location']).toBe(`/v1/applications/${application.id}`);

  const [stage] = await owned((sql) => sql<{ position: number }[]>`
    select position from job_stages where id = ${stageId}`);
  // Omitted stageId means the job's first stage. Positions are 1-based — the
  // seed writes `i + 1`, and job creation now matches it.
  expect(stage?.position).toBe(1);
});

it('writes exactly one first transition, from nowhere', async () => {
  const { application } = CreateApplicationResponseSchema.parse((await post(recruiter, body())).json());

  const rows = await owned((sql) => sql<{ from_stage_id: string | null; actor_id: string }[]>`
    select from_stage_id, actor_id from stage_transitions where application_id = ${application.id}`);

  // One row, and `from_stage_id` null. Without this the application is invisible
  // to every metric that derives from stage_transitions (#4).
  expect(rows).toHaveLength(1);
  expect(rows[0]?.from_stage_id).toBeNull();
  expect(rows[0]?.actor_id).toBe(fixtures.talon.recruiter.id);
});

it('audits the creation', async () => {
  const { application } = CreateApplicationResponseSchema.parse((await post(recruiter, body())).json());

  const rows = await owned((sql) => sql<{ action: string }[]>`
    select action from audit_log where entity_type = 'application' and entity_id = ${application.id}`);
  // #13: every mutation writes one.
  expect(rows.map((r) => r.action)).toEqual(['application.created']);
});

it('puts the new card at the TOP of its column', async () => {
  const before = await test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${fixtures.talon.jobId}/board`,
    headers: recruiter,
  });
  const firstBefore = (before.json() as { columns: { cards: { id: string }[] }[] }).columns[0]?.cards[0]?.id;

  const { application } = CreateApplicationResponseSchema.parse((await post(recruiter, body())).json());

  const after = await test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${fixtures.talon.jobId}/board`,
    headers: recruiter,
  });
  const cards = (after.json() as { columns: { cards: { id: string }[] }[] }).columns[0]!.cards;
  // A candidate somebody just added and cannot see without scrolling reads as an
  // add that failed.
  expect(cards[0]?.id).toBe(application.id);
  expect(cards[1]?.id).toBe(firstBefore);
});

it('attaches an existing candidate to a DIFFERENT job', async () => {
  const first = CreateApplicationResponseSchema.parse((await post(recruiter, body())).json());
  const [otherJob] = await owned((sql) => sql<{ id: string }[]>`
    select id from jobs where req_code = 'ENG-209'`);

  const second = await post(recruiter, {
    jobId: otherJob!.id,
    candidateId: first.application.candidateId,
    source: 'referral',
  });

  expect(second.statusCode, second.body).toBe(201);
  const parsed = CreateApplicationResponseSchema.parse(second.json());
  // One person, two reqs — the avatar hue hashes off the candidate, so they stay
  // the same colour on both boards.
  expect(parsed.application.candidateId).toBe(first.application.candidateId);
  expect(parsed.application.id).not.toBe(first.application.id);
});

it('409s rather than 500s when the person already applied to this job', async () => {
  const first = CreateApplicationResponseSchema.parse((await post(recruiter, body())).json());

  const again = await post(recruiter, {
    jobId: fixtures.talon.jobId,
    candidateId: first.application.candidateId,
    source: 'referral',
  });

  // `applications` is unique on (tenant_id, candidate_id, job_id) — one person
  // applies to one req once. Spec 005 §10.9 said otherwise and was wrong about
  // the schema; the constraint has been there since 0001.
  expect(again.statusCode, again.body).toBe(409);
  expect(again.json()).toMatchObject({ type: ERROR_TYPES.ALREADY_APPLIED });
});

/* ── Refusals ──────────────────────────────────────────────────────────────── */

it('refuses both a candidate and a candidateId, and neither', async () => {
  expect((await post(recruiter, { ...body(), candidateId: fixtures.talon.jobId })).statusCode).toBe(400);
  expect(
    (await post(recruiter, { jobId: fixtures.talon.jobId, source: 'outbound' })).statusCode,
  ).toBe(400);
});

it('404s on a stage that belongs to another job', async () => {
  const [otherStage] = await owned((sql) => sql<{ id: string }[]>`
    select js.id from job_stages js
    join jobs j on j.id = js.job_id
    where j.req_code = 'ENG-209' limit 1`);

  const res = await post(recruiter, body({ stageId: otherStage?.id }));
  // The composite FK on (job_id, id) would refuse it anyway (#10) — this makes
  // the answer a 404 rather than a constraint violation surfacing as a 500.
  expect(res.statusCode).toBe(404);
});

it('404s on a job that does not exist', async () => {
  const res = await post(recruiter, body({ jobId: '00000000-0000-4000-8000-000000000000' }));
  expect(res.statusCode).toBe(404);
});

it('leaves nothing behind when the stage is refused', async () => {
  const name = `Orphan Probe ${Date.now()}`;
  const [otherStage] = await owned((sql) => sql<{ id: string }[]>`
    select js.id from job_stages js join jobs j on j.id = js.job_id
    where j.req_code = 'ENG-209' limit 1`);

  await post(recruiter, { ...body({ stageId: otherStage?.id }), candidate: { name } });

  // The stage is checked BEFORE the candidate is inserted, so a refusal costs no
  // rows — and even if it did not, the transaction would roll back.
  const rows = await owned((sql) => sql`select 1 from candidates where name = ${name}`);
  expect(rows).toHaveLength(0);
});

/* ── The comp gate ─────────────────────────────────────────────────────────── */

it('refuses a comp expectation from a caller without comp:read', async () => {
  const res = await post(member, body({
    compExpectationMinCents: '15000000',
    compExpectationMaxCents: '18000000',
    compExpectationCurrency: 'USD',
  }));

  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ type: ERROR_TYPES.FORBIDDEN });
});

it('lets a recruiter record one, and stores it as cents', async () => {
  const res = await post(recruiter, body({
    compExpectationMinCents: '15000000',
    compExpectationMaxCents: '18000000',
    compExpectationCurrency: 'USD',
  }));
  expect(res.statusCode).toBe(201);

  const { application } = CreateApplicationResponseSchema.parse(res.json());
  const [row] = await owned((sql) => sql<{ min: string; cur: string }[]>`
    select comp_expectation_min_cents::text as min, comp_expectation_currency as cur
    from applications where id = ${application.id}`);
  expect(row?.min).toBe('15000000');
  expect(row?.cur).toBe('USD');
});

it('refuses a comp expectation with no currency — never assumes USD', async () => {
  const res = await post(recruiter, body({
    compExpectationMinCents: '15000000',
    compExpectationMaxCents: '18000000',
  }));
  expect(res.statusCode).toBe(400);
});

it('rejects an unexpected key rather than dropping it', async () => {
  // Resumes are NOT accepted here: spec 005 §5 needs a quarantine bucket and a
  // scanner (#17), and an intake that cannot scan a file must not take one.
  const res = await post(recruiter, body({ resumeUrl: 'https://example.test/cv.pdf' }));
  expect(res.statusCode).toBe(400);
});
