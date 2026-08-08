/**
 * The transaction hook (spec 001 §6.3) and §9 edge case 10: a handler that
 * throws must roll back AND release, and the pool must not leak.
 *
 * The throwing route lives here rather than in the app: a test-only 500 endpoint
 * shipped in `src` is a test-only 500 endpoint in production. The hooks under
 * test are the real exported ones, registered exactly as app.ts registers them.
 */
import { fastify, type FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildContainer } from '../src/container.js';
import { requireTx } from '../src/context.js';
import { problemErrorHandler } from '../src/errors.js';
import {
  authenticate,
  finishTenantTransaction,
  openTenantTransaction,
  resolveTenant,
} from '../src/hooks/auth.js';
import {
  dedicatedUser,
  loadFixtures,
  removeDedicatedUser,
  startApp,
  testConfig,
  type Fixtures,
  type Person,
  type TestApp,
} from './helpers.js';
import { OWNER_URL } from './urls.js';

// A pool of exactly one: a single leaked connection makes the next request hang
// rather than merely degrading, so the assertion is unambiguous.
const POOL_MAX = 1;

let harness: TestApp;
let app: FastifyInstance;
let fixtures: Fixtures;
let token: string;
/**
 * This file's OWN user. See `dedicatedUser` — signing in re-provisions, which
 * rewrites `users.external_id`, so a shared row leaves every other suite naming a
 * subject that no longer resolves.
 */
let owned: Person;

beforeAll(async () => {
  // startApp is used only to mint a session over the real sign-in route; the app
  // under test below is built by hand so it can carry a throwing handler.
  harness = await startApp();
  fixtures = await loadFixtures();
  const dedicated = await dedicatedUser(harness, 'tenanttransaction', {
    tenantId: fixtures.talon.tenantId,
    role: 'recruiter',
  });
  owned = dedicated.person;
  token = dedicated.session.accessToken;

  const container = buildContainer(testConfig({ poolMax: POOL_MAX }));
  app = fastify({ exposeHeadRoutes: false });
  app.decorate('container', container);
  app.setErrorHandler(problemErrorHandler);
  app.addHook('onClose', async () => {
    await container.cradle.sql.end();
  });
  await app.register(
    async (scoped) => {
      scoped.addHook('onRequest', authenticate);
      scoped.addHook('onRequest', resolveTenant);
      scoped.addHook('preHandler', openTenantTransaction);
      scoped.addHook('onSend', finishTenantTransaction);

      scoped.get('/boom', async () => {
        throw new Error('handler exploded');
      });
      scoped.get('/write', async (request) => {
        const tx = requireTx(request);
        await tx.sql`insert into candidates (id, tenant_id, name) values (gen_random_uuid(), ${tx.tenantId}::uuid, 'Rollback Probe')`;
        const [row] = await tx.sql<{ n: number }[]>`
        select count(*)::int as n from candidates where name = 'Rollback Probe'`;
        return { visibleInTransaction: row?.n ?? 0 };
      });
      scoped.get('/write-then-fail', async (request) => {
        const tx = requireTx(request);
        await tx.sql`insert into candidates (id, tenant_id, name) values (gen_random_uuid(), ${tx.tenantId}::uuid, 'Never Committed')`;
        throw new Error('handler exploded after writing');
      });
      scoped.get('/settings', async (request) => {
        const tx = requireTx(request);
        const [row] = await tx.sql<{ tenant: string; user: string }[]>`
        select current_setting('app.tenant_id', true) as tenant,
               current_setting('app.user_id', true) as user`;
        return row;
      });
    },
    { prefix: '/v1' },
  );
  await app.ready();
}, 180_000);

afterAll(async () => {
  await removeDedicatedUser(owned);
  // Guarded: if beforeAll failed, the real error should be what the run reports.
  await app?.close();
  await harness?.close();
});

const call = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

it('sets app.tenant_id and app.user_id on the transaction', async () => {
  const res = await call('/v1/settings');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    tenant: fixtures.talon.tenantId,
    user: owned.id,
  });
});

it('repeated 500s neither leak a connection nor leave a transaction open', async () => {
  // With max = 1, ten unreleased connections would be one unreleased connection
  // and this loop would hang on the second iteration.
  for (let i = 0; i < 10; i += 1) {
    const res = await call('/v1/boom');
    expect(res.statusCode).toBe(500);
    // The error body is a problem document, not a stack trace.
    expect(res.json<{ type: string }>().type).toBe('urn:talon:error:internal');
  }
  // Still serving.
  expect((await call('/v1/settings')).statusCode).toBe(200);

  const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and state = 'idle in transaction'`;
    expect(row?.n, 'a connection left idle in transaction is a leaked transaction').toBe(0);
  } finally {
    await owner.end();
  }
});

it('a write is visible inside its own transaction and gone after a rollback', async () => {
  const failed = await call('/v1/write-then-fail');
  expect(failed.statusCode).toBe(500);

  const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await owner<{ n: number }[]>`
      select count(*)::int as n from candidates where name = 'Never Committed'`;
    expect(row?.n, 'a thrown handler must roll back its writes').toBe(0);
  } finally {
    await owner.end();
  }
});

it('commits on a 2xx', async () => {
  const res = await call('/v1/write');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ visibleInTransaction: 1 });

  const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await owner<{ n: number }[]>`
      select count(*)::int as n from candidates where name = 'Rollback Probe'`;
    expect(row?.n, 'a 2xx must commit').toBe(1);
    await owner`delete from candidates where name = 'Rollback Probe'`;
  } finally {
    await owner.end();
  }
});

it('tenant context does not survive the transaction on a pooled connection', async () => {
  // SET LOCAL, not SET. packages/db/test/leak.test.ts demonstrates the leak this
  // prevents; this asserts the api's own hook is on the right side of it.
  await call('/v1/settings');
  const container = app.container;
  const [row] = await container.cradle.sql<{ tenant: string | null }[]>`
    select current_setting('app.tenant_id', true) as tenant`;
  expect(row?.tenant === null || row?.tenant === '').toBe(true);
});
