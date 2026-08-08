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
3a. **`tokens_valid_after` was not enforced at sign-in. Fixed 2026-08-08.** It was checked on every authenticated request (`resolveTenant`) and at refresh, but not at the door — so an account whose cut-off is in the **future**, which is how an admin suspends someone until Monday, signed in with a 200 and then 401'd on the very next call. "Signed in", immediately followed by "session invalid", with nothing naming the cause: the same shape as the `external_id` regression in §3, and the same answer.

   Sign-in now stamps its `iat` once, checks it, and mints with it, so the door applies **literally** the predicate the next request will. The predicate itself moved into `session.ts` (`isIssuedBeforeInvalidation`) and is called from all three sites, because "three checks that agree today" is exactly the arrangement that produced this bug.

   A new `IdentityFailureCode`, `token_invalidated` → 401 `urn:talon:error:token-invalidated`, the same `type` `resolveTenant` already answered with. Distinct from `invalid_token` because nothing is wrong with the token; reachable only after Cognito has accepted the password, so naming it discloses nothing the caller did not already know. The detail deliberately omits *when* the cut-off lifts — that is account state, and this response is the one place it would be visible. Refresh moved onto the same code, which changes its `type` from `invalid-token`: same condition, same answer.

   A cut-off in the **past** still lets sign-in through, and a test pins it. Otherwise `tokens_valid_after` would be an account lock with no way back, rather than the "everything issued before now is dead" switch it is.

4. **JWKS key rotation** heals within 60s — an unknown `kid` is answered from cache first, a deliberate anti-amplification trade. The refetch floor is keyed on the last **successful** load, not the last attempt: keyed on attempts, a single key-server outage would leave the cache empty and answer `bad_signature` for a minute, turning a 500 into a fleet of 401s telling users to re-login. That matters most after the Lambda swap, when this verifier runs on every request.
5. **`AWS_ENDPOINT_URL`** in `.env.example` is LocalStack's, and it is the SDK's *global* override — exported alongside Cognito it points sign-in at LocalStack and the failure reads as bad credentials. The real fix is service-scoped `AWS_ENDPOINT_URL_S3` / `_SQS`.

## 10. Open questions

