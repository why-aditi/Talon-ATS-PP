/**
 * POST /v1/jobs, GET /v1/stage-templates, GET /v1/users — spec 005 §4.2, §6.3, §6.4.
 *
 * The endpoints behind wizard steps 2, 3 and 4. What is worth asserting here is
 * not that a row appears — it is the three rules that are invisible until they
 * are broken: the comp gate applies to writes, a job is never created without
 * its stages, and req codes are unique under concurrency.
 */
import {
  ERROR_TYPES,
  JobSchema,
  ListStageTemplatesResponseSchema,
  ListUsersResponseSchema,
} from '@talon/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  bearer,
  dedicatedUser,
  deleteJobs,
  loadFixtures,
  removeDedicatedUser,
  startApp,
  type Fixtures,
  type Person,
  type TestApp,
} from './helpers.js';

let test: TestApp;
let fixtures: Fixtures;
let recruiter: Record<string, string>;
let member: Record<string, string>;
/**
 * This file's OWN users. See `dedicatedUser` — signing in re-provisions, which
 * rewrites `users.external_id`, so a shared row leaves every other suite naming a
 * subject that no longer resolves.
 */
let ownedRecruiter: Person;
let ownedMember: Person;

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  const r = await dedicatedUser(test, 'jobcreaterecruiter', {
    tenantId: fixtures.talon.tenantId,
    role: 'recruiter',
  });
  const m = await dedicatedUser(test, 'jobcreatemember', {
    tenantId: fixtures.talon.tenantId,
    role: 'member',
  });
  ownedRecruiter = r.person;
  ownedMember = m.person;
  recruiter = bearer(r.session);
  member = bearer(m.session);
});

/**
 * Every job this file creates, removed at the end.
 *
 * The suite shares one seeded database and `jobs-list.test.ts` asserts the exact
 * set of departments. Leaving these behind breaks that file, and which file
 * fails depends on run order — so this is not tidiness, it is the difference
 * between a deterministic suite and a coin toss.
 */
const created: string[] = [];

afterAll(async () => {
  // Jobs first: they reference the users below.
  await deleteJobs(created);
  await removeDedicatedUser(ownedRecruiter);
  await removeDedicatedUser(ownedMember);
  await test.close();
});

/**
 * Every created job gets its own department, so its req-code sequence is its own
 * and nothing here can collide with a seeded code or with another test's job.
 * The jobs-list assertions two files away order by department, and a job landing
 * in Engineering would move them.
 */
let n = 0;
const body = (over: Record<string, unknown> = {}) => ({
  title: 'Senior Backend Engineer',
  department: `Probe${(n += 1)}`,
  location: 'Remote (US)',
  stageTemplateId: fixtures.talon.stageTemplateId,
  ...over,
});

async function post(headers: Record<string, string>, payload: Record<string, unknown>) {
  const res = await test.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });
  // Recorded here rather than at each call site: a test that forgets is a test
  // that pollutes, and there is no reason for that to be opt-in.
  if (res.statusCode === 201) created.push((res.json() as { id: string }).id);
  return res;
}

it('creates a draft, returns the full resource, and addresses it in Location', async () => {
  const res = await post(recruiter, body());

  expect(res.statusCode).toBe(201);
  const job = JobSchema.parse(res.json());
  expect(job.status).toBe('draft');
  // §9: writes return the full resource. The header is what makes it
  // addressable without the client parsing the body to find its own id.
  expect(res.headers['location']).toBe(`/v1/jobs/${job.id}`);
});

it('copies the template into job_stages, so the new job has a board', async () => {
  const job = JobSchema.parse((await post(recruiter, body())).json());

  // Read through the board endpoint rather than the database: a job whose stages
  // were not written is one whose board cannot render, and this is the assertion
  // that would have caught it.
  const board = await test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${job.id}/board`,
    headers: recruiter,
  });
  expect(board.statusCode).toBe(200);
  expect((board.json() as { columns: unknown[] }).columns.length).toBeGreaterThan(0);
});

it('applies an SLA override, including an override to no SLA', async () => {
  const job = JobSchema.parse(
    (
      await post(
        recruiter,
        // Position 1 is Screen, seeded at 5 days. Position 0 is Applied, seeded
        // at null — overriding it TO null must stay null rather than falling
        // back to the template, which is what `??` would have done.
        body({ stageOverrides: [{ position: 1, slaDays: 12 }, { position: 0, slaDays: null }] }),
      )
    ).json(),
  );

  const board = await test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${job.id}/board`,
    headers: recruiter,
  });
  const columns = (board.json() as { columns: { name: string; slaDays: number | null }[] }).columns;
  expect(columns.find((c) => c.name === 'Screen')?.slaDays).toBe(12);
  expect(columns.find((c) => c.name === 'Applied')?.slaDays).toBeNull();
});

