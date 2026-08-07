# Spec 001 — Foundations (M0a)

**Status:** approved to build
**Milestone:** M0a (local). M0b/Terraform is spec 002.
**Depends on:** nothing
**Blocks:** everything

---

## 1. Context and goal

Talon has documentation and no code. This spec covers the foundation every later feature is built on: a working monorepo, **enforced** module boundaries, the data layer with tenant isolation, an auth and tenancy request chain that works without AWS, and one real screen proving the whole path end to end.

The goal is not "some code exists." It's that after this lands, several agents can work in parallel on different modules without colliding, and without any of them being able to accidentally ship a cross-tenant data leak.

**One screen, not four.** The jobs list is the deliverable because it exercises the entire stack — tokens → components → API → repository → RLS → seed — while being simple enough that a failure anywhere is obvious. The new-job wizard moves to M1.

## 2. Scope

**In:** pnpm + Turborepo workspace; Docker Compose (Postgres, Redis, LocalStack); boundary lint; Fastify plugin structure; awilix composition roots; route-manifest test; seven sub-agent configs; Drizzle schema for the M0a table set; RLS policies; migrations; seed reproducing the reference screens; `IdentityProvider` interface with a local stub issuer; token verification and tenancy hook chain; users, roles, permission model; token build pipeline; AppShell; jobs list screen.

**Out:** new-job wizard (M1). Any Terraform or AWS resource (spec 002). Cognito itself — only the interface it will sit behind. Pipeline, candidates, review inbox, scheduling, offers, reports. Real email. Realtime/SSE. Search.

## 3. Step 1 — Repo skeleton

```
apps/{web,api,workers}
packages/{domain,db,contracts,tokens,testing}
infra/terraform/          (empty, spec 002)
docs/, e2e/
```

- pnpm workspaces + **Turborepo**. Pipeline: `build` depends on `^build`; `test` depends on `build`; `lint` and `typecheck` standalone. Local cache only — no remote cache, no signup.
- TypeScript strict everywhere, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Painful on day one, much cheaper than retrofitting.
- Shared base `tsconfig`, flat-config ESLint, Prettier. Conventional-commit lint on commit message.
- `docker-compose.yml`: Postgres 16 (`pg_trgm`, `citext` enabled via init script), Redis 7, LocalStack (S3 + SQS only).
- `.env.example` committed; `.env` gitignored.

**Acceptance:** `pnpm install && pnpm build && pnpm lint && pnpm typecheck` all pass on the empty graph. `docker compose up -d` gives a reachable Postgres and Redis.

## 4. Step 2 — Boundary scaffolding

Implements ARCHITECTURE §4.1. **Nothing else in this spec may start before this lands** — retrofitting boundaries onto written modules is far more expensive than building against them.

### 4.1 Module template

Every `apps/api/src/modules/<name>/` gets: `index.ts` (plugin), `routes.ts`, `service.ts`, `repository.ts`, `container.ts`, `events.ts`, `index.public.ts`. Ship a `pnpm gen:module <name>` scaffolder — if creating a compliant module is harder than creating a non-compliant one, agents will create non-compliant ones.

### 4.2 Lint graph

`eslint-plugin-boundaries` per ARCHITECTURE §4.1, at `--max-warnings 0`. Plus `no-restricted-imports`: only `repository.ts` may import `@talon/db`; cross-module imports resolve to `index.public.ts` only.

### 4.3 Plugin scopes

```ts
await app.register(publicRoutes, { prefix: '/v1' });     // /healthz, /readyz, /auth/*
await app.register(async (scoped) => {
  scoped.addHook('onRequest', authenticate);
  scoped.addHook('onRequest', resolveTenant);
  scoped.addHook('preHandler', openTenantTransaction);
  for (const m of modules) await scoped.register(m);
}, { prefix: '/v1' });
```

### 4.4 Route-manifest test

Boots the app, walks every route, asserts each is in `PUBLIC_ROUTES` or carries both `authenticate` and `resolveTenant`. Failure message names the offending route.

### 4.5 Sub-agent configs

`.claude/agents/` — `schema`, `api`, `ui`, `tokens-guard`, `infra`, `test`, `reviewer`, per CLAUDE.md §5.

**Acceptance:**
1. A test fixture importing `../applications/repository` from another module fails lint.
2. A test fixture importing `@talon/db` from a `service.ts` fails lint.
3. A route registered outside the authenticated scope fails the manifest test.
4. All three failures are demonstrated in CI on a branch, then removed.

## 5. Step 3 — Data layer

