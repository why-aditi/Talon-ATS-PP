/**
 * Orchestration for the auth chain. Provider failures become problem+json here
 * and nowhere else, so every route and hook reports the same taxonomy.
 *
 * Transactions begin here (CLAUDE.md §3): the repository owns the mechanics, the
 * service decides when one opens.
 */
import { ERROR_TYPES, type RefreshResponse, type SignInResponse, type SsoRequest, type SsoResponse } from '@talon/contracts';
import { scopesFor } from '@talon/domain';
import { HttpProblem } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import { IdentityFailure, type IdentityProvider, type VerifiedIdentity } from './provider.js';
import type { IdentityRepository } from './repository.js';
import { isIssuedBeforeInvalidation } from './session.js';

const PROBLEMS: Record<IdentityFailure['code'], { status: number; type: string; title: string }> = {
  invalid_credentials: {
    status: 401,
    type: ERROR_TYPES.INVALID_CREDENTIALS,
    title: 'Invalid credentials',
  },
  user_not_provisioned: {
    status: 401,
    type: ERROR_TYPES.USER_NOT_PROVISIONED,
    title: 'User not provisioned',
  },
  mfa_not_enrolled: { status: 401, type: ERROR_TYPES.MFA_NOT_ENROLLED, title: 'MFA not enrolled' },
  invalid_token: { status: 401, type: ERROR_TYPES.INVALID_TOKEN, title: 'Invalid token' },
  token_expired: { status: 401, type: ERROR_TYPES.TOKEN_EXPIRED, title: 'Token expired' },
  token_not_yet_valid: {
    status: 401,
    type: ERROR_TYPES.TOKEN_NOT_YET_VALID,
    title: 'Token not yet valid',
  },
  token_invalidated: {
    status: 401,
    type: ERROR_TYPES.TOKEN_INVALIDATED,
    title: 'Token invalidated',
  },
  // The two entries here that are not 401. In both, nothing about the caller's
  // credential is wrong, so a 401 would send them to retype a password that was
  // fine — and in the throttling case it would also hide an operational problem
  // behind a user-facing one.
  rate_limited: { status: 429, type: ERROR_TYPES.RATE_LIMITED, title: 'Too many requests' },
  not_implemented: {
    status: 501,
    type: ERROR_TYPES.NOT_IMPLEMENTED,
    title: 'Not implemented',
  },
};

/** Only used if a provider raises `rate_limited` without one. RFC 9110 §10.2.3. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * What the audit row records about the caller rather than the credential
 * (CLAUDE.md §4: actor, before, after, IP, request id). Passed in from the route
 * because a service must not reach for a Fastify request — and because being an
 * explicit parameter is what stops a new caller forgetting it.
 */
export interface AuditContext {
  ip: string | undefined;
  requestId: string | undefined;
}

function asProblem(error: unknown): unknown {
  if (!(error instanceof IdentityFailure)) return error;
  const problem = PROBLEMS[error.code];
  if (error.code !== 'rate_limited') {
    return new HttpProblem(problem.status, problem.type, problem.title, error.detail);
  }
  const seconds = error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
  return new HttpProblem(
    problem.status,
    problem.type,
    problem.title,
    error.detail,
    // In the body as well as the header. `Retry-After` is not CORS-safelisted,
    // so a browser calling the api cross-origin cannot read it without an
    // explicit `Access-Control-Expose-Headers` — and a 429 whose backoff the
    // client cannot see is a 429 the client retries immediately.
    { retryAfter: seconds },
    { 'Retry-After': String(seconds) },
  );
}

export class IdentityService {
  readonly #provider: IdentityProvider;
  readonly #repository: IdentityRepository;

  constructor({
    identityProvider,
    identityRepository,
  }: {
    identityProvider: IdentityProvider;
    identityRepository: IdentityRepository;
  }) {
    this.#provider = identityProvider;
    this.#repository = identityRepository;
  }

