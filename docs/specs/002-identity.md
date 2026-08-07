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

**In:** `users.external_id` (migration 0004) and a text-typed `auth_user_by_sub`; `CognitoIdentityProvider`; a JWKS verifier; `session.ts` as the single source of the §6.2 claim shape; provider selection by env var; a network-level Cognito stub so the suite needs no AWS.

**Out:** the pre-token-generation Lambda; Terraform for the pool (`002-infrastructure.md`); SSO and hosted-UI flows (spec 003); removing `LocalIdentityProvider`.

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

`TALON_IDENTITY_PROVIDER` selects the implementation; **local remains the default** so nothing changes for anyone without AWS. Cognito mode additionally requires `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, a region, and `TALON_JWT_SECRET`.

That last one is a security fix, not a convenience: the secret guard previously only fired on `NODE_ENV=production`, so a staging deployment against a real pool would have signed every token with the constant published in this repo — forgeable for any tenant and any role. Boot now refuses `cognito` unless a **real** key is supplied — the published constant is rejected even when named explicitly, and whitespace counts as unset. A presence-only check would be satisfied by an operator pasting the value they found in `config.ts`, which is the exact outcome the guard exists to prevent.

## 7. Testing

The Cognito boundary is stubbed at the **network** layer — the SDK is pointed at a local `node:http` server speaking AWS JSON 1.1, and JWKS is intercepted at `globalThis.fetch` — so the real serialiser, signer, deserialiser and retry middleware all execute. Verified green with every `AWS_*` variable unset and the credential files pointed at nonexistent paths.

This matters more than a convenience: if `LocalIdentityProvider` is ever removed, that stub becomes the only way `pnpm test` runs without AWS, and it stops being a test helper and becomes load-bearing infrastructure.

## 8. Accepted divergences from spec 001

1. **Refresh is absolute, not sliding**, under Cognito — see spec 001 open question 2's amendment.
2. **`enrollTotp(sub)` / `verifyTotp(sub, code)` are not implementable** behind the §6.1 signature. `AssociateSoftwareToken` needs an access token or a challenge session, which the signature cannot carry. They return 501. **This is a defect in the interface, not the adapter** — it only surfaced once a real IdP sat behind the seam.
3. **`sub` differs by provider.** Shape identical, value provider-specific — spec 001 §6.2's nuance.

## 9. Edge cases

1. **Clock skew.** Cognito measured 2s ahead of the dev machine, and the verifier had inherited the local rule of zero leeway on a future `iat` — correct for tokens we sign ourselves, wrong for a remote issuer. Leeway is now explicit and required, bounded at 60s.
2. **A user provisioned in Cognito, signing in locally** (or the reverse) fails closed at sign-in with `user_not_provisioned`, rather than issuing a token that dies on the next request.
3. **Throttling.** A sustained `TooManyRequestsException` currently surfaces as 500 where it should be 429 with `Retry-After`; `IdentityFailureCode` has no `rate_limited`, and the local provider cannot throttle at all. Known gap, pinned by a test.
4. **JWKS key rotation** heals within 60s — an unknown `kid` is answered from cache first, a deliberate anti-amplification trade. The refetch floor is keyed on the last **successful** load, not the last attempt: keyed on attempts, a single key-server outage would leave the cache empty and answer `bad_signature` for a minute, turning a 500 into a fleet of 401s telling users to re-login. That matters most after the Lambda swap, when this verifier runs on every request.
5. **`AWS_ENDPOINT_URL`** in `.env.example` is LocalStack's, and it is the SDK's *global* override — exported alongside Cognito it points sign-in at LocalStack and the failure reads as bad credentials. The real fix is service-scoped `AWS_ENDPOINT_URL_S3` / `_SQS`.

## 10. Open questions

1. **Does `LocalIdentityProvider` stay?** Answered verbally "Cognito only", not yet implemented. Removing it touches ~20 files across three owners, breaks `pnpm db:seed && pnpm dev` without AWS, and makes spec 001 §12's definition of done false. Owner: Aditi.
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
- [ ] Open question 1 answered and reflected in code
- [ ] Pool owned by Terraform, not the CLI
