/**
 * Just-in-time user provisioning — `TALON_JIT_PROVISION`.
 *
 * Cognito is the only identity provider, and its Google IdP will authenticate any
 * Google account. So the feature under test is an OPEN DOOR by construction, and
 * the tests are shaped around that rather than around the happy path:
 *
 *   1. Off by default, and off means byte-identical to before it existed —
 *      same status, same RFC 9457 `type`, no row, no audit row.
 *   2. On means on for the allow-listed domain and NOTHING else. A domain that
 *      is not listed gets the same refusal it always did, with no hint that the
 *      list exists.
 *   3. It cannot be used to take over an address that already belongs to
 *      someone (`#provision`'s existing-email decision: refuse, never link).
 *   4. It cannot produce two rows for one person, however concurrent the two
 *      first requests are.
 *   5. It cannot resurrect a deleted user from a still-valid access token.
 *
 * Everything runs against the fake Cognito (`cognito-stub.ts`) — no AWS account,
 * no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { ERROR_TYPES, SignInResponseSchema } from '@talon/contracts';
import { buildApp } from '../src/app.js';
import { buildContainer } from '../src/container.js';
import { parseJitPolicy } from '../src/config.js';
import {
  loadFixtures,
  startApp,
  testConfig,
  TEST_PASSWORD,
  type Fixtures,
  type TestApp,
} from './helpers.js';
import { OWNER_URL } from './urls.js';

/** No seeded user has an address here, so the allow-list cannot collide with the fixtures. */
const JIT_DOMAIN = 'jit.example';
/** Allow-listed too, and deliberately the domain the seed already uses — the takeover case. */
const SEEDED_DOMAIN = 'taloninc.com';

let fixtures: Fixtures;
let owner: postgres.Sql;
/** The app under test: JIT on, two domains, two different roles. */
let test: TestApp;
/** A second app with the feature unconfigured, so "off" is asserted against the same fixtures. */
let off: TestApp;

const jitUsers = () => owner<
  { id: string; tenant_id: string; email: string; name: string; role: string; external_id: string }[]
>`select id, tenant_id, email, name, role, external_id from users
  where email like ${'%@' + JIT_DOMAIN} order by id`;

const auditRows = () => owner<
  { tenant_id: string; actor_id: string; entity_id: string; before: unknown; after: Record<string, string>; ip: string; request_id: string }[]
>`select tenant_id, actor_id, entity_id, before, after, host(ip) as ip, request_id
  from audit_log where action = 'user.provisioned.jit' order by id`;

/**
 * Everything this file creates, removed. Not `truncate`: the suite shares one
 * seeded database and the other files assert against it.
 */
async function cleanup(): Promise<void> {
  await owner`delete from audit_log where action = 'user.provisioned.jit'`;
  await owner`delete from users where email like ${'%@' + JIT_DOMAIN}`;
}

beforeAll(async () => {
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  fixtures = await loadFixtures();
  await cleanup();
  test = await startApp({
    jit: `${JIT_DOMAIN}=${fixtures.talon.tenantId}:recruiter,${SEEDED_DOMAIN}=${fixtures.talon.tenantId}:member`,
  });
  off = await startApp();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await off.close();
  await test.close();
  await owner.end();
});

// A fresh identity per call: the pool has never seen it and neither has `users`.
let sequence = 0;
const newIdentity = (domain = JIT_DOMAIN) => {
  sequence += 1;
  const stamp = `${Date.now().toString(36)}${sequence}`;
  return { email: `newcomer-${stamp}@${domain}`, sub: `sub-${stamp}` };
};

const sso = (app: TestApp, idToken: string, refreshToken = 'cognito-refresh-token') =>
  app.app.inject({ method: 'POST', url: '/v1/auth/sso', payload: { idToken, refreshToken } });

// ── 1. off by default ───────────────────────────────────────────────────────

describe('unconfigured', () => {
  it('answers a verified identity with no users row exactly as it always did', async () => {
    const who = newIdentity();
    const res = await sso(off, off.stub.mintIdToken(who.sub, who.email));

    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERROR_TYPES.USER_NOT_PROVISIONED);
    expect(await jitUsers()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers a password sign-in for an unknown identity as it always did', async () => {
    const who = newIdentity();
    off.stub.addUser(who.email, TEST_PASSWORD, who.sub);
    const res = await off.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: who.email, password: TEST_PASSWORD },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERROR_TYPES.USER_NOT_PROVISIONED);
    expect(await jitUsers()).toHaveLength(0);
  });
});

// ── 2. on, for the allow-listed domain only ─────────────────────────────────