1. **Does `LocalIdentityProvider` stay?** **Answered "Cognito only" and implemented 2026-08-08.** `local-provider.ts` is deleted, along with `password.ts` and `totp.ts` (both had no other caller — Cognito holds the credential, and its TOTP enrolment is session-scoped and returns 501, see §8.2), the local credential-store methods on `IdentityRepository`, `issueTokens`/`issueRefreshToken` (Talon never mints a refresh token; Cognito's is opaque and Cognito owns the exchange), and `AuthConfig.refreshAudience`/`refreshTtlSeconds` with them. `CreateUserInput.sub` went too. `local_identities` and `auth_user_by_email` stay in the database with no readers — see §2. The cost is recorded in spec 001 §5.4, §6.1, §10 and §12.
2. **`AccessTokenClaimsSchema.sub` is `z.string().uuid()`.** **Answered and implemented 2026-08-08.** Loosened to `SubjectSchema`: a bounded, non-blank, control-character-free string mirroring `users.external_id` and its `users_external_id_ck` check. Doing it now rather than at the start of the SAML work matters, because the alternative was loosening the validator for every bearer token under time pressure, in the file that decides whether a token is a token.

   What is deliberately **kept**: non-empty after trimming (`external_id = ''` in the lookup would resolve a real user for an empty subject, and the database refuses to store one); a 1024-character bound, the same as the check constraint, since a longer value can never match a stored subject and accepting it only carries an unbounded attacker-controlled string further in; and no C0/C1 control characters, because a subject travels into log lines and audit rows. It is checked, never trimmed — the subject is matched byte-for-byte against `external_id`, and a schema that silently rewrote it would make the token's `sub` and the lookup key two different values.

   What is **not** loosened: `tenant_id`, and `SessionUserSchema.id`/`tenantId`. Those name our own rows, whose type we control; loosening them would weaken a real check rather than remove a false one.

   Proven end to end, not at the schema: a SAML-shaped subject signs in and then serves `GET /v1/jobs`, because the subject has to survive the id token, the mint, `verifyToken` and `auth_user_by_sub`'s exact-match lookup — four places, of which the schema is one.

   `RefreshTokenClaimsSchema` was **removed** in the same change rather than loosened alongside it. Talon mints no refresh token; Cognito's is an opaque string, not a JWT with claims, so the schema described a token nobody issues — and the next person to read it would have written a verifier against it. `RefreshRequestSchema` (a bounded opaque string) is the real contract. Nothing imported it.
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

As shipped in 0005 that last clause over-claimed: `tenant_id` and `actor_id` on the success path were taken from the caller and only checked for null, so `talon_app` could name any tenant and any actor. Closed in `0007_definer_rls_exemption` — the function now reads the actor's tenant from `users` and writes **that**, raising if it disagrees with the tenant it was passed. See §12.6.

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

### 12.6 `security definer` is not an exemption from `force row level security` (fixed 2026-08-08, migration `0007_definer_rls_exemption`)

§12.2 chose a `security definer` writer, and §11b had already chosen two `security definer` readers, on an assumption nobody wrote down: that a definer function is exempt from the policies on the tables it touches. It is not. `FORCE` subjects the table's **owner** to the policy, and a definer runs **as the owner** — so the exemption comes from the owner holding `BYPASSRLS` or being a superuser, not from `security definer` at all.

Locally the migration role is `talon`, which is both, so every test passed. The RDS/Aurora master user is neither, which is the shape this spec exists to deploy onto. On that shape, before 0006:

* `audit_sign_in` raised `42501` on **both** paths — the null-tenant failure row because the `WITH CHECK` is `NULL`, and the success row because sign-in runs before `app.tenant_id` is set, so the check compares against `NULL` there too. The write is fail-closed by §12.4, so that is not a degraded audit trail: it is **HTTP 500 on every sign-in**;
* `auth_user_by_sub` returned zero rows, so every authenticated request would 401 as an unknown subject even if a token could be minted.

0003's header had already named the choice — "the Aurora role in spec 002 must carry `BYPASSRLS` or own an exception policy" — and neither branch was ever taken. `0007` takes the second: two policies, `auth_bootstrap_read` (SELECT on `users`) and `audit_sign_in_write` (INSERT on `audit_log`, restricted to the two authentication row shapes). Each admits the conjunction of *`current_user` is the table's owner* — which `talon_app` can never be, and which carries the security weight — and *a marker GUC the definer functions set `LOCAL`*, which is forgeable by anyone and is there only to keep FORCE's backstop against an owner-connected session that has not deliberately opted in.

**The marker is confined by the explicit resets, not by the `SET search_path` clause.** A `SET` clause on a function restores only the variable it names; it does not confine a different GUC set with `SET LOCAL` in the body. Every success path clears the marker explicitly and (sub)transaction rollback covers the error paths — so removing a reset silently keeps an owner session's widened read alive for the rest of its transaction. The migration header says the same thing at the line where someone would delete it, and the test asserts it.

`BYPASSRLS` on the migration role was refused as the alternative: it is not grantable on a managed instance without a superuser session to start the chain, and it would let the role that runs migrations read and write past every policy in the schema, permanently, to buy an exemption three functions need. A dedicated `BYPASSRLS` function owner from provisioning was refused for the same reason plus CLAUDE.md §4.11 (migrations never create roles).

**The blindness was the defect.** Every suite in the repo migrates as `talon`, so no test could see this class at all. `packages/db/test/non-superuser-owner.test.ts` now builds the hostile shape on purpose — a `nosuperuser nobypassrls` role owning its own database, the real migrations applied by it, the real calls made as `talon_app` — and asserts both audit rows are written, the bootstrap read resolves, and the marker is useless to `talon_app`.

**Still true after 0006:** a null-tenant `audit_log` row is readable by nobody through RLS. Under a superuser owner the owner connection sees it anyway; on Aurora nothing will, until §12.3's deferred "reader on the owner side" exists. `pnpm db:seed` and `seed:identities` also write `users` as the owner and are subject to the same rule — they fail loudly rather than silently, and neither runs on the request path, so 0006 deliberately does not widen anything for them.
