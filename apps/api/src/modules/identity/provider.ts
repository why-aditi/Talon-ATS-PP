/**
 * The IdentityProvider seam (spec 001 §6.1). `LocalIdentityProvider` implements
 * it today; `CognitoIdentityProvider` implements it in spec 002. Nothing outside
 * this folder may import either concrete class — code is written against this
 * interface, which is what makes the AWS swap a container registration rather
 * than a rewrite.
 */
import type { AccessTokenClaims, SessionUser, AuthTokens } from '@talon/contracts';

export interface VerifiedIdentity {
  sub: string;
  email: string;
  /**
   * The verified claim set (§6.2). `tenant_id` and `role` here are a snapshot
   * taken at sign-in, NOT authority: the request chain re-reads the `users` row
   * every request and the database wins on disagreement.
   */
  claims: AccessTokenClaims;
}

export interface CreateUserInput {
  email: string;
  password: string;
  /**
   * Local only. Provisioning order for a new person is: createUser → insert the
   * `users` row keyed by the returned sub. `users` has no `external_id` column
   * yet, so locally the subject IS `users.id` and an already-provisioned user
   * (the seed) has to hand its id in. Cognito allocates the sub itself and
   * ignores this — closing that gap is a spec 002 migration, not a local hack.
   */
  sub?: string;
}

export type AuthResult =
  | { status: 'authenticated'; tokens: AuthTokens; user: SessionUser }
  /** Cognito answers a challenge here rather than tokens; so do we. */
  | { status: 'mfa_required'; challenge: 'totp' };

export type IdentityFailureCode =
  | 'invalid_credentials'
  | 'user_not_provisioned'
  | 'mfa_not_enrolled'
  | 'invalid_token'
  | 'token_expired'
  | 'token_not_yet_valid';

/**
 * Provider-agnostic failure. Adapters translate their own errors into these;
 * `service.ts` translates these into problem+json. A Cognito SDK exception must
 * never reach a route handler.
 */
export class IdentityFailure extends Error {
  constructor(
    readonly code: IdentityFailureCode,
    readonly detail?: string,
  ) {
    super(detail ?? code);
    this.name = 'IdentityFailure';
  }
}

export interface IdentityProvider {
  verifyToken(token: string): Promise<VerifiedIdentity>;
  createUser(input: CreateUserInput): Promise<{ sub: string }>;
  initiatePasswordAuth(email: string, password: string): Promise<AuthResult>;
  enrollTotp(sub: string): Promise<{ secretUri: string }>;
  verifyTotp(sub: string, code: string): Promise<boolean>;

  /**
   * DEVIATION from §6.1, which lists five methods. Open question 2 answered
   * "30d refresh, sliding", and a refresh token nothing can redeem is worse than
   * no refresh token — the exchange has to live behind the same seam as the
   * issue. Cognito implements it natively (`REFRESH_TOKEN_AUTH`), so this does
   * not compromise the swap. Flagged in the step-4 report.
   */
  refreshSession(refreshToken: string): Promise<AuthResult>;
}
