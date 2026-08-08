/**
 * Contract: POST /v1/auth/sign-in, POST /v1/auth/refresh — spec 001 §6.
 *
 * Wire bodies are camelCase like every other response. JWT claims (below) are
 * snake_case because §6.2 fixes that shape and every implementation — the
 * adapter today, Cognito's pre-token-generation Lambda tomorrow — must emit it
 * identically.
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
 * The identity provider's subject for this person — `users.external_id`, which
 * is `text` and not `uuid`, deliberately (migration 0004): a SAML persistent
 * `NameID` is an opaque, case-sensitive string and is not a UUID.
 *
 * So this is NOT `z.string().uuid()`. A Cognito sub happens to be a UUID, and
 * pinning the shape to the one provider that exists today would have to be
 * loosened by whoever adds the second — under time pressure, in the file that
 * validates every bearer token.
 *
 * What is kept, because none of it is provider-specific:
 *
 *   - **Non-empty after trimming.** `''` and `'   '` are not subjects any IdP
 *     issues, and `external_id = ''` in the lookup would resolve a real user for
 *     an empty token subject. The database refuses to store one
 *     (`users_external_id_ck`); this refuses to carry one.
 *   - **1024 characters**, the same bound as that check constraint. A longer
 *     value can never match a stored subject, so accepting it only means
 *     carrying an unbounded attacker-controlled string further into the system.
 *   - **No C0/C1 control characters.** No IdP subject legitimately contains one,
 *     and a subject is a string that travels into log lines and audit rows.
 *
 * Not trimmed, only checked: the subject is matched byte-for-byte against
 * `users.external_id`, and a schema that silently rewrote it would make the
 * token's `sub` and the lookup key two different values.
 *
 * `tenant_id` below stays `uuid`, and so does `SessionUserSchema.id`. Those name
 * OUR rows, whose type we control; loosening them would weaken a real check
 * rather than remove a false one.
 */
export const SubjectSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim().length > 0, { message: 'must not be blank' })
  .refine((value) => !/[\u0000-\u001F\u007F-\u009F]/u.test(value), {
    message: 'must not contain control characters',
  });

/**
 * Not `.strict()`: Cognito adds its own claims (`token_use`, `auth_time`,
 * `origin_jti`, …) and rejecting them would make the AWS swap a rewrite. What
 * matters is that everything Talon reads is present and well typed.
 *
 * `tenant_id` and `role` are NOT stored on the identity provider — the
 * pre-token-generation Lambda will read them from `users` at sign-in, as the
 * adapter does today. They are a snapshot for logging and defence in depth; the
 * request chain re-reads the `users` row on every request and treats the
 * database as authoritative.
 */
export const AccessTokenClaimsSchema = z.object({
  sub: SubjectSchema,
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

/*
 * `RefreshTokenClaimsSchema` used to sit here, and it is gone rather than
 * loosened alongside `sub` above. Talon does not mint refresh tokens: Cognito
 * issues one, owns the exchange, and its value is an OPAQUE string, not a JWT
 * with claims to describe. A contract describing a token nobody issues is a lie
 * in the source of truth, and the next person to read it would have written a
 * verifier against it. `RefreshRequestSchema` below is the real contract — a
 * bounded opaque string, which is all the wire actually carries.
 */

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

/**
 * A completed Cognito hosted-UI flow (spec 004 §11.2).
 *
 * Both tokens come from the same `/oauth2/token` exchange and are sent server to
 * server by the web app's callback route — neither reaches the browser, which is why
 * there is no CSRF concern on this endpoint and no cookie in the exchange.
 *
 * DEVIATION from §11.2, which specified `{ idToken }` alone. That cannot work:
 * `SsoResponseSchema` is `SignInResponseSchema`, whose `refreshToken` is required,
 * and an id token carries no refresh token. Cognito issues one in the same response;
 * the callback simply was not forwarding it. Taking it here keeps the refresh token
 * Cognito's — the same property the password path relies on, and what makes
 * `AdminUserGlobalSignOut` actually end a federated session.
 */
export const SsoRequestSchema = z
  .object({ idToken: z.string().min(1), refreshToken: z.string().min(1).max(4096) })
  .strict();
export type SsoRequest = z.infer<typeof SsoRequestSchema>;

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
 * Open question 2 (answered 2026-08-07): 1h access token, 30d refresh.
 *
 * **Amended 2026-08-08: not sliding.** Cognito only rotates a refresh token when
 * rotation is enabled on the app client, and with it enabled `AdminInitiateAuth`
 * answers `UnsupportedOperationException` — verified against a real pool. So
 * `refreshToken` here is frequently the SAME string the caller sent, the 30-day
 * window is absolute from sign-in, and an active user is signed out on day 30.
 * A client must not treat an unchanged value as a failed refresh.
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

// ---------------------------------------------------------------------------
// GET /v1/users — spec 005 §6.4, and §15 OQ7 which noted nobody had counted it
//
// The people a job can be assigned to. Deliberately NOT SessionUserSchema: that
// carries an email and a tenant id, and a picker needs neither. Sending them
// would put every colleague's address into a dropdown on a screen that only
// ever renders names.
// ---------------------------------------------------------------------------

export const UserSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: RoleSchema,
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const ListUsersQuerySchema = z
  .object({
    /** Repeatable, so one request can fetch recruiters and admins together. */
    role: z.union([RoleSchema, z.array(RoleSchema)]).optional(),
  })
  .strict();
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

/** No cursor: a tenant's assignable staff is a list a picker shows whole. */
export const ListUsersResponseSchema = z.object({
  data: z.array(UserSummarySchema),
});
export type ListUsersResponse = z.infer<typeof ListUsersResponseSchema>;

/**
 * Identical to sign-in: same tokens, same user, same session semantics.
 *
 * Reused rather than declared in parallel — the web callback already parses with it,
 * and a session that differs by how it was obtained is a session two code paths have
 * to handle forever (spec 004 §11.2).
 */
export const SsoResponseSchema = SignInResponseSchema;
export type SsoResponse = z.infer<typeof SsoResponseSchema>;