### 5.1 Tables

Per ARCHITECTURE §5, this subset only: `tenants`, `users`, `stage_templates`, `jobs`, `job_stages`, `candidates`, `applications`, `stage_transitions`, `activities`, `audit_log`.

Later-milestone tables are **not** created now. An empty table is an invitation for an agent to write against a contract nobody has specced.

Step-3 notes: `stage_templates` had no DDL in any doc — built minimally as an ordered `stages jsonb` array copied into `job_stages` at job creation (ARCHITECTURE §5 needs updating). `users` adds `tokens_valid_after timestamptz` (nullable) so token-embedded claims can be invalidated before expiry; the auth chain (step 4) rejects tokens whose `iat` predates it. `users.email` is globally unique (open question 1), deviating from ARCHITECTURE's `unique(tenant_id, email)`.

Further divergences from ARCHITECTURE §5, all introduced by the step-3 review and needing to be reflected there:
- `applications.comp_expectation_currency char(3)`, with a check requiring it whenever either cents column is set. ARCHITECTURE §5 omits it — the same §4.9 bug in the canonical DDL.
- `jobs.currency` carries **no** default. ARCHITECTURE §5 defaults it to `'USD'`; a default is an assumption wearing a constraint (§4.9).
- **Composite foreign keys throughout** (§4.10): `(tenant_id, id)` on every tenant-scoped parent, plus `applications (job_id, current_stage_id) → job_stages (job_id, id)`, backed by `unique (job_stages.job_id, id)`. FK validation bypasses RLS, so single-column FKs let a write point across a tenant or a job boundary and Postgres accepts it. `applications (tenant_id, current_stage_id)` is deliberately omitted as transitively implied; `audit_log` is deliberately unconstrained (nullable `tenant_id` makes a MATCH SIMPLE composite vacuous, and an audit row must outlive its entity).
- `candidates unique (tenant_id, email)` — per-tenant, nulls distinct, so anonymized candidates are unaffected and two tenants may hold the same person.
- Money columns are Drizzle `mode: 'bigint'` (§4.9). **Step 4 must decide serialization before a repository first returns one** — `JSON.stringify` throws on a BigInt; string-encoded cents in the contract is the expected answer.

### 5.2 Conventions

- UUIDv7 for ids (time-ordered — better index locality than v4).
- Money is `bigint` cents plus a `currency char(3)`. No floats, no assumed USD.
- All timestamps `timestamptz`, UTC.
- `created_at`/`updated_at` on every table; `updated_at` by trigger, not application code.
- Every tenant-scoped table: `tenant_id uuid not null` + RLS policy + an index leading with `tenant_id`.

### 5.3 RLS

