import { HttpResponse, delay, http } from 'msw';
import { jobListResponseSchema } from '../lib/jobs-contract';
import { JOBS } from './fixtures';

/**
 * Stand-in for `GET /v1/jobs` (spec 001 §7.2) until the API stream lands step 4.
 *
 * `_scenario` reaches states that filters alone cannot produce. It is a mock-only
 * parameter: the real endpoint ignores unknown query params, so leaving it in a URL
 * degrades to the default response rather than breaking. The filtered-empty state
 * needs no scenario — `?status=draft` genuinely matches nothing.
 */
export const handlers = [
  http.get('*/v1/jobs', async ({ request }) => {
    const params = new URL(request.url).searchParams;
    const scenario = params.get('_scenario');

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
    if (recruiterId) data = data.filter((job) => job.recruiter.id === recruiterId);

    // A caller without `comp:read` gets the job without band fields — not nulls, and
    // not an error (spec 001 §7.3, Forbidden row).
    if (scenario === 'forbidden') {
      data = data.map(({ bandMinCents: _min, bandMaxCents: _max, ...job }) => job);
    }

    // The mock validates its own response, so a fixture can never drift out of the
    // shape the screen is built against.
    return HttpResponse.json(jobListResponseSchema.parse({ data, nextCursor: null }));
  }),
];
