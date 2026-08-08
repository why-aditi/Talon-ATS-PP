/**
 * The audit_log row a sign-in writes — CLAUDE.md §4 ("every mutation writes to
 * audit_log with actor, before, after, IP, request id"), applied to the mutation
 * that had never obeyed it.
 *
 * Two things are being asserted, and the second matters more than the first:
 *
 *   1. The row exists, for successes AND failures, and carries what §4 asks for.
 *   2. The row is not an oracle. A failed sign-in for an address that exists and
 *      one for an address that does not must produce rows that are identical
 *      apart from the string the caller typed — same action, same reason, same
 *      null tenant, same null actor. Anything else moves the account-enumeration
 *      leak out of the response and into the log, where nobody is looking for it.
 *
 * Read as the OWNER, deliberately: rows for failed attempts carry a null
 * tenant_id and are invisible to `talon_app` under audit_log's RLS policy. That
 * is by design (0001's comment on the table), and asserting it from the app role
 * would silently assert nothing.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import postgres from 'postgres';
import { ERROR_TYPES } from '@talon/contracts';
import {
  loadFixtures,
  provision,
  startApp,
  TEST_PASSWORD,
  type Fixtures,
  type TestApp,
} from './helpers.js';
import { OWNER_URL } from './urls.js';

interface AuditRow {
  tenant_id: string | null;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: { outcome?: string; email?: string; reason?: string };
  ip: string | null;
  request_id: string | null;
}

let test: TestApp;
let fixtures: Fixtures;
let owner: postgres.Sql;

const signInRequest = (email: string, password: string) =>
  test.app.inject({ method: 'POST', url: '/v1/auth/sign-in', payload: { email, password } });

/** Every authentication row this file has caused, oldest first. */
const auditRows = (): Promise<AuditRow[]> => owner<AuditRow[]>`
  select tenant_id, actor_id, action, entity_type, entity_id, before, after, host(ip) as ip,
         request_id
  from audit_log where entity_type = 'authentication' order by id`;

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  await provision(test, fixtures.talon.recruiter);
});

beforeEach(async () => {
  // Cleared BEFORE, not after: every other file in this suite signs in, and the
  // database is shared and seeded once. Cleaning up afterwards would leave each
  // assertion here counting whatever ran before it.
  //
  // Append-only means `talon_app` has no DELETE grant on audit_log — the owner
  // does, and this is a fixture, not the thing under test.
  await owner`delete from audit_log where entity_type = 'authentication'`;
});

afterAll(async () => {
  await owner`delete from audit_log where entity_type = 'authentication'`;
  await owner?.end();
  await test.close();
});

it('a successful sign-in writes one row naming the actor, the tenant, the ip and the request', async () => {
  const response = await signInRequest(fixtures.talon.recruiter.email, TEST_PASSWORD);
  expect(response.statusCode).toBe(200);

  const rows = await auditRows();
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row).toMatchObject({
    tenant_id: fixtures.talon.tenantId,
    actor_id: fixtures.talon.recruiter.id,
    action: 'auth.sign_in.succeeded',
    entity_type: 'authentication',
    entity_id: null,
    // Authenticating changes no entity, so there is no prior state to record.
    before: null,
  });
  expect(row?.after).toEqual({ outcome: 'succeeded', email: fixtures.talon.recruiter.email });
  expect(row?.ip).toBe('127.0.0.1');
  // Correlates the row with the server log line and with the problem document a
  // client would have been handed.
  expect(row?.request_id).toBeTruthy();
});

it('a failed sign-in is recorded, and carries no tenant and no actor', async () => {
  const response = await signInRequest(fixtures.talon.recruiter.email, 'not the password');
  expect(response.statusCode).toBe(401);

  const rows = await auditRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    // Attributing a failure to an account asserts an identity nobody proved.
    tenant_id: null,
    actor_id: null,
    action: 'auth.sign_in.failed',
    entity_type: 'authentication',
  });
  expect(rows[0]?.after).toEqual({
    outcome: 'failed',
    email: fixtures.talon.recruiter.email,
    // Exactly the `type` the caller was given, and nothing more.
    reason: ERROR_TYPES.INVALID_CREDENTIALS,
  });
  expect(rows[0]?.ip).toBe('127.0.0.1');
});

it('the audit trail does not say whether the account exists', async () => {
  // The response side of this is asserted in auth-chain.test.ts. This is the
  // other half: a log that distinguishes the two cases is the same leak, moved
  // somewhere nobody thought to check.
  const known = await signInRequest(fixtures.talon.recruiter.email, 'not the password');
  const unknown = await signInRequest('nobody-at-all@taloninc.com', 'not the password');
  expect(unknown.statusCode).toBe(known.statusCode);

  const rows = await auditRows();
  expect(rows).toHaveLength(2);
  const [first, second] = rows;
  expect(second?.action).toBe(first?.action);
  expect(second?.tenant_id).toBe(first?.tenant_id);
  expect(second?.actor_id).toBe(first?.actor_id);
  expect(second?.after.reason).toBe(first?.after.reason);
  // The only difference is the string the caller typed, which is the whole point
  // of recording it.
  expect(second?.after.email).toBe('nobody-at-all@taloninc.com');
});

it('never records the password, and never records a token', async () => {
  const secret = 'a-password-that-must-not-be-logged';
  await signInRequest(fixtures.talon.recruiter.email, secret);
  const success = await signInRequest(fixtures.talon.recruiter.email, TEST_PASSWORD);
  const { accessToken, refreshToken } = success.json<{
    accessToken: string;
    refreshToken: string;
  }>();

  const serialised = JSON.stringify(await auditRows());
  expect(serialised).not.toContain(secret);
  expect(serialised).not.toContain(accessToken);
  expect(serialised).not.toContain(refreshToken);
  // Belt: nothing password- or token-shaped under any key.
  expect(serialised).not.toMatch(/scrypt|password_hash|Bearer /i);
});

it('a request rejected by its schema writes nothing — there was no attempt to record', async () => {
  // Validation runs before the service, so `audit_log` is not a dumping ground
  // for malformed bodies. A 400 is a client bug, not an authentication event.
  const response = await signInRequest('not-an-email', '');
  expect(response.statusCode).toBe(400);
  expect(await auditRows()).toHaveLength(0);
});

it('the app role cannot write an authentication row any other way', async () => {
  // The narrowness claim behind migration 0005: `talon_app` is granted one
  // function that produces one of two row shapes, not "insert into audit_log".
  // Its 0001 insert grant still exists for the in-transaction case, but the RLS
  // policy refuses a null tenant, which is every failed sign-in.
  const app = postgres(test.container.cradle.config.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await expect(
      app`insert into audit_log (tenant_id, action, entity_type)
          values (null, 'auth.sign_in.failed', 'authentication')`,
    ).rejects.toThrow(/row-level security|violates/i);
    // And the function refuses to invent an action of its own.
    await expect(
      app`select audit_sign_in('deleted'::text, null::text, ${'x@y.test'}::text,
            null::uuid, null::uuid, null::text, null::text)`,
    ).rejects.toThrow(/succeeded or failed/);
    // A success with no identity behind it is refused too: it would be written
    // with a null tenant and vanish from the trail its tenant would read.
    await expect(
      app`select audit_sign_in('succeeded'::text, null::text, ${'x@y.test'}::text,
            null::uuid, null::uuid, null::text, null::text)`,
    ).rejects.toThrow(/must carry a tenant and an actor/);
  } finally {
    await app.end();
  }
  expect(await auditRows()).toHaveLength(0);
});
