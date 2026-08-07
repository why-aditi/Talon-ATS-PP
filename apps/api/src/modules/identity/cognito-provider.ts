/**
 * CognitoIdentityProvider — the AWS implementation of the §6.1 seam.
 *
 * Concrete class: importable only from inside `modules/identity/`. Everything
 * else resolves `identityProvider` from the container and sees the interface.
 *
 * ── The design decision, and why ───────────────────────────────────────────
 *
 * §6.2 fixes one claim shape for every implementation, and says `tenant_id` and
 * `role` are never stored on the identity provider: locally the stub reads them
 * from `users` at sign-in, and in AWS the pre-token-generation Lambda does the
 * same. **That Lambda does not exist yet.** A raw Cognito token therefore
 * carries no `tenant_id` and no `role`, and CLAUDE.md §4 forbids the obvious
 * shortcut — a custom pool attribute is immutable, forces a pool replacement on
 * any schema diff, and destroys every user with it.
 *
 * So: **Cognito is the credential authority, Talon is the session authority.**
 *
 *   sign-in → AdminInitiateAuth proves the password to Cognito
 *           → verify the returned id token against the pool's JWKS (RS256)
 *           → the verified `sub` selects our `users` row, via
 *             `users.external_id` (migration 0004)
 *           → we mint the §6.2 access token from that row, with `session.ts`,
 *             the same function the local provider calls, carrying the Cognito
 *             `sub` as its subject
 *
 * That last clause is load-bearing and cost a live-run failure to learn:
 * `auth_user_by_sub` resolves `users.id` only where `external_id is null`, so a
 * Cognito-provisioned person is NOT reachable by their `users.id`. See
 * `session.ts`.
 *
 * The alternative — accept Cognito's own token as the bearer token and
 * synthesise `tenant_id`/`role` into `VerifiedIdentity.claims` from a database
 * read inside `verifyToken` — was rejected for three reasons:
 *
 *   1. It would make `service.resolveAuthenticatedUser`'s tenant check
 *      (`user.tenantId !== identity.claims.tenant_id`) compare the database
 *      against itself. A real check would become a tautology while still
 *      looking like a check, which is the worst possible outcome for a tenancy
 *      guard.
 *   2. Cognito's *access* token carries no `email`, so it would have to be the
 *      *id* token presented as a bearer token — an id token is minted for a
 *      client, not for an API, and using one as an access token is the exact
 *      confusion `aud` exists to prevent.
 *   3. "The claims" would no longer be the token's claims. Acceptance 1 asks to
 *      decode a token and compare; a synthesised object is not decodable from
 *      anything and cannot be compared to anything.
 *
 * ── What this means when the Lambda lands ─────────────────────────────────
 *
 * The Lambda's job is to put `tenant_id` and `role` into Cognito's token,
 * reading them from the same `users` row this file reads. When it exists, this
 * adapter stops minting: `initiatePasswordAuth` returns Cognito's access token
 * directly and `verifyToken` runs `JwksVerifier` with `tokenUse: 'access'` and
 * `audience` = the pool's client id, instead of `verifyJwt`. Two consequences
 * to plan for, both real and both cheap to state now:
 *
 *   - The bearer token's `sub` ALREADY holds the Cognito sub rather than
 *     `users.id` (see above), so the Lambda changes nothing here. Anything that
 *     assumes `claims.sub === users.id` is wrong today, not later. Nothing does
 *     — `resolveAuthenticatedUser` goes through `auth_user_by_sub` — and that
 *     should stay true.
 *   - `aud` becomes the app-client id and `iss` the pool URL, so
 *     `AuthConfig.audience`/`issuer` become provider-derived rather than fixed
 *     constants. The schema already permits it (`aud` is `z.string().min(1)`,
 *     not a literal), which was foresight worth keeping.
 *   - `AccessTokenClaimsSchema.sub` is `z.string().uuid()`. A Cognito sub is a
 *     UUID so that holds, but `users.external_id` is `text` for a future SAML
 *     NameID, and that contract has to loosen before a non-UUID subject works.
 *
 * Scaffolding vs permanent, stated plainly:
 *   - PERMANENT: `JwksVerifier`, the provisioning order (Cognito allocates the
 *     sub → `users.external_id` points at it), the IdP subject travelling into
 *     the token's `sub`, the failure mapping, the challenge handling,
 *     `session.ts` as the single claim-shape source.
 *   - M0b SCAFFOLDING: minting our own access token from a Cognito sign-in.
 *     It goes away with the Lambda. It is confined to this file plus the two
 *     `issueAccessToken` calls, and it changes no interface.
 */
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  type AdminInitiateAuthCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';
import { AccessTokenClaimsSchema } from '@talon/contracts';
import type { AuthConfig, CognitoConfig } from '../../config.js';
import { JwtError, nowSeconds, verifyJwt } from './jwt.js';
import { JwksVerifier } from './jwks.js';
import {
  IdentityFailure,
  type AuthResult,
  type CreateUserInput,
  type IdentityProvider,
  type VerifiedIdentity,
} from './provider.js';
import type { IdentityRepository, UserRecord } from './repository.js';
import { issueAccessToken, toSessionUser } from './session.js';

