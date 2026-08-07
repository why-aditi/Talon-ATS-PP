/**
 * Tenant isolation at the HTTP layer — `pnpm test:isolation`.
 *
 * CLAUDE.md §6 defines this gate as "runs every endpoint as a hostile tenant —
 * must be 404 across the board", and spec 001 §6.4 acceptance 2 is "tenant B
 * against tenant A's job id → 404, not 403". The db-layer RLS suite
 * (packages/db) proves the policies; this proves the endpoints.
 *
 * Every protected route needs an entry in HOSTILE_REQUESTS. A route without one
 * FAILS rather than being skipped: a silently uncovered endpoint is exactly the
 * hole this gate exists to close.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ERROR_TYPES } from '@talon/contracts';
import {
  bearer,
  loadFixtures,
  signIn,
  startApp,
  type Fixtures,
  type Session,
  type TestApp,
} from './helpers.js';

interface HostileCase {
  /** A request naming tenant A's resource, to be sent by tenant B. */
  request(fixtures: Fixtures): { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string };
}

const HOSTILE_REQUESTS: Record<string, HostileCase> = {
  'GET /v1/jobs/:id': {
    request: (f) => ({ method: 'GET', url: `/v1/jobs/${f.talon.jobId}` }),
  },
};

let test: TestApp;
let fixtures: Fixtures;
let victim: Session;
let attacker: Session;

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  victim = await signIn(test, fixtures.talon.recruiter); // tenant A
  attacker = await signIn(test, fixtures.acme.admin); // tenant B, an admin at home
});

afterAll(async () => {
  await test.close();
});

it('every protected route has a hostile-tenant case', () => {
  const missing = test.app.protectedRoutes
    .map((r) => `${r.method} ${r.url}`)
    .filter((key) => !(key in HOSTILE_REQUESTS));
  expect(
    missing,
    'add these to HOSTILE_REQUESTS — an endpoint with no hostile-tenant case is untested, not safe',
  ).toEqual([]);
});

it('the same requests succeed for the tenant that owns the resource', async () => {
  // Without this, a 404 everywhere would pass the suite by being broken.
  for (const [key, hostile] of Object.entries(HOSTILE_REQUESTS)) {
    const { method, url } = hostile.request(fixtures);
    const res = await test.app.inject({ method, url, headers: bearer(victim) });
    expect(res.statusCode, key).toBe(200);
  }
});

it('tenant B against tenant A resources gets 404 — never 403, never 200', async () => {
  for (const [key, hostile] of Object.entries(HOSTILE_REQUESTS)) {
    const { method, url } = hostile.request(fixtures);
    const res = await test.app.inject({ method, url, headers: bearer(attacker) });
    // 403 would confirm the resource exists, which is itself the leak (§6.4).
    expect(res.statusCode, key).toBe(404);
    expect(res.json<{ type: string }>().type, key).toBe(ERROR_TYPES.NOT_FOUND);
    expect(res.body, `${key} must not echo the other tenant's data`).not.toContain(
      fixtures.talon.jobReqCode,
    );
  }
});

it('an id that never existed is indistinguishable from another tenant’s', async () => {
  const nonexistent = await test.app.inject({
    method: 'GET',
    url: '/v1/jobs/00000000-0000-0000-0000-000000000000',
    headers: bearer(attacker),
  });
  const otherTenants = await test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${fixtures.talon.jobId}`,
    headers: bearer(attacker),
  });
  expect(otherTenants.statusCode).toBe(nonexistent.statusCode);
  expect(otherTenants.json<{ type: string }>().type).toBe(nonexistent.json<{ type: string }>().type);
});
