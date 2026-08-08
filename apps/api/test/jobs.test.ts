/**
 * GET /v1/jobs/:id — comp scope gating (spec 001 §6.4 acceptance 4) and the
 * shape the contract promises.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ERROR_TYPES, JobSchema } from '@talon/contracts';
import {
  bearer,
  dedicatedUser,
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
 * This file's OWN user. See `dedicatedUser` — signing in re-provisions, which
 * rewrites `users.external_id`, so a shared row leaves every other suite naming a
 * subject that no longer resolves.
 */
let ownedRecruiter: Person;
let ownedMember: Person;

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  // This file's own pair. The seeded Maya and Lin stay untouched — assertions about
  // a JOB's recruiter still name them, because that is seeded data rather than who
  // is holding the token.
  const r = await dedicatedUser(test, 'jobsrecruiter', {
    tenantId: fixtures.talon.tenantId,
    role: 'recruiter',
  });
  const m = await dedicatedUser(test, 'jobsmember', {
    tenantId: fixtures.talon.tenantId,
    role: 'member',
  });
  ownedRecruiter = r.person;
  ownedMember = m.person;
  recruiter = bearer(r.session);
  member = bearer(m.session);
});

afterAll(async () => {
  await removeDedicatedUser(ownedRecruiter);
  await removeDedicatedUser(ownedMember);
  await test.close();
});

const getJob = (headers: Record<string, string>, id = fixtures.talon.jobId) =>
  test.app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers });

it('a member receives the job with no band key at all — not null, absent', async () => {
  const res = await getJob(member);
  expect(res.statusCode).toBe(200);
  const body = res.json<Record<string, unknown>>();
  expect('band' in body, 'the key itself must be absent, not null or empty').toBe(false);
  // Nothing else comp-shaped got through either.
  expect(JSON.stringify(body)).not.toMatch(/cents/i);
  expect(body['reqCode']).toBe('ENG-204');
});

it('a comp:read holder receives band as one atomic object', async () => {
  const res = await getJob(recruiter);
  expect(res.statusCode).toBe(200);
  const body = res.json<{ band?: { minCents: string; maxCents: string; currency: string } }>();
  // Money is a canonical digit string of integer cents, never a float.
  expect(body.band).toEqual({ minCents: '19000000', maxCents: '22500000', currency: 'USD' });
});

it('the payload satisfies the contract, including a full stage distribution', async () => {
  const res = await getJob(recruiter);
  const job = JobSchema.parse(res.json());
  // §9 edge case 4: every canonical stage present, zeroes included.
  expect(Object.keys(job.stageDistribution).sort()).toEqual(
    ['applied', 'hired', 'offer', 'onsite', 'rejected', 'screen', 'withdrawn'].sort(),
  );
  // The nine pictured ENG-204 candidates: 4 applied, 2 screen, 1 onsite, 1 offer, 1 hired.
  expect(job.stageDistribution).toMatchObject({
    applied: 4,
    screen: 2,
    onsite: 1,
    offer: 1,
    hired: 1,
    rejected: 0,
    withdrawn: 0,
  });
  expect(job.inProcessCount).toBe(8);
  expect(job.activeCount).toBe(9);
  expect(job.recruiter).toEqual({ id: fixtures.talon.recruiter.id, name: 'Maya Reyes' });
});

it('a job that does not exist is 404 problem+json', async () => {
  const res = await getJob(recruiter, '00000000-0000-0000-0000-000000000000');
  expect(res.statusCode).toBe(404);
  expect(res.headers['content-type']).toContain('application/problem+json');
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.NOT_FOUND);
});

it('a path parameter that is not a uuid is 400, not a database error', async () => {
  const res = await getJob(recruiter, 'not-a-uuid');
  expect(res.statusCode).toBe(400);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.VALIDATION_FAILED);
});