function failureFor(error: JwtError): IdentityFailure {
  switch (error.failure) {
    case 'expired':
      return new IdentityFailure('token_expired', 'The access token has expired.');
    case 'not_yet_valid':
      return new IdentityFailure('token_not_yet_valid', 'The token is dated in the future.');
    default:
      return new IdentityFailure('invalid_token', 'The token could not be verified.');
  }
}

/**
 * Every Cognito error class carries a `name`, and the SDK exports a class per
 * error — but only for the ones it models. Matching on `name` covers both, and
 * covers an error the installed SDK version does not know about yet.
 */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/**
 * Sign-in failures that must be indistinguishable to the caller. `UserNotFound`
 * is in here for the same reason the local provider burns a hash verification on
 * an unknown email: anything else is an account-enumeration oracle. (The pool
 * also sets `PreventUserExistenceErrors`, but that only covers the unauthenticated
 * `InitiateAuth`; the admin flows answer honestly and we have to not pass it on.)
 */
const CREDENTIAL_FAILURES = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
]);

export class CognitoIdentityProvider implements IdentityProvider {
  readonly #repository: IdentityRepository;
  readonly #config: AuthConfig;
  readonly #cognito: CognitoConfig;
  readonly #client: CognitoIdentityProviderClient;
  readonly #idTokens: JwksVerifier;

