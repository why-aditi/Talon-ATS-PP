/**
 * The request chain end to end (spec 001 §6.3) and the edge cases that hang off
 * it: §9 edge case 1 (authenticated but not provisioned) and §9 edge case 9
 * (clock skew), plus `tokens_valid_after`.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ERROR_TYPES } from '@talon/contracts';
import postgres from 'postgres';
import { signJwt } from '../src/modules/identity/jwt.js';
import {
  bearer,
  loadFixtures,
  signIn,
  startApp,
  testConfig,
  TEST_PASSWORD,
  type Fixtures,
  type Session,
  type TestApp,
} from './helpers.js';
import { OWNER_URL } from './urls.js';

let test: TestApp;
let fixtures: Fixtures;
let session: Session;

const auth = testConfig().auth;
const now = () => Math.floor(Date.now() / 1000);

/** Mints a token the api will accept the signature of, with claims we choose. */
function mint(claims: Record<string, unknown>): string {
  return signJwt(
    {
      sub: fixtures.talon.recruiter.id,
      email: fixtures.talon.recruiter.email,
      tenant_id: fixtures.talon.tenantId,
      role: 'recruiter',
      iss: auth.issuer,
      aud: auth.audience,
      iat: now(),
      exp: now() + auth.accessTtlSeconds,
      jti: 'test-jti',
      ...claims,
    },
    auth.secret,
  );
}

const get = (token: string) =>
  test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${fixtures.talon.jobId}`,
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  session = await signIn(test, fixtures.talon.recruiter);
});

afterAll(async () => {
  await test.close();
});

// ── acceptance 1 ───────────────────────────────────────────────────────────

it('a protected route without credentials is 401', async () => {
  const res = await test.app.inject({ method: 'GET', url: `/v1/jobs/${fixtures.talon.jobId}` });
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.UNAUTHENTICATED);
});

it('a signed-in caller reaches the handler', async () => {
  const res = await test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${fixtures.talon.jobId}`,
    headers: bearer(session),
  });
  expect(res.statusCode).toBe(200);
});

it.each([
  ['no scheme', 'abc.def.ghi'],
  ['wrong scheme', 'Basic abc.def.ghi'],
  ['bearer with no token', 'Bearer'],
  ['two tokens', 'Bearer a.b.c d.e.f'],
])('a malformed Authorization header (%s) is 401', async (_label, header) => {
  const res = await test.app.inject({
    method: 'GET',
    url: `/v1/jobs/${fixtures.talon.jobId}`,
    headers: { authorization: header },
  });
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.UNAUTHENTICATED);
});

it('a token signed with the wrong key is 401 invalid-token, not expired', async () => {
  const forged = signJwt({ sub: fixtures.talon.recruiter.id }, 'not-the-signing-key');
  const res = await get(forged);
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.INVALID_TOKEN);
});

it('a refresh token is not a bearer token', async () => {
  // Different audience, same signature — the check that stops a 30-day token
  // being used as an access token for 30 days.
  const res = await get(session.refreshToken);
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.INVALID_TOKEN);
});

// ── §9 edge case 9: clock skew ─────────────────────────────────────────────

it('an access token 30s past exp still works — 60s of leeway', async () => {
  const res = await get(mint({ iat: now() - 3660, exp: now() - 30 }));
  expect(res.statusCode).toBe(200);
});

it('an access token 90s past exp is rejected as expired', async () => {
  const res = await get(mint({ iat: now() - 3700, exp: now() - 90 }));
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.TOKEN_EXPIRED);
});

it('an access token dated in the future is rejected with no leeway at all', async () => {
  const res = await get(mint({ iat: now() + 5 }));
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.TOKEN_NOT_YET_VALID);
});

// ── §9 edge case 1: authenticated but not provisioned ──────────────────────

