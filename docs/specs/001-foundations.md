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

### 6.4 Permissions

Roles: `admin`, `recruiter`, `hiring_manager`, `member`. Scopes are checked in `service.ts`, never in components. `comp:read` is a distinct scope held by admin, recruiter, hiring manager, and approvers — not by members. Enforced at the API layer: comp fields are stripped from serialization when the scope is absent, so a hand-crafted request can't retrieve them.

**Acceptance:**
1. Unauthenticated request to a protected route → 401.
2. Authenticated as tenant B against tenant A's job id → **404, not 403** (a 403 confirms the resource exists, which is itself a leak).
3. RLS blocks the same request even with the application check stubbed out — belt and braces, tested independently.
4. A `member` requesting a job with band data receives the job without `band_min_cents`/`band_max_cents`.

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
- Comp is a **tagged union**, not an optional field: `{ visible: false }` when the caller lacks `comp:read`, `{ visible: true, band: … | null }` otherwise. An optional field cannot express this in TypeScript — `'compBand' in job` does not narrow away `undefined`, and a handler could emit `compBand: undefined` as a silent third state. §7.3's Forbidden row depends on the distinction.
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
| Isolation | Every route as a hostile tenant → 404 |
| Contract | OpenAPI generated matches committed snapshot |
| E2E (Playwright) | Sign in with the local provider → jobs list renders seeded jobs → filter by status → filter by department → empty-filter state → sign out |
| a11y | `axe` on the jobs list, zero violations |

CI gates, all blocking: `lint`, `typecheck`, `test`, `test:isolation`, `test:routes`, `e2e`, contrast check.

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

## 12. Definition of done

- [ ] All step acceptance criteria met
- [ ] CI gates green on a clean clone
- [ ] `docker compose up && pnpm db:migrate && pnpm db:seed && pnpm dev` yields a working jobs list from nothing
- [ ] The three boundary violations demonstrably fail, then are removed
- [ ] Open questions 1 and 2 answered and reflected in code
- [ ] Spec updated in place if reality diverged — a spec that lies is worse than no spec