  constructor({
    identityRepository,
    authConfig,
    cognitoConfig,
  }: {
    identityRepository: IdentityRepository;
    authConfig: AuthConfig;
    cognitoConfig: CognitoConfig;
  }) {
    this.#repository = identityRepository;
    this.#config = authConfig;
    this.#cognito = cognitoConfig;
    // Credentials come from the SDK's own chain — the ECS task role in AWS, the
    // ambient profile locally. Nothing here reads a key: an access key in
    // config is a key in an environment variable in a task definition.
    this.#client = new CognitoIdentityProviderClient({ region: cognitoConfig.region });
    const issuer = `https://cognito-idp.${cognitoConfig.region}.amazonaws.com/${cognitoConfig.userPoolId}`;
    this.#idTokens = new JwksVerifier({
      jwksUri: `${issuer}/.well-known/jwks.json`,
      issuer,
      audience: cognitoConfig.clientId,
      tokenUse: 'id',
      expLeewaySeconds: authConfig.expLeewaySeconds,
      // Cognito's clock, not ours. Measured 2s ahead of a developer machine
      // against us-east-1; with no leeway every sign-in on that machine 401s
      // with `token-not-yet-valid`. See `JwksVerifierOptions.iatLeewaySeconds`.
      iatLeewaySeconds: authConfig.expLeewaySeconds,
    });
  }

  /**
   * Verifies OUR access token, identically to the local provider — see the
   * header. Under the Lambda this becomes `this.#accessTokens.verify(token)`
   * against the same JWKS machinery `#idTokens` already uses.
   */
  async verifyToken(token: string): Promise<VerifiedIdentity> {
    let claims: Record<string, unknown>;
    try {
      claims = verifyJwt(token, {
        secret: this.#config.secret,
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        expLeewaySeconds: this.#config.expLeewaySeconds,
      });
    } catch (err) {
      throw err instanceof JwtError ? failureFor(err) : err;
    }
    const parsed = AccessTokenClaimsSchema.safeParse(claims);
    if (!parsed.success) {
      throw new IdentityFailure('invalid_token', 'The token is missing required claims.');
    }
    return { sub: parsed.data.sub, email: parsed.data.email, claims: parsed.data };
  }

  /**
   * Provisioning order (spec 002): create in Cognito, which allocates the sub,
   * then point the `users` row at it with `external_id`. This method does the
   * first half only. The second half is deliberately NOT here: writing `users`
   * needs either RLS bypass or a `security definer` *writer*, and neither
   * belongs in the request process (§11b). `scripts/seed-identities.ts` does it
   * over the owner connection, where operator provisioning belongs.
   *
   * `input.sub` is ignored. It is documented on `CreateUserInput` as local-only,
   * and honouring it here would mean claiming a subject Cognito did not issue.
   */
  async createUser(input: CreateUserInput): Promise<{ sub: string }> {
    let sub: string;
    try {
      const created = await this.#client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.#cognito.userPoolId,
          Username: input.email,
          // No welcome mail: the seeded addresses are fictional, and a pool that
          // tries to send to them burns SES reputation on bounces.
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: input.email },
            // Pre-verified because provisioning is an operator act, not a
            // self-service sign-up — there is nobody to click the link.
            { Name: 'email_verified', Value: 'true' },
          ],
        }),
      );
      sub = subOf(created.User?.Attributes);
    } catch (err) {
      // By name, not `instanceof UsernameExistsException`, for the reason
      // `nameOf` states: one mechanism for every Cognito error, and an
      // `instanceof` also fails silently if two copies of the SDK are resolved.
      if (nameOf(err) !== 'UsernameExistsException') throw err;
      // Re-provisioning an existing person is not an error — the local provider
      // upserts on email for the same reason. Cognito keeps the original sub,
      // which is exactly what `users.external_id` already points at.
      const existing = await this.#client.send(
        new AdminGetUserCommand({
          UserPoolId: this.#cognito.userPoolId,
          Username: input.email,
        }),
      );
      sub = subOf(existing.UserAttributes);
    }

    await this.#client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.#cognito.userPoolId,
        Username: input.email,
        Password: input.password,
        // Permanent, or the account lands in FORCE_CHANGE_PASSWORD and the next
        // sign-in returns a NEW_PASSWORD_REQUIRED challenge no screen can answer.
        Permanent: true,
      }),
    );
    return { sub };
  }

  async initiatePasswordAuth(email: string, password: string): Promise<AuthResult> {
    const result = await this.#authenticate({
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    if (result.status === 'challenge') return result.answer;

    const { sub, user } = await this.#userForIdToken(result.idToken);

    // Talon's MFA policy lives in our table, not the pool (ARCHITECTURE §9.4:
    // TOTP is OPTIONAL at the pool level precisely so the application decides).
    // Reaching here with `mfa_enabled` set means Cognito did not challenge,
    // i.e. nothing is enrolled — the same fail-closed branch the local provider
    // takes when `local_identities.totp_secret` is null.
    if (user.mfaEnabled) {
      throw new IdentityFailure('mfa_not_enrolled', 'This account requires an authenticator app.');
    }

    return {
      status: 'authenticated',
      tokens: {
        // The subject is Cognito's, not `users.id`: `auth_user_by_sub` matches
        // `external_id` and refuses `users.id` for an externally-provisioned
        // person. See `session.ts` — minting `user.id` here signs in cleanly and
        // then 401s on the next request.
        accessToken: issueAccessToken(user, this.#config, nowSeconds(), sub),
        // Cognito's, not ours, and deliberately: the refresh token is the
        // long-lived half, so leaving it under Cognito's control is what makes
        // `AdminUserGlobalSignOut` or disabling a user actually end the session
        // — within one access-token lifetime rather than thirty days.
        refreshToken: result.refreshToken,
        tokenType: 'Bearer',
        expiresIn: this.#config.accessTtlSeconds,
      },
      user: toSessionUser(user),
    };
  }

  async refreshSession(refreshToken: string): Promise<AuthResult> {
    const result = await this.#authenticate(
      { AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: refreshToken } },
      // An expired or revoked refresh token is a token problem, not a password
      // problem: the client must sign in again, and `invalid_credentials` would
      // send it to re-prompt for a password it has already thrown away.
      () => new IdentityFailure('invalid_token', 'The refresh token was rejected.'),
    );
    // Cognito answers a refresh with tokens or an error, never a challenge.
    if (result.status === 'challenge') {
      throw new IdentityFailure('invalid_token', 'The refresh token was rejected.');
    }

    const claims = await this.#verifyIdToken(result.idToken);
    const sub = claims['sub'];
    if (typeof sub !== 'string' || sub === '') {
      throw new IdentityFailure('invalid_token', 'The id token is missing its subject.');
    }
    // Claims are re-read from `users`, never carried over from the old session:
    // a role or tenant change takes effect at the next refresh.
    const user = await this.#requireUser(sub);
    // `auth_time` is when the *session* began, which is the right thing to
    // compare against `tokens_valid_after`; `iat` is when this refresh happened
    // and would defeat the switch entirely, because it is always "now".
    this.#assertNotInvalidated(user, claims['auth_time'] ?? claims['iat']);

    return {
      status: 'authenticated',
      tokens: {
        accessToken: issueAccessToken(user, this.#config, nowSeconds(), sub),
        /*
         * Carried forward, because Cognito returns no new one here.
         *
         * DEVIATION from spec 001 open question 2 ("30d refresh, sliding"). The
         * local provider mints a fresh 30-day token on every exchange, so an
         * active session never expires. Cognito only rotates when the app client
         * has refresh token rotation enabled — and with rotation enabled BOTH
         * `AdminInitiateAuth` and `InitiateAuth` answer
         * `UnsupportedOperationException: This API does not support refresh
         * token rotation`. Verified against a real pool, both flows. Rotation is
         * only reachable through the hosted `/oauth2/token` endpoint, which
         * needs a Cognito domain and OAuth flows configured — a much larger
         * surface than a token exchange warrants at M0b.
         *
         * So under Cognito the 30-day window is ABSOLUTE, from sign-in, and an
         * active user is signed out on day 30. Recorded rather than hidden; the
         * fix is the OAuth token endpoint, not a flag on this call.
         */
        refreshToken: result.refreshToken || refreshToken,
        tokenType: 'Bearer',
        expiresIn: this.#config.accessTtlSeconds,
      },
      user: toSessionUser(user),
    };
  }

  /**
   * NOT IMPLEMENTED, and not implementable behind this signature.
   *
   * `AssociateSoftwareToken` accepts a Cognito **access token** or a challenge
   * **session** — both session-scoped. There is no admin equivalent, so a bare
   * `sub` cannot start an enrolment. This is a genuine gap in the §6.1
   * interface that only shows up once a real IdP is behind it, and papering
   * over it (retaining Cognito access tokens in process memory just to reach
   * this call) would be worse than reporting it.
   *
   * 501, not 401: "we cannot do this here" is an operator fact, and dressing it
   * as an authentication failure would send a user to retry a thing that cannot
   * work. Unreachable today — no route calls it.
   */
  async enrollTotp(_sub: string): Promise<{ secretUri: string }> {
    throw new IdentityFailure(
      'not_implemented',
      'TOTP enrolment against Cognito needs a provider session, which IdentityProvider.enrollTotp(sub) cannot carry.',
    );
  }

  /** Same gap: the code is verified against a challenge session, not a subject. */
  async verifyTotp(_sub: string, _code: string): Promise<boolean> {
    throw new IdentityFailure(
      'not_implemented',
      'TOTP verification against Cognito is part of the challenge exchange, not a standalone check.',
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * One place where an AWS exception becomes an `IdentityFailure`. Nothing above
   * this line sees an SDK error type, which is the adapter's whole job — a
   * `NotAuthorizedException` reaching a route handler would be a 500 on a wrong
   * password.
   *
   * Throttling is deliberately NOT mapped: `IdentityFailureCode` has no
   * `rate_limited`, so `TooManyRequestsException` propagates and surfaces as a
   * 500. That is wrong — it should be a 429 with `Retry-After` — but inventing
   * the code here would give the local provider, which cannot throttle at all,
   * a failure mode it never produces. Flagged for the spec, not papered over.
   */
  async #authenticate(
    input: { AuthFlow: 'ADMIN_USER_PASSWORD_AUTH' | 'REFRESH_TOKEN_AUTH'; AuthParameters: Record<string, string> },
    onRejected: () => IdentityFailure = () =>
      new IdentityFailure('invalid_credentials', 'Email or password is incorrect.'),
  ): Promise<
    | { status: 'tokens'; idToken: string; refreshToken: string }
    | { status: 'challenge'; answer: AuthResult }
  > {
    let output: AdminInitiateAuthCommandOutput;
    try {
      output = await this.#client.send(
        new AdminInitiateAuthCommand({
          UserPoolId: this.#cognito.userPoolId,
          ClientId: this.#cognito.clientId,
          ...input,
        }),
      );
    } catch (err) {
      if (CREDENTIAL_FAILURES.has(nameOf(err))) throw onRejected();
      throw err;
    }

    if (output.ChallengeName !== undefined) {
      switch (output.ChallengeName) {
        case 'SOFTWARE_TOKEN_MFA':
        case 'SELECT_MFA_TYPE':
          // Mirrors the local provider exactly: the service turns this into a
          // 401 `mfa-required`, because M0a has no screen to collect the code.
          return { status: 'challenge', answer: { status: 'mfa_required', challenge: 'totp' } };
        case 'MFA_SETUP':
          throw new IdentityFailure(
            'mfa_not_enrolled',
            'This account requires an authenticator app.',
          );
        default:
          // NEW_PASSWORD_REQUIRED and friends: the password was right, but the
          // account cannot complete a sign-in this release can drive. Fail
          // closed and say nothing more — the detail would describe account
          // state to whoever asked.
          throw onRejected();
      }
    }

    const tokens = output.AuthenticationResult;
    if (!tokens?.IdToken) {
      throw new Error('Cognito returned neither a challenge nor an id token');
    }
    return { status: 'tokens', idToken: tokens.IdToken, refreshToken: tokens.RefreshToken ?? '' };
  }

  /**
   * The id token arrived over an authenticated TLS channel from AWS, so this
   * verification is belt to that braces. It is here anyway because it is the
   * code path the Lambda swap makes load-bearing, and a verifier that has never
   * run in anger is a verifier that does not work.
   */
  async #verifyIdToken(idToken: string): Promise<Record<string, unknown>> {
    try {
      return await this.#idTokens.verify(idToken);
    } catch (err) {
      throw err instanceof JwtError ? failureFor(err) : err;
    }
  }

  async #userForIdToken(idToken: string): Promise<{ sub: string; user: UserRecord }> {
    const claims = await this.#verifyIdToken(idToken);
    const sub = claims['sub'];
    if (typeof sub !== 'string' || sub === '') {
      throw new IdentityFailure('invalid_token', 'The id token is missing its subject.');
    }
    // The sub travels with the user because it, not `users.id`, is what the
    // access token has to name — see `session.ts`.
    return { sub, user: await this.#requireUser(sub) };
  }

  /**
   * The join that makes this whole design work: the IdP's subject selects our
   * row, and everything the token then says about tenancy and role comes from
   * that row. `auth_user_by_sub` (migration 0004) matches `users.external_id`.
   */
  async #requireUser(sub: string): Promise<UserRecord> {
    const user = await this.#repository.findUserBySub(sub);
    if (!user) {
      // Cognito authenticated them; this deployment has nobody for them to be.
      // §9 edge case 1 — an operator problem, and no amount of retyping a
      // password fixes it. Under Cognito this is also the symptom of a users
      // row whose `external_id` was never pointed at the allocated sub.
      throw new IdentityFailure('user_not_provisioned', 'No user record exists for this identity.');
    }
    return user;
  }

  #assertNotInvalidated(user: UserRecord, authTime: unknown): void {
    if (!user.tokensValidAfter) return;
    if (typeof authTime !== 'number' || authTime * 1000 < user.tokensValidAfter.getTime()) {
      throw new IdentityFailure('invalid_token', 'This token was invalidated.');
    }
  }
}

function subOf(
  attributes: { Name?: string | undefined; Value?: string | undefined }[] | undefined,
): string {
  const sub = attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
  if (!sub) throw new Error('Cognito returned a user with no sub attribute');
  return sub;
}