it('a valid token whose subject has no users row is 401 with a distinct type', async () => {
  const orphan = mint({
    sub: '00000000-0000-0000-0000-0000000000ff',
    email: 'ghost@taloninc.com',
  });
  const res = await get(orphan);
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.USER_NOT_PROVISIONED);
  // Not a crash, and not the same answer as a bad token.
  expect(res.json<{ type: string }>().type).not.toBe(ERROR_TYPES.INVALID_TOKEN);
});

it('a token whose tenant_id disagrees with the users row is refused', async () => {
  const res = await get(mint({ tenant_id: fixtures.acme.tenantId }));
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.INVALID_TOKEN);
});

// ── tokens_valid_after: invalidation before expiry ─────────────────────────

it('a token issued before users.tokens_valid_after is refused while still unexpired', async () => {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const token = mint({ iat: now() - 120 });
    // Sanity: accepted before the switch is thrown.
    expect((await get(token)).statusCode).toBe(200);

    // A cut-off 60s in the past: after the old token's `iat` (now − 120s) and
    // comfortably before the fresh one's. Deliberately not `now()` — `iat` has
    // second resolution and the api's clock is not the database's, so an
    // instant cut-off makes this assertion a race rather than a test.
    await sql`update users set tokens_valid_after = date_trunc('second', now() - interval '60 seconds')
              where id = ${fixtures.talon.recruiter.id}::uuid`;
    const after = await get(token);
    expect(after.statusCode).toBe(401);
    expect(after.json<{ type: string }>().type).toBe(ERROR_TYPES.TOKEN_INVALIDATED);

    // A token issued now is fine — invalidation is a cut-off, not a ban.
    const fresh = await test.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: fixtures.talon.recruiter.email, password: TEST_PASSWORD },
    });
    expect(fresh.statusCode).toBe(200);
    expect((await get(fresh.json<Session>().accessToken)).statusCode).toBe(200);
  } finally {
    await sql`update users set tokens_valid_after = null where id = ${fixtures.talon.recruiter.id}::uuid`;
    await sql.end();
  }
});

// ── sign-in and refresh ────────────────────────────────────────────────────

it('sign-in with a wrong password is 401 and says nothing about the account', async () => {
  const res = await test.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email: fixtures.talon.recruiter.email, password: 'not the password' },
  });
  const unknown = await test.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email: 'nobody@taloninc.com', password: 'not the password' },
  });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toMatchObject({ type: ERROR_TYPES.INVALID_CREDENTIALS });
  // Identical answers: anything else is an account-enumeration oracle.
  expect(unknown.statusCode).toBe(res.statusCode);
  expect(unknown.json<{ type: string }>().type).toBe(res.json<{ type: string }>().type);
});

it('sign-in rejects a malformed body with a 400 problem carrying field errors', async () => {
  const res = await test.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email: 'not-an-email', password: '' },
  });
  expect(res.statusCode).toBe(400);
  const body = res.json<{ type: string; errors: { path: string }[] }>();
  expect(body.type).toBe(ERROR_TYPES.VALIDATION_FAILED);
  expect(body.errors.map((e) => e.path).sort()).toEqual(['email', 'password']);
});

it('sign-in rejects unknown fields rather than ignoring them', async () => {
  const res = await test.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    payload: { email: fixtures.talon.recruiter.email, password: TEST_PASSWORD, role: 'admin' },
  });
  expect(res.statusCode).toBe(400);
});

it('refresh returns a new access token and a new refresh token (sliding)', async () => {
  const res = await test.app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refreshToken: session.refreshToken },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ accessToken: string; refreshToken: string; expiresIn: number }>();
  expect(body.expiresIn).toBe(3600);
  expect(body.refreshToken).not.toBe(session.refreshToken);
  expect((await get(body.accessToken)).statusCode).toBe(200);
});

it('an access token cannot be redeemed at the refresh endpoint', async () => {
  const res = await test.app.inject({
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: { refreshToken: session.accessToken },
  });
  expect(res.statusCode).toBe(401);
  expect(res.json<{ type: string }>().type).toBe(ERROR_TYPES.INVALID_TOKEN);
});
