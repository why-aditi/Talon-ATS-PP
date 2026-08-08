# Spec 004 — Google SSO

**Status:** the flow works end to end as far as Google's sign-in page, verified live on
2026-08-08. Web, api and infra are all built. The remaining gap is provisioning, not
plumbing — see §10.6.
**Milestone:** M0b. Follows `002-identity.md`, which named SSO as the thing it blocks.
**Depends on:** spec 002 (`CognitoIdentityProvider`, the JWKS verifier, `users.external_id`)
**Blocks:** SAML SSO, and PRD §5.1's SSO-discovery-by-email-domain

> Numbered 004, not 003. Spec 002 said "spec 003 (SSO)", but 003 was taken by the
> job-template modal before this was written. The reference in 002 §1 should read 004.

---

## 1. Context and goal

The sign-in screen ships "Continue with Google" and "Continue with SAML SSO"
disabled, under the line "Single sign-on isn't available yet." This makes the
Google half true.

**Google only.** SAML is deliberately excluded, and not for effort: spec 002's
open question 2 records that `AccessTokenClaimsSchema.sub` is `z.string().uuid()`,
which a Cognito sub satisfies and a SAML persistent `NameID` does not. Google
through Cognito yields a Cognito sub, so it clears that hurdle untouched. SAML
needs the schema loosened first — that is a contract change with an owner, not
something to slip in behind a button.

## 2. Scope

**In:** a Cognito hosted-UI authorization-code flow with `identity_provider=Google`;
the two web route handlers that start and finish it; `POST /v1/auth/sso` on the api
so the id token becomes a Talon session; the Terraform for a user-pool domain and a
Google IdP; the enabled button and its failure states.

**Out:** SAML. SSO discovery by email domain (PRD §5.1 — needs a per-tenant IdP
mapping that does not exist). Just-in-time user provisioning: a Google identity for
someone with no `users` row fails as `user_not_provisioned`, exactly as password
sign-in does today. Account linking between a password user and a Google user —
spec 002 §5's exclusivity rule says one person has one sign-in method, and that
rule holds here.

## 3. Who owns what

The flow crosses all three streams. Nothing below works until all three land.

| Piece | Owner | State |
|---|---|---|
| `aws_cognito_user_pool_domain`, `aws_cognito_identity_provider` (Google), callback URL allow-list, `supported_identity_providers` on the app client | infra | **not started** — confirmed against AWS on 2026-08-08: no domain, no Google IdP, no OAuth flows on the client. Full work order with the Terraform in **§10** |
| `POST /v1/auth/sso` — verify a Cognito id token, resolve `users` by `external_id`, mint the §6.2 session | api | **BUILT** 2026-08-08. `exchangeIdToken` on the provider seam, `signInWithSso` on the service, the route in `identityRoutes` and in `PUBLIC_ROUTES`. Eight tests in `apps/api/test/sso.test.ts`, verified to fail when token verification is bypassed. See §11.8 for the one deviation |
| The two route handlers, the button, the states | web | **built, flag-off, unit-tested** (2026-08-08) |

The off state is the shipped state and was verified live, not reasoned about: with
no `COGNITO_DOMAIN` set, `GET /api/auth/sso/google` and `GET /api/auth/sso/callback`
both return 404, the button renders disabled, and `POST /v1/auth/sign-in` still
returns 200. Turning the flag on before the api route exists produces a round-trip
that fails at its last step — so the flag stays off until the row above changes.

## 4. Flow

```
browser  GET  /api/auth/sso/google
  web    302  → {cognitoDomain}/oauth2/authorize
                  ?identity_provider=Google
                  &response_type=code
                  &client_id=…&redirect_uri={app}/api/auth/sso/callback
                  &scope=openid+email+profile
                  &state=…&code_challenge=…&code_challenge_method=S256
  …Cognito → Google → Cognito…
browser  GET  /api/auth/sso/callback?code=…&state=…
  web    POST {cognitoDomain}/oauth2/token      (code + verifier → id_token)
  web    POST {api}/v1/auth/sso                 (id_token → Talon session)
  web    302  → /jobs, with the refresh cookie set
```

