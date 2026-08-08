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
  dedicatedUser,
  deleteApplications,
  deleteJobs,
  loadFixtures,
  removeDedicatedUser,
  startApp,
  type Fixtures,
  type Person,
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
  // `beforeId` names the card this one goes above — itself, so the computed position
  // is the one it already holds and the write is a no-op.
  //
  // `{ beforeId: null, afterId: null }` was the first version and is NOT inert: it
  // resolves no neighbour, falls through to `lastRank`, and appends. That moved the
  // first Applied card to the bottom permanently, and `board.test.ts` asserts Applied's
  // exact order — a race decided by which file vitest happened to run first. Same trap
  // the stage case above was already fixed for; `/rank` just has no version to stale.
  // Collections: they name no resource to be wrong about, so the hostile answer
  // is 200 over the attacker's OWN rows. The body assertion below is what proves
  // none of tenant A's data came back.
  'GET /v1/stage-templates': {
    request: () => ({ method: 'GET', url: '/v1/stage-templates' }),
    hostileStatus: 200,
  },
  'GET /v1/users': {
    request: () => ({ method: 'GET', url: '/v1/users' }),
    hostileStatus: 200,
  },
  /*
    The body is valid and names TENANT A's stage template, which is the whole
    point: the attacker is refused because that template is invisible under RLS,
    not because the schema rejected them. A body with their own template id would
    succeed and prove nothing.

    The owner gets 201 and a real job — this is the one case that writes. It uses
    a department of its own so the req code cannot collide with a seeded one, and
    nothing else asserts on a job created here.
  */
  'POST /v1/jobs': {
    request: (f) => ({
      method: 'POST',
      url: '/v1/jobs',
      payload: {
        title: 'Isolation probe',
        department: 'Isolation',
        location: 'Remote (US)',
        stageTemplateId: f.talon.stageTemplateId,
      },
    }),
    victimStatus: 201,
  },
  /*
    Tenant A's job id, with a body that VALIDATES — a schema rejection would 400
    before the tenancy check and prove nothing.

    `version: 9_999` is deliberately stale so the OWNER gets 409 rather than
    actually editing a seeded job: `jobs-list.test.ts` asserts ENG-204's title
    and department, and a real edit here would move it. The attacker still gets
    404, because the row is invisible to them before any version is compared —
    which is exactly what this gate measures. Same trick the stage case uses.
  */
  'PATCH /v1/jobs/:id': {
    request: (f) => ({
      method: 'PATCH',
      url: `/v1/jobs/${f.talon.jobId}`,
      payload: { title: 'Renamed by an attacker', version: 9_999 },
    }),
    victimStatus: 409,
  },
  /*
    Tenant A's job, with a body that VALIDATES so the refusal is about tenancy
    and not about the schema. The owner really does create a candidate here —
    there is no stale-version trick available on a create — so the row is removed
    in afterAll alongside the jobs.
  */
  'POST /v1/applications': {
    request: (f) => ({
      method: 'POST',
      url: '/v1/applications',
      payload: {
        jobId: f.talon.jobId,
        candidate: { name: 'Isolation Probe' },
        source: 'outbound',
      },
    }),
    victimStatus: 201,
  },
  'PATCH /v1/applications/:id/rank': {
    request: (f) => ({
      method: 'PATCH',
      url: `/v1/applications/${f.talon.applicationId}/rank`,
      payload: { beforeId: f.talon.applicationId, afterId: null },
    }),
  },
};

let test: TestApp;
let fixtures: Fixtures;
let victim: Session;
let attacker: Session;
/**
 * This file's OWN users. See `dedicatedUser` — signing in re-provisions, which
 * rewrites `users.external_id`, so a shared row leaves every other suite naming a
 * subject that no longer resolves.
 */
let ownedVictim: Person;
let ownedAttacker: Person;

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  // The attacker is an ADMIN at home on purpose: maximum privilege in tenant B
  // still sees nothing of tenant A.
  const a = await dedicatedUser(test, 'isolationvictim', {
    tenantId: fixtures.talon.tenantId,
    role: 'recruiter',
  });
  const b = await dedicatedUser(test, 'isolationattacker', {
    tenantId: fixtures.acme.tenantId,
    role: 'admin',
  });
  ownedVictim = a.person;
  ownedAttacker = b.person;
  victim = a.session;
  attacker = b.session;
});

/*
  The POST case creates a real job for the owner, which is what proves the route
  is visible to them. It is removed here for the same reason job-create.test.ts
  removes its own: jobs-list.test.ts asserts the exact set of departments, and a
  leftover row makes which file fails depend on vitest's run order.
*/
const createdJobs: string[] = [];
/** Same reasoning as `createdJobs`: the POST case really does create one. */
const createdApplications: string[] = [];

afterAll(async () => {
  // Applications first: they reference the jobs, which reference the users.
  await deleteApplications(createdApplications);
  await deleteJobs(createdJobs);
  await removeDedicatedUser(ownedVictim);
  await removeDedicatedUser(ownedAttacker);
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
    const res = await test.app.inject({
      method,
      url,
      headers: bearer(victim),
      ...(payload ? { payload } : {}),
    });
    // Any row this created is this file's to remove — see `createdJobs`.
    if (res.statusCode === 201 && url === '/v1/jobs') {
      createdJobs.push((res.json() as { id: string }).id);
    }
    if (res.statusCode === 201 && url === '/v1/applications') {
      createdApplications.push((res.json() as { application: { id: string } }).application.id);
    }
    // Anything but 404: the owner can see their own resource. 200 unless the case says
    // otherwise — see `victimStatus`.
    expect(res.statusCode, key).toBe(hostile.victimStatus ?? 200);
    expect(res.statusCode, key).not.toBe(404);
  }
});

it('tenant B against tenant A resources gets 404 — never 403, never 200', async () => {
  for (const [key, hostile] of Object.entries(HOSTILE_REQUESTS)) {
    const { method, url, payload } = hostile.request(fixtures);
    const res = await test.app.inject({
      method,
      url,
      headers: bearer(attacker),
      ...(payload ? { payload } : {}),
    });
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
  expect(otherTenants.json<{ type: string }>().type).toBe(
    nonexistent.json<{ type: string }>().type,
  );
});