describe('an allow-listed domain', () => {
  it('creates the row and completes the federated sign-in', async () => {
    const who = newIdentity();
    const res = await sso(test, test.stub.mintIdToken(who.sub, who.email, { name: 'Ada Lovelace' }));
    expect(res.statusCode).toBe(200);

    const session = SignInResponseSchema.parse(res.json());
    expect(session.user.email).toBe(who.email);
    expect(session.user.role).toBe('recruiter');
    expect(session.user.tenantId).toBe(fixtures.talon.tenantId);

    const rows = await jitUsers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: fixtures.talon.tenantId,
      email: who.email,
      name: 'Ada Lovelace',
      role: 'recruiter',
      // The join the whole design rests on: the IdP's subject, not `users.id`.
      external_id: who.sub,
    });
    expect(rows[0]?.id).toBe(session.user.id);

    // The point of the endpoint is a usable session, not a well-shaped payload.
    const jobs = await test.app.inject({
      method: 'GET',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(jobs.statusCode).toBe(200);
  });

  it('mints a token naming the Cognito sub, so the very next request resolves', async () => {
    // The failure this guards is the one `session.ts` documents: minting `users.id`
    // signs in cleanly and then 401s, because `auth_user_by_sub` refuses `users.id`
    // once `external_id` is set — and a JIT row always has one.
    const who = newIdentity();
    const res = await sso(test, test.stub.mintIdToken(who.sub, who.email));
    const session = SignInResponseSchema.parse(res.json());
    const claims = JSON.parse(
      Buffer.from(session.accessToken.split('.')[1]!, 'base64url').toString(),
    );
    expect(claims.sub).toBe(who.sub);
    expect(claims.tenant_id).toBe(fixtures.talon.tenantId);
  });

  it('falls back to the local part when the token carries no name', async () => {
    const who = newIdentity();
    await sso(test, test.stub.mintIdToken(who.sub, who.email));
    const rows = await jitUsers();
    expect(rows[0]?.name).toBe(who.email.slice(0, who.email.indexOf('@')));
  });

  it('provisions on the password path too, with the role its own entry names', async () => {
    // A second entry, a different role: the grant is per domain, not global.
    const who = newIdentity(SEEDED_DOMAIN);
    test.stub.addUser(who.email, TEST_PASSWORD, who.sub);
    try {
      const res = await test.app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email: who.email, password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const session = SignInResponseSchema.parse(res.json());
      expect(session.user.role).toBe('member');
      expect(session.user.tenantId).toBe(fixtures.talon.tenantId);
    } finally {
      await owner`delete from audit_log where action = 'user.provisioned.jit'`;
      await owner`delete from users where email = ${who.email}`;
    }
  });

  it('provisions on the refresh path, so a live Cognito session is not stranded', async () => {
    const who = newIdentity();
    test.stub.addUser(who.email, TEST_PASSWORD, who.sub);
    // Sign in once to obtain a real refresh token, then remove the row this created
    // so the refresh below arrives at a subject with nobody behind it.
    const first = SignInResponseSchema.parse(
      (
        await test.app.inject({
          method: 'POST',
          url: '/v1/auth/sign-in',
          payload: { email: who.email, password: TEST_PASSWORD },
        })
      ).json(),
    );
    await owner`delete from audit_log where action = 'user.provisioned.jit'`;
    await owner`delete from users where email = ${who.email}`;

    const res = await test.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(res.statusCode).toBe(200);
    expect(await jitUsers()).toHaveLength(1);
  });

  it('writes the audit row in the same transaction, with actor, ip and request id', async () => {
    // CLAUDE.md §4. A person appearing in a tenant is a mutation and has to be
    // attributable — including to WHICH allow-list entry admitted them, because
    // the configuration can change and the row still has to say what the rule was.
    const who = newIdentity();
    const res = await sso(test, test.stub.mintIdToken(who.sub, who.email));
    expect(res.statusCode).toBe(200);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const [user] = await jitUsers();
    expect(row).toMatchObject({
      tenant_id: fixtures.talon.tenantId,
      // The person is the actor in their own creation: nobody else caused it.
      actor_id: user?.id,
      entity_id: user?.id,
      // The entity did not exist a statement ago, so there is no prior state.
      before: null,
    });
    expect(row?.after).toEqual({
      email: who.email,
      name: who.email.slice(0, who.email.indexOf('@')),
      role: 'recruiter',
      externalId: who.sub,
      source: 'jit',
      matchedDomain: JIT_DOMAIN,
    });
    expect(row?.ip).toBe('127.0.0.1');
    expect(row?.request_id).toBeTruthy();
  });

  it('records no password and no token in the audit row', async () => {
    const who = newIdentity();
    const res = await sso(test, test.stub.mintIdToken(who.sub, who.email), 'a-refresh-token');
    const session = SignInResponseSchema.parse(res.json());
    const serialised = JSON.stringify(await auditRows());
    expect(serialised).not.toContain(session.accessToken);
    expect(serialised).not.toContain('a-refresh-token');
    expect(serialised).not.toContain(TEST_PASSWORD);
  });
});

