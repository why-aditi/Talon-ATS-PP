/**
 * The IdentityProvider seam (spec 001 §6.1). `CognitoIdentityProvider` is the
 * only implementation (spec 002 open question 1). Nothing outside this folder
 * may import the concrete class — code is written against this interface, which
 * is what keeps a second provider (spec 003's per-tenant SAML) a container
 * registration rather than a rewrite, and what lets the test suite substitute
 * the network instead of the class.
 */
import type { AccessTokenClaims, SessionUser, AuthTokens } from '@talon/contracts';
import { brandError, isBrandedError } from '../../branded-error.js';

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
   * `users.tokens_valid_after` refuses this session. Distinct from
   * `invalid_token` because nothing is wrong with the token: it was issued, or
   * would be issued, before a cut-off somebody set deliberately. Only reachable
   * after authentication has already succeeded, so naming it discloses nothing
   * the caller did not already know.
   */
  | 'token_invalidated'
  /**
   * The identity provider is throttling us. 429, not 401 and not 500: nothing
   * about the caller's credential is wrong, and nothing about ours is broken.
   *
   * SERVICE-level throttling only. A per-account attempt limit is account
   * state, so it is reported as `invalid_credentials` — see
   * `CREDENTIAL_FAILURES` in cognito-provider.ts.
   */
  | 'rate_limited'
  /**
   * The operation is part of the interface but this provider cannot perform it
   * — Cognito's TOTP enrolment is session-scoped and `enrollTotp(sub)` has no
   * session to give it. 501, not 401: an operator fact, not a credential one.
   */
  | 'not_implemented';

const IDENTITY_FAILURE_BRAND = Symbol.for('talon.identityFailure');

/**
 * Checked instead of `instanceof` — `branded-error.ts` carries the reasoning.
 * This one is load-bearing in the same way `isHttpProblem` is: `asProblem` in
 * `service.ts` returns anything that fails this check unchanged, so a false
 * negative turns every provider failure into a 500.
 */
export function isIdentityFailure(error: unknown): error is IdentityFailure {
  return isBrandedError(error, IDENTITY_FAILURE_BRAND);
}

/**
 * Who the provider just authenticated, when this deployment has nobody for them
 * to be. Attached to a `user_not_provisioned` failure so the service can decide
 * whether the allow-list says to create them (just-in-time provisioning).
 *
 * NEVER leaves the module: `asProblem` in service.ts builds a fresh `HttpProblem`
 * and copies nothing from here. A 401 that named the address it had just verified
 * would be an account-enumeration oracle wearing a helpful error message.
 */
export interface UnprovisionedSubject {
  /** The IdP's subject — what `users.external_id` would point at. */
  sub: string;
  /** The verified email claim, exactly as the token carried it. */
  email: string;
  /** Best available display name from the token, or undefined if it carried none. */
  name: string | undefined;
}

/**
 * Provider-agnostic failure. Adapters translate their own errors into these;
 * `service.ts` translates these into problem+json. A Cognito SDK exception must
 * never reach a route handler.
 */
export class IdentityFailure extends Error {
  constructor(
    readonly code: IdentityFailureCode,
    readonly detail?: string,
    /**
     * Seconds the caller should wait before retrying. Meaningful only for
     * `rate_limited`, where it becomes the `Retry-After` header; a 429 without
     * one leaves every client to invent its own backoff, and the ones that
     * invent "immediately" are what turns a throttle into an outage.
     */
    readonly retryAfterSeconds?: number,
    /**
     * Meaningful only for `user_not_provisioned`, and only when the adapter got
     * far enough to have a verified identity in hand. Its presence is what makes
     * just-in-time provisioning possible without the provider knowing anything
     * about tenants, allow-lists or transactions — all of which belong to
     * `service.ts` (CLAUDE.md §3: transactions begin there and nowhere else).
     */
    readonly subject?: UnprovisionedSubject,
  ) {
    super(detail ?? code);
    this.name = 'IdentityFailure';
    brandError(this, IDENTITY_FAILURE_BRAND);
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

  /**
   * Federated sign-in (spec 004 §11.5). The caller holds the tokens Cognito minted
   * for a completed hosted-UI flow; this verifies the id token and returns a Talon
   * session, exactly as `initiatePasswordAuth` does once a password is proven.
   *
   * Deliberately NOT folded into `verifyToken`. That answers "is this OUR access
   * token", runs on every authenticated request via the `authenticate` hook, and must
   * stay that narrow. An id token is minted for a client, not for an API — the
   * confusion `aud` exists to prevent — so it gets its own door.
   */
  exchangeIdToken(idToken: string, refreshToken: string): Promise<AuthResult>;
}
