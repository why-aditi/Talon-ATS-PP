/**
 * Orchestration for the auth chain. Provider failures become problem+json here
 * and nowhere else, so every route and hook reports the same taxonomy.
 *
 * Transactions begin here (CLAUDE.md §3): the repository owns the mechanics, the
 * service decides when one opens.
 */
import { ERROR_TYPES, type RefreshResponse, type SignInResponse } from '@talon/contracts';
import { scopesFor } from '@talon/domain';
import { HttpProblem } from '../../errors.js';
import type { AuthenticatedUser, TenantTransaction } from '../../request-context.js';
import { IdentityFailure, type IdentityProvider, type VerifiedIdentity } from './provider.js';
import type { IdentityRepository } from './repository.js';

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
};

function asProblem(error: unknown): unknown {
  if (!(error instanceof IdentityFailure)) return error;
  const problem = PROBLEMS[error.code];
  return new HttpProblem(problem.status, problem.type, problem.title, error.detail);
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

  async signIn(input: { email: string; password: string }): Promise<SignInResponse> {
    const result = await this.#run(() =>
      this.#provider.initiatePasswordAuth(input.email, input.password),
    );
    if (result.status === 'mfa_required') {
      // No MFA challenge endpoint in M0a — there is no screen for it and
      // inventing the exchange now would fix a contract nobody has specced. The
      // seeded users have mfa_enabled = false; this is the fail-closed branch.
      throw new HttpProblem(
        401,
        ERROR_TYPES.MFA_REQUIRED,
        'MFA required',
        'This account requires a one-time code, which this release cannot collect.',
      );
    }
    return { ...result.tokens, user: result.user };
  }

  async refresh(input: { refreshToken: string }): Promise<RefreshResponse> {
    const result = await this.#run(() => this.#provider.refreshSession(input.refreshToken));
    if (result.status === 'mfa_required') {
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
    if (
      user.tokensValidAfter !== null &&
      identity.claims.iat * 1000 < user.tokensValidAfter.getTime()
    ) {
      // Claims are embedded in the token, so revoking a role cannot wait for
      // expiry. `tokens_valid_after` is the pre-expiry invalidation switch.
      //
      // `iat` has second resolution and the comparison is strict, so a cut-off
      // with a sub-second component also kills a token issued during that same
      // second. That is the fail-closed direction and it heals itself: the next
      // sign-in, a second later, works.
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
   * Creates or replaces a local credential. There is no self-service sign-up in
   * M0a; this exists for provisioning and for the E2E/test fixtures that need a
   * seeded person to be able to sign in.
   */
  async provisionCredential(input: {
    email: string;
    password: string;
    sub?: string;
  }): Promise<{ sub: string }> {
    return this.#run(() => this.#provider.createUser(input));
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      throw asProblem(err);
    }
  }
}
