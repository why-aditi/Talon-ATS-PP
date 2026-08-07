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