**Why the web owns the dance rather than the api.** The redirect and the callback
are browser navigations, and the callback has to end by setting the httpOnly refresh
cookie — which is already a web route handler's job (spec 001 §7b.1). The api keeps
the part that is actually its own: verifying an IdP token and minting a session.
The alternative — the api owning both legs — would mean it setting cookies on a
redirect for a browser it otherwise never talks to.

**`POST /v1/auth/sso`** takes `{ idToken: string }` and returns exactly what
`/v1/auth/sign-in` returns (`SignInResponseSchema`), so the web side has one shape
to handle. It verifies against the pool's JWKS with `token_use: 'id'`, resolves
`users` through `external_id` per spec 002 §5, and fails `user_not_provisioned`
when there is no row — never creating one.

## 5. Security

- **`state`** is 32 random bytes, held in a short-lived httpOnly cookie and compared
  on return. Without it the callback accepts any code an attacker can deliver, which
  is login CSRF wearing an OAuth costume — the same hole the origin guard closed on
  `/api/auth/sign-in`.
- **PKCE** (`S256`). The app client has no secret (spec 002 open question 3), so the
  code alone is bearer-equivalent; the verifier is what stops an intercepted code
  being redeemed by someone else.
- **The id token never reaches the browser.** It is exchanged server-side and posted
  to the api from the route handler, the same shape as the sign-in proxy.
- **`redirect_uri` is exact-matched** by Cognito's allow-list. It is derived from
  `APP_ORIGIN` rather than from the request, so a Host header cannot redirect the
  code somewhere else.
- The `state` and verifier cookies are `SameSite=Lax` — the callback is a top-level
  cross-site GET, which `Strict` would strip.

## 6. Configuration

`NEXT_PUBLIC_SSO_GOOGLE` enables the button; `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`
and `APP_ORIGIN` are read server-side by the route handlers. **Default off.** With
the flag unset the button keeps today's disabled treatment and the routes 404 — a
button that redirects to an unconfigured pool is worse than one that says it isn't
ready.

## 7. States

| State | Cause | Screen |
|---|---|---|
| Start | button pressed | Redirect. No spinner: the navigation is the feedback. |
| Denied | user cancels at Google (`error=access_denied`) | Back on sign-in, "Google sign-in was cancelled." Not an error tone. |
| Not provisioned | valid Google identity, no `users` row | The existing `USER_NOT_PROVISIONED` copy — "ask an admin to add you." |
| State mismatch | cookie missing or ≠ returned `state` | "That sign-in link expired. Start again." Never "invalid credentials". |
| Exchange failed | Cognito or the api rejects | The existing generic failure copy. |

## 8. Test plan

- Unit: the authorize URL carries `identity_provider=Google`, a `state`, and an
  `S256` challenge; the callback rejects a mismatched `state` without calling
  Cognito; each failure maps to its own copy.
  Landed as `apps/web/src/test/sso.test.ts` (15 cases) and the
  `a Google round-trip that failed` block in `sign-in.test.tsx` (3 cases). The
  state-rejection tests assert `fetch` was never called, not merely that the
  response was a redirect — a handler that exchanged the code and *then* redirected
  would pass the weaker assertion while being the exact bug the test exists for.
- E2E: not automatable against real Google without a test account and a live pool.
  The slice covers the flag-off case — the button is disabled and the routes 404 —
  and the flag-on path is verified by hand until a Cognito test pool exists. Said
  plainly here rather than left as an assumed gap.

## 9. Open questions

1. **Who provisions the `users` row for a Google identity?** Until admin invites
   exist, a new hire signs in successfully at Google and is refused by Talon. That
   is correct and unhelpful. Owner: Aditi.
2. **One pool or one per tenant?** One pool means one Google IdP for everyone and
   `hd`-claim checks are the only tenant boundary at the IdP. Decide before SAML,
   where per-tenant is the whole point. Owner: infra.
3. **`AccessTokenClaimsSchema.sub`** still `z.string().uuid()` — unblocked for
   Google, blocking for SAML. Carried from spec 002. Owner: Aditi.

---

# Part II — Work orders

Written 2026-08-08 by the web stream, for the infra and api streams to pick up.
The web half is built and merged behind a flag; these two sections are everything
that has to exist before the flag can be turned on. Neither is in `apps/web`, so
neither was written by the person who wrote the client — read them as a request
with the reasoning attached, not as a finished design you may not argue with.

**State of the world, checked against AWS on 2026-08-08, not assumed:**

