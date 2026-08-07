/**
 * Contract: POST /v1/auth/sign-in, POST /v1/auth/refresh — spec 001 §6.
 *
 * Wire bodies are camelCase like every other response. JWT claims (below) are
 * snake_case because §6.2 fixes that shape and both implementations — the local
 * stub and Cognito's pre-token-generation Lambda — must emit it identically.
 */
import { z } from 'zod';
import { ROLES } from '@talon/domain';

/** Derived from the domain table so a new role cannot exist in only one place. */
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

// ---------------------------------------------------------------------------
// Token claims — §6.2, identical in every IdentityProvider implementation
// ---------------------------------------------------------------------------

/**
 * Not `.strict()`: Cognito adds its own claims (`token_use`, `auth_time`,
 * `origin_jti`, …) and rejecting them would make the AWS swap a rewrite. What
 * matters is that everything Talon reads is present and well typed.
 *
 * `tenant_id` and `role` are NOT stored on the identity provider — the local
 * stub reads them from `users` at sign-in and the Lambda will do the same. They
 * are a snapshot for logging and defence in depth; the request chain re-reads
 * the `users` row on every request and treats the database as authoritative.
 */
export const AccessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().min(1),
  tenant_id: z.string().uuid(),
  role: RoleSchema,
  iss: z.string().min(1),
  aud: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  jti: z.string().min(1),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;

/**
 * Refresh tokens carry no `tenant_id` or `role`: they are exchanged for an
 * access token whose claims are read fresh from `users`, so a role change takes
 * effect on the next refresh rather than being frozen for 30 days. A distinct
 * `aud` is what stops a refresh token being presented as a bearer token.
 */
export const RefreshTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().min(1),
  iss: z.string().min(1),
  aud: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  jti: z.string().min(1),
});
export type RefreshTokenClaims = z.infer<typeof RefreshTokenClaimsSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// Length-bounded before it reaches a password hash: scrypt's cost is fixed, but
// an unbounded body is free work for anyone who asks.
const EmailSchema = z.string().trim().min(3).max(320).email();

export const SignInRequestSchema = z
  .object({
    email: EmailSchema,
    // No min length here on purpose — sign-in validates against the stored
    // hash, and a length rule at sign-in only tells an attacker what the policy
    // is. NewPasswordSchema below is where the policy lives.
    password: z.string().min(1).max(256),
  })
  .strict();
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/** Policy for setting a password (provisioning). 12 chars, no composition rules. */
export const NewPasswordSchema = z.string().min(12).max(256);

export const RefreshRequestSchema = z
  .object({ refreshToken: z.string().min(1).max(4096) })
  .strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const SessionUserSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
  /** IANA zone. Timestamps are UTC on the wire and converted at render. */
  timezone: z.string(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

/**
 * Open question 2 (answered 2026-08-07): 1h access token, 30d refresh, sliding —
 * every refresh returns a new refresh token with a fresh 30-day window, so an
 * active session never expires and an idle one dies after 30 days.
 */
export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  /** Access-token lifetime in seconds. */
  expiresIn: z.number().int().positive(),
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const SignInResponseSchema = AuthTokensSchema.extend({ user: SessionUserSchema });
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

export const RefreshResponseSchema = AuthTokensSchema.extend({ user: SessionUserSchema });
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
