/**
 * POST /v1/auth/sso — federated sign-in (spec 004 §11).
 *
 * The hosted-UI round trip itself cannot be tested without Google. What CAN be, and
 * is, is everything after it: the id token is verified against the pool's JWKS, the
 * verified `sub` selects our `users` row, and the session that comes back is
 * indistinguishable from a password one. The stub signs real RS256 tokens, so the
 * verifier, the JWKS fetch and the claim checks all run for real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_TYPES, SignInResponseSchema } from '@talon/contracts';
import postgres from 'postgres';
import {
  dedicatedUser,
  loadFixtures,
  removeDedicatedUser,
  startApp,
  type Fixtures,
  type Person,
  type TestApp,
} from './helpers.js';
import { OWNER_URL } from './urls.js';

let test: TestApp;
let fixtures: Fixtures;
let sub: string;
/** This file's own user — see `dedicatedUser`. */
let owned: Person;
const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });

beforeAll(async () => {
  test = await startApp();
  fixtures = await loadFixtures();
  // Provisioning points `users.external_id` at the sub Cognito allocated — the join
  // this entire design rests on. On a user this file owns, so re-provisioning cannot
  // invalidate another suite's live session.
  const dedicated = await dedicatedUser(test, 'sso', {
    tenantId: fixtures.talon.tenantId,
    role: 'recruiter',
  });
  owned = dedicated.person;
  sub = dedicated.session.sub;
});

afterAll(async () => {
  await removeDedicatedUser(owned);
  await owner.end();
  await test.close();
});

const sso = (body: unknown) =>
  test.app.inject({ method: 'POST', url: '/v1/auth/sso', payload: body as object });

const idToken = (overrides = {}) => test.stub.mintIdToken(sub, owned.email, overrides);

describe('a completed Google flow', () => {
  it('returns a session indistinguishable from a password sign-in', async () => {
    const res = await sso({ idToken: idToken(), refreshToken: 'cognito-refresh-token' });
    expect(res.statusCode).toBe(200);

    // Parsed with the SAME schema the password path returns and the web callback
    // parses. A session that differed by how it was obtained is a session two code
    // paths have to handle forever.
    const session = SignInResponseSchema.parse(res.json());
    expect(session.user.email).toBe(owned.email);
    expect(session.tokenType).toBe('Bearer');
    // Cognito's refresh token, handed straight back: leaving the long-lived half under
    // Cognito's control is what makes a global sign-out actually end this session.
    expect(session.refreshToken).toBe('cognito-refresh-token');

    // And it actually works — the point of the endpoint is a usable session, not a
    // well-shaped payload.
    const board = await test.app.inject({
      method: 'GET',
      url: '/v1/jobs',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(board.statusCode).toBe(200);
  });

  it('mints claims naming the Cognito sub, not users.id', async () => {
    const res = await sso({ idToken: idToken(), refreshToken: 'r' });
    const claims = JSON.parse(
      Buffer.from(
        SignInResponseSchema.parse(res.json()).accessToken.split('.')[1]!,
        'base64url',
      ).toString(),
    );
    // `auth_user_by_sub` matches `external_id`; minting `users.id` here would sign in
    // cleanly and then 401 on the very next request.
    expect(claims.sub).toBe(sub);
    expect(claims.tenant_id).toBe(fixtures.talon.tenantId);
  });
});

describe('refusals', () => {
  it('refuses an access token presented as an id token', async () => {
    // `tokenUse: 'id'` is not optional. An access token is minted for a different
    // purpose, and accepting one here would take a credential for something else.
    const res = await sso({ idToken: idToken({ token_use: 'access' }), refreshToken: 'r' });
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERROR_TYPES.INVALID_TOKEN);
  });

  it('refuses a token minted for another audience', async () => {
    const res = await sso({ idToken: idToken({ aud: 'some-other-client' }), refreshToken: 'r' });
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERROR_TYPES.INVALID_TOKEN);
  });

  it('reports an expired token as expired, not as invalid', async () => {
    // The distinction is the client's: one is retryable by signing in again, the
    // other means something is wrong with the deployment.
    const past = Math.floor(Date.now() / 1000) - 7200;
    const res = await sso({ idToken: idToken({ iat: past, exp: past + 60 }), refreshToken: 'r' });
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERROR_TYPES.TOKEN_EXPIRED);
  });

  /**
   * The row that matters, and the one a generic handler would lose. "Your Google
   * sign-in worked; this workspace has no account for you" and "sign-in failed" send
   * a person to do completely different things, and only one of them can succeed.
   */
  it('reports a verified identity with no users row as not provisioned', async () => {
    const orphan = test.stub.mintIdToken(
      '00000000-0000-4000-8000-00000000dead',
      'nobody@taloninc.com',
    );
    const res = await sso({ idToken: orphan, refreshToken: 'r' });
    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe(ERROR_TYPES.USER_NOT_PROVISIONED);
  });

  it('refuses a session issued before tokens_valid_after', async () => {
    await owner`
      update users set tokens_valid_after = date_trunc('second', now() + interval '60 seconds')
      where id = ${owned.id}::uuid`;
    try {
      const res = await sso({ idToken: idToken(), refreshToken: 'r' });
      expect(res.statusCode).toBe(401);
      expect(res.json().type).toBe(ERROR_TYPES.TOKEN_INVALIDATED);
    } finally {
      await owner`update users set tokens_valid_after = null where id = ${owned.id}::uuid`;
    }
  });

  it('400s a body that is not the contract', async () => {
    expect((await sso({ idToken: idToken() })).statusCode).toBe(400);
    expect((await sso({ idToken: '', refreshToken: 'r' })).statusCode).toBe(400);
    expect((await sso({ idToken: idToken(), refreshToken: 'r', extra: 1 })).statusCode).toBe(400);
  });
});
