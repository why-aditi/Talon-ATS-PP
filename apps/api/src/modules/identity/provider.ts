/**
 * The IdentityProvider seam (spec 001 §6.1). `LocalIdentityProvider` and
 * `CognitoIdentityProvider` both implement it. Nothing outside this folder may
 * import either concrete class — code is written against this interface, which
 * is what makes the AWS swap a container registration rather than a rewrite.
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
   * Local only, and ignored by every other implementation.
   *
   * Provisioning order is: createUser → point the `users` row at the returned
   * sub. Locally the subject IS `users.id`, so an already-provisioned person
   * (the seed) hands their id in and `users.external_id` stays null —
   * `auth_user_by_sub` resolves them by primary key. Cognito allocates the sub
   * itself, so there the returned value is written to `users.external_id`
   * (migration 0004) and this field is meaningless: honouring it would mean
   * claiming a subject the IdP never issued.
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
  | 'token_not_yet_valid'
  /**
   * The operation is part of the interface but this provider cannot perform it
   * — Cognito's TOTP enrolment is session-scoped and `enrollTotp(sub)` has no
   * session to give it. 501, not 401: an operator fact, not a credential one.
   */
  | 'not_implemented';

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