```
$ aws cognito-idp describe-user-pool --user-pool-id us-east-1_08d7fh6x5
  Name:         talon-throwaway-spec002
  Domain:       null          <- no hosted UI. There is nowhere to redirect.
  CustomDomain: null
$ aws cognito-idp list-identity-providers --user-pool-id us-east-1_08d7fh6x5
  Providers: []               <- Google is not configured.
$ aws cognito-idp describe-user-pool-client --client-id 3nc06m1cq2j663ud2uutgpbmuf
  ClientName:                 talon-throwaway-api
  ClientSecret:               null    <- public client, which PKCE wants
  AllowedOAuthFlows:          null    <- no code flow
  CallbackURLs:               null    <- nothing allow-listed
  AllowedOAuthScopes:         null
  SupportedIdentityProviders: null
$ curl -X POST localhost:3001/v1/auth/sso
  404                                 <- the route does not exist
```

Four blockers. Sections 10 and 11 clear them.

---

## 10. Infra work order — Cognito hosted UI and the Google IdP

**Owner:** infra stream · **Stack:** `infra/terraform/stacks/persistent` (does not
exist yet — spec 002 §2 lists it as "in, later")

### 10.1 Do not import the existing pool

`talon-throwaway-spec002` is a hand-made pool from spec 002's live-run testing.
The name says what it is. Importing it would make a throwaway the permanent
identity store for every environment, under a name nobody can change — **pool
renames are not in-place, and CLAUDE.md non-negotiable #16 forbids the schema
churn that would follow.** Create a properly named pool in `stacks/persistent`
and delete the throwaway once the seeded local users no longer point at it.

This reverses the "pool import" line in the 04:56 dispatch. It is worth reversing
now: every day the throwaway survives makes it more load-bearing.

### 10.2 `stacks/persistent/cognito.tf`

Naming follows `stacks/iam`: everything derives from
`local.name = "${var.name_prefix}-${var.env}"`, so a prefix-scoped company IAM
grant is satisfied by changing one variable.

```hcl
# ---------------------------------------------------------------------------
# User pool. CLAUDE.md non-negotiable #16: the schema is immutable and a diff
# force-replaces the pool, destroying every user. `ignore_changes = [schema]` is
# what stops an innocuous-looking plan doing that. `prevent_destroy` is
# deliberately NOT used — ARCHITECTURE §9.5a rules it out because it cannot be
# parameterized and would block `scripts/down.sh`. The protection that replaces
# it is the explicit `cognito-idp:DeleteUserPool` deny on the CI deploy role
# (spec 002 §4), which leaves the pool destroyable by a human and not by an
# automated apply.
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool" "main" {
  name = local.name

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # No custom attributes, ever. tenant_id, role and job membership live in our
  # `users` table keyed by `sub` (ARCHITECTURE §9.4). If you think you need one,
  # you need a database column.
  lifecycle {
    ignore_changes = [schema]
  }
}

# ---------------------------------------------------------------------------
# Hosted UI domain. This is the thing whose absence blocks everything: without
# it there is no /oauth2/authorize to redirect to, and the web app's SSO routes
# correctly 404 rather than sending anyone to a URL that does not resolve.
#
# Cognito prefix domain, not a custom one. A custom domain needs an ACM cert in
# us-east-1 and a Route 53 record — a larger change for zero functional gain at
# this stage, since the domain only ever appears in a redirect nobody reads.
# Revisit for prod branding.
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool_domain" "main" {
  domain       = local.name # -> https://talon-dev.auth.us-east-1.amazoncognito.com
  user_pool_id = aws_cognito_user_pool.main.id
}

# ---------------------------------------------------------------------------
# Google. `attribute_mapping` is the load-bearing part: the api resolves the
# `users` row by the token's `sub` via `users.external_id` (migration 0004), and
# `email` is what a human matches an invite against. `username` must map to
# `sub` — mapping it to email lets a Google account that changes its primary
# address collide with an existing pool user.
# ---------------------------------------------------------------------------
resource "aws_cognito_identity_provider" "google" {
  user_pool_id = aws_cognito_user_pool.main.id

  # Exact string. The web app sends `identity_provider=Google` in the authorize
  # URL (apps/web/src/lib/sso.ts), so this is a contract between two repos'
  # worth of code that share no types. Changing it breaks the button silently.
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = local.google_oauth.client_id
    client_secret    = local.google_oauth.client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    username       = "sub"
    email          = "email"
    email_verified = "email_verified"
    name           = "name"
  }
}

# ---------------------------------------------------------------------------
# App client. ONE client for both the API's password auth and the hosted UI: the
# `aud` claim then matches whichever way someone signed in, and the api's JWKS
# verification needs no branch.
#
# Deliberately SECRET-LESS. The web app is a public client, PKCE is what binds
# the code to the browser that started the flow, and a secret in a client that
# cannot keep one is worse than no secret because it looks like protection.
#
# `callback_urls` is exact-matched by Cognito. The web app builds its
# redirect_uri from APP_ORIGIN and never from the request Host — precisely so a
# spoofed Host cannot steer the authorization code elsewhere — so these two
# strings must agree character for character, trailing slash included.
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool_client" "app" {
  name         = "${local.name}-app"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH", # CognitoIdentityProvider.initiatePasswordAuth
    "ALLOW_REFRESH_TOKEN_AUTH",       # ...refreshSession
    "ALLOW_USER_SRP_AUTH",
  ]

  supported_identity_providers = ["COGNITO", "Google"]

  allowed_oauth_flows                  = ["code"] # never "implicit"
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  callback_urls = var.sso_callback_urls
  logout_urls   = var.sso_logout_urls

  # Matches the throwaway client, which matches spec 001 §11 open question 2:
  # 1h access, 30d sliding refresh.
  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # Cognito defaults this to LEGACY, which leaks whether an address exists. An
  # attacker who can enumerate valid emails has a head start on everything else.
  prevent_user_existence_errors = "ENABLED"

  depends_on = [aws_cognito_identity_provider.google]
}
```

