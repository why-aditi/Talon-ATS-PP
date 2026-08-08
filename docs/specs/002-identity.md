# Spec 002 — Identity (M0b)

**Status:** built, unreviewed
**Milestone:** M0b. Companion to `002-infrastructure.md`, which covers the Terraform stacks — same milestone, split because the two have different owners and different review surfaces. Merge them if that ever stops being true.
**Depends on:** spec 001 §6 (the `IdentityProvider` seam)
**Blocks:** spec 003 (SSO)

---

## 1. Context and goal

Spec 001 §6.1 put `LocalIdentityProvider` behind an interface and promised `CognitoIdentityProvider` would be "a configuration change rather than a rewrite." This is the change that tests that claim.

Written retrospectively: the adapter was built from a task brief and six commits already reference "(spec 002)". Recording what was decided is worth more than pretending the order was clean.

## 2. Scope

**In:** `users.external_id` (migration 0004) and a text-typed `auth_user_by_sub`; `CognitoIdentityProvider`; a JWKS verifier; `session.ts` as the single source of the §6.2 claim shape; a network-level Cognito stub so the suite needs no AWS; **the removal of `LocalIdentityProvider`** (open question 1, answered "Cognito only" — see §10).

**Out:** the pre-token-generation Lambda; Terraform for the pool (`002-infrastructure.md`); SSO and hosted-UI flows (spec 003); dropping `local_identities` and `auth_user_by_email` from the schema (spec 003 §6 — a table of password hashes goes in a migration with a rollback story, not as a footnote to a code change).

**Scope amendment, 2026-08-08.** "Provider selection by env var" and "removing `LocalIdentityProvider`" swapped sides. There is nothing left to select between, so `TALON_IDENTITY_PROVIDER` no longer chooses anything: it accepts `cognito` or nothing at all, and rejects every other value — `local` loudest of all — so a stale `.env` fails at boot instead of silently getting a Cognito deployment it did not ask for.

## 3. The decision: Cognito is the credential authority, Talon is the session authority

Sign-in calls `AdminInitiateAuth` → the returned **id token** is verified against the pool's JWKS (RS256) → the verified `sub` selects our `users` row through `external_id` → we mint the §6.2 access token from that row.

**Rejected:** pass Cognito's own token through as the bearer token and synthesise `tenant_id`/`role` inside `verifyToken`. Three reasons, the first decisive:

1. `resolveAuthenticatedUser` checks `user.tenantId !== identity.claims.tenant_id`. If those claims were themselves read from the database, that check compares the database against itself — a tautology that still looks like a tenancy guard. That is the worst possible outcome for this particular check.
2. Cognito's *access* token carries no `email`, so it would have to be the *id* token presented as a bearer token — exactly the confusion `aud` exists to prevent.
3. There would be no token to decode, so "the claim shape is identical" would become unverifiable.

**What this means for the Lambda swap.** Minting our own token is **M0b scaffolding**, confined to `cognito-provider.ts` and two `issueAccessToken` calls; it changes no interface. When the Lambda lands, `verifyToken` switches to the JWKS verifier with `tokenUse: 'access'`, and `aud`/`iss` become provider-derived. The bearer token's `sub` **already** holds the Cognito subject, so that part does not move.

**Permanent:** the JWKS verifier, the provisioning order (Cognito allocates the sub → `users.external_id` points at it), the IdP subject travelling into the token's `sub`, the error mapping, and `session.ts` as the one place the claim shape is built.

## 4. Auth flow and dependency

`ADMIN_USER_PASSWORD_AUTH`, not `USER_SRP_AUTH`. SRP's value is not transmitting a password from an untrusted client; this process already holds the plaintext because it terminates the sign-in form, so SRP would add a two-round-trip handshake to protect a secret we already have. SRP stays **enabled on the app client** (ARCHITECTURE §9.4), so a future browser-side client needs no pool change.

`@aws-sdk/client-cognito-identity-provider` replaces hand-rolled SigV4 signing, the AWS JSON 1.1 protocol, and a retry policy against a service whose error taxonomy we make security decisions on. Deliberately **not** added: `jose` or `aws-jwt-verify` — Node 22 imports a JWK and verifies RS256 natively, and the rules that matter (leeway policy, `token_use` pinning) are ours either way.

## 5. Subject resolution — the exclusivity rule

Migration 0004 adds `users.external_id text unique` (nullable) and replaces `auth_user_by_sub(uuid)` with `auth_user_by_sub(text)`, which resolves `external_id = p_sub` first and falls back to `id::text = p_sub` **only where `external_id is null`**.