// ── 3. everything the allow-list does not cover ─────────────────────────────

describe('refusals', () => {
  it('refuses a domain that is not on the list, and says nothing about the list', async () => {
    const who = newIdentity('not-listed.example');
    const listed = newIdentity();

    const refused = await sso(test, test.stub.mintIdToken(who.sub, who.email));
    expect(refused.statusCode).toBe(401);
    expect(refused.json().type).toBe(ERROR_TYPES.USER_NOT_PROVISIONED);

    // Indistinguishable from the answer the unconfigured deployment gives, so the
    // response cannot be used to probe which domains are allow-listed. Compared
    // field by field minus `requestId`, which is per-request by design and is the
    // only thing that legitimately differs.
    const unconfigured = await sso(off, off.stub.mintIdToken(listed.sub, listed.email));
    const shape = (body: Record<string, unknown>) => ({ ...body, requestId: undefined });
    expect(refused.statusCode).toBe(unconfigured.statusCode);
    expect(shape(refused.json())).toEqual(shape(unconfigured.json()));

    expect(
      await owner`select 1 from users where email = ${who.email}`,
    ).toHaveLength(0);
  });

  it('refuses an identity whose token carries no email at all', async () => {
    // Nothing to key the allow-list on, and a `users` row with no address is
    // unrepresentable. 401, not an invented address.
    const who = newIdentity();
    const res = await sso(test, test.stub.mintIdToken(who.sub, ''));
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERROR_TYPES.USER_NOT_PROVISIONED);
    expect(await jitUsers()).toHaveLength(0);
  });

  /**
   * The takeover case, and the reason `#provision` refuses instead of linking.
   *
   * `taloninc.com` IS allow-listed here, and `maya@taloninc.com` is a seeded
   * recruiter with her own `external_id`. An identity the pool authenticates with
   * her address must not inherit her row — that would be an account takeover
   * reachable by anyone who can get an IdP to assert an address at an allow-listed
   * domain.
   */
  it('refuses to adopt an address that already belongs to somebody', async () => {
    const before = await owner<{ external_id: string | null; role: string }[]>`
      select external_id, role from users where id = ${fixtures.talon.recruiter.id}::uuid`;

    const impostor = await sso(
      test,
      test.stub.mintIdToken('sub-impostor-not-mayas', fixtures.talon.recruiter.email),
    );
    expect(impostor.statusCode).toBe(401);
    expect(impostor.json().type).toBe(ERROR_TYPES.USER_NOT_PROVISIONED);

    // Her row is untouched — not relinked, not demoted, not duplicated.
    const after = await owner<{ external_id: string | null; role: string }[]>`
      select external_id, role from users where id = ${fixtures.talon.recruiter.id}::uuid`;
    expect(after).toEqual(before);
    expect(
      await owner`select 1 from users where email = ${fixtures.talon.recruiter.email}`,
    ).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  /**
   * The one path that must NOT provision. A Talon access token can only exist
   * because a sign-in already succeeded, so a missing row means the person was
   * deleted mid-session — and re-creating them from config would make deletion a
   * no-op for up to an access-token lifetime.
   */
  it('does not resurrect a deleted user from a still-valid access token', async () => {
    const who = newIdentity();
    const session = SignInResponseSchema.parse(
      (await sso(test, test.stub.mintIdToken(who.sub, who.email))).json(),
    );
    const bearer = { authorization: `Bearer ${session.accessToken}` };
    expect((await test.app.inject({ method: 'GET', url: '/v1/jobs', headers: bearer })).statusCode).toBe(200);

    await owner`delete from audit_log where actor_id = ${session.user.id}::uuid`;
    await owner`delete from users where id = ${session.user.id}::uuid`;

    const after = await test.app.inject({ method: 'GET', url: '/v1/jobs', headers: bearer });
    expect(after.statusCode).toBe(401);
    expect(after.json().type).toBe(ERROR_TYPES.USER_NOT_PROVISIONED);
    // Still gone. The request chain resolves users; it does not create them.
    expect(await jitUsers()).toHaveLength(0);
  });
});

// ── 4. concurrency ──────────────────────────────────────────────────────────

it('creates exactly one row when several first requests arrive together', async () => {
  // Check-then-act cannot prevent this: every request reads "absent" before any of
  // them writes. `insertProvisionedUser` lets the unique constraints arbitrate and
  // the losers re-read, so the outcome is one row and N working sessions.
  //
  // The query counter is the evidence that the race is REAL rather than an
  // accidentally-serialised test: all N requests genuinely attempt the insert, and
  // the database — not the application — decides that only one of them lands.
  let attemptedInserts = 0;
  const racing = await startApp({
    jit: `${JIT_DOMAIN}=${fixtures.talon.tenantId}:recruiter`,
    onQuery: (query) => {
      if (/insert into users/i.test(query)) attemptedInserts += 1;
    },
  });
  try {
    const who = newIdentity();
    const token = racing.stub.mintIdToken(who.sub, who.email);
    const responses = await Promise.all([1, 2, 3, 4].map(() => sso(racing, token)));

    for (const response of responses) expect(response.statusCode).toBe(200);
    expect(attemptedInserts).toBeGreaterThan(1);

    const rows = await jitUsers();
    expect(rows).toHaveLength(1);
    // Every session names the same person — a second row would show up as two
    // different ids here even if the count assertion somehow passed.
    for (const response of responses) {
      expect(SignInResponseSchema.parse(response.json()).user.id).toBe(rows[0]?.id);
    }
    // And one creation, audited once. A duplicate audit row would mean a second
    // transaction believed it had created somebody.
    expect(await auditRows()).toHaveLength(1);
  } finally {
    await racing.close();
  }
});

// ── 5. configuration ────────────────────────────────────────────────────────

describe('TALON_JIT_PROVISION', () => {
  const uuid = '018f2c31-0000-7000-8000-000000000001';

  it('is off when unset, empty or whitespace', () => {
    expect(parseJitPolicy(undefined).size).toBe(0);
    expect(parseJitPolicy('').size).toBe(0);
    expect(parseJitPolicy('   ').size).toBe(0);
  });

  it('parses entries, lowercases the domain, and keeps each grant separate', () => {
    const policy = parseJitPolicy(`TalonInc.com=${uuid}:recruiter, jit.example=${uuid}:admin,`);
    expect(policy.size).toBe(2);
    expect(policy.get('taloninc.com')).toEqual({ tenantId: uuid, role: 'recruiter' });
    expect(policy.get('jit.example')).toEqual({ tenantId: uuid, role: 'admin' });
  });

  /**
   * Every one of these throws rather than being ignored. A typo that silently
   * disabled the feature would leave an operator believing people are being
   * provisioned when they are not; a typo that silently widened it is worse. The
   * only outcome nobody can miss is a process that will not start.
   */
  it.each([
    ['no separator', `jit.example${uuid}:admin`],
    ['two separators', `jit.example=${uuid}:admin=x`],
    ['no role', `jit.example=${uuid}`],
    ['an unknown role', `jit.example=${uuid}:superuser`],
    ['a tenant name instead of a uuid', 'jit.example=Talon Inc.:admin'],
    ['a tenant slug instead of a uuid', 'jit.example=talon:admin'],
    ['a malformed uuid', 'jit.example=018f2c31-0000-7000-8000:admin'],
    ['a bare tld', `com=${uuid}:admin`],
    ['a wildcard', `*=${uuid}:admin`],
    ['a leading dot', `.example=${uuid}:admin`],
    ['an address rather than a domain', `me@jit.example=${uuid}:admin`],
    ['the same domain twice', `jit.example=${uuid}:admin,jit.example=${uuid}:member`],
  ])('refuses %s', (_why, raw) => {
    expect(() => parseJitPolicy(raw)).toThrow(/TALON_JIT_PROVISION/);
  });

  it('refuses to boot when the configured tenant does not exist', async () => {
    // Not at first sign-in: the person would get the exact 401 the feature was
    // turned on to remove, and nothing anywhere would say why.
    const config = testConfig({ jit: `jit.example=${uuid}:admin` });
    const container = buildContainer(config);
    try {
      await expect(buildApp({ config, container })).rejects.toThrow(
        /TALON_JIT_PROVISION names tenant .* and no such tenant exists/s,
      );
    } finally {
      await container.cradle.sql.end();
    }
  });

  it('boots when it does, and the tenant is readable as the app role', async () => {
    const config = testConfig({ jit: `jit.example=${fixtures.talon.tenantId}:admin` });
    const container = buildContainer(config);
    const app = await buildApp({ config, container });
    await app.close();
    await container.cradle.sql.end();
  });
});