### 10.3 The Google client secret

`aws_cognito_identity_provider.provider_details` takes the secret as a plain
string, so it lands in Terraform state whatever you do. That is a fact about the
resource, not something to design around — but it does mean the secret must not
*also* sit in a `.tfvars` file in the repo.

```hcl
# secrets.tf
data "aws_secretsmanager_secret_version" "google_oauth" {
  secret_id = var.google_oauth_secret_id # e.g. "talon-dev/google-oauth"
}

locals {
  # { "client_id": "....apps.googleusercontent.com", "client_secret": "..." }
  google_oauth = jsondecode(data.aws_secretsmanager_secret_version.google_oauth.secret_string)
}
```

The secret is created out of band (console or CLI), **not** by Terraform. A
Terraform-created secret with a placeholder value gets applied over the real one
by the next `apply` that runs before someone rotates it.

Consequence, stated plainly: **the state bucket now holds a credential.** It must
be encrypted (SSE-KMS) and its bucket policy must deny non-TLS access. If that is
not already true of the stage-1 bootstrap bucket, it is a blocker for this
section rather than a follow-up.

### 10.4 Google Cloud console side

Not Terraform — there is no usable provider path for OAuth client creation. Done
by hand, once, and written down here so it does not become folklore:

1. APIs & Services → Credentials → **Create OAuth client ID** → *Web application*
2. **Authorized JavaScript origins:**
   `https://<local.name>.auth.<region>.amazoncognito.com`
3. **Authorized redirect URIs:**
   `https://<local.name>.auth.<region>.amazoncognito.com/oauth2/idpresponse`

   Cognito's endpoint, **not** Talon's callback. Talon's callback is registered
   with Cognito (`callback_urls`); Google never sees it. Getting these two the
   wrong way round is the most common failure in this setup, and it presents as
   `redirect_uri_mismatch` at Google with no hint which side is wrong.
4. Put the resulting id and secret into the Secrets Manager secret from §10.3.

### 10.5 Variables

```hcl
variable "sso_callback_urls" {
  description = "Exact-matched by Cognito against the web app's redirect_uri, which is built from APP_ORIGIN. Both must agree character for character."
  type        = list(string)
  default     = ["http://localhost:3000/api/auth/sso/callback"]
}

variable "sso_logout_urls" {
  type    = list(string)
  default = ["http://localhost:3000/sign-in"]
}

variable "google_oauth_secret_id" {
  description = "Secrets Manager secret holding {client_id, client_secret} for the Google OAuth web client. Created out of band; see spec 004 §10.3."
  type        = string
}
```

