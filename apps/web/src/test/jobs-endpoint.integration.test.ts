/**
 * The test that converts the fixture prediction into a verified contract (spec §7.4).
 *
 * Everything else in this suite proves the screen renders a *copy* of the seed. This
 * one asserts the live `GET /v1/jobs` returns exactly that copy for the seeded tenant,
 * which is the only thing that can catch fixture-vs-seed drift — change a bulk count
 * in `packages/db/src/seed.ts` and nothing else in `apps/web` notices.
 *
 * It is skipped until an endpoint exists to point it at. As of this commit:
 *   - `apps/api/src/modules/jobs/routes.ts` registers an empty plugin — no route
 *   - `authenticate` is a fail-closed stub that 401s every protected route (step 4)
 *   - `apps/api` has no dev/start script
 *
 * To run it once those land:
 *   TALON_API_URL=http://localhost:3001 TALON_API_TOKEN=<token> pnpm --filter web test
 *
 * Owner: api + test. Living here because the expected table lives here; move it to
 * `e2e/` if that suite grows a seeded-tenant fixture first.
 */
import { ListJobsResponseSchema, type Job } from '@talon/contracts';
import { describe, expect, it } from 'vitest';
import { JOBS } from '../mocks/fixtures';

const API_URL = process.env['TALON_API_URL'];
const API_TOKEN = process.env['TALON_API_TOKEN'];

/** Only the fields the seed determines. Ids, timestamps and openings are not seeded facts. */
function seededShape(job: Job) {
  return {
    reqCode: job.reqCode,
    title: job.title,
    department: job.department,
    location: job.location,
    status: job.status,
    recruiterName: job.recruiter?.name ?? null,
    inProcessCount: job.inProcessCount,
    activeCount: job.activeCount,
    stageDistribution: job.stageDistribution,
  };
}

describe.skipIf(!API_URL)('GET /v1/jobs against the seeded tenant', () => {
  it('returns exactly the six seeded jobs, in the order the screen groups them', async () => {
    const response = await fetch(`${API_URL}/v1/jobs`, {
      headers: {
        accept: 'application/json',
        ...(API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}),
      },
    });

    if (response.status === 401) {
      throw new Error(
        'GET /v1/jobs returned 401. Set TALON_API_TOKEN, or the step-4 auth chain is not wired yet.',
      );
    }
    // Read once: a Response body is a stream, so consuming it for the failure
    // message would leave nothing for the parse below.
    const raw = await response.text();
    expect(response.status, raw).toBe(200);

    // Parsing with the contract is half the assertion: a payload that does not satisfy
    // ListJobsResponseSchema fails here rather than surfacing as a render bug.
    const body = ListJobsResponseSchema.parse(JSON.parse(raw));

    expect(body.data.map(seededShape)).toEqual(JOBS.map(seededShape));

    // Six jobs fit one page, so a cursor would mean the API is paginating differently
    // than the screen assumes — "N open" is currently counted client-side over one page.
    expect(body.nextCursor).toBeNull();
  });

  it('serves ENG-204 from the board, not from the jobs-list screenshot', async () => {
    // Spec §11 open question 5. If this ever reads 18/38, the seed grew filler
    // candidates to make a screenshot come out right.
    const response = await fetch(`${API_URL}/v1/jobs`, {
      headers: {
        accept: 'application/json',
        ...(API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}),
      },
    });
    const body = ListJobsResponseSchema.parse(await response.json());
    const eng204 = body.data.find((job) => job.reqCode === 'ENG-204');

    expect(eng204).toBeDefined();
    expect(eng204).toMatchObject({ inProcessCount: 8, activeCount: 9 });
    expect(eng204?.stageDistribution).toEqual({
      applied: 4,
      screen: 2,
      onsite: 1,
      offer: 1,
      hired: 1,
      rejected: 0,
      withdrawn: 0,
    });
  });

  it('agrees with the seed on what "active" counts', async () => {
    // The contract docstring says "not rejected or withdrawn"; the seed and the
    // reference screen mean total applications ever received. They differ on every
    // job except ENG-204. Recorded in §7.4 — this is the assertion that forces the
    // question rather than letting the two definitions drift apart silently.
    const response = await fetch(`${API_URL}/v1/jobs`, {
      headers: {
        accept: 'application/json',
        ...(API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {}),
      },
    });
    const body = ListJobsResponseSchema.parse(await response.json());
    const eng209 = body.data.find((job) => job.reqCode === 'ENG-209');

    expect(
      eng209?.activeCount,
      'ENG-209 has 21 applications, 13 rejected. 21 = total (screen + seed); 8 = not-rejected (contract docstring).',
    ).toBe(21);
  });
});
