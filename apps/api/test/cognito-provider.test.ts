/**
 * CognitoIdentityProvider end to end against a fake pool (see `cognito-stub.ts`).
 *
 * Nothing here is mocked in the `vi.mock` sense: the real AWS SDK serialises,
 * signs and sends real HTTP, the real `JwksVerifier` fetches and verifies a real
 * RS256 key set, and the real `users` table answers who the subject is. The only
 * substitution is where the packets go — which is what lets `pnpm test` pass with
 * no AWS account at all, now that Cognito is the only identity provider.
 *
 * The claims are the thing under test. Spec 001 §6.2 fixes the shape and says
 * `tenant_id`/`role` never live on the identity provider — so the assertions
 * below decode the minted token and change a role in the database to prove which
 * side is authoritative. The side-by-side comparison against
 * `LocalIdentityProvider` went with the provider itself (spec 002 open question
 * 1); what survives it is the claim list, pinned literally, because `session.ts`
 * is now the only thing keeping that promise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { AwilixContainer } from 'awilix';
import postgres from 'postgres';
import { buildApp } from '../src/app.js';
import { LOCAL_JWT_SECRET, loadConfig, type ApiConfig } from '../src/config.js';
import { buildContainer } from '../src/container.js';
import type { Cradle } from '../src/context.js';
import { ERROR_TYPES } from '@talon/contracts';
import { retryAfterOf } from '../src/modules/identity/cognito-provider.js';
import { signJwt } from '../src/modules/identity/jwt.js';
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

/** A complete, valid environment. Every boot test below removes one thing from it. */
const COGNITO_ENV: NodeJS.ProcessEnv = {
  API_DATABASE_URL: APP_URL,
  TALON_JWT_SECRET: 'test-signing-key-not-the-published-default',
  COGNITO_REGION: 'us-east-1',
  COGNITO_USER_POOL_ID: 'us-east-1_x',
  COGNITO_CLIENT_ID: 'client',
};

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
    COGNITO_REGION: stub.region,
    COGNITO_USER_POOL_ID: stub.userPoolId,
    COGNITO_CLIENT_ID: stub.clientId,
  });
});