it('allocates sequential req codes, and PPL for People rather than PEO', async () => {
  const first = JobSchema.parse((await post(recruiter, body({ department: 'People' }))).json());
  const second = JobSchema.parse((await post(recruiter, body({ department: 'People' }))).json());

  // The seed ships PPL-031, so the rule is a lookup with a first-three-letters
  // fallback, not the fallback alone (spec 005 §4.6, §15 OQ3).
  expect(first.reqCode).toMatch(/^PPL-\d+$/);
  expect(second.reqCode).toMatch(/^PPL-\d+$/);
  expect(first.reqCode).not.toBe(second.reqCode);
});

it('never issues the same req code twice under concurrency', async () => {
  // The service reads max()+1, so these all read the same number and the unique
  // index is what makes all but one lose. Without the retry they would 500.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => post(recruiter, body({ department: 'Race' }))),
  );

  // The bodies are in the message: a bare status array turns any failure here
  // into a guess about which layer refused.
  expect(results.map((r) => `${r.statusCode} ${r.body.slice(0, 140)}`).filter((r) => !r.startsWith('201'))).toEqual(
    [],
  );

  const codes = results.map((r) => JobSchema.parse(r.json()).reqCode);
  expect(new Set(codes).size).toBe(5);
});

/* ── The comp gate, on the way in ──────────────────────────────────────────── */

it('refuses a band from a caller without comp:read — 403, not a silent drop', async () => {
  const res = await post(member, body({ bandMinCents: '18000000', bandMaxCents: '22000000', currency: 'USD' }));

  // Read-gating a field while leaving it writable is not access control (#2).
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ type: ERROR_TYPES.FORBIDDEN });
});

it('lets a recruiter set a band, and returns it', async () => {
  const res = await post(recruiter, body({ bandMinCents: '18000000', bandMaxCents: '22000000', currency: 'USD' }));

  expect(res.statusCode).toBe(201);
  expect(JobSchema.parse(res.json()).band).toMatchObject({
    // Digit strings on the wire: bigint has no JSON representation, and a number
    // would reinstate the 2^53 class §4.9 abolishes.
    minCents: '18000000',
    maxCents: '22000000',
    currency: 'USD',
  });
});

it('refuses a band with no currency — never assumes USD', async () => {
  const res = await post(recruiter, body({ bandMinCents: '18000000', bandMaxCents: '22000000' }));
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ type: ERROR_TYPES.VALIDATION_FAILED });
});

it('refuses half a band, and an inverted one', async () => {
  expect((await post(recruiter, body({ bandMinCents: '18000000', currency: 'USD' }))).statusCode).toBe(400);
  expect(
    (await post(recruiter, body({ bandMinCents: '22000000', bandMaxCents: '18000000', currency: 'USD' })))
      .statusCode,
  ).toBe(400);
});

/* ── Bad references ────────────────────────────────────────────────────────── */

it('404s on a stage template that does not exist', async () => {
  const res = await post(recruiter, body({ stageTemplateId: '00000000-0000-4000-8000-000000000000' }));
  // 404 and not 403: an id from another tenant must be indistinguishable from
  // one that was never issued (§6.4).
  expect(res.statusCode).toBe(404);
});

it('rejects an unexpected key rather than dropping it', async () => {
  // .strict(): a client sending `salary` thinks it is sending something.
  const res = await post(recruiter, body({ salary: 100 }));
  expect(res.statusCode).toBe(400);
});

/* ── The two reads behind steps 2 and 3 ────────────────────────────────────── */

it('lists the tenant’s stage templates with their stages in order', async () => {
  const res = await test.app.inject({ method: 'GET', url: '/v1/stage-templates', headers: recruiter });

  expect(res.statusCode).toBe(200);
  const { data } = ListStageTemplatesResponseSchema.parse(res.json());
  expect(data.length).toBeGreaterThan(0);
  expect(data[0]?.stages.map((s) => s.name).slice(0, 2)).toEqual(['Applied', 'Screen']);
  // Null is "no SLA", and must survive the round trip as null rather than 0.
  expect(data[0]?.stages[0]?.slaDays).toBeNull();
});

it('lists assignable users, filtered by role, and never their email', async () => {
  const all = await test.app.inject({ method: 'GET', url: '/v1/users', headers: recruiter });
  expect(all.statusCode).toBe(200);
  const everyone = ListUsersResponseSchema.parse(all.json()).data;
  expect(everyone.length).toBeGreaterThan(1);
  // A picker renders names. Sending addresses would turn it into a directory of
  // colleagues' emails on a screen that never shows one.
  expect(JSON.stringify(everyone)).not.toContain('@');

  const filtered = await test.app.inject({
    method: 'GET',
    url: '/v1/users?role=recruiter',
    headers: recruiter,
  });
  const recruiters = ListUsersResponseSchema.parse(filtered.json()).data;
  expect(recruiters.length).toBeGreaterThan(0);
  expect(recruiters.every((u) => u.role === 'recruiter')).toBe(true);
  expect(recruiters.length).toBeLessThan(everyone.length);
});
