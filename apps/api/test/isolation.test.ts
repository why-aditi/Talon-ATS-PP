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
  request(fixtures: Fixtures): {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    /** Sent verbatim. A route with a `.strict()` body needs one that VALIDATES, or the
     *  request 400s on the schema before it ever reaches the tenancy check and this
     *  gate proves nothing about isolation. */
    payload?: object;
  };
  /**
   * 404 for anything addressed by id. A COLLECTION is the exception and says so
   * here rather than by omission: it names no resource to be wrong about, so the
   * hostile answer is 200 over the attacker's OWN rows. What must hold either
   * way is the assertion below — none of tenant A's data in the body.
   */
  hostileStatus?: number;
  /**
   * The OWNER's answer, when it is not 200.
   *
   * The owner pass exists so a suite that 404s everywhere cannot pass by being broken
   * — the real assertion is "not 404", and 200 is only the usual way to say it. A
   * mutation would otherwise have to genuinely run against the shared seed to satisfy
   * this: the first version of the stage case moved a real ENG-204 candidate and broke
   * the jobs-endpoint distribution assertion two files away. A conflict proves
   * visibility just as well and changes nothing.
   */
  victimStatus?: number;
}

const HOSTILE_REQUESTS: Record<string, HostileCase> = {
  'GET /v1/jobs': {
    request: () => ({ method: 'GET', url: '/v1/jobs?limit=100' }),
    hostileStatus: 200,
  },
  'GET /v1/jobs/:id': {
    request: (f) => ({ method: 'GET', url: `/v1/jobs/${f.talon.jobId}` }),
  },
  'GET /v1/jobs/:jobId/board': {
    request: (f) => ({ method: 'GET', url: `/v1/jobs/${f.talon.jobId}/board` }),
  },
  // The bodies are valid on purpose. `moveStage` locks the application first, so the
  // attacker gets 404 from the row being invisible under RLS — not from a schema
  // error, which would pass this gate while proving nothing.
  'PATCH /v1/applications/:id/stage': {
    request: (f) => ({
      method: 'PATCH',
      url: `/v1/applications/${f.talon.applicationId}/stage`,
      payload: {
        fromStageId: f.talon.stageId,
        toStageId: f.talon.nextStageId,
        // Deliberately stale, so the owner gets 409 rather than actually moving a
        // seeded candidate. The attacker still gets 404 — the row is invisible to them
        // before any version is looked at, which is exactly what this gate measures.
        version: 9_999,
        beforeId: null,
        afterId: null,
      },
    }),
    victimStatus: 409,
  },
  'PATCH /v1/applications/:id/rank': {
    request: (f) => ({
      method: 'PATCH',
      url: `/v1/applications/${f.talon.applicationId}/rank`,
      payload: { beforeId: null, afterId: null },
    }),
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
    const { method, url, payload } = hostile.request(fixtures);
    const res = await test.app.inject({ method, url, headers: bearer(victim), ...(payload ? { payload } : {}) });
    // Anything but 404: the owner can see their own resource. 200 unless the case says
    // otherwise — see `victimStatus`.
    expect(res.statusCode, key).toBe(hostile.victimStatus ?? 200);
    expect(res.statusCode, key).not.toBe(404);
  }
});

it('tenant B against tenant A resources gets 404 — never 403, never 200', async () => {
  for (const [key, hostile] of Object.entries(HOSTILE_REQUESTS)) {
    const { method, url, payload } = hostile.request(fixtures);
    const res = await test.app.inject({ method, url, headers: bearer(attacker), ...(payload ? { payload } : {}) });
    // 403 would confirm the resource exists, which is itself the leak (§6.4).
    expect(res.statusCode, key).toBe(hostile.hostileStatus ?? 404);
    if ((hostile.hostileStatus ?? 404) === 404) {
      expect(res.json<{ type: string }>().type, key).toBe(ERROR_TYPES.NOT_FOUND);
    }
    expect(res.body, `${key} must not echo the other tenant's data`).not.toContain(
      fixtures.talon.jobReqCode,
    );
  }
});

it('a list endpoint returns the attacker’s own rows and only those', async () => {
  // The 200 above would also pass on an empty body, which would be isolation by
  // outage rather than by policy.
  const res = await test.app.inject({
    method: 'GET',
    url: '/v1/jobs?limit=100',
    headers: bearer(attacker),
  });
  const data = res.json<{ data: { id: string; reqCode: string }[] }>().data;
  expect(data.map((job) => job.reqCode)).toEqual(['ACM-001']);
  expect(data.map((job) => job.id)).toEqual([fixtures.acme.jobId]);
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
