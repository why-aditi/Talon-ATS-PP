/**
 * Spec 001 §6.4 acceptance 3: the database alone stops a cross-tenant read.
 *
 * The repository filters by `tenant_id` AND relies on RLS. This test removes the
 * application half — it runs the query the repository would run, with the tenant
 * predicate deleted, on the same connection the request chain builds (app role,
 * reserved, BEGIN, SET LOCAL app.tenant_id). If the policy were ever dropped or
 * the app were run as a bypassing role, this returns a row and fails, while the
 * belt-and-braces endpoint test would still pass.
 *
 * Deliberately separate from isolation.test.ts, and deliberately not reachable
 * from a route: stubbing the check inside the service would mean shipping a
 * switch that turns tenant filtering off.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildContainer } from '../src/container.js';
import type { TenantTransaction } from '../src/request-context.js';
import { loadFixtures, startApp, testConfig, type Fixtures, type TestApp } from './helpers.js';
import { OWNER_URL } from './urls.js';

let test: TestApp;
let fixtures: Fixtures;

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
});

afterAll(async () => {
  await test.close();
});

const asTenant = async <T>(
  tenantId: string,
  userId: string,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> => {
  const tx = await test.container.cradle.identityService.openTenantTransaction(tenantId, userId);
  try {
    return await fn(tx);
  } finally {
    await tx.rollback();
  }
};

it('with the tenant predicate removed, tenant B still cannot read tenant A’s job', async () => {
  const rows = await asTenant(
    fixtures.acme.tenantId,
    fixtures.acme.admin.id,
    (tx) =>
      // No `and tenant_id = …`. The only thing standing between this query and
      // another tenant's row is the RLS policy.
      tx.sql<{ id: string }[]>`select id from jobs where id = ${fixtures.talon.jobId}::uuid`,
  );
  expect(rows).toHaveLength(0);
});

it('the same unfiltered query does return the row to its owner', async () => {
  // Otherwise the assertion above passes for the wrong reason.
  const rows = await asTenant(
    fixtures.talon.tenantId,
    fixtures.talon.recruiter.id,
    (tx) => tx.sql<{ id: string }[]>`select id from jobs where id = ${fixtures.talon.jobId}::uuid`,
  );
  expect(rows).toHaveLength(1);
});

it('an unfiltered read of every tenant-scoped table returns only the caller’s tenant', async () => {
  const foreign = await asTenant(fixtures.acme.tenantId, fixtures.acme.admin.id, async (tx) => {
    const counts: Record<string, number> = {};
    for (const table of ['jobs', 'users', 'candidates', 'applications', 'job_stages']) {
      const [row] = await tx.sql<{ n: number }[]>`
        select count(*)::int as n from ${tx.sql(table)} where tenant_id = ${fixtures.talon.tenantId}::uuid`;
      counts[table] = row?.n ?? -1;
    }
    return counts;
  });
  expect(foreign).toEqual({ jobs: 0, users: 0, candidates: 0, applications: 0, job_stages: 0 });
});

it('the api refuses to run on a connection that bypasses RLS', async () => {
  // §11b's actual danger: a service pointed at the owner connection nullifies
  // every policy above, and nothing else in the system notices.
  const container = buildContainer({ ...testConfig(), databaseUrl: OWNER_URL });
  try {
    await expect(
      container.cradle.identityService.openTenantTransaction(
        fixtures.acme.tenantId,
        fixtures.acme.admin.id,
      ),
    ).rejects.toThrow(/bypasses row level security/);
  } finally {
    await container.cradle.sql.end();
  }
});
