import { ListJobsResponseSchema } from '@talon/contracts';
import { vi } from 'vitest';
import { pipelineRoute } from './pipeline-handlers';
import { SEEDED_JOBS } from './seeded-jobs';

/**
 * Replaces MSW. Component tests need *some* stand-in for the network, and once
 * the browser talks to a real API the only remaining consumer was the test suite
 * — a service worker, a request interceptor and a dependency to answer a handful
 * of calls that `fetch` can answer directly.
 *
 * A route returns a Response to handle a request, or `undefined` to decline and
 * let the next one try. Anything nothing handles falls through to the seeded
 * jobs list, so the common case needs no setup at all.
 */
export type Route = (
  url: URL,
  init: RequestInit | undefined,
) => Response | undefined | Promise<Response | undefined>;

const routes: Route[] = [];

/** Registers a route for the current test. Cleared automatically after each one. */
export function route(handler: Route): void {
  routes.unshift(handler);
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

/** The seeded tenant, filtered the way the real endpoint filters. */
function seededJobs(url: URL): Response {
  const status = url.searchParams.get('status');
  const department = url.searchParams.get('department');
  let data = SEEDED_JOBS;
  if (status) data = data.filter((job) => job.status === status);
  if (department) data = data.filter((job) => job.department.toLowerCase() === department.toLowerCase());
  // Validated against the real contract, so a fixture cannot drift out of the
  // shape the screen is built against.
  return json(ListJobsResponseSchema.parse({ data, nextCursor: null }));
}

export function installFetchStub(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'http://localhost');

    for (const handler of routes) {
      const response = await handler(url, init);
      if (response) return response;
    }

    if (url.pathname === '/v1/jobs') return seededJobs(url);

    // The board endpoints, which hold state across a test and so cannot be a
    // per-test registration. Consulted after the per-test routes so a case can
    // still override one of them.
    const board = await pipelineRoute(url, init);
    if (board) return board;

    throw new Error(`Unhandled request in test: ${init?.method ?? 'GET'} ${url.pathname}`);
  });
}

export function resetRoutes(): void {
  routes.length = 0;
}
