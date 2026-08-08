/**
 * Stable RFC 9457 `type` values (ARCHITECTURE §7).
 *
 * `ProblemSchema.type` is an open string on purpose; these are the values the
 * endpoints that exist today emit, declared here because the ui switches on
 * them. A client that treats an unknown `type` as "generic error" stays correct
 * when a new one is added — that is the contract.
 *
 * Auth deliberately distinguishes its failures rather than answering a flat 401:
 * "your token expired" (refresh), "your token is not a token" (sign in again)
 * and "you are authenticated but this deployment has no user row for you"
 * (spec 001 §9 edge case 1 — a support problem, not a login problem) need
 * different client behaviour. None of them disclose whether an account exists.
 */
export const ERROR_TYPES = {
  /** No credentials presented at all. */
  UNAUTHENTICATED: 'urn:talon:error:unauthenticated',
  /** Malformed, wrongly signed, wrong audience/issuer, or claims missing. */
  INVALID_TOKEN: 'urn:talon:error:invalid-token',
  /** Signature good, `exp` past (60s leeway applied). Refresh and retry. */
  TOKEN_EXPIRED: 'urn:talon:error:token-expired',
  /** Signature good, `iat` in the future. No leeway — spec 001 §9 edge case 9. */
  TOKEN_NOT_YET_VALID: 'urn:talon:error:token-not-yet-valid',
  /** Signature good, unexpired, but issued before `users.tokens_valid_after`. */
  TOKEN_INVALIDATED: 'urn:talon:error:token-invalidated',
  /** Valid token, no `users` row — spec 001 §9 edge case 1. */
  USER_NOT_PROVISIONED: 'urn:talon:error:user-not-provisioned',
  /** Sign-in: wrong email or wrong password. Never says which. */
  INVALID_CREDENTIALS: 'urn:talon:error:invalid-credentials',
  /** Sign-in: the user has MFA enabled and must answer a TOTP challenge. */
  MFA_REQUIRED: 'urn:talon:error:mfa-required',
  /** Sign-in: MFA is required for this user but no authenticator is enrolled. */
  MFA_NOT_ENROLLED: 'urn:talon:error:mfa-not-enrolled',
  /**
   * The endpoint exists and the caller is fine, but the configured provider
   * cannot perform the operation — Cognito's TOTP enrolment is session-scoped
   * and the §6.1 `enrollTotp(sub)` signature cannot carry a session (spec 002).
   * Retrying never helps; this is for an operator, not a user.
   */
  NOT_IMPLEMENTED: 'urn:talon:error:not-implemented',
  /** Request body, params or query rejected by its schema. Carries `errors`. */
  VALIDATION_FAILED: 'urn:talon:error:validation-failed',
  /** Also returned for another tenant's resource — never 403 (spec 001 §6.4). */
  NOT_FOUND: 'urn:talon:error:not-found',
  /**
   * Board moves. Two 409s, deliberately distinct (ARCHITECTURE §6.1): the card
   * changed under you, versus the card is no longer where you thought. The ui shows
   * different copy for each and refetches differently, so collapsing them would lose
   * the only signal that someone else moved it.
   */
  STAGE_VERSION_CONFLICT: 'urn:talon:error:stage-version-conflict',
  /** Answered regardless of version — re-applying a stage change over someone else's
   *  move corrupts the append-only transition log. */
  STAGE_MOVED: 'urn:talon:error:stage-moved',
  /** A move to a terminal stage with no reason (PRD §5.4). */
  REASON_REQUIRED: 'urn:talon:error:reason-required',
  INTERNAL: 'urn:talon:error:internal',
} as const;

export type ErrorType = (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES];