`http://localhost:3000` in a callback list is legitimate — Cognito permits plain
HTTP for `localhost` specifically, and it is the only way the flow is testable
before a deployed origin exists. It should not survive into the prod tfvars.

### 10.6 Outputs, and the second IAM apply

```hcl
output "cognito_user_pool_id"  { value = aws_cognito_user_pool.main.id }
output "cognito_user_pool_arn" { value = aws_cognito_user_pool.main.arn }
output "cognito_client_id"     { value = aws_cognito_user_pool_client.app.id }

output "cognito_domain" {
  description = "Hosted UI origin. Becomes COGNITO_DOMAIN in the web app's environment."
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}
```

Then, per spec 002 §4.5, re-apply `stacks/iam` with the pool ARN so the Cognito
statement is actually generated:

```
terraform -chdir=infra/terraform/stacks/iam apply \
  -var 'cognito_user_pool_arns=["<cognito_user_pool_arn>"]'
```

Until that second apply, tenant SSO configuration fails with `AccessDenied`.
Spec 002 §7.9 records this as intended; it is repeated here because it is exactly
the kind of thing that reads as a bug three weeks later.

### 10.7 Acceptance

1. `describe-user-pool` shows a non-null `Domain`.
2. `list-identity-providers` lists `Google`.
3. `describe-user-pool-client` shows `AllowedOAuthFlows: ["code"]`, the three
   scopes, and the callback URL.
4. Opening this in a browser reaches **Google's** account chooser:

   ```
   <cognito_domain>/oauth2/authorize
     ?identity_provider=Google
     &response_type=code
     &client_id=<cognito_client_id>
     &redirect_uri=<callback>
     &scope=openid+email+profile
     &state=x&code_challenge=y&code_challenge_method=S256
   ```

   This is the check that proves §10.4 was done right, and it works before any
   Talon code runs.
5. `terraform plan` immediately after apply is empty. A non-empty plan touching
   `aws_cognito_user_pool` is the non-negotiable #16 failure mode: understand it,
   never re-apply through it.

---

## 11. API work order — `POST /v1/auth/sso`

**Owner:** api stream · **Files:** `packages/contracts/src/auth.ts`,
`apps/api/src/modules/identity/{routes,service,provider,cognito-provider,local-provider}.ts`

### 11.1 This is smaller than it looks

`cognito-provider.ts` already does every hard part. Its own header comment
describes the flow this route needs:

> verify the returned id token against the pool's JWKS (RS256) → the verified
> `sub` selects our `users` row, via `users.external_id` (migration 0004) → we
> mint the §6.2 access token from that row, with `session.ts`

That is this endpoint, minus the password step. **`AdminInitiateAuth` is the only
part that does not apply** — the browser has already proved the identity to
Google, and Cognito has already minted an id token for it. So this is a new
provider method reusing the existing verification and session-issuing path, not a
new authentication mechanism.

### 11.2 Contract

`packages/contracts/src/auth.ts`:

```ts
/**
 * The id token Cognito issued for a completed hosted-UI flow. Sent by the web
 * app's callback route handler, server to server — it never reaches the browser
 * (spec 004 §4), which is why there is no CSRF concern on this endpoint and no
 * cookie in the exchange.
 */
export const SsoRequestSchema = z.object({
  idToken: z.string().min(1),
});
export type SsoRequest = z.infer<typeof SsoRequestSchema>;

/** Identical to sign-in: same tokens, same user, same session semantics. */
export const SsoResponseSchema = SignInResponseSchema;
export type SsoResponse = z.infer<typeof SsoResponseSchema>;
```

Reusing `SignInResponseSchema` rather than declaring a parallel shape is
deliberate: the web app already parses the response with it
(`app/api/auth/sso/callback/route.ts`), and a session that differs by how it was
obtained is a session two code paths have to handle forever.

**Do not loosen `AccessTokenClaimsSchema.sub` for this.** A Google `sub` through
Cognito is a UUID, so `z.string().uuid()` holds. It has to loosen for SAML, whose
NameID is not a UUID — that is open question 3, a separate change with its own
blast radius.

### 11.3 Route

`apps/api/src/modules/identity/routes.ts`, alongside the two already there:

```ts
app.post('/auth/sso', async (request, reply) => {
  const body = parseOrThrow(SsoRequestSchema, request.body, 'body');
  return reply.send(await services(request).identityService.signInWithSso(body));
});
```