afterAll(async () => {
  await cognito?.close();
  if (owner) {
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
  stub.authErrorRetryAfter = undefined;
  stub.nextIdTokenOverrides = undefined;
  await setRole('recruiter');
  await setExternalId(null);
});

/** Provisions in the fake pool and points the users row at the allocated sub. */
async function provision(): Promise<string> {
  const { sub } = await cognito.cradle.identityProvider.createUser({
    email: EMAIL,
    password: PASSWORD,
  });
  await setExternalId(sub);
  return sub;
}

// ── container selection ────────────────────────────────────────────────────

it('Cognito is the only provider, and it is not selected by a flag', () => {
  expect(cognito.cradle.identityProvider.constructor.name).toBe('CognitoIdentityProvider');
  expect(cognito.config.auth.cognito).toEqual({
    region: stub.region,
    userPoolId: stub.userPoolId,
    clientId: stub.clientId,
  });
});

it.each(['local', 'Cognito', 'COGNITO', 'aws', ''])(
  'refuses to boot on TALON_IDENTITY_PROVIDER=%s',
  (raw) => {
    // `local` is in this list on purpose. A stale value in somebody's .env has to
    // fail loudly: silently running Cognito while the configuration says
    // otherwise is the same class of mistake the old "anything that is not
    // cognito is local" coercion caused, pointing the other way.
    expect(() => loadConfig({ ...COGNITO_ENV, TALON_IDENTITY_PROVIDER: raw })).toThrow(
      /TALON_IDENTITY_PROVIDER/,
    );
  },
);

it.each(['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_REGION'])(
  'refuses to boot without %s — there is no fallback to degrade to',
  (missing) => {
    const env: NodeJS.ProcessEnv = { ...COGNITO_ENV };
    delete env[missing];
    // A pool-id typo must stop the process, not turn every login into a 500 —
    // and a missing one must not start a deployment that cannot authenticate.
    expect(() => loadConfig(env)).toThrow(new RegExp(missing));
  },
);

it.each(['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_REGION', 'TALON_JWT_SECRET'])(
  'treats whitespace in %s as unset',
  (blanked) => {
    expect(() => loadConfig({ ...COGNITO_ENV, [blanked]: '   ' })).toThrow(new RegExp(blanked));
  },
);

it('refuses to run with the published local signing key', () => {
  // Talon mints the §6.2 bearer token with TALON_JWT_SECRET — Cognito proves the
  // credential but does not replace this key. Signing with the constant
  // published in this repository would let anyone forge a token for any tenant
  // and any role.
  const withoutSecret: NodeJS.ProcessEnv = { ...COGNITO_ENV };
  delete withoutSecret['TALON_JWT_SECRET'];
  expect(() => loadConfig(withoutSecret)).toThrow(/TALON_JWT_SECRET/);

  // The case the title actually claims: supplying the published constant
  // explicitly must be refused too. A presence-only guard passes the assertion
  // above while leaving every token forgeable, so this is the one that matters.
  // The padded variants are the ones that actually shipped broken: the guard
  // trimmed to decide "is it set" but compared the untrimmed value, so a trailing
  // newline — how this variable is usually set — defeated the blocklist entirely.
  for (const secret of [
    LOCAL_JWT_SECRET,
    `${LOCAL_JWT_SECRET}\n`,
    `  ${LOCAL_JWT_SECRET}  `,
    `\t${LOCAL_JWT_SECRET}`,
    ' ',
    '\t\n',
  ]) {
    expect(
      () => loadConfig({ ...COGNITO_ENV, TALON_JWT_SECRET: secret }),
      JSON.stringify(secret),
    ).toThrow(/TALON_JWT_SECRET/);
  }
  // A real key is accepted, so the guard is not simply refusing everything.
  expect(loadConfig({ ...COGNITO_ENV, TALON_JWT_SECRET: 'a-real-key' }).auth.secret).toBe(
    'a-real-key',
  );
});

// ── provisioning ───────────────────────────────────────────────────────────

it('lets Cognito allocate the sub, which is never users.id', async () => {
  const sub = await provision();
  // `CreateUserInput` no longer carries a caller-supplied subject at all, and
  // this is the assertion that says why: the subject belongs to the IdP.
  expect(sub).not.toBe(userId);
  expect(stub.users.get(EMAIL)?.sub).toBe(sub);
  // Created, then given a permanent password — otherwise the account sits in
  // FORCE_CHANGE_PASSWORD and every sign-in returns a challenge no screen answers.
  expect(stub.calls.map((call) => call.target)).toEqual([
    'AdminCreateUser',
    'AdminSetUserPassword',
  ]);
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

it('mints exactly the §6.2 claim set and nothing else', async () => {
  await provision();
  const signedIn = authenticated(
    await cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );
  const claims = decode(signedIn.tokens.accessToken);

  // Pinned literally, in both directions. With one provider left there is no
  // second token to diff against, so this list IS the §6.2 contract: a claim
  // added to `session.ts` fails here, and so does one removed. `toEqual` on the
  // sorted key set is deliberate — `toMatchObject` would let an extra claim
  // (say, a leaked `password_hash` or a Cognito group list) through unnoticed.
  expect(Object.keys(claims).sort()).toEqual([
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
  expect(claims).toMatchObject({
    email: EMAIL,
    tenant_id: tenantId,
    role: 'recruiter',
    aud: 'talon-api',
  });

  // The subject is the IdP's, never `users.id` — see `session.ts`. This is the
  // one value that is provider-specific (spec 001 §6.2's nuance).
  expect(claims['sub']).toBe(stub.users.get(EMAIL)?.sub);
  expect(claims['sub']).not.toBe(userId);

  // The session payload the client sees stays `users.id`-shaped, so nothing in
  // apps/web has to know which provider issued the credential.
  expect(signedIn.user.id).toBe(userId);
  expect(signedIn.user).toEqual({
    id: userId,
    tenantId,
    email: EMAIL,
    name: 'Cognito Probe',
    role: 'recruiter',
    timezone: 'UTC',
  });
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

it('verifies the bearer token it just minted', async () => {
  const sub = await provision();
  const signedIn = authenticated(
    await cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );
  // Minting and verification are separate code paths that only agree because
  // they read the same `AuthConfig`; a mismatch in secret, issuer or audience is
  // a deployment that signs people in and then 401s them.
  await expect(
    cognito.cradle.identityProvider.verifyToken(signedIn.tokens.accessToken),
  ).resolves.toMatchObject({ sub, email: EMAIL });
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
 * `users.external_id` is exclusive by design (migration 0004), so a person whose
 * row does not point at the subject Cognito issued cannot sign in — and the
 * failure has to happen AT THE DOOR. Before this guard, sign-in minted a token
 * that worked once and then 401'd on every subsequent request, so the user saw
 * "signed in" immediately followed by "session invalid" and nothing named why.
 *
 * The half of this that used to be demonstrated by flipping to the local
 * provider is now demonstrated by pointing `external_id` at the wrong subject,
 * which is the same state a half-finished re-provision leaves behind.
 */
it('refuses a sign-in whose subject our users table does not point at', async () => {
  await provision();
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).resolves.toMatchObject({ status: 'authenticated' });

  // A stale external_id — an old pool's sub, or a re-provision that wrote the
  // credential and died before the users update.
  await setExternalId(randomUUID());
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toMatchObject({ code: 'user_not_provisioned' });

  // `users.id` is NOT a fallback subject once external_id is set to anything —
  // that exclusivity is what stops IdP revocation being toothless.
  await setExternalId(userId);
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.toMatchObject({ code: 'user_not_provisioned' });

  // Re-running `seed:identities` restores it.
  await provision();
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).resolves.toMatchObject({ status: 'authenticated' });
});

// ── a non-UUID subject (spec 002 open question 2) ───────────────────

/**
 * `users.external_id` is `text` rather than `uuid` on purpose (migration 0004):
 * a SAML persistent `NameID` is opaque and case-sensitive, and is not a UUID.
 * `AccessTokenClaimsSchema.sub` used to be `z.string().uuid()`, which would have
 * refused one at `verifyToken` — i.e. the SAML work would have found out in the
 * file that validates every bearer token, under time pressure.
 *
 * Driven end to end rather than through the schema, because the schema is only
 * one of three places the subject has to survive: the id token, the mint, and
 * `auth_user_by_sub`.
 */
it('signs in and serves a request for a subject that is not a UUID', async () => {
  const samlSubject = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent!Talon!aB3-x_9~Z';
  stub.addUser(EMAIL, PASSWORD, samlSubject);
  await setExternalId(samlSubject);

  const app = await buildApp({ config: cognito.config, container: cognito.container });
  try {
    const signedIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(signedIn.statusCode).toBe(200);
    const { accessToken } = signedIn.json<{ accessToken: string }>();
    expect(decode(accessToken)['sub']).toBe(samlSubject);

    // The half a schema test cannot cover: the subject has to survive the mint,
    // `verifyToken`, and `auth_user_by_sub`'s exact-match lookup.
    const jobs = await app.inject({
      method: 'GET',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(jobs.statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it.each([
  ['empty', ''],
  ['whitespace only', '   '],
  ['a tab and a newline', ' \t\n '],
  ['longer than users_external_id_ck allows', 'a'.repeat(1025)],
  ['carrying a NUL', 'sub\u0000injected'],
  ['carrying a newline', 'sub\nSet-Cookie: x=1'],
])('refuses a bearer token whose subject is %s', async (_label, subject) => {
  // Loosening `sub` must not mean accepting anything. A blank subject would make
  // `external_id = ''` resolvable, an unbounded one is an attacker-controlled
  // string travelling further into the system than it can ever match, and a
  // control character in a value that reaches audit rows and log lines is a
  // classic injection vector.
  const token = signJwt(
    {
      sub: subject,
      email: EMAIL,
      tenant_id: tenantId,
      role: 'recruiter',
      iss: cognito.config.auth.issuer,
      aud: cognito.config.auth.audience,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: 'subject-probe',
    },
    cognito.config.auth.secret,
  );
  await expect(cognito.cradle.identityProvider.verifyToken(token)).rejects.toMatchObject({
    code: 'invalid_token',
  });
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

it.each([['UserNotConfirmedException'], ['PasswordResetRequiredException']])(
  'maps %s to invalid_credentials rather than leaking account state',
  async (error) => {
    await provision();
    stub.authError = error;
    await expect(
      cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  },
);

it.each(['TooManyRequestsException', 'ThrottlingException'])(
  'maps a sustained %s to rate_limited, after the SDK has retried',
  async (error) => {
    await provision();
    stub.authError = error;
    const failure = await failureOf(
      cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
    );
    expect(failure.code).toBe('rate_limited');
    // The SDK retries throttling itself, so a TRANSIENT throttle never reaches
    // the mapping at all — only a sustained one does. Asserting the retry
    // happened is what keeps this a test of the real client rather than of a
    // double: `stub.authError` is sticky for exactly this reason.
    expect(stub.calls.filter((call) => call.target === 'AdminInitiateAuth').length).toBeGreaterThan(
      1,
    );
  },
);

it('reads the service’s own Retry-After off the deserialised error', async () => {
  await provision();
  stub.authError = 'TooManyRequestsException';
  // Small, deliberately: the SDK honours `retry-after` in its OWN backoff, so a
  // large value here would be a multi-second sleep inside the suite. What this
  // proves is the one thing a unit test cannot — that the header survives the
  // SDK's deserialiser and is reachable on the error. The clamping rules are
  // asserted below, where they cost nothing.
  stub.authErrorRetryAfter = '2';
  const failure = await failureOf(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  );
  expect(failure.code).toBe('rate_limited');
  expect(failure.retryAfterSeconds).toBe(2);
});

it.each([
  ['absent', undefined, 5],
  ['unparseable', 'soon', 5],
  // RFC 9110 also permits an HTTP-date. Cognito does not send one, and inventing
  // a parse for it would mean emitting a header shape we have never seen.
  ['an HTTP-date', 'Wed, 21 Oct 2015 07:28:00 GMT', 5],
  ['zero — which would invite the retry storm the throttle exists to stop', '0', 1],
  ['negative', '-30', 1],
  ['a day, which would take the sign-in screen out for a day', '86400', 300],
  ['fractional', '7.9', 7],
  ['ordinary', '30', 30],
])('Retry-After %s becomes %s → %ds', (_label, header, expected) => {
  const error = header === undefined ? {} : { $response: { headers: { 'retry-after': header } } };
  expect(retryAfterOf(error)).toBe(expected);
});

it.each(['LimitExceededException', 'TooManyFailedAttemptsException'])(
  'reports a per-account limit (%s) as invalid_credentials, not as throttling',
  async (error) => {
    await provision();
    stub.authError = error;
    // A per-ACCOUNT limit is account state, and account state is only reachable
    // for an account that exists. A distinguishable answer here would turn
    // lockout into an enumeration oracle — so it gets the same answer a wrong
    // password does, message included.
    const failure = await failureOf(
      cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
    );
    expect(failure.code).toBe('invalid_credentials');
    expect(failure.message).toBe('Email or password is incorrect.');
  },
);

it('does not swallow an error it has no answer for', async () => {
  await provision();
  stub.authError = 'InternalErrorException';
  // Not every AWS error is an authentication failure. One the adapter has no
  // mapping for is a bug or an outage, and dressing it as a 401 would send a
  // user to retype a password that was fine.
  await expect(
    cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
  ).rejects.not.toBeInstanceOf(IdentityFailure);
});

it('a throttled sign-in is a 429 with Retry-After, over the whole chain', async () => {
  await provision();
  const app = await buildApp({ config: cognito.config, container: cognito.container });
  try {
    // No `retry-after` from the service, which is the common case: the client
    // still gets a number, because a 429 without one leaves every caller to
    // invent its own backoff and the ones that invent "immediately" are what
    // turn a throttle into an outage.
    stub.authError = 'TooManyRequestsException';
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['retry-after']).toBe('5');
    // Also in the body: `Retry-After` is not CORS-safelisted, so a cross-origin
    // browser client cannot read the header without extra server configuration.
    expect(response.json()).toMatchObject({
      type: ERROR_TYPES.RATE_LIMITED,
      status: 429,
      retryAfter: 5,
    });
    // Not a 401, which would have sent the user to retype a correct password,
    // and not a 500, which is what this was before `rate_limited` existed.
    expect(response.statusCode).not.toBe(401);
  } finally {
    await app.close();
  }
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
    ).rejects.toMatchObject({ code: 'token_invalidated' });
  } finally {
    await owner`update users set tokens_valid_after = null where id = ${userId}::uuid`;
  }
});

// ── tokens_valid_after at the door ─────────────────────────────────────────

/**
 * The gap this closes: `tokens_valid_after` was enforced on every request and at
 * refresh, but not at SIGN-IN. A cut-off in the future — an admin suspending an
 * account until Monday — therefore produced a 200 with a token that 401'd on the
 * very next call. "Signed in", immediately followed by "session invalid", with
 * nothing naming the cause: the same shape as the `external_id` bug above, and
 * the same fix.
 */
it('refuses a sign-in that would mint a token the next request will reject', async () => {
  await provision();
  await owner`update users set tokens_valid_after = now() + interval '1 hour' where id = ${userId}::uuid`;
  try {
    const failure = await failureOf(
      cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
    );
    expect(failure.code).toBe('token_invalidated');
    // The detail must not say when the cut-off lifts: that is account state, and
    // this response is the one place it would be visible.
    expect(failure.message).not.toMatch(/\d/);
  } finally {
    await owner`update users set tokens_valid_after = null where id = ${userId}::uuid`;
  }
});

it('a cut-off in the past is a cut-off, not a ban — signing in again works', async () => {
  await provision();
  // The ordinary revocation case: everything issued before now is dead, and the
  // user fixes it by signing in. If this failed, `tokens_valid_after` would be
  // an account lock with no way back.
  await owner`update users set tokens_valid_after = now() - interval '1 minute' where id = ${userId}::uuid`;
  try {
    await expect(
      cognito.cradle.identityProvider.initiatePasswordAuth(EMAIL, PASSWORD),
    ).resolves.toMatchObject({ status: 'authenticated' });
  } finally {
    await owner`update users set tokens_valid_after = null where id = ${userId}::uuid`;
  }
});

it('the door and the next request agree — 401 at sign-in, never 200 then 401', async () => {
  await provision();
  const app = await buildApp({ config: cognito.config, container: cognito.container });
  try {
    await owner`update users set tokens_valid_after = now() + interval '1 hour' where id = ${userId}::uuid`;
    const signIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json<{ type: string }>().type).toBe(ERROR_TYPES.TOKEN_INVALIDATED);
    // The same type `resolveTenant` answers with, because it is the same
    // condition — one predicate, in session.ts, called from both.
    expect(signIn.body).not.toContain('accessToken');
  } finally {
    await owner`update users set tokens_valid_after = null where id = ${userId}::uuid`;
    await app.close();
  }
});

// ── the gaps, stated as tests ──────────────────────────────────────────────

const TOTP_GAPS: [string, () => Promise<unknown>][] = [
  ['enrollTotp', () => cognito.cradle.identityProvider.enrollTotp('any-sub')],
  ['verifyTotp', () => cognito.cradle.identityProvider.verifyTotp('any-sub', '000000')],
];

it.each(TOTP_GAPS)(
  '%s reports an operator fact, not an authentication failure',
  async (_l, call) => {
    // 501 via service.ts. Cognito's TOTP enrolment is session-scoped and the §6.1
    // signature carries a bare `sub` — a genuine gap in the interface, reported
    // rather than papered over.
    expect((await failureOf(call())).code).toBe('not_implemented');
  },
);
