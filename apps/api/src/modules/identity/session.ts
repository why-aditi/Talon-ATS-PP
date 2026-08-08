/**
 * Talon's own session tokens — the §6.2 claim shape, minted from one `users`
 * row by one function.
 *
 * This file exists because §6.2 says the claim shape is *identical in every
 * implementation*, and a provider that builds its own claims object is a
 * promise, not a guarantee: the day someone adds a claim to one of them, the
 * shape silently forks. Here it is structural — every provider mints through
 * this one function over the same `UserRecord`, so "identical" is not something
 * a test has to keep re-proving. It stayed after `LocalIdentityProvider` was
 * removed for exactly that reason: spec 003 adds SSO flows behind the same seam.
 *
 * `tenant_id` and `role` are read from the `users` row and from nowhere else.
 * The provider does not store them, which is the whole point: the IdP answers
 * "who is this", our database answers "what may they do" (ARCHITECTURE §9.4).
 */
import type { SessionUser } from '@talon/contracts';
import type { AuthConfig } from '../../config.js';
import { newJti, signJwt } from './jwt.js';
import type { UserRecord } from './repository.js';

/**
 * `users.tokens_valid_after` is the pre-expiry invalidation switch: a token
 * issued before the cut-off is refused, whatever its `exp` says.
 *
 * One function, called from all three places that need it, for the same reason
 * the claim shape is one function. The three are:
 *
 *   - `resolveTenant`, on every authenticated request;
 *   - the refresh exchange, against the session's `auth_time` — NOT its `iat`,
 *     which is always "now" and would defeat the switch entirely;
 *   - **sign-in**, against the `iat` the token is about to be stamped with.
 *
 * That last one is not redundant. A cut-off in the FUTURE — an admin suspending
 * an account until Monday — used to let sign-in succeed with a 200 and then 401
 * on the very next request: "signed in", immediately followed by "session
 * invalid", with nothing naming the cause. It is the same shape as the
 * `external_id` bug, and the same fix: refuse at the door. Because sign-in
 * passes the exact `iat` it is about to mint, the door applies literally the
 * predicate the next request will.
 *
 * Strict `<`, and `iat` has second resolution, so a cut-off with a sub-second
 * component also kills a token issued during that same second. That is the
 * fail-closed direction and it heals itself a second later.
 */
export function isIssuedBeforeInvalidation(
  tokensValidAfter: Date | null,
  issuedAtSeconds: number,
): boolean {
  if (tokensValidAfter === null) return false;
  return issuedAtSeconds * 1000 < tokensValidAfter.getTime();
}

export function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    name: user.name,
    role: user.role,
    timezone: user.timezone,
  };
}

/**
 * The bearer token.
 *
 * `subject` is passed in rather than taken as `user.id`, and that is the one
 * thing in this file that is easy to get wrong. `resolveTenant` resolves a
 * bearer token through `auth_user_by_sub` (migration 0004), which matches
 * `users.external_id` first and falls back to `users.id` **only where
 * `external_id is null`** — deliberately, so that revoking an identity at the
 * IdP cannot leave the raw `users.id` working as a token subject.
 *
 * So for a Cognito-provisioned person `users.id` is NOT a resolvable subject.
 * Minting `sub: user.id` there produces a token that signs in cleanly and then
 * 401s `user-not-provisioned` on the very next request — which is exactly what
 * the first live run against a real pool did.
 *
 * The subject is therefore "whatever this deployment's identity provider calls
 * this person" — under Cognito, the `sub` from the verified id token.
 *
 * Nothing downstream assumes `claims.sub === users.id`; `resolveTenant` goes
 * through the lookup and puts `users.id` on `request.user` itself. That should
 * stay true.
 */
export function issueAccessToken(
  user: UserRecord,
  config: AuthConfig,
  iat: number,
  subject: string,
): string {
  return signJwt(
    {
      sub: subject,
      email: user.email,
      tenant_id: user.tenantId,
      role: user.role,
      iss: config.issuer,
      aud: config.audience,
      iat,
      exp: iat + config.accessTtlSeconds,
      jti: newJti(),
    },
    config.secret,
  );
}

/*
 * There is no `issueRefreshToken` here any more, and its absence is deliberate.
 * Talon never mints a refresh token: Cognito issues one and owns the exchange,
 * which is what makes `AdminUserGlobalSignOut` or disabling a user actually end
 * a session, within one access-token lifetime rather than thirty days. The
 * refresh token that reaches `POST /v1/auth/refresh` is Cognito's opaque string,
 * not a JWT — nothing here can or should verify it. See `cognito-provider.ts`,
 * and spec 001 open question 2's 2026-08-08 amendment for what that costs (the
 * 30-day window is absolute from sign-in, not sliding).
 */