**It belongs in `identityRoutes`, which `public-routes.ts` registers outside the
authenticated scope, and it must be added to `PUBLIC_ROUTES`.** You cannot
present a bearer token to the endpoint that issues one. That list is the
deliberate, visible act of opting out (ARCHITECTURE §4.1), and the route-manifest
test fails CI if a route is neither protected nor listed — which is the correct
outcome if this step is forgotten.

### 11.4 Service

```ts
async signInWithSso(input: { idToken: string }): Promise<SsoResponse> {
  const result = await this.#run(() => this.#provider.exchangeIdToken(input.idToken));
  if (result.status === 'mfa_required') {
    // Unreachable today: MFA is enforced at the IdP for a federated identity and
    // Cognito does not re-challenge one. Handled rather than asserted away,
    // because `AuthResult` is a union and narrowing it by assertion is how the
    // branch that eventually happens goes unnoticed.
    throw new HttpProblem(401, ERROR_TYPES.MFA_REQUIRED, 'MFA required');
  }
  return { ...result.tokens, user: result.user };
}
```

`#run` maps `IdentityFailure` to problem+json, so the table in §11.6 needs no
per-call handling.

### 11.5 Provider

Add to the `IdentityProvider` interface in `provider.ts`:

```ts
/**
 * Federated sign-in. The caller holds an id token Cognito minted for a completed
 * hosted-UI flow; this verifies it and returns a Talon session, exactly as
 * `initiatePasswordAuth` does once a password is proven.
 *
 * Not folded into `verifyToken`: that answers "is this OUR access token", runs
 * on every authenticated request via the `authenticate` hook, and must stay that
 * narrow. An id token is minted for a client, not for an API — the confusion
 * `aud` exists to prevent — so it gets its own door.
 */
exchangeIdToken(idToken: string): Promise<AuthResult>;
```

**`CognitoIdentityProvider`** — reuse, do not reimplement:

1. `JwksVerifier` with `tokenUse: 'id'` and `audience` = the app-client id. The
   `tokenUse` is not optional: accepting an access token here would take a token
   minted for a different purpose. Same JWKS cache as `verifyToken` — note the
   timestamp-caching bug already fixed there and do not reintroduce it.
2. Resolve the `users` row by the verified `sub` through `findUserBySub`, which
   goes via `auth_user_by_sub` / `users.external_id`.
3. No row → `IdentityFailure('user_not_provisioned')`. This is the ordinary case
   for a real new hire, not a malfunction.
4. Row → `issueAccessToken` from `session.ts`, the same call the password path
   makes. One claim-shape source (§6.2) is what keeps a federated session
   indistinguishable from a password one everywhere downstream.

> **Amended 2026-08-08.** This paragraph named a second implementation. There
> isn't one any more: `f41ac45` (spec 002 open question 1, answered "Cognito
> only") deleted `local-provider.ts`, `password.ts` and `totp.ts`, and
> `container.ts` now registers `CognitoIdentityProvider` unconditionally. So
> `exchangeIdToken` has exactly one implementation and needs no 501 branch. The
> seam itself stays — `cognito-stub.ts` substitutes the *network*, not the class,
> which is what keeps the tests in §11.7 deterministic.

### 11.6 Failures, and what the web app already does with them

The client maps these to distinct copy (`sign-in.tsx`, `SSO_FAILURES`). The
mapping exists; it needs the API to distinguish the cases.

| Cause | `IdentityFailure` | Status | `type` | Web shows |
|---|---|---|---|---|
| Signature / issuer / audience bad | `invalid_token` | 401 | `…:invalid-token` | `?sso=failed` |
| Token expired | `token_expired` | 401 | `…:token-expired` | `?sso=failed` |
| Verified, but no `users` row | `user_not_provisioned` | 401 | `…:user-not-provisioned` | `?sso=not_provisioned` |
| Body is not `{ idToken }` | — | 400 | `…:validation-failed` | `?sso=failed` |

The third row is the one that matters and the one a generic handler would lose.
"Your Google sign-in worked; this workspace has no account for you" and "sign-in
failed" send a person to do completely different things, and only one of them can
succeed. The web app's callback already switches on
`ERROR_TYPES.USER_NOT_PROVISIONED` to pick it.