  /**
   * Sign-in, and the one audit_log row it produces (CLAUDE.md §4).
   *
   * The audit write is deliberately NOT inside a `try`. Every mutation writes to
   * `audit_log`, and a sign-in that cannot be recorded must not mint a session:
   * an attacker who can break the audit path must not thereby get an unlogged
   * one. On the success path the token has already been minted when the write
   * runs, but it has not been *returned* — a JWT nobody was handed is inert.
   *
   * The failure path writes first and then rethrows the original problem, so a
   * broken audit path turns every 401 into a 500 rather than some of them. That
   * uniformity is the point: nothing in the audit call depends on whether the
   * address exists, so it cannot become the enumeration oracle `signIn` itself
   * is careful not to be.
   */
  async signIn(
    input: { email: string; password: string },
    context: AuditContext,
  ): Promise<SignInResponse> {
    let result;
    try {
      result = await this.#run(() =>
        this.#provider.initiatePasswordAuth(input.email, input.password),
      );
      if (result.status === 'mfa_required') {
        // No MFA challenge endpoint in M0a — there is no screen for it and
        // inventing the exchange now would fix a contract nobody has specced.
        // The seeded users have mfa_enabled = false; this is the fail-closed
        // branch, and an incomplete sign-in is a failed one for audit purposes.
        throw new HttpProblem(
          401,
          ERROR_TYPES.MFA_REQUIRED,
          'MFA required',
          'This account requires a one-time code, which this release cannot collect.',
        );
      }
    } catch (err) {
      await this.#auditSignIn('failed', input.email, context, {
        // The `type` the caller is about to receive, and nothing beyond it. A
        // log that knows more about why a sign-in failed than the response did
        // is the oracle the response was written to avoid.
        reason: err instanceof HttpProblem ? err.type : ERROR_TYPES.INTERNAL,
        tenantId: null,
        actorId: null,
      });
      throw err;
    }

    await this.#auditSignIn('succeeded', input.email, context, {
      reason: null,
      // Only a successful sign-in names a tenant and an actor. Attributing a
      // failed attempt to an account would assert an identity nobody proved,
      // and resolving one would mean an existence-dependent lookup on the
      // failure path.
      tenantId: result.user.tenantId,
      actorId: result.user.id,
    });
    return { ...result.tokens, user: result.user };
  }

  async refresh(input: { refreshToken: string }): Promise<RefreshResponse> {
    const result = await this.#run(() => this.#provider.refreshSession(input.refreshToken));
    if (result.status === 'mfa_required') {
      throw new HttpProblem(401, ERROR_TYPES.MFA_REQUIRED, 'MFA required');
    }
    return { ...result.tokens, user: result.user };
  }

  /**
   * Federated sign-in (spec 004 §11.4). `#run` maps `IdentityFailure` to problem+json,
   * so the failure table in §11.6 needs no per-call handling — including the row that
   * matters most: a verified Google identity with no `users` row answers
   * `user_not_provisioned`, not a generic failure. "Your Google sign-in worked; this
   * workspace has no account for you" and "sign-in failed" send a person to do
   * completely different things, and only one of them can succeed.
   */
  async signInWithSso(input: SsoRequest): Promise<SsoResponse> {
    const result = await this.#run(() =>
      this.#provider.exchangeIdToken(input.idToken, input.refreshToken),
    );
    if (result.status === 'mfa_required') {
      // Unreachable today: MFA is enforced at the IdP for a federated identity and
      // Cognito does not re-challenge one. Handled rather than asserted away, because
      // `AuthResult` is a union and narrowing it by assertion is how the branch that
      // eventually happens goes unnoticed.
      throw new HttpProblem(401, ERROR_TYPES.MFA_REQUIRED, 'MFA required');
    }
    return { ...result.tokens, user: result.user };
  }

  /** Signature, audience, issuer, expiry. Used by the `authenticate` hook. */
  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    return this.#run(() => this.#provider.verifyToken(token));
  }

  /**
   * Loads the `users` row for a verified token — the `resolveTenant` hook.
   *
   * The database is authoritative: a role changed since the token was issued
   * takes effect now, not at expiry. A `tenant_id` that disagrees with the token
   * is not a stale claim but a broken one, and is refused.
   */
  async resolveAuthenticatedUser(identity: VerifiedIdentity): Promise<AuthenticatedUser> {
    const user = await this.#repository.findUserBySub(identity.sub);
    if (!user) {
      // §9 edge case 1 — valid token, nobody to be. Distinct type, not a crash.
      throw new HttpProblem(
        401,
        ERROR_TYPES.USER_NOT_PROVISIONED,
        'User not provisioned',
        'This identity is authenticated but has no user record in this deployment.',
      );
    }
    if (isIssuedBeforeInvalidation(user.tokensValidAfter, identity.claims.iat)) {
      // Claims are embedded in the token, so revoking a role cannot wait for
      // expiry. `tokens_valid_after` is the pre-expiry invalidation switch, and
      // the predicate lives in `session.ts` so that sign-in, refresh and this
      // hook cannot drift apart — they did, and the result was a 200 followed
      // immediately by a 401.
      throw new HttpProblem(
        401,
        ERROR_TYPES.TOKEN_INVALIDATED,
        'Token invalidated',
        'This token was issued before the account was invalidated.',
      );
    }
    if (user.tenantId !== identity.claims.tenant_id) {
      throw new HttpProblem(
        401,
        ERROR_TYPES.INVALID_TOKEN,
        'Invalid token',
        'The token does not match the tenant of its subject.',
      );
    }
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone,
      scopes: scopesFor(user.role),
    };
  }

  async openTenantTransaction(tenantId: string, userId: string): Promise<TenantTransaction> {
    return this.#repository.beginTenantTransaction(tenantId, userId);
  }

  /**
   * Creates or replaces the credential at the identity provider and returns the
   * subject it allocated. There is no self-service sign-up in M0a; this exists
   * for operator provisioning (`scripts/seed-identities.ts`) and for the test
   * fixtures that need a seeded person to be able to sign in.
   *
   * The caller is responsible for the second half — writing the returned subject
   * to `users.external_id`. That write is deliberately not here: it needs RLS
   * bypass, and the request process must not have it (spec 001 §11b).
   */
  async provisionCredential(input: { email: string; password: string }): Promise<{ sub: string }> {
    return this.#run(() => this.#provider.createUser(input));
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw asProblem(err);
    }
  }

  async #auditSignIn(
    outcome: 'succeeded' | 'failed',
    email: string,
    context: AuditContext,
    attribution: { reason: string | null; tenantId: string | null; actorId: string | null },
  ): Promise<void> {
    await this.#repository.recordSignIn({
      outcome,
      email,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
      ...attribution,
    });
  }
}
