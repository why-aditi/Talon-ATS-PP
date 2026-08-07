// Acceptance 3 (spec 001 §5.4): pooled-connection leak test. Max-1 pool, so every
// query hits the SAME physical connection. Tenant context set with SET LOCAL
// (set_config(..., is_local => true)) must die with its transaction; the plain-SET
// counterexample at the bottom demonstrates the leak that SET LOCAL prevents.
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { APP_URL, OWNER_URL } from './urls.js';

let sql: postgres.Sql;
let talon: string;
let acme: string;

// The request-chain fixture pattern (step 4 mirrors this): one transaction,
// SET LOCAL inside it, context gone at commit.
async function withTenantTx<T>(tenantId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`; // true = SET LOCAL
    return fn(tx);
  })) as T;
}

beforeAll(async () => {
  const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const tenants = await owner`select id, slug from tenants`;
  talon = tenants.find((t) => t['slug'] === 'talon')?.['id'] as string;
  acme = tenants.find((t) => t['slug'] === 'acme')?.['id'] as string;
  await owner.end();
  sql = postgres(APP_URL, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await sql.end();
});

it('same physical connection: tenant B never sees tenant A after A commits', async () => {
  const pidBefore = (await sql`select pg_backend_pid() as pid`)[0]?.['pid'];

  const jobsA = await withTenantTx(talon, (tx) => tx`select req_code from jobs`);
  expect(jobsA).toHaveLength(6);

  const pidAfter = (await sql`select pg_backend_pid() as pid`)[0]?.['pid'];
  expect(pidAfter, 'max-1 pool must reuse the same physical connection').toBe(pidBefore);

  const { jobsB, leakedA } = await withTenantTx(acme, async (tx) => ({
    jobsB: await tx`select req_code from jobs`,
    leakedA: await tx`select count(*)::int as n from jobs where tenant_id = ${talon}`,
  }));
  expect(jobsB.map((j) => j['req_code'])).toEqual(['ACM-001']);
  expect(leakedA[0]?.['n'], "tenant A's rows must not leak into B's transaction").toBe(0);

  // between transactions the connection carries no tenant → fails closed
  expect(await sql`select id from jobs`).toHaveLength(0);
});

it('counterexample: plain SET (is_local = false) leaks across the transaction boundary', async () => {
  await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${talon}, false)`; // plain SET — the bug
  });
  const leaked = await sql`select id from jobs`;
  // This is the failure mode the fixture's SET LOCAL prevents: the committed
  // session-level setting survives, and an unrelated caller on the pooled
  // connection now reads tenant A's rows.
  expect(leaked.length).toBe(6);
  await sql`reset app.tenant_id`;
  expect(await sql`select id from jobs`).toHaveLength(0);
});