```sql
alter table <t> enable row level security;
alter table <t> force row level security;      -- applies to the table owner too
create policy tenant_isolation on <t>
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

`force row level security` matters — without it the owning role bypasses the policy and your backstop silently does nothing. The `true` second argument to `current_setting` returns null rather than erroring when unset, which fails closed. The `nullif(..., '')` wrapper is load-bearing (amended during step 3): after a `SET LOCAL` transaction commits, the GUC exists as **empty string**, and `''::uuid` makes every subsequent query on the connection *error* instead of returning nothing — the original snippet failed its own acceptance 3.

Migrations run as a migration role that bypasses RLS; the app connects as a role that cannot.

### 5.4 Seed

Reproduces the reference screens exactly: tenant, five users (Maya Reyes recruiting lead, Sam Altmann HM, Lin Chen, David Osei, Tom Iwu), six jobs matching the jobs list (ENG-204, ENG-209, ENG-198, DES-114, PPL-031, SAL-076) with their statuses and counts, and the nine ENG-204 candidates at their pictured stages.

**The seed writes history, not state.** For every application it inserts backdated `stage_transitions` such that the derived values match the screenshots — Ana Petrova reads "3d in Onsite", Elena Ruiz reads "Stalled 8d in stage", the four column medians read 2d/4d/6d/3d. Seeding a current stage only will produce a board that does not resemble the reference, and every later metric test will be built on sand.

A second tenant with its own jobs and candidates is seeded for isolation testing.

**No filler candidates** (resolves open question 5, 2026-08-07). The board is the truth: ENG-204 gets exactly the nine pictured candidates and nothing else, and the other five jobs get exactly the candidate counts shown on the jobs list. Padding a job to make a funnel percentage come out right produces candidates no screen shows, which then appear in every later list, count, and export. Where a screen-derived percentage cannot be reproduced from the pictured population, the seed reports the real derived value and the discrepancy is recorded here — never closed by inventing rows.

**Recorded deltas for ENG-204** (the screens contradict each other; see open question 5):

| Reads | Screen shows | Nine pictured candidates yield |
|---|---|---|
| Funnel Applied → Screen → Onsite → Offer | 100 / 42 / 21 / 8 % | 100 / 56 / 33 / 22 % (9 / 5 / 3 / 2 ever-reached) |
| Jobs list "active" | 38 | 9 |
| Jobs list "in process" | 18 | 8 |

The screen's percentages are exactly the ratios of a 38-application population (16/38 = 42%, 8/38 = 21%, 3/38 = 8%), matching the jobs list's "38 active" — so the kanban's funnel bar agrees with the jobs list and disagrees with the nine cards drawn beside it on the same screen. The four column medians reproduce exactly from the nine, which confirms the panel is ENG-204-scoped rather than tenant-wide. Step 5's reference-screen comparison will differ in these three cells and only these; that is expected, not a regression.

**Acceptance:**
1. `pnpm db:migrate && pnpm db:seed` from empty produces a database whose derived metrics match the reference screens.
2. Tenant-isolation suite passes.
3. **Pooled-connection leak test** passes: with a max-1 connection pool, request as tenant A, then tenant B, on the same physical connection — B must never see A's rows. This is the test that catches `SET` where `SET LOCAL` was required.
4. Migrations are reversible; `down` then `up` is clean.

## 6. Step 4 — Auth and tenancy

### 6.1 IdentityProvider interface

```ts
interface IdentityProvider {
  verifyToken(token: string): Promise<VerifiedIdentity>;  // sub, email, claims
  createUser(input: CreateUserInput): Promise<{ sub: string }>;
  initiatePasswordAuth(email: string, password: string): Promise<AuthResult>;
  enrollTotp(sub: string): Promise<{ secretUri: string }>;
  verifyTotp(sub: string, code: string): Promise<boolean>;
}
```

Two implementations: `LocalIdentityProvider` (dev/test — signs JWTs with a local key, stores password hashes in a `local_identities` table) and `CognitoIdentityProvider` (spec 002). **Nothing outside `modules/identity/` imports either concrete class.**

Step-4 notes on the interface as built:
- A **sixth method, `refreshSession(refreshToken)`**, was added. Open question 2 answered "30d refresh, sliding", and a refresh token nothing can redeem is worse than none; the exchange has to sit behind the same seam as the issue. Cognito implements it natively (`REFRESH_TOKEN_AUTH`).
- `initiatePasswordAuth` returns a discriminated `AuthResult`, `authenticated` or `mfa_required`, mirroring Cognito's challenge flow. M0a has no screen for the challenge, so a user with `mfa_enabled` gets a 401 `urn:talon:error:mfa-required` — fail closed rather than inventing an unspecced exchange.
- `CreateUserInput` carries an optional `sub` for the local provider only. `users` has **no `external_id` column**, so locally the token subject IS `users.id` and an already-provisioned person hands their id in. Cognito allocates the sub itself, so **spec 002 needs a `users.external_id` migration** before the swap is real. Flagged, not fixed here — step 4 was scoped to one migration.
- The concrete class is named in exactly one file (`modules/identity/container.ts`), and `no-restricted-imports` now bans every module-internal path outside its own folder, so the lint graph backs the rule rather than the convention.

### 6.2 Claim shape — identical in both implementations

```json
{ "sub": "...", "email": "...", "tenant_id": "...", "role": "recruiter",
  "iss": "...", "aud": "talon-api", "iat": 0, "exp": 0, "jti": "..." }