### 11.7 Tests

- **Unit** — an id token with the wrong `aud` is refused; an expired one is
  refused as `token_expired`, not `invalid_token`; a valid token for a `sub` with
  no `users` row raises `user_not_provisioned`; a valid token for a provisioned
  `sub` returns claims matching `session.ts`'s shape.
- **Route manifest** — the route appears in the public allow-list and
  `pnpm test:routes` passes. It is public by design; the test's job is to make
  that a decision someone wrote down rather than an omission.
- **Tenant isolation** — a token for tenant A's user returns tenant A's session
  and nothing else. The hostile-tenant suite covers the resulting session; what
  this adds is that the *token* cannot select across tenants.
- **What cannot be tested without Google** — the hosted-UI round trip itself.
  Stub the JWKS at the network layer with a locally signed RS256 token, which is
  what makes every row above deterministic, and say so rather than claiming
  coverage of the live flow.

### 11.8 Acceptance

1. `POST /v1/auth/sso` with a valid id token for a provisioned user returns 200
   and a body `SignInResponseSchema` parses.
2. The same call for an unprovisioned `sub` returns 401 with
   `type: urn:talon:error:user-not-provisioned`.
3. `pnpm test:routes` passes with the route explicitly public.
4. `pnpm test:isolation` still green.

---

## 12. Turning it on

Nothing in `apps/web` changes. Two variables, both already in `.env.example`:

```
NEXT_PUBLIC_SSO_GOOGLE=on
COGNITO_DOMAIN=<stacks/persistent cognito_domain output>
COGNITO_CLIENT_ID=<cognito_client_id output>
APP_ORIGIN=http://localhost:3000
```

`ssoConfig()` reads all of them at call time rather than module load, so a missing
one is a 404 on the SSO route rather than a boot failure — the rest of sign-in
keeps working while this is half-configured.

**The copy changes itself.** `sign-in.tsx` renders *"Single sign-on isn't
available yet. Use your email and password."* only while the flag is off; with it
on the line becomes *"SAML single sign-on isn't available yet."* and the Google
button becomes a live link. Nobody edits a string — which is the point of having
written it as a condition rather than as prose.

### 12.1 Order of operations

§10 and §11 are independent and can run in parallel, but the flag stays off until
**both** are done. With the domain but no API route, the round trip reaches
Google, comes back, and dies at the last step with `?sso=failed` — worse than a
disabled button, because it fails *after* the person has handed over credentials.

### 12.2 First walkthrough, by hand

E2E cannot cover this without a Google test account (§8). The manual pass, once:

1. Sign-in shows an **enabled** Google button and the SAML-only copy.
2. Click → Google's chooser → consent.
3. Land on `/jobs`, signed in, correct name and role in the sidebar.
4. `document.cookie` does **not** contain `talon_refresh` — the whole point of the
   BFF.
5. Sign out, then repeat with a Google account that has no `users` row: expect
   *"Your Google account signed in, but this workspace has no account for you
   yet."*
6. Cancel at Google's chooser: expect *"Google sign-in was cancelled."*, not a
   generic failure.

---

## 11.8 Deviation from §11.2 — the request carries the refresh token too

§11.2 specified `SsoRequestSchema = { idToken }`. **That cannot work**, and it was found by building it:

`SsoResponseSchema` is `SignInResponseSchema`, whose `refreshToken` is **required** — the web callback sets it as an httpOnly cookie the moment the response lands. An id token carries no refresh token, and the api has no way to obtain one: the password path gets its refresh token from `AdminInitiateAuth`, and that call is precisely the step the federated flow skips.

Cognito already issues one in the same `/oauth2/token` response the callback was reading `id_token` from — it was simply discarding it. So the contract is:

```ts
SsoRequestSchema = z.object({ idToken: ..., refreshToken: ... }).strict()
```

Both are minted by the same exchange, both travel server to server, and neither reaches the browser. Taking the refresh token from Cognito rather than minting one keeps the long-lived half of the session under Cognito's control — which is the property that makes `AdminUserGlobalSignOut` or disabling a user actually end a federated session, instead of leaving it alive until a token we issued expires. That is the same choice `initiatePasswordAuth` and `refreshSession` already make.

The web callback now forwards both, asserted in `apps/web/src/test/sso.test.ts`.

## 11.9 What is still not true

