/**
 * The IdentityProvider seam (spec 001 §6.1). `CognitoIdentityProvider` is the
 * only implementation (spec 002 open question 1). Nothing outside this folder
 * may import the concrete class — code is written against this interface, which
 * is what keeps a second provider (spec 003's per-tenant SAML) a container
 * registration rather than a rewrite, and what lets the test suite substitute
 * the network instead of the class.
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

/**
 * Provisioning order is: `createUser` → the provider allocates a subject → point
 * `users.external_id` (migration 0004) at what came back.
 *
 * There is deliberately no caller-supplied `sub`. It existed for the local
 * provider, whose subject WAS `users.id`; asking an IdP to adopt a subject we
 * chose means claiming an identity it never issued, and every provider that
 * remains allocates its own.
 */
export interface CreateUserInput {
  email: string;
  password: string;
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
