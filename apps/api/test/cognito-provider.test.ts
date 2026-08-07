/**
 * CognitoIdentityProvider end to end against a fake pool (see `cognito-stub.ts`).
 *
 * Nothing here is mocked in the `vi.mock` sense: the real AWS SDK serialises,
 * signs and sends real HTTP, the real `JwksVerifier` fetches and verifies a real
 * RS256 key set, and the real `users` table answers who the subject is. The only
 * substitution is where the packets go.
 *
 * The claims are the thing under test. Spec 001 §6.2 says the shape is identical
 * in both implementations and that `tenant_id`/`role` never live on the identity
 * provider — so the assertions below decode both providers' tokens and compare
 * them, and change a role in the database to prove which side is authoritative.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AwilixContainer } from 'awilix';
import postgres from 'postgres';
import { buildApp } from '../src/app.js';
import { loadConfig, type ApiConfig } from '../src/config.js';
import { buildContainer } from '../src/container.js';
import type { Cradle } from '../src/context.js';
import { IdentityFailure, type AuthResult } from '../src/modules/identity/provider.js';
import { CognitoStub, type IdTokenOverrides } from './cognito-stub.js';
import { APP_URL, OWNER_URL } from './urls.js';

const PASSWORD = 'correct-horse-battery-staple';
const EMAIL = 'cognito-probe@taloninc.com';

const stub = new CognitoStub();
let owner: postgres.Sql;
let userId: string;
let tenantId: string;
let cognito: Awaited<ReturnType<typeof buildStack>>;
let local: Awaited<ReturnType<typeof buildStack>>;

function buildStack(env: Record<string, string>): {
  config: ApiConfig;
  container: AwilixContainer<Cradle>;
  cradle: Cradle;
  close: () => Promise<void>;
} {
  const config = loadConfig({
    API_DATABASE_URL: APP_URL,
    TALON_JWT_SECRET: 'test-signing-key-not-the-published-default',
    ...env,
  });
  const container = buildContainer(config);
  return {
    config,
    container,
    cradle: container.cradle,
    close: () => container.cradle.sql.end(),
  };
}

/** Reads a JWT payload without verifying it — this is an assertion, not a check. */
function decode(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function authenticated(result: AuthResult): Extract<AuthResult, { status: 'authenticated' }> {
  if (result.status !== 'authenticated') throw new Error(`expected tokens, got ${result.status}`);
  return result;
}

/** Awaits a rejection and insists it is an IdentityFailure — never an SDK error. */
async function failureOf(work: Promise<unknown>): Promise<IdentityFailure> {
  try {
    await work;
  } catch (err) {
    if (err instanceof IdentityFailure) return err;
    throw new Error(`expected an IdentityFailure, got ${String(err)}`);
  }
  throw new Error('expected a rejection');
}

const setRole = (role: string): Promise<unknown> =>
  owner`update users set role = ${role} where id = ${userId}::uuid`;

const setExternalId = (value: string | null): Promise<unknown> =>
  owner`update users set external_id = ${value} where id = ${userId}::uuid`;

beforeAll(async () => {
  await stub.start();
  owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });

  // A user this file owns outright, in the seeded tenant. Mutating a seeded
  // person's role or external_id would leak into every other file — the suite
  // shares one database and runs serially.
  const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'talon'`;
  if (!tenant) throw new Error('seed is incomplete: no talon tenant');
  tenantId = tenant.id;
  userId = randomUUID();
  await owner`
    insert into users (id, tenant_id, email, name, role, timezone)
    values (${userId}::uuid, ${tenantId}::uuid, ${EMAIL}::citext, 'Cognito Probe', 'recruiter', 'UTC')`;

  cognito = buildStack({
    TALON_IDENTITY_PROVIDER: 'cognito',
    COGNITO_REGION: stub.region,
    COGNITO_USER_POOL_ID: stub.userPoolId,
    COGNITO_CLIENT_ID: stub.clientId,
  });
  local = buildStack({ TALON_IDENTITY_PROVIDER: 'local' });
});

afterAll(async () => {
  await cognito?.close();
  await local?.close();
  if (owner) {
    await owner`delete from local_identities where email = ${EMAIL}::citext`;
    await owner`delete from users where id = ${userId}::uuid`;
    await owner.end();
  }
  await stub.stop();
});

beforeEach(async () => {
  stub.users.clear();
  stub.refreshTokens.clear();
  stub.calls.length = 0;
  stub.authError = undefined;
  stub.nextIdTokenOverrides = undefined;
  await setRole('recruiter');
  await setExternalId(null);
});

/** Provisions in the fake pool and points the users row at the allocated sub. */
async function provision(): Promise<string> {
  const { sub } = await cognito.cradle.identityProvider.createUser({
    email: EMAIL,
    password: PASSWORD,
    // Local-only, and Cognito must ignore it: honouring it would mean claiming
    // a subject the IdP never issued.
    sub: userId,
  });
  await setExternalId(sub);
  return sub;
}

// ── container selection ────────────────────────────────────────────────────

it('selects the provider by configuration, with local as the default', () => {
  expect(cognito.config.auth.provider).toBe('cognito');
  expect(cognito.cradle.identityProvider.constructor.name).toBe('CognitoIdentityProvider');
  expect(local.config.auth.provider).toBe('local');
  expect(local.cradle.identityProvider.constructor.name).toBe('LocalIdentityProvider');
  // No env var at all is local — a clean clone with no AWS account still boots.
  expect(loadConfig({ API_DATABASE_URL: APP_URL }).auth.provider).toBe('local');
});

it.each(['Cognito', 'COGNITO', 'aws', ''])(
  'refuses to boot on an unrecognised provider name (%s)',
  (raw) => {
    expect(() =>
      loadConfig({ API_DATABASE_URL: APP_URL, TALON_IDENTITY_PROVIDER: raw }),
    ).toThrow(/TALON_IDENTITY_PROVIDER/);
  },
);

it.each(['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID'])(
  'refuses to boot as cognito without %s',
  (missing) => {
    const env: NodeJS.ProcessEnv = {
      API_DATABASE_URL: APP_URL,
      TALON_JWT_SECRET: 'test-signing-key-not-the-published-default',
      TALON_IDENTITY_PROVIDER: 'cognito',
      COGNITO_REGION: 'us-east-1',
      COGNITO_USER_POOL_ID: 'us-east-1_x',
      COGNITO_CLIENT_ID: 'client',
    };
    delete env[missing];
    // A pool-id typo must stop the process, not turn every login into a 500.
    expect(() => loadConfig(env)).toThrow(new RegExp(missing));
  },
);

it('refuses to run against a real pool with the published local signing key', () => {
  // Both providers mint the §6.2 bearer token with TALON_JWT_SECRET — Cognito
  // does not replace it. Falling back to the published constant here would let
  // anyone forge a token for any tenant and any role.
  expect(() =>
    loadConfig({
      API_DATABASE_URL: APP_URL,
      TALON_IDENTITY_PROVIDER: 'cognito',
      COGNITO_REGION: 'us-east-1',
      COGNITO_USER_POOL_ID: 'us-east-1_x',
      COGNITO_CLIENT_ID: 'client',
    }),
  ).toThrow(/TALON_JWT_SECRET/);
  // Local development is unaffected: no AWS, no secret needed.
  expect(loadConfig({ API_DATABASE_URL: APP_URL }).auth.secret).toBeTruthy();
});

// ── provisioning ───────────────────────────────────────────────────────────

it('lets Cognito allocate the sub and ignores the caller-supplied one', async () => {
  const sub = await provision();
  expect(sub).not.toBe(userId);
  expect(stub.users.get(EMAIL)?.sub).toBe(sub);
  // Created, then given a permanent password — otherwise the account sits in
  // FORCE_CHANGE_PASSWORD and every sign-in returns a challenge no screen answers.
  expect(stub.calls.map((call) => call.target)).toEqual(['AdminCreateUser', 'AdminSetUserPassword']);
  expect(stub.calls[1]?.body['Permanent']).toBe(true);
});

it('re-provisioning an existing person keeps the original sub', async () => {
  const first = await provision();
  stub.calls.length = 0;
  const { sub: second } = await cognito.cradle.identityProvider.createUser({
    email: EMAIL,
    password: 'a-different-password-entirely',
  });
  expect(second).toBe(first);
  expect(stub.calls.map((call) => call.target)).toEqual([
    'AdminCreateUser',
    'AdminGetUser',
    'AdminSetUserPassword',
  ]);
  // The new password took, which is what makes the seed script re-runnable.
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, 'a-different-password-entirely'),
  ).resolves.toMatchObject({ status: 'authenticated' });
});

// ── the claim shape (§6.2) ─────────────────────────────────────────────────

it('mints the §6.2 claim shape, identical to the local provider', async () => {
  await provision();
  const viaCognito = authenticated(
    await cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );

  // Same person, provisioned locally instead. external_id must go back to null:
  // migration 0004 resolves users.id only where there is no external subject.
  await setExternalId(null);
  await local.cradle.identityProvider.createUser({ email: EMAIL, password: PASSWORD, sub: userId });
  const viaLocal = authenticated(
    await local.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );

  const cognitoClaims = decode(viaCognito.tokens.accessToken);
  const localClaims = decode(viaLocal.tokens.accessToken);

  expect(Object.keys(cognitoClaims).sort()).toEqual([
    'aud',
    'email',
    'exp',
    'iat',
    'iss',
    'jti',
    'role',
    'sub',
    'tenant_id',
  ]);
  expect(Object.keys(cognitoClaims).sort()).toEqual(Object.keys(localClaims).sort());

  // Identical everywhere the shape is a promise. `jti` is unique per token by
  // construction, `iat`/`exp` are clocks, and `sub` names the IdP's subject —
  // which is the one claim that is SUPPOSED to differ, because it is the key
  // `auth_user_by_sub` resolves and the two providers key differently.
  for (const claim of ['email', 'tenant_id', 'role', 'iss', 'aud']) {
    expect(cognitoClaims[claim]).toEqual(localClaims[claim]);
  }
  expect(cognitoClaims['jti']).not.toBe(localClaims['jti']);
  expect(localClaims['sub']).toBe(userId);
  expect(cognitoClaims['sub']).toBe(stub.users.get(EMAIL)?.sub);
  expect(cognitoClaims['sub']).not.toBe(userId);
  expect(cognitoClaims).toMatchObject({
    email: EMAIL,
    tenant_id: tenantId,
    role: 'recruiter',
    aud: 'talon-api',
  });
  // The session payload the client sees is `users.id`-shaped either way, so the
  // web app cannot tell which provider is configured.
  expect(viaCognito.user).toEqual(viaLocal.user);
  expect(viaCognito.user.id).toBe(userId);
});

/**
 * The regression the first live run against a real pool produced, and the only
 * shape of test that could have caught it: sign-in and the request chain are
 * different code paths, and minting `users.id` as the subject passes the first
 * and fails the second. `auth_user_by_sub` resolves `users.id` ONLY where
 * `external_id is null` — deliberately, so revoking at the IdP cannot leave the
 * raw id working — and provisioning sets `external_id`.
 */
it('signs in AND then serves an authenticated request, over the whole chain', async () => {
  await provision();
  const app = await buildApp({ config: cognito.config, container: cognito.container });
  try {
    const signedIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
    const { accessToken } = signedIn.json<{ accessToken: string }>();

    const jobs = await app.inject({
      method: 'GET',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json<{ data: unknown[] }>().data.length).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

it('strips comp from an authenticated request when the role loses comp:read', async () => {
  await provision();
  const app = await buildApp({ config: cognito.config, container: cognito.container });
  try {
    const listAs = async (): Promise<Record<string, unknown>[]> => {
      const signedIn = await app.inject({
        method: 'POST',
        url: '/v1/auth/sign-in',
        payload: { email: EMAIL, password: PASSWORD },
      });
      const { accessToken } = signedIn.json<{ accessToken: string }>();
      const jobs = await app.inject({
        method: 'GET',
        url: '/v1/jobs',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return jobs.json<{ data: Record<string, unknown>[] }>().data;
    };

    const asRecruiter = await listAs();
    expect(asRecruiter.some((job) => 'band' in job)).toBe(true);

    // Comp gating reads the role from `users`, which is the only place it lives.
    await setRole('member');
    const asMember = await listAs();
    expect(asMember.some((job) => 'band' in job)).toBe(false);
  } finally {
    await app.close();
  }
});

it('reads tenant_id and role from OUR users table, not from Cognito', async () => {
  await provision();
  const before = decode(
    authenticated(await cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD))
      .tokens.accessToken,
  );
  expect(before['role']).toBe('recruiter');

  // Nothing changes at the identity provider — the pool has no role to change.
  await setRole('member');
  const after = decode(
    authenticated(await cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD))
      .tokens.accessToken,
  );
  expect(after['role']).toBe('member');
  expect(after['tenant_id']).toBe(tenantId);
  expect(after['sub']).toBe(before['sub']);
});

it('the bearer token means the same thing whichever provider is configured', async () => {
  const sub = await provision();
  const viaCognito = authenticated(
    await cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );
  // Both mint and verify with the same secret, issuer and audience — because it
  // is one function (`session.ts`). Verified by BOTH providers is the point: the
  // bearer token does not change meaning when the env var flips.
  for (const provider of [local, cognito]) {
    await expect(
      provider.cradle.identityProvider.verifyToken(viaCognito.tokens.accessToken),
    ).resolves.toMatchObject({ sub, email: EMAIL });
  }
});

it('refuses a bearer token it did not mint', async () => {
  await provision();
  await expect(cognito.cradle.identityProvider.verifyToken('not.a.token')).rejects.toMatchObject({
    code: 'invalid_token',
  });
  // A Cognito id token is not a bearer token here, which is what `aud` is for.
  const idToken = stub.mintIdToken(stub.users.get(EMAIL)?.sub ?? '', EMAIL);
  await expect(cognito.cradle.identityProvider.verifyToken(idToken)).rejects.toMatchObject({
    code: 'invalid_token',
  });
});

/**
 * Flipping TALON_IDENTITY_PROVIDER is an env change AND a re-provision, because
 * `users.external_id` is exclusive by design. The failure has to happen at the
 * door: before this guard the local provider minted a token that signed in
 * perfectly and then 401'd on every subsequent request, so the user saw
 * "signed in" immediately followed by "session invalid" and nothing named why.
 */
it('refuses a local sign-in for someone currently provisioned against Cognito', async () => {
  await local.cradle.identityProvider.createUser({ email: EMAIL, password: PASSWORD, sub: userId });
  await expect(
    local.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).resolves.toMatchObject({ status: 'authenticated' });

  // Now point the same person at Cognito. The stale local credential must stop
  // working, rather than minting an unusable token.
  await provision();
  await expect(
    local.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toMatchObject({ code: 'user_not_provisioned' });

  // Re-provisioning locally (what `seed:identities` does) restores it.
  await setExternalId(null);
  await expect(
    local.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).resolves.toMatchObject({ status: 'authenticated' });
});

// ── sign-in failure mapping ────────────────────────────────────────────────

it('does not reveal whether an account exists', async () => {
  await provision();
  const wrongPassword = await failureOf(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, 'wrong'),
  );
  const noSuchUser = await failureOf(
    cognito.cradle.identityProvider.initiatePasswordAuth('nobody@taloninc.com', PASSWORD),
  );
  // Identical code AND identical detail: a differing message is an enumeration
  // oracle just as surely as a differing status.
  expect(noSuchUser.code).toBe(wrongPassword.code);
  expect(noSuchUser.message).toBe(wrongPassword.message);
  expect(wrongPassword.code).toBe('invalid_credentials');
});

it.each([
  ['UserNotConfirmedException'],
  ['PasswordResetRequiredException'],
])('maps %s to invalid_credentials rather than leaking account state', async (error) => {
  await provision();
  stub.authError = error;
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toMatchObject({ code: 'invalid_credentials' });
});

it('does not swallow an error it has no answer for', async () => {
  await provision();
  stub.authError = 'TooManyRequestsException';
  // Deliberately NOT mapped: `IdentityFailureCode` has no `rate_limited`, so a
  // sustained throttle surfaces as a 500 where it should be a 429 with
  // `Retry-After`. Recorded as a known gap rather than papered over — inventing
  // the code here would give the local provider, which cannot throttle at all, a
  // failure mode it never produces.
  //
  // The SDK retries throttling itself (three attempts), so a transient throttle
  // never reaches this line. Only a sustained one does.
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.not.toBeInstanceOf(IdentityFailure);
  expect(stub.calls.filter((call) => call.target === 'AdminInitiateAuth').length).toBeGreaterThan(1);
});

it('authenticates a person Cognito knows but this deployment does not', async () => {
  await provision();
  await setExternalId(null); // the sub Cognito issued now points at nobody
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toMatchObject({ code: 'user_not_provisioned' });
});

// ── MFA challenges ─────────────────────────────────────────────────────────

it.each([['SOFTWARE_TOKEN_MFA'], ['SELECT_MFA_TYPE']])(
  'passes a %s challenge through as mfa_required',
  async (challenge) => {
    await provision();
    const user = stub.users.get(EMAIL);
    if (user) user.challenge = challenge;
    await expect(
      cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
    ).resolves.toEqual({ status: 'mfa_required', challenge: 'totp' });
  },
);

it('fails closed on MFA_SETUP', async () => {
  await provision();
  const user = stub.users.get(EMAIL);
  if (user) user.challenge = 'MFA_SETUP';
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toMatchObject({ code: 'mfa_not_enrolled' });
});

it('fails closed on a challenge this release cannot drive', async () => {
  await provision();
  const user = stub.users.get(EMAIL);
  if (user) user.challenge = 'NEW_PASSWORD_REQUIRED';
  const failure = await failureOf(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );
  expect(failure.code).toBe('invalid_credentials');
  // The detail says nothing about account state — the password was right.
  expect(failure.message).toBe('Email or password is incorrect.');
});

it('refuses to sign in when our table requires MFA and the pool did not challenge', async () => {
  await provision();
  await owner`update users set mfa_enabled = true where id = ${userId}::uuid`;
  try {
    await expect(
      cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
    ).rejects.toMatchObject({ code: 'mfa_not_enrolled' });
  } finally {
    await owner`update users set mfa_enabled = false where id = ${userId}::uuid`;
  }
});

// ── id token verification ──────────────────────────────────────────────────

const BAD_ID_TOKENS: [string, IdTokenOverrides][] = [
  ['a foreign issuer', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_evil' }],
  ['a foreign audience', { aud: 'someone-elses-client' }],
  ['an access token in the id token slot', { token_use: 'access' }],
  ['an unpublished signing key', { kid: 'kid-nobody-published' }],
];

it.each(BAD_ID_TOKENS)('refuses an id token with %s', async (_label, overrides) => {
  await provision();
  stub.nextIdTokenOverrides = overrides;
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toBeInstanceOf(IdentityFailure);
});

/**
 * Regression from the live run against a real pool: Cognito's clock was 2s ahead
 * of the machine verifying the token, and the verifier forgave nothing on a
 * future `iat`, so every sign-in 401'd with `token-not-yet-valid`. Zero leeway
 * is right for tokens we signed ourselves and wrong for a remote issuer's.
 */
it('tolerates a Cognito clock that runs a few seconds ahead of ours', async () => {
  await provision();
  const now = Math.floor(Date.now() / 1000);
  stub.nextIdTokenOverrides = { iat: now + 5, auth_time: now + 5, exp: now + 3605 };
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).resolves.toMatchObject({ status: 'authenticated' });
});

it('still refuses an id token minted far in the future', async () => {
  await provision();
  const now = Math.floor(Date.now() / 1000);
  stub.nextIdTokenOverrides = { iat: now + 3600, auth_time: now + 3600, exp: now + 7200 };
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toMatchObject({ code: 'token_not_yet_valid' });
});

it('refuses an expired id token and reports it as expiry', async () => {
  await provision();
  stub.nextIdTokenOverrides = {
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 3600,
  };
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toMatchObject({ code: 'token_expired' });
});

// ── refresh ────────────────────────────────────────────────────────────────

it('exchanges a Cognito refresh token for a fresh Talon access token', async () => {
  await provision();
  const first = authenticated(
    await cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );
  expect(first.tokens.refreshToken).toMatch(/^refresh-/);

  await setRole('admin');
  const second = authenticated(
    await cognito.cradle.identityProvider.refreshSession(first.tokens.refreshToken),
  );
  // Claims are re-read from `users`, never carried over from the old session.
  expect(decode(second.tokens.accessToken)['role']).toBe('admin');
  // Cognito returned no new refresh token (rotation off), so the old one is
  // carried forward rather than dropped.
  expect(second.tokens.refreshToken).toBe(first.tokens.refreshToken);
});

it('rejects a revoked refresh token as a token problem, not a password problem', async () => {
  await provision();
  await expect(
    cognito.cradle.identityProvider.refreshSession('refresh-never-issued'),
  ).rejects.toMatchObject({ code: 'invalid_token' });
});

it('honours tokens_valid_after against the session start, not the refresh time', async () => {
  await provision();
  const session = authenticated(
    await cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );
  await owner`update users set tokens_valid_after = now() + interval '1 hour' where id = ${userId}::uuid`;
  try {
    // `auth_time` is when the session began; comparing `iat` instead would
    // always pass, because a refresh's `iat` is always "now".
    await expect(
      cognito.cradle.identityProvider.refreshSession(session.tokens.refreshToken),
    ).rejects.toMatchObject({ code: 'invalid_token' });
  } finally {
    await owner`update users set tokens_valid_after = null where id = ${userId}::uuid`;
  }
});

// ── the gaps, stated as tests ──────────────────────────────────────────────

const TOTP_GAPS: [string, () => Promise<unknown>][] = [
  ['enrollTotp', () => cognito.cradle.identityProvider.enrollTotp('any-sub')],
  ['verifyTotp', () => cognito.cradle.identityProvider.verifyTotp('any-sub', '000000')],
];

it.each(TOTP_GAPS)('%s reports an operator fact, not an authentication failure', async (_l, call) => {
  // 501 via service.ts. Cognito's TOTP enrolment is session-scoped and the §6.1
  // signature carries a bare `sub` — a genuine gap in the interface, reported
  // rather than papered over.
  expect((await failureOf(call())).code).toBe('not_implemented');
});
