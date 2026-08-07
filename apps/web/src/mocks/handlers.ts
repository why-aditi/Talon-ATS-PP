import { ListJobsResponseSchema } from '@talon/contracts';
import { HttpResponse, delay, http, passthrough } from 'msw';
import { JOBS } from './fixtures';
import { pipelineHandlers } from './pipeline-handlers';

/**
 * Stand-in for `GET /v1/jobs` (spec 001 §7.2) until the API stream lands step 4.
 *
 * `_scenario` reaches states that filters alone cannot produce. It is mock-only and
 * must never reach the wire: `ListJobsQuerySchema` is `.strict()`, so the real endpoint
 * 400s on an unknown param rather than ignoring it. `jobs-query.ts` builds the query
 * key by key and drops `_scenario` outside development for exactly that reason.
 * The filtered-empty state needs no scenario — `?status=draft` genuinely matches nothing.
 */
/** Serves the seeded fixtures for the default path. Tests only — see mocks/node.ts. */
export const fixtureJobsHandler = http.get('*/v1/jobs', ({ request }) => {
  const params = new URL(request.url).searchParams;
  if (params.get('_scenario')) return undefined;

  let data = JOBS;
  const status = params.get('status');
  const department = params.get('department');
  if (status) data = data.filter((job) => job.status === status);
  if (department) data = data.filter((job) => job.department.toLowerCase() === department.toLowerCase());
  return HttpResponse.json(ListJobsResponseSchema.parse({ data, nextCursor: null }));
});

export const handlers = [
  http.get('*/v1/jobs', async ({ request }) => {
    const params = new URL(request.url).searchParams;
    const scenario = params.get('_scenario');

    // The default path is live. Only the states that a real endpoint cannot be
    // asked to produce on demand — an empty tenant, a 500, a request that never
    // settles — are still mocked, and each one announces itself with `_scenario`.
    // Filtered-empty is deliberately absent: `?status=draft` genuinely matches
    // nothing, so it is real against the API too.
    if (!scenario) return passthrough();

    if (scenario === 'error') {
      // RFC 9457 problem+json, per CLAUDE.md §8.
      return HttpResponse.json(
        {
          type: 'https://talon.dev/problems/internal-error',
          title: 'Jobs could not be loaded',
          status: 500,
          detail: 'The jobs service did not respond.',
        },
        { status: 500, headers: { 'content-type': 'application/problem+json' } },
      );
    }

    // Holds the loading state open so it can be screenshotted and axe-checked.
    if (scenario === 'slow') await delay('infinite');

    const status = params.get('status');
    const department = params.get('department');
    const recruiterId = params.get('recruiter_id');

    let data = scenario === 'empty' ? [] : JOBS;
    if (status) data = data.filter((job) => job.status === status);
    if (department) data = data.filter((job) => job.department.toLowerCase() === department.toLowerCase());
    if (recruiterId) data = data.filter((job) => job.recruiter?.id === recruiterId);

    // A caller without `comp:read` gets the job with `band` omitted entirely — not
    // null, not an error (spec 001 §7.3 Forbidden, §6.4).
    //
    // Step 4 reshaped this: comp was a tagged union whose stated purpose was to keep
    // "you may not see comp" distinct from "this job has no band". An optional field
    // cannot, and the two now serialize identically. Recorded in §7.4 — owner: api.
    if (scenario === 'forbidden') {
      data = data.map(({ band: _band, ...job }) => job);
    }

    // The mock validates its own response against the real contract, so a fixture can
    // never drift out of the shape the screen is built against.
    return HttpResponse.json(ListJobsResponseSchema.parse({ data, nextCursor: null }));
  }),

  // Spec 003. The board endpoints do not exist at all, so unlike jobs there is no
  // passthrough path to fall back to.
  ...pipelineHandlers,
];
