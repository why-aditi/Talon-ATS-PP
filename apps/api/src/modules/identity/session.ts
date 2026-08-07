/**
 * Talon's own session tokens — the §6.2 claim shape, minted from one `users`
 * row by one function.
 *
 * This file exists because §6.2 says the claim shape is *identical in both
 * implementations*, and two providers each building their own claims object is a
 * promise, not a guarantee: the day someone adds a claim to one of them, the
 * shape silently forks. Here it is structural — `LocalIdentityProvider` and
 * `CognitoIdentityProvider` call the same function over the same `UserRecord`,
 * so "identical" is not something a test has to keep re-proving.
 *
 * `tenant_id` and `role` are read from the `users` row and from nowhere else.
 * Neither provider stores them on the identity provider, which is the whole
 * point: the IdP answers "who is this", our database answers "what may they do"
 * (ARCHITECTURE §9.4).
 */
import type { AuthTokens, SessionUser } from '@talon/contracts';
import type { AuthConfig } from '../../config.js';
import { newJti, nowSeconds, signJwt } from './jwt.js';
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
 * this person": `users.id` locally, the Cognito `sub` under Cognito. Callers:
 *   - `LocalIdentityProvider` (via `issueTokens`) → `user.id`
 *   - `CognitoIdentityProvider` → the `sub` from the verified Cognito id token
 *
 * Nothing downstream assumes `claims.sub === users.id`; `resolveTenant` goes
 * through the lookup and puts `users.id` on `request.user` itself. That should
 * stay true.
 *
 * Known limit: `AccessTokenClaimsSchema.sub` is `z.string().uuid()`, which a
 * Cognito sub satisfies. `users.external_id` is `text` because a future SAML
 * NameID is not a UUID, so that contract has to loosen before a non-UUID subject
 * can sign in. Recorded rather than pre-emptively loosened — today it would only
 * weaken validation of tokens we mint ourselves.
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

/**
 * Sliding: every refresh returns a new 30-day token, so an active session never
 * expires and an idle one dies on schedule (spec 001 open question 2).
 *
 * Only the local provider mints these. Cognito issues its own refresh token and
 * owns the exchange, which is what makes disabling a user at the IdP actually
 * end their session — see `cognito-provider.ts`.
 */
export function issueRefreshToken(user: UserRecord, config: AuthConfig, iat: number): string {
  return signJwt(
    {
      sub: user.id,
      email: user.email,
      iss: config.issuer,
      aud: config.refreshAudience,
      iat,
      exp: iat + config.refreshTtlSeconds,
      jti: newJti(),
    },
    config.secret,
  );
}

/**
 * The local provider's pair. Its token subject IS `users.id` — the local
 * identity store is keyed on it and `users.external_id` stays null, which is the
 * case `auth_user_by_sub`'s fallback exists for.
 */
export function issueTokens(user: UserRecord, config: AuthConfig): AuthTokens {
  const iat = nowSeconds();
  return {
    accessToken: issueAccessToken(user, config, iat, user.id),
    refreshToken: issueRefreshToken(user, config, iat),
    tokenType: 'Bearer',
    expiresIn: config.accessTtlSeconds,
  };
}