The `is null` is load-bearing: a user reachable by both subjects is a user whose IdP revocation does nothing. The consequence is that **one person has exactly one sign-in method**, and switching providers for an existing user is a re-provision, not a config flip.

`text`, not `citext` or `uuid`: a SAML persistent `NameID` is opaque and case-sensitive, and folding case would let two IdP-distinct subjects collide on one row. The function is `plpgsql` rather than `sql` because SQL does not guarantee evaluation order, so a folded `::uuid` cast raises `22P02` on a hostile subject — a 500 and a probe oracle where there should be a clean 401.

## 6. Configuration

**Rewritten 2026-08-08, when open question 1 was answered.** There is no provider to select. `loadConfig` requires `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, a region (`COGNITO_REGION`, falling back to `AWS_REGION`/`AWS_DEFAULT_REGION` because ECS already sets it), and `TALON_JWT_SECRET`. Any of them missing — or whitespace, which counts as unset — stops the process at boot.

**No fallback, on purpose.** The obvious alternative, "start anyway and fail at first sign-in", produces a deployment that looks healthy, passes a readiness probe and cannot authenticate a single person. A pool-id typo has to be a boot failure, not a 500 per login.

`TALON_IDENTITY_PROVIDER` survives only as a tripwire: `cognito` or unset is accepted, everything else throws, and `local` is called out by name in the message. Deleting the variable outright would have made a stale `TALON_IDENTITY_PROVIDER=local` silently ignored — the same class of mistake as the old "anything that is not `cognito` is local" coercion, pointing the other way.

`TALON_JWT_SECRET` is a security fix, not a convenience: the guard previously only fired on `NODE_ENV=production`, so a staging deployment against a real pool would have signed every token with the constant published in this repo — forgeable for any tenant and any role. It is now required unconditionally, because Cognito is now unconditional and Cognito does not replace it: the pool proves the credential, Talon mints the §6.2 bearer token. The published constant is rejected even when named explicitly. A presence-only check would be satisfied by an operator pasting the value they found in `config.ts`, which is the exact outcome the guard exists to prevent.

**What this costs, and where it is written down.** Spec 001 §12's "yields a working jobs list from nothing" is now "from nothing plus an AWS account", §5.4 acceptance 1 is annotated, and §10's E2E flow no longer signs in with a local provider. All three are amended in place rather than left to lie.

## 7. Testing

The Cognito boundary is stubbed at the **network** layer — the SDK is pointed at a local `node:http` server speaking AWS JSON 1.1, and JWKS is intercepted at `globalThis.fetch` — so the real serialiser, signer, deserialiser and retry middleware all execute. Verified green with every `AWS_*` variable unset and the credential files pointed at nonexistent paths.

**That happened.** With `LocalIdentityProvider` removed (§10 open question 1), `cognito-stub.ts` is the only way `pnpm test` runs without AWS: it stopped being a test helper and became load-bearing infrastructure, and it is commented as such. It also now blanks `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` and disables IMDS, so a developer's ambient credentials can be neither the reason the suite passes nor a route to a real pool from CI. Re-verified green on 2026-08-08 with every `AWS_*` variable unset, the credential files pointed at nonexistent paths and `HOME`/`USERPROFILE` pointed at a directory that does not exist: 152 tests, 12 files.

## 8. Accepted divergences from spec 001

1. **Refresh is absolute, not sliding**, under Cognito — see spec 001 open question 2's amendment.
2. **`enrollTotp(sub)` / `verifyTotp(sub, code)` are not implementable** behind the §6.1 signature. `AssociateSoftwareToken` needs an access token or a challenge session, which the signature cannot carry. They return 501. **This is a defect in the interface, not the adapter** — it only surfaced once a real IdP sat behind the seam.
3. **`sub` differs by provider.** Shape identical, value provider-specific — spec 001 §6.2's nuance.

## 9. Edge cases

1. **Clock skew.** Cognito measured 2s ahead of the dev machine, and the verifier had inherited the local rule of zero leeway on a future `iat` — correct for tokens we sign ourselves, wrong for a remote issuer. Leeway is now explicit and required, bounded at 60s.
2. **A user provisioned in Cognito, signing in locally** (or the reverse) fails closed at sign-in with `user_not_provisioned`, rather than issuing a token that dies on the next request.
3. **Throttling. Fixed 2026-08-08.** A sustained `TooManyRequestsException` used to surface as a 500. `IdentityFailureCode` gained `rate_limited`, `ERROR_TYPES.RATE_LIMITED` (`urn:talon:error:rate-limited`) is the stable `type`, and the answer is **429 with `Retry-After`** — plus a `retryAfter` extension member in the body, because `Retry-After` is not CORS-safelisted and a cross-origin browser client cannot read the header without extra server configuration. A 429 whose backoff the client cannot see is a 429 the client retries immediately.

   Which exception lands in which bucket is a security decision, not a taxonomy exercise. `TooManyRequestsException` and `ThrottlingException` are **service**-level: they describe this deployment and say nothing about any account. `LimitExceededException` and `TooManyFailedAttemptsException` are **per-account** limits, so they are answered as `invalid-credentials`, identically to a wrong password — a rate limit that fires only for addresses that exist is an enumeration oracle wearing a status code. (Cognito normally expresses password lockout as `NotAuthorizedException: Password attempts exceeded`, which was already in that bucket; the two are named so a different pool configuration cannot open the hole quietly.)

   The service's own `Retry-After` is honoured, clamped to 1–300s: a repeated `86400` takes the sign-in screen out for a day and a `0` invites the retry storm the throttle exists to stop. Absent or unparseable — including the HTTP-date form RFC 9110 permits and Cognito does not send — falls back to 5s.

   The test that pinned the gap survives as the test that pins the fix: `stub.authError` is sticky precisely because the SDK retries throttling itself, so the assertion that `AdminInitiateAuth` was called more than once is what keeps this a test of the real client rather than of a double.

   Operational note: a throttled attempt is a failed sign-in, so it also writes an `audit_log` row (§12). Under a sustained throttle that is one row per attempt — visibility that is worth having, and write amplification to be aware of during an incident.
4. **JWKS key rotation** heals within 60s — an unknown `kid` is answered from cache first, a deliberate anti-amplification trade. The refetch floor is keyed on the last **successful** load, not the last attempt: keyed on attempts, a single key-server outage would leave the cache empty and answer `bad_signature` for a minute, turning a 500 into a fleet of 401s telling users to re-login. That matters most after the Lambda swap, when this verifier runs on every request.
5. **`AWS_ENDPOINT_URL`** in `.env.example` is LocalStack's, and it is the SDK's *global* override — exported alongside Cognito it points sign-in at LocalStack and the failure reads as bad credentials. The real fix is service-scoped `AWS_ENDPOINT_URL_S3` / `_SQS`.

## 10. Open questions

1. **Does `LocalIdentityProvider` stay?** **Answered "Cognito only" and implemented 2026-08-08.** `local-provider.ts` is deleted, along with `password.ts` and `totp.ts` (both had no other caller — Cognito holds the credential, and its TOTP enrolment is session-scoped and returns 501, see §8.2), the local credential-store methods on `IdentityRepository`, `issueTokens`/`issueRefreshToken` (Talon never mints a refresh token; Cognito's is opaque and Cognito owns the exchange), and `AuthConfig.refreshAudience`/`refreshTtlSeconds` with them. `CreateUserInput.sub` went too. `local_identities` and `auth_user_by_email` stay in the database with no readers — see §2. The cost is recorded in spec 001 §5.4, §6.1, §10 and §12.
2. **`AccessTokenClaimsSchema.sub` is `z.string().uuid()`.** A Cognito sub satisfies it; a SAML `NameID` will not. Must loosen before per-tenant SAML. Owner: Aditi.
3. **No client secret on the app client.** Fine for admin flows from a trusted server, but `SECRET_HASH` is unimplemented, so adding one later is a code change. Decide before Terraform owns the pool. Owner: infra.
4. **The pool is hand-built and throwaway** (`us-east-1_08d7fh6x5`). Terraform does not know about it. Owner: infra.

## 11. Definition of done

- [x] Claim shape identical across providers, verified side by side against a live pool
- [x] `tenant_id` and `role` read from our `users` table — proven by changing a role in Postgres and seeing the next sign-in and comp gating follow
- [x] No custom attributes on the pool
- [x] End to end under Cognito: sign in → `GET /v1/jobs` → six-job table, `band` gated by role
- [x] Suite passes with zero AWS credentials
- [ ] Reviewed per CLAUDE.md §8
- [x] Open question 1 answered and reflected in code (2026-08-08)
- [ ] Pool owned by Terraform, not the CLI

## 12. Sign-in writes to `audit_log` (added 2026-08-08)

CLAUDE.md §4 says every mutation writes `audit_log` with actor, before, after, IP and request id. Sign-in — the mutation with the largest security value and the smallest state change — wrote nothing.

### 12.1 Why it could not just use the tenant transaction

Sign-in runs **before** tenant context exists. There is no `openTenantTransaction` to enlist in, because the tenant is only known once the credential has been checked, and for a failed attempt it is never known at all. `audit_log.tenant_id` is nullable for exactly this case (ARCHITECTURE §5, "system-level events"), and 0001's own comment says such rows are writable only by "the owner (migration role / **system writer**)": under the table's RLS policy a null tenant makes the `WITH CHECK` expression evaluate to `NULL`, and only `TRUE` passes, so `talon_app` cannot insert one.

### 12.2 The three options, and the decision

1. **A second, owner-privileged connection in the api process.** Rejected on spec 001 §11b's reasoning, unchanged: a connection is granted a *table*, so it can write anything to anything for as long as it is held, and `beginTenantTransaction` deliberately refuses to serve a request on a role that bypasses RLS. Handing the request process owner credentials to buy a log line inverts the guarantee that check exists to make.
2. **Audit only what a tenant transaction can reach** — successes, plus failures for known addresses after a lookup. Rejected, and this is the important one: it drops failed attempts for **unknown** addresses, which is precisely the shape of a credential-stuffing sweep, and it makes the audit path branch on whether an account exists. A branch there is a timing oracle, and if the null-tenant insert then raises it is an error-shaped one — a 500 for unknown addresses against a 401 for known ones, which is the enumeration leak the sign-in path is otherwise careful to avoid.
3. **A `security definer` writer, granted narrowly.** Taken. Migration `0005_audit_authentication` adds `audit_sign_in(...)`: `volatile`, `security definer`, `set search_path = pg_catalog, public`, `execute` revoked from `public` and granted only to `talon_app`. This is the same shape §11b settled on for the two bootstrap *readers*, and the same argument — `talon_app` is granted a **result**, not a table.

**Narrow means narrow.** The function can only ever produce one of two rows: `auth.sign_in.succeeded` or `auth.sign_in.failed`, `entity_type` fixed to `authentication`, no caller-chosen action, no caller-chosen entity, no `before` state, and every column the caller has no legitimate say in decided inside the function. An outcome that is neither value raises; a `succeeded` without a tenant and an actor raises, because it would be written with a null tenant and vanish from the trail its own tenant would read.

### 12.3 What is recorded, and what deliberately is not

| Field | Value |
|---|---|
| `action` | `auth.sign_in.succeeded` / `auth.sign_in.failed` |
| `entity_type` | `authentication`; `entity_id` null — no entity changed |
| `tenant_id`, `actor_id` | **Only on success.** Null on every failure |
| `before` | Null. Authenticating changes no state |
| `after` | `{ outcome, email, reason? }` |
| `ip` | `request.ip`, the socket peer — `trustProxy` is off, so no attacker-settable `X-Forwarded-For` reaches the trail |
| `request_id` | Fastify's, which is also the `requestId` in the problem document the caller received |

**Never the password. Never the token.** And never a `reason` beyond the RFC 9457 `type` the caller was already given: a log that knows more about *why* a sign-in failed than the response did is the oracle the response was written not to be. An unknown address and a wrong password produce rows that are byte-identical apart from the string the caller typed.

**Failures carry no tenant and no actor even when the address is real.** Attributing a failed attempt to an account asserts an identity nobody proved, and resolving one would put an existence-dependent lookup on the failure path. The address as typed is kept, so correlation is still possible offline by someone entitled to do it. The cost, stated: a tenant admin reading their own audit trail will not see failed attempts against their users, because those rows are null-tenant and invisible under RLS. When there is a screen for that, the answer is a reader on the owner side, not attribution at write time.

### 12.4 Fail-closed

The write is not wrapped in a `try`. A sign-in that cannot be audited does not happen: on success the token has been minted but not returned when the write runs, and a JWT nobody was handed is inert. On failure the row is written first and the original problem rethrown, so a broken audit path turns **every** 401 into a 500 rather than some of them — uniformity being the point, since nothing in the audit call depends on whether the address exists.

The trade is deliberate and worth naming: `audit_sign_in` is now a hard dependency of sign-in, and rolling migration 0005 back under a running api breaks every login. That is written into `0005_audit_authentication.down.sql`. The alternative — swallow the error and serve the session — makes CLAUDE.md §4 a hope, and hands anyone who can break the audit path an unlogged way in.

### 12.5 Not covered

`POST /v1/auth/refresh` writes no audit row. It is an authentication event and should have one, but its "attempted identity" is a token that must not be logged, and the failure case carries nothing but an IP — a different design question, deliberately not answered in the same change. **Owner: api.** Sign-out does not exist server-side yet (spec 001 §7b: the web BFF clears its cookie), so there is nothing to record.