```

`tenant_id` and `role` are **not** stored on the identity provider. Locally the stub reads them from `users` at sign-in; in AWS the pre-token-generation Lambda does the same. Same source of truth, same claims, different signer — which is what makes the Cognito swap a configuration change rather than a rewrite.

### 6.3 Request chain

1. `authenticate` — verify signature, expiry, audience; attach `request.identity`. 401 on failure.
2. `resolveTenant` — load the user row by `sub`; attach `request.user` and `request.tenantId`. 401 if no user row exists (authenticated but not provisioned).
3. `openTenantTransaction` — check out a connection, `BEGIN`, `SET LOCAL app.tenant_id`, `SET LOCAL app.user_id`; attach the transaction to the request. Commit on 2xx/3xx, rollback otherwise.

`SET LOCAL`, never `SET` — see §5.4 acceptance 3.

Step-4 notes on the chain as built:
- A **fourth hook** was needed: `finishTenantTransaction` on `onSend`, which commits below 400 and rolls back at or above it. `onSend` runs after the error handler has turned a thrown handler into a response, so one hook covers both the ordinary and the exploded path. `openTenantTransaction` also registers a `close` listener on the raw reply as a safety net for a client that disappears mid-handler — Fastify may never run `onSend` for a dead socket, and an unreleased reserved connection is a pool leak.
- `tokens_valid_after` is enforced in `resolveTenant`, not `authenticate`: it needs the `users` row, which is `resolveTenant`'s job to load. Both reject with 401 before any handler runs, so nothing observable changes. `iat` has second resolution and the comparison is strict, so a cut-off with a sub-second component also invalidates a token issued during that same second — fail closed, and self-healing at the next sign-in.
- The chain treats the **database as authoritative** for role: a role changed since the token was issued takes effect now. A `tenant_id` claim that disagrees with the `users` row is refused outright (401 `invalid-token`) rather than reconciled.
- The transaction opener refuses to run on a connection whose role has `rolsuper` or `rolbypassrls`, checked once per pool. Running the api as the owner is the §11b failure mode that leaves every policy in place and inert.

### 6.4 Permissions

Roles: `admin`, `recruiter`, `hiring_manager`, `member`. Scopes are checked in `service.ts`, never in components. `comp:read` is a distinct scope held by admin, recruiter, hiring manager, and approvers — not by members. Enforced at the API layer: comp fields are stripped from serialization when the scope is absent, so a hand-crafted request can't retrieve them.

**Acceptance:**
1. Unauthenticated request to a protected route → 401.
2. Authenticated as tenant B against tenant A's job id → **404, not 403** (a 403 confirms the resource exists, which is itself a leak).
3. RLS blocks the same request even with the application check stubbed out — belt and braces, tested independently.
4. A `member` requesting a job with band data receives the job with **no `band` key at all** — no error, no empty state. A holder of `comp:read` receives `band: { minCents, maxCents, currency }`, and jobs with no band set also omit the key. The strip happens because the route declares `response: { 200: ListJobsResponseSchema }`; a route that omits the response schema is not comp-gated, whatever the service returns.

Step-4 note: acceptances 2 and 4 need a route that returns tenant-scoped data, and none existed. `GET /v1/jobs/:id` landed here, returning the existing `JobSchema` (single-job aggregate; no new response shape invented). The list endpoint with its filters and cursor is still step 5. The strip happens in `service.ts` — the route additionally parses the response through `JobSchema`, which is equivalent to declaring `response: { 200: … }` and needs no type-provider dependency.

`band` is a **single nested optional**, not three loose fields — presence is atomic, so a band can never arrive missing its currency. It deliberately does not distinguish "you may not see this" from "there is nothing to see": §7.3 renders both identically (row without band data), so a discriminator would be a distinction no consumer acts on. If a screen ever needs to tell them apart, that is a contract change with a reason behind it.

## 7. Step 5 — Jobs list

### 7.1 Token pipeline

`packages/tokens`: `design-tokens.json` → `tokens.css` (CSS custom properties) + Tailwind v4 `@theme` + typed keys. Contrast test over every semantic bg/text pair runs in CI. Lint rule bans raw hex outside `packages/tokens`.

### 7.2 API

```
GET /v1/jobs?status=&department=&recruiter_id=&cursor=&limit=50
→ { data: Job[], nextCursor: string | null }
```

`Job` includes `stageDistribution` (counts per canonical stage), `inProcessCount` (non-terminal), `activeCount`, and comp band **only** for holders of `comp:read`. Zod schema in `packages/contracts`; OpenAPI generated from it.

Contract notes (landed ahead of the handler so the api and ui streams build against fixed shapes):
- Response bodies are camelCase; query params stay snake_case as written above.
- Money crosses the wire as a **canonical digit string of integer cents** plus an alpha-3 currency — the columns are `bigint` and `JSON.stringify` throws on a BigInt.
- `band` is a single nested optional, omitted entirely without `comp:read` — see §6.4 acceptance 4.
- The `recruiter` summary carries `{ id, name }` and **no color**: the UI hashes the id over the `avatar.1–8` token ramp, so a hex value from the API would be a raw color outside `packages/tokens` (§4.8). `users.avatar_color` is dropped in step 4 for the same reason — it had no legitimate reader.
- `stageDistribution` requires every canonical key, zero included (§9 edge case 4), and is derived from the stage enum so a new stage cannot skip it.
- `limit` is digits-only with a max of 100. Deliberately not `z.coerce`, which is `Number()` and accepts `0x10`, `1e2`, and `" 100 "`.
- Unknown query params **400** rather than being ignored, so a typo'd filter can't return unfiltered data that looks correct. The web client must allow-list before forwarding `searchParams` — a shared URL carrying `utm_source` would otherwise fail.
- `packages/contracts` also owns the RFC 9457 `Problem` envelope (ARCHITECTURE §7), since the ui switches on `type` for the §7.3 Error state and §9 edge case 1. Stable `type` values are declared by the endpoints that emit them.
- `inProcessCount` counts non-terminal stages, and terminality is per-job data (`job_stages.is_terminal`), not a constant — the api stream must read it, not hardcode a stage list.

One query, not N+1: distribution comes from a single grouped aggregate joined to the job list, not a per-job count.

### 7.3 UI

Per DESIGN_SYSTEM §4. AppShell (sidebar with live counts, topbar), department group headers, JobRow, status pills, distribution bar.

**Every state specced, not just the happy one:**

| State | Behavior |
|---|---|
| Loading | Skeleton rows at the real row height (55px) — no layout shift on load |
| Empty (no jobs) | "No open roles yet. Create your first job to start a pipeline." + primary action |
| Empty (filtered) | "No jobs match this filter." + clear-filter action. Distinct from above — different cause, different fix |
| Error | Inline retry, filters preserved. Never a blank screen |
| Forbidden | Rows render without band data; no error, no empty state |

**Acceptance:**
1. Renders from seeded data and diffs acceptably against `02-jobs-list@2x.png`.
2. Type-scale pass from DESIGN_SYSTEM §2.1 complete; `_meta.confidence.typography` updated with what pinned it.
3. Keyboard navigable; `axe` clean.
4. All five states reachable in Storybook or via fixtures.

### 7.4 As built (2026-08-07)

**Acceptance 3 and 4 met. Acceptance 1 is partial. Acceptance 2 is not met.**

*Acceptance 1 is partial by definition, not by omission.* The screen renders from MSW
fixtures derived from `packages/db/src/seed.ts`, and every column diffs to within ~1px
of `02-jobs-list@2x.png`. But §1 says the jobs list is the M0a deliverable because it
exercises **tokens → components → API → repository → RLS → seed**, and it currently
exercises the first two and a hand-transcribed copy of the last. Acceptance 1 completes
at step-4 integration, not here.

**Follow-up that converts the prediction into a contract** (must survive this merge):
when `GET /v1/jobs` has a handler, assert the live endpoint returns exactly the six-row
table below for the seeded tenant — req code, status, recruiter, `inProcessCount`,
`activeCount`, and full `stageDistribution`. Until that test exists, fixture-to-seed
agreement is a transcription that nothing rechecks. **Owner: api + test.**

| req | distribution (applied/screen/onsite/offer/hired/rejected) | inProcess | active |
|---|---|---|---|
| ENG-204 | 4/2/1/1/1/0 | 8 | 9 |
| ENG-209 | 4/3/1/0/0/13 | 8 | 21 |
| ENG-198 | 2/1/0/0/0/9 | 3 | 12 |
| DES-114 | 8/8/4/0/0/34 | 20 | 54 |
| PPL-031 | 8/8/3/0/0/48 | 19 | 67 |
| SAL-076 | 3/2/1/0/0/3 | 6 | 9 |

#### Open questions this answers

- **6 — does the job row render a comp band?** No. DESIGN_SYSTEM §JobRow specifies the
  grid exactly and it has no band cell, so the row renders none. The contract still
  ships `comp`, and the UI consumes the tagged union only to prove the Forbidden state
  at the wire. Consequence: **permission-denied has no visual manifestation on this
  screen** — it is asserted in `fetchJobs`, not in the DOM, because asserting it in the
  DOM would mean testing nothing.
- **7 — where do the sidebar counts come from?** Unresolved, and confirmed to need a
  separate endpoint: they are tenant-wide and cannot ride `{ data, nextCursor }`. Jobs
  is derived from the page; Pipeline, Review inbox, Scheduling and Offers are constants
  marked `ponytail:` in `mocks/fixtures.ts`. Pipeline is *not* derived — it counts one
  board's cards, which means choosing a job arbitrarily.
- **8 — row height 52 or 55?** 55, from `layout.rowHeight` and §7.3. DESIGN_SYSTEM
  §JobRow's 52 is stale and should be corrected there.

#### `activeCount` — the two streams disagree

`packages/contracts` documents `activeCount` as "applications not rejected or
withdrawn; includes hired". The seed and the reference screen both mean **total
applications ever received**. The two coincide only for ENG-204 (nothing rejected);
everywhere else the contract's reading collapses `activeCount` onto `inProcessCount` —
ENG-209 would read 8 active / 8 in process where the screen reads 21 / 8 — which makes
the column redundant and contradicts the picture. Fixtures follow the screen and the
seed. **The API must not implement the docstring as written. Owner: api.**

Correcting the docstring is not enough — the *name* is what will be re-broken.
`activeCount` reads as "currently active", and the value is "every application
ever received, rejected ones included". Recommend renaming the field to
`totalApplications` when the handler lands; the review of this branch reached the
same conclusion independently. `apps/web` follows whatever the contract declares.

#### Typography — acceptance 2, open

The §2.1 pass was run by scanning the 2880px original for ink extents and deriving
sizes from cap/ascender heights. It contradicts §2.1's own premise:

| token | current | measured | ratio |
|---|---|---|---|
| pageTitle | 26px | ~19px | 0.73 |
| cardTitle | 15px | ~12px | 0.80 |
| body | 14px | ~12.3px | 0.88 |
| meta | 13px | ~11px | 0.85 |
| caption | 12px | ~11px | 0.92 |
| code | 12px | ~11px | 0.92 |
| eyebrow | 11px | ~11px | 1.00 |

The ratios climb monotonically as size falls: the ramp is stretched at the top and
correct at the bottom. §2.1 says "if `pageTitle` is off, it's off everywhere by the
same amount" — the reference says otherwise, so no single factor fixes it. Reshaping
the ratios affects all nine screens. Width-derived sizes land ~8% below height-derived
ones, which says the display face is narrower than Inter and must be settled first
(§2.1's letterform comparison against `01-sign-in@2x.png`). Nothing was applied;
`_meta.confidence.typography` stays `LOW`. **Owner: design.**

#### Token findings

Six measured pairs fall below AA, each pinned with its exact ratio in
`packages/tokens/test/contrast.test.ts` so drift still fails: `text.tertiary` 3.52 on
surface / 3.20 on canvas, `text.placeholder` 2.53, `text.secondary` on
`action.ghostBgHover` 4.40, `avatar.2` 4.40 and `avatar.6` 4.18 under white initials.
Values are measured and were left unchanged. **DESIGN_SYSTEM §5's claim that every
semantic bg/text pair clears 4.5:1 is false as written and should be corrected.**
Separately, the §3 pill padding of `2px 8px` has no vertical token — the space scale
steps 1px → 4px.

#### Deltas against the reference screen

1. ENG-204 reads 8 in process / 9 active, not 18 / 38 — open question 5, already closed.
2. Reference bars show an Offer segment on jobs the seed gives no offers to; bulk
   applications only reach Applied/Screen/Onsite, so those bars have three segments.
3. Avatar hues match only because fixture user ids are pinned to hash onto them. With
   real uuidv7 ids they will differ — the hash is on id by design (§3). The contract's
   `recruiter.avatarColor` is deliberately ignored: `packages/db` stores raw hex outside
   the `avatar.1–8` ramp. **Owner: schema.**
4. **The header "+ New job" button is absent**, where the screen shows it. It is
   deferred with the wizard rather than rendered inert, so the empty state has no
   action either — §7.3's "primary action" returns when `/jobs/new` exists. The sidebar
   link is the single navigating path.
5. The reference badges the Review-inbox count in `bg.selected`/`text.link` while its
   row is inactive; §3 reserves that for the active row. Built to the doc.
6. Req code and location render as one monospace line per the screen; §4 describes it
   as `code`/`meta`. Built to the screen.
7. Row hover raises the background only; §4 also calls for `border.strong`, but rows sit
   inside one bordered card per department and have no border of their own.
8. The screen contradicts itself on Maya's avatar — amber in the rows, green in the
   sidebar user block, same person. Both render amber, per the hash-on-id rule.

#### Two silent-failure classes found while building

- **Tailwind drops `@theme` variables no utility references.** That erased every avatar
  fill (they are reached through inline `var()`) until the block became `@theme static`.
  Because the generated theme also clears Tailwind's own scales, a utility naming a
  value we do not ship — `top-1.5`, `px-1.5` — produces *no declaration* rather than an
  error: an invisible active-nav marker and an unpadded ⌘K chip.
  `apps/web/src/test/token-usage.test.ts` now fails on both classes, including
  arbitrary values (`w-[130px]`) that the first version of the guard could not see.
  Measured constants live in `layout.jobRow` and are referenced as `var(--layout-*)`.
- **`axe.run` never returns on a ~220-node tree under jsdom** unless
  `resultTypes: ['violations']` is set. Every rule still runs against every node; axe
  simply stops assembling full detail for passing checks, each node of which costs a
  `getComputedStyle`. Coverage is unchanged; the gate went from hanging to 0.4s.

#### Deferred, each marked `ponytail:` in the source

Job rows are not links (no detail screen). Topbar search, the notification bell and
sign-out are presentational — a control that takes focus and does nothing is a keyboard
dead end. Sidebar counts are constants. The MSW worker starts unconditionally because
there is no API yet. `nextCursor` is ignored and there is no load-more, so "N open" is
counted client-side over one page and is wrong past `limit=50`. There is no department
filter control — filtering works via URL only, so §10's E2E "filter by department" step
cannot be walked yet. The no-raw-hex ESLint rule is scoped to `apps/web`; widening it
fails today on `users.avatarColor`.

## 8. Events

`JobCreated`, `JobStatusChanged`, `ApplicationCreated`, `ApplicationAdvanced`. Written to an `outbox` table in the same transaction as the state change. **No consumers in M0a** — the relay and EventBridge publishing are spec 002. The point is that the write path is correct from the first commit, so later consumers get a complete history rather than one starting mid-project.

## 9. Edge cases

1. **Authenticated but not provisioned** — valid token, no `users` row → 401 with a distinct error type, not a crash.
2. **A person in two tenants** — see open question 1. M0a assumes one tenant per email and asserts it with a unique constraint.
3. **`app.tenant_id` unset** — RLS fails closed (returns nothing) rather than erroring. Any code path reaching the DB without tenant context returns empty, and a test asserts this.
4. **Job with zero applications** — distribution bar renders at zero width, not `NaN`, not absent.
5. **Job whose stage template was edited after creation** — `job_stages` are per-job copies, so existing jobs are unaffected by template edits.
6. **Cursor pointing at a deleted row** — pagination resumes from the next valid row rather than 500ing.
7. **Two jobs, same req code, different tenants** — permitted; uniqueness is `(tenant_id, req_code)`.
8. **Seeded backdated transitions crossing a DST boundary** — durations computed in UTC; a fixture covers it.
9. **Clock skew on token expiry** — 60s leeway on `exp`, no leeway on `iat` in the future.
10. **Transaction left open by a thrown handler** — the hook's error path rolls back and releases; a test asserts the pool doesn't leak connections under repeated 500s.

## 10. Test plan

| Layer | Covers |
|---|---|
| Unit | Permission scope resolution, cursor encode/decode, distribution aggregation, seed date arithmetic |
| Integration (Testcontainers) | RLS policies, pooled-connection isolation, migration up/down, repository queries, outbox writes in-transaction |
| Boundary | The three lint failures + the route-manifest test from §4.5 |
| Isolation | Step 3: every tenant-scoped table as a hostile tenant → empty (packages/db, runs under `pnpm test`). **Step 4 (not step 5) moved `pnpm test:isolation` to the endpoint suite** in `apps/api`, per CLAUDE.md §6 ("runs every endpoint as a hostile tenant — must be 404 across the board"): a protected route with no hostile-tenant case fails the gate rather than being skipped |
| Contract | OpenAPI generated matches committed snapshot |
| E2E (Playwright) | Sign in with the local provider → jobs list renders seeded jobs → filter by status → filter by department → empty-filter state → sign out |
| a11y | `axe` on the jobs list, zero violations |

CI gates, all blocking, each wired in the step that first has something for it to guard:

| Gate | Lands in |
|---|---|
| `lint`, `typecheck`, `test` | Step 1 |
| `test:routes` | Step 2 |
| `test:isolation` | Step 3 (tables, under `pnpm test`); the gate itself points at the endpoint suite from step 4 |
| `e2e`, contrast check | Step 5 — nothing to drive until the jobs list exists |

A gate is not "declared blocking" before its step: the script exists and the workflow runs it, or the row above says which step it arrives in. A named-but-missing gate cannot be a required status check, and its absence is silent.

## 11. Open questions

1. **Can one email belong to two tenants?** **Answered 2026-08-07: no.** One tenant per email, enforced with a unique constraint. `tenant_id` stays in the token.
2. **Session length and refresh?** **Answered 2026-08-07: confirmed** — 1h access token, 30d refresh, sliding.
3. **Does the jobs list need realtime counts?** Assumed no for M0a — refetch on focus. SSE arrives with the pipeline board.
4. **Seed tenant name?** Screens don't show one. Using "Talon Inc." from the offer letter unless told otherwise.
5. **ENG-204: jobs list says "18 in process", kanban pictures 8 non-terminal candidates.** **Answered 2026-08-07: the board is the truth.** Seed the nine pictured ENG-204 candidates and no filler; seed the other five jobs to their jobs-list counts. The jobs-list "in process" cell will read the board's count, not 18. Screen-derived percentages that the pictured population cannot produce are recorded as deltas in §11b, not manufactured.

6. **Does the job row show a comp band at all?** DESIGN_SYSTEM §JobRow specifies the grid exactly — title + `code · location` → recruiter → distribution bar → active count → status pill — and it contains no band, while §7.2 requires the band in the payload and §7.3 specs a Forbidden row state for it. The contract ships the band (the API needs it either way; §7.2 is explicit), but whether the row *renders* it is undecided and blocks the step-5 UI. Owner: Aditi.
7. **Where do the AppShell sidebar's live counts come from?** §7.3 requires them; they are tenant-wide, not page-scoped, so they cannot ride the `{ data, nextCursor }` envelope. Either a separate endpoint or an envelope change — and an envelope change breaks both streams at once. Needs answering before the ui stream builds the shell. Owner: Aditi.
8. **Row height: 52px or 55px?** DESIGN_SYSTEM §JobRow says `rowHeight` 52px; §7.3 specs skeleton rows at "the real row height (55px)". One is wrong, and the whole point of the skeleton is that it doesn't shift on load. Owner: Aditi.
9. **Nothing catches DB-vs-contract enum drift.** The job status and canonical stage enums exist in the SQL check constraints, the Drizzle columns, and `packages/contracts` — three copies, no test. `packages/contracts` cannot import `packages/db` under the boundary graph, so the test belongs in `apps/api` and should land with the jobs repository.

## 11b. Carried to step 4

1. **`tenants` slug→tenant resolution at sign-in runs before any tenant context exists.** The app role can only see its own tenant row under RLS, so the lookup must be a narrow owner-connection query or a `security definer` function scoped to that one resolution. Running the request chain on the owner connection would nullify RLS for the whole request — this is a decision to make deliberately in step 4, not an accident to discover. (Reviewer finding 9 on the step-3 PR.)

**Answered 2026-08-07 (step 4): two `security definer` functions, not a bootstrap connection.** Migration `0003_local_identities` adds `auth_user_by_email(citext)` and `auth_user_by_sub(uuid)`, each `stable`, `security definer`, `set search_path = pg_catalog, public`, `execute` revoked from `public` and granted only to `talon_app`.

Why a function: a connection is granted a *table*, so it can read every column of every row for as long as it is held and nothing in the codebase constrains what runs over it. A function is granted a *result* — one row, by exact key, with a fixed column list containing no password material. It also cannot be left open, which a second connection has to be policed for. `apps/api/test/bootstrap.test.ts` is the narrowness evidence: as the app role, ordinary reads of `users`/`tenants`/`jobs` return nothing, the function returns exactly the eight columns sign-in needs, a wildcard argument matches nothing, and those two are the only `prosecdef` functions in the schema with a pinned `search_path`.

Two consequences recorded rather than hidden:
- The **slug lookup is not needed in M0a**. Open question 1 made email globally unique, so sign-in resolves the tenant from the `users` row; a tenant-by-slug entry point would be a second bootstrap surface with no caller.
- The function owner must be able to bypass RLS. Locally and in CI that is the superuser that runs migrations. Under `force row level security` a non-bypassing owner makes these return zero rows — every sign-in fails closed with "invalid credentials" — so **the Aurora migration role in spec 002 must carry `BYPASSRLS`**, and that is a spec 002 prerequisite, not an implementation detail.

Belt and braces on the other side: `beginTenantTransaction` refuses to open a transaction on a connection whose role is `rolsuper` or `rolbypassrls`, so the api cannot be pointed at the owner connection by configuration accident.

## 12. Definition of done

- [ ] All step acceptance criteria met
- [ ] CI gates green on a clean clone — every gate whose step has landed, per the §10 table
- [ ] `docker compose up && pnpm db:migrate && pnpm db:seed && pnpm dev` yields a working jobs list from nothing
- [ ] The three boundary violations demonstrably fail, then are removed
- [ ] Open questions 1 and 2 answered and reflected in code
- [ ] Spec updated in place if reality diverged — a spec that lies is worse than no spec