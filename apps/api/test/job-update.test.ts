/**
 * PATCH /v1/jobs/:id — spec 005 §4.3.
 *
 * Three rules, all invisible until they break:
 *
 *  1. Absent means untouched; null means clear. If absent meant clear, saving a
 *     title would destroy a salary band the editor was never allowed to see.
 *  2. The comp gate applies to writes, including writes of null.
 *  3. A stale version loses, and is told what it lost to.
 *
 * The job under test is created here rather than borrowed from the seed: this
 * file edits, and `jobs-list.test.ts` asserts the seeded rows exactly.
 */
import { ERROR_TYPES, JobConflictSchema, JobSchema, type Job } from '@talon/contracts';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { bearer, deleteJobs, loadFixtures, signIn, startApp, type Fixtures, type TestApp } from './helpers.js';

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
  await deleteJobs(created);
  await test.close();
});

let n = 0;
/** A fresh job per test, in its own department, so nothing here collides. */
async function makeJob(over: Record<string, unknown> = {}): Promise<Job> {
  const res = await test.app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: recruiter,
    payload: {
      title: 'Senior Backend Engineer',
      department: `Edit${(n += 1)}`,
      location: 'Remote (US)',
      stageTemplateId: fixtures.talon.stageTemplateId,
      ...over,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const job = JobSchema.parse(res.json());
  created.push(job.id);
  return job;
}

const patch = (headers: Record<string, string>, id: string, payload: Record<string, unknown>) =>
  test.app.inject({ method: 'PATCH', url: `/v1/jobs/${id}`, headers, payload });

const banded = () =>
  makeJob({ bandMinCents: '18000000', bandMaxCents: '22000000', currency: 'USD' });

let job: Job;
beforeEach(async () => {
  job = await makeJob();
});

it('edits a field and returns the full resource with a new version', async () => {
  const res = await patch(recruiter, job.id, { title: 'Staff Backend Engineer', version: job.version });

  expect(res.statusCode).toBe(200);
  const updated = JobSchema.parse(res.json());
  expect(updated.title).toBe('Staff Backend Engineer');
  // §9: the new version comes back, or the client must refetch before it can
  // edit again.
  expect(updated.version).toBe(job.version + 1);
});

it('leaves every field the patch did not mention', async () => {
  const before = await banded();
  const res = await patch(recruiter, before.id, { title: 'Renamed', version: before.version });

  const after = JobSchema.parse(res.json());
  expect(after.department).toBe(before.department);
  expect(after.location).toBe(before.location);
  expect(after.band).toEqual(before.band);
  expect(after.reqCode).toBe(before.reqCode);
});

it('bumps the version even when nothing actually changed', async () => {
  // Skipping the bump on a no-op would let two concurrent identical edits both
  // succeed — the lost update this column exists to prevent, reached by a
  // longer route.
  const res = await patch(recruiter, job.id, { title: job.title, version: job.version });
  expect(JobSchema.parse(res.json()).version).toBe(job.version + 1);
});

/* ── The band, and the wipe that must not happen ───────────────────────────── */

it('KEEPS the band when a caller without comp:read edits the title', async () => {
  /*
    The most important test in this file.

    A member never receives the band, so their client cannot send one. If PATCH
    treated an absent key as "clear", this title edit would destroy a salary band
    the editor was never allowed to look at — silently, with a 200.
  */
  const before = await banded();
  const res = await patch(member, before.id, { title: 'Renamed by a member', version: before.version });
  expect(res.statusCode).toBe(200);

  // Read back as someone who CAN see comp: the member's own response omits the
  // band either way, so asserting on it would prove nothing.
  const readBack = await test.app.inject({ method: 'GET', url: `/v1/jobs/${before.id}`, headers: recruiter });
  expect(JobSchema.parse(readBack.json()).band).toEqual(before.band);
});

it('refuses a band from a caller without comp:read — including a null one', async () => {
  const before = await banded();

  for (const payload of [
    { bandMinCents: '1', bandMaxCents: '2', currency: 'USD' },
    // Null too: clearing a field you may not see is still writing it.
    { bandMinCents: null, bandMaxCents: null, currency: null },
  ]) {
    const res = await patch(member, before.id, { ...payload, version: before.version });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ type: ERROR_TYPES.FORBIDDEN });
  }

  const readBack = await test.app.inject({ method: 'GET', url: `/v1/jobs/${before.id}`, headers: recruiter });
  expect(JobSchema.parse(readBack.json()).band).toEqual(before.band);
});

it('clears the band when a recruiter explicitly sends nulls', async () => {
  const before = await banded();
  const res = await patch(recruiter, before.id, {
    bandMinCents: null,
    bandMaxCents: null,
    currency: null,
    version: before.version,
  });

  expect(res.statusCode).toBe(200);
  // Absent from the response entirely — the same shape as a job that never had
  // one, which is what §6.4 acceptance 4 asks for.
  expect(JobSchema.parse(res.json())).not.toHaveProperty('band');
});

it('refuses to clear half a band', async () => {
  const before = await banded();
  const res = await patch(recruiter, before.id, { bandMinCents: null, version: before.version });
  expect(res.statusCode).toBe(400);
});

/* ── Concurrency ───────────────────────────────────────────────────────────── */

it('409s on a stale version, and says what it lost to', async () => {
  const first = await patch(recruiter, job.id, { title: 'First writer wins', version: job.version });
  expect(first.statusCode).toBe(200);

  const second = await patch(recruiter, job.id, { title: 'Second writer', version: job.version });

  expect(second.statusCode).toBe(409);
  const conflict = JobConflictSchema.parse(second.json());
  expect(conflict.type).toBe(ERROR_TYPES.JOB_VERSION_CONFLICT);
  // `current` is what makes it actionable: "someone changed this" with no
  // indication of WHAT forces the user to discard their edit blind.
  expect(conflict.current.title).toBe('First writer wins');
  expect(conflict.current.version).toBe(job.version + 1);
});

it('404s on a job that does not exist, before any version is compared', async () => {
  const res = await patch(recruiter, '00000000-0000-4000-8000-000000000000', {
    title: 'Nope',
    version: 1,
  });
  expect(res.statusCode).toBe(404);
});

it('requires a version — editing blind is not an option', async () => {
  const res = await patch(recruiter, job.id, { title: 'No version' });
  expect(res.statusCode).toBe(400);
});

it('rejects an unexpected key rather than dropping it', async () => {
  // reqCode is deliberately not editable: it is on offer letters and in inboxes.
  const res = await patch(recruiter, job.id, { reqCode: 'ENG-999', version: job.version });
  expect(res.statusCode).toBe(400);
});
