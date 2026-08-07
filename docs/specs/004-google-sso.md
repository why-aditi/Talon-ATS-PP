# Spec 004 — Google SSO

**Status:** web half built behind a flag; api and infra halves not started
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
| `aws_cognito_user_pool_domain`, `aws_cognito_identity_provider` (Google), callback URL allow-list, `supported_identity_providers` on the app client | infra | **not started** |
| `POST /v1/auth/sso` — verify a Cognito id token, resolve `users` by `external_id`, mint the §6.2 session | api | **not started** — confirmed 404 against a running API on 2026-08-08; `apps/api/src/modules/identity/routes.ts` registers only `/auth/sign-in` and `/auth/refresh` |
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