The api half is done and tested; **Google sign-in still does not work end to end**, and the reason is entirely §10:

- No `aws_cognito_user_pool_domain`, so there is no hosted UI to redirect to.
- No `aws_cognito_identity_provider` for Google, so the pool cannot federate.
- No OAuth flows or callback URLs on the app client.
- No Google Cloud OAuth client — that needs a Google project, a client id and a secret, which are credentials rather than code.

`ssoConfig()` returns null without `COGNITO_DOMAIN`, so both web routes 404 and the button stays disabled. **That off state is correct and deliberate** — turning the flag on before §10 lands produces a round trip that fails at its first step rather than its last.

Local verification is against the Cognito stub, which substitutes the network and not the class: the JWKS fetch, the RS256 signature check, the `aud`/`iss`/`token_use` checks and the `external_id` join all run for real. What the stub cannot cover is the hosted-UI round trip itself, and no amount of test infrastructure can — it needs a real pool and a real Google client.

---

## 10.5 What was applied on 2026-08-08, and the one thing left

Applied against the spec-002 throwaway pool `us-east-1_08d7fh6x5`, and captured in `infra/terraform/stacks/persistent/cognito_sso.tf`:

| Change | State |
|---|---|
| `aws_cognito_user_pool_domain` — `talon-dev-762079300828` | **created** |
| Google identity provider, credentials read from `talon-dev/sso/google` | **created**, mapping `email`→`email`, `username`→`sub` |
| App client OAuth: `code` flow, `openid email profile`, callback + logout URLs, `COGNITO`+`Google` | **enabled** |

**Verified live, not reasoned about.** `GET /oauth2/authorize?identity_provider=Google` returns `302` to `accounts.google.com` carrying the right client id, so the flow starts correctly.

### The blocker — resolved 2026-08-08

Following that redirect, Google first answered **`Error 400: redirect_uri_mismatch`**.

Cognito sends Google its own callback, and that URL is not on the Google OAuth client's allow-list:

```
https://talon-dev-762079300828.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
```

It has to be added under **Authorized redirect URIs** on the OAuth client `559468296486-…apps.googleusercontent.com` in the Google Cloud console. That is a Google project setting — no AWS credential reaches it, and no Terraform provider in this repo manages it. The client id and secret in Secrets Manager grant use of the client, not administration of it.

That line was added, and re-testing the same request now lands on `accounts.google.com/v3/signin/identifier` — Google's real account chooser. The flow starts, federates and returns.

**The mistake worth recording**, because it is the natural guess: the app's own callback (`http://localhost:3000/api/auth/sso/callback`) does NOT go in Google. Google never redirects to the app — it redirects to Cognito, which then redirects to the app. Two different URIs, two different places.

### Then, to run it locally

`apps/web` needs both, or `ssoConfig()` returns null and the routes 404 by design:

```
COGNITO_DOMAIN=https://talon-dev-762079300828.auth.us-east-1.amazoncognito.com
APP_ORIGIN=http://localhost:3000
```

### Recorded drift

§10.1 says do not build on the throwaway pool, and this did — because it is the pool the dev app and every seeded `users.external_id` already point at, and standing up the permanent pool means re-provisioning all of them before anyone can sign in at all. The Terraform is written so the move is a one-variable change: the three resources take `user_pool_id` as input. §10.1 still holds — the throwaway must not become the permanent identity store.

---

## 10.6 What happens on the first real sign-in

The plumbing is done. The next thing anyone hits is **provisioning**, and it is expected rather than broken.

When a Google identity signs in for the first time, Cognito creates a **new user in the pool with a new `sub`**. Nothing in `users.external_id` points at it, because the seeded users were provisioned through `AdminCreateUser` and carry the subs that allocated. So the api answers exactly what §11.6 says it should:

```
401  urn:talon:error:user-not-provisioned   →  /sign-in?sso=not_provisioned
```

That is correct behaviour, not a failure: just-in-time provisioning is explicitly out of scope (§2), and spec 002 §5's exclusivity rule says one person has one sign-in method. Making a specific Google account work means pointing an existing `users` row's `external_id` at the sub Cognito allocates for that federated identity — a deliberate act, per person.

The failure is *distinguishable* precisely so this reads as "this workspace has no account for you" rather than "sign-in failed", which is the distinction §11.6 exists to preserve.
