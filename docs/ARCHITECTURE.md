# Talon — Technical Architecture

Companion to `PRD.md`. Covers stack, data model, the three hard subsystems, AWS topology, IaC layout, and testing.

---

## 1. Constraints that shape everything

1. **Multi-tenant SaaS with hard isolation.** A leak is existential, so tenancy is enforced at two real layers: the application (repositories scope every query) and Postgres RLS as the backstop that catches the query someone forgot to scope. Drizzle enforces nothing on its own — it is a typed query builder, not a guard, and treating it as a third layer would be a false sense of depth.
2. **Read-heavy, burst-write.** Board views and reports dominate. Writes cluster around business hours and bulk imports.
3. **Small team, real scale requirements.** A microservice-per-domain split would cost more in operational surface than it buys. **Modular monolith + async workers** is the right shape until a single module demonstrably needs independent scaling.
4. **Third-party latency is unavoidable.** Google/Microsoft calendar and email APIs are slow and rate-limited. Anything touching them is async, cached, and retried.
5. **Correctness is auditable.** Every derived number must be reproducible from an append-only log.

## 2. Stack

| Layer | Choice | Why, and what was rejected |
|---|---|---|
| Frontend | **Next.js 15 (App Router), TypeScript, React 19** | Server components for the data-heavy list/report screens, client islands for kanban and scheduling. Rejected plain SPA: the reports and job list benefit too much from server rendering. |
| Styling | **Tailwind v4 + design tokens as CSS custom properties** | Tokens in `design-tokens.json` are the single source; Tailwind theme is generated from them, so a token change can't drift from the CSS. |
| Components | **Radix primitives + shadcn/ui**, `dnd-kit` for kanban, `@tanstack/react-virtual` for long lists | Radix gets keyboard and ARIA right, which matters for the AA target. `dnd-kit` has a first-class keyboard sensor — react-beautiful-dnd is unmaintained. |
| Data fetching | **TanStack Query** + typed client generated from OpenAPI | Optimistic mutations with rollback are exactly the kanban/review-inbox pattern. |
| Forms | react-hook-form + Zod, schemas shared with the backend | One schema, both sides. |
| Backend | **Fastify 5 on Node 22, TypeScript strict** | The contract chain is Zod end to end — `fastify-type-provider-zod` consumes `packages/contracts` directly and emits OpenAPI from it, so there is exactly one definition of every shape. NestJS was evaluated and rejected: it wants class-validator DTOs, which would mean maintaining a second source of truth for the same schemas, and its per-endpoint boilerplate (controller + service + module + DTO + provider) is not worth it at ~50 routes. Rejected Express (no encapsulation) and Go (no schema sharing with the frontend). **The boundary enforcement Nest would have provided is replaced by §4.1 — that scaffolding is a prerequisite, not a nice-to-have.** |
| DI | **awilix**, one composition root per module | Constructor injection without decorators. Keeps handlers pure functions of their dependencies, which is what makes the integration suite fast. |
| API | **REST + OpenAPI 3.1**, `/v1`, cursor pagination | Rejected GraphQL: the board's query shape is stable and known; GraphQL's cost here is auth-per-field and N+1 discipline for no real benefit. |
| DB | **PostgreSQL 16 (Aurora Serverless v2)** with **RLS** | One engine for relational data, JSONB, full-text search, and `pg_trgm` fuzzy matching. Serverless v2 fits the business-hours load curve. |
| ORM | **Drizzle** | Typed SQL that doesn't hide the query plan; migrations are plain SQL and reviewable. Prisma's generated client fights RLS session variables. |
| Cache / locks / rate limits | **Redis (ElastiCache Serverless)** | Free/busy cache, slot holds, idempotency keys, board presence, distributed locks. |
| Queue | **SQS (Standard + FIFO)** + **EventBridge** for domain events | SQS for work, EventBridge for fan-out and future integrations. Rejected Kafka: nothing here needs a log with replay semantics that Postgres isn't already providing. |
| Object storage | **S3** with presigned upload/download | Resumes, offer PDFs, import files. |
| Auth | **Cognito user pools** (email/password, Google IdP, per-tenant SAML, TOTP MFA) | **Decided.** The only option that lives inside the Terraform stack, so `terraform apply` produces a system you can actually log into — which is what the brief's one-click requirement means. Alternatives rejected: **Clerk** (best DX and its Organizations map cleanly onto tenants, but it sits outside IaC and adds a webhook sync boundary), **self-hosted GoTrue** (open source and in-stack, but you own upgrades and SAML key management), **Keycloak** (most control, most ops). Isolated behind an `IdentityProvider` interface — the swap stays cheap. |
| Search | Postgres `tsvector` + `pg_trgm` for v1; **OpenSearch** above ~1M candidates per tenant | Don't run a second datastore until Postgres actually stops being enough. |
| Email | **SES** outbound; inbound to S3 → Lambda → threading | Reply parsing and thread stitching by `Message-ID`/`In-Reply-To`. |
| Realtime | **SSE** over the ALB, fanned out via Redis pub/sub | Board updates and notifications are server→client only. WebSockets add reconnect and scaling complexity for no gain. |
| Compute | **ECS Fargate** behind an ALB, plus Lambda for cron and inbound-mail hooks | Fargate for long-lived HTTP and workers; Lambda where the workload is spiky and short. Rejected EKS: no team to run it. |
| Edge | **CloudFront + WAF** | Static assets, caching, rate limiting, bot control. |
| Observability | **OpenTelemetry** → CloudWatch + X-Ray, structured JSON logs, RUM on the frontend | |
| IaC | **Terraform** (root module per env, S3 + DynamoDB state) | **Decided.** Named first in the brief and provider-agnostic. Trade-off accepted: no type sharing with the TypeScript app, and `cdk-nag`'s equivalent is `tflint` + `checkov`. See §9.5 for layout, §9.6 for cost profiles, and §9.7 for the Cognito-specific hazards Terraform introduces. |
| CI/CD | GitHub Actions → ECR → `terraform apply` via OIDC, ephemeral PR environments via workspaces | |
| E2E | **Playwright** against ephemeral envs | |

## 3. System context

```
                          ┌──────────────┐
                          │  CloudFront  │  static + /api behind WAF
                          └──────┬───────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
      ┌───────▼────────┐                   ┌────────▼────────┐
      │  Next.js (web) │  ECS Fargate      │  API (Fastify)  │  ECS Fargate
      │  SSR + RSC     │◄──── internal ───►│   modular       │
      └────────────────┘                   └────┬───────┬────┘
                                                │       │
                    ┌───────────────────────────┘       └──────────────┐
                    │                                                   │
            ┌───────▼────────┐   ┌──────────────┐   ┌─────────┐  ┌─────▼──────┐
            │ Aurora PG 16   │   │ Redis        │   │   S3    │  │ EventBridge│
            │ writer+replica │   │ cache/locks  │   │ files   │  │  domain evts│
            │ RLS enforced   │   └──────────────┘   └─────────┘  └─────┬──────┘
            └────────────────┘                                          │
                                                                  ┌─────▼─────┐
                                                                  │    SQS    │
                                                                  └─────┬─────┘
                                                                        │
                                    ┌───────────────────────────────────┴────┐
                                    │        Workers (ECS Fargate)           │
                                    │  calendar-sync · email-out · email-in  │
                                    │  import · resume-parse · report-rollup │
                                    │  notification · offer-render           │
                                    └───────┬────────────────────────────────┘
                                            │
                            ┌───────────────┴──────────────┐
                            │  Google Calendar / MS Graph  │
                            │  SES · Cognito · IdPs        │
                            └──────────────────────────────┘
```

## 4. Backend module map

Single deployable, enforced boundaries. Modules talk through published interfaces and domain events — never by reaching into each other's tables.

```
apps/
  web/                  Next.js
  api/                  Fastify HTTP
  workers/              queue consumers (same image, different entrypoint)
packages/
  domain/               entities, invariants, state machines — no I/O
  db/                   Drizzle schema, migrations, RLS policies
  contracts/            Zod schemas + generated OpenAPI types
  tokens/               design-tokens.json → CSS vars + Tailwind theme
  testing/              fixtures, factories, seed
infra/
  terraform/            modules + per-env root modules
```

Modules inside `api`: `identity`, `tenancy`, `jobs`, `candidates`, `applications` (pipeline + transitions), `review`, `interviews` (scheduling + scorecards), `offers`, `messaging`, `search`, `imports`, `reporting`, `notifications`, `audit`.

**Dependency rule:** `domain` depends on nothing. `applications` may publish `ApplicationAdvanced`; `notifications` subscribes. `offers` never imports from `interviews`.

Each module is a **Fastify plugin** with a fixed internal shape:

```
apps/api/src/modules/applications/
  index.ts          fastify plugin: registers routes, exports nothing else
  routes.ts         route definitions, Zod schemas from packages/contracts
  service.ts        orchestration; the only place transactions begin
  repository.ts     Drizzle queries; the ONLY file that touches packages/db
  container.ts      awilix registrations for this module
  events.ts         what it publishes and what it subscribes to
  index.public.ts   the module's published interface — the only legal import target
```

A Fastify plugin gets its own encapsulation scope, so decorators and hooks registered inside it don't leak to siblings. Cross-module access goes through `index.public.ts`; nothing else in the folder is importable from outside.

### 4.1 Boundary enforcement (replaces what NestJS would have given us)

Choosing Fastify trades framework-enforced structure for convention, and conventions decay — especially with several agents writing modules in parallel. These three controls make the structure enforced again, and **all three land in M0, before any feature work.** Without them, the Fastify choice is not sound.

**1. Lint-enforced module graph.** `eslint-plugin-boundaries` with explicit element types and allowed-import rules, run in CI at `--max-warnings 0`:

```js
// eslint.config.js
{
  settings: { 'boundaries/elements': [
    { type: 'domain',   pattern: 'packages/domain/*' },
    { type: 'db',       pattern: 'packages/db/*' },
    { type: 'contracts',pattern: 'packages/contracts/*' },
    { type: 'module',   pattern: 'apps/api/src/modules/*', capture: ['name'] },
  ]},
  rules: { 'boundaries/element-types': ['error', { default: 'disallow', rules: [
    { from: 'domain', allow: [] },                                  // depends on nothing
    { from: 'db',     allow: ['domain'] },
    { from: 'module', allow: ['domain', 'contracts',
                              ['module', { name: '${from.name}' }]] }, // only itself…
  ]}],
    'no-restricted-imports': ['error', { patterns: [
      { group: ['**/modules/*/repository', '**/modules/*/service'],
        message: 'Cross-module access goes through index.public.ts.' },
      { group: ['@talon/db/*'], message: 'Only repository.ts may import db.' },
    ]}],
  }
}
```

Cross-module imports are added to the allow-list deliberately, one edge at a time, in a PR that says why. An import that isn't in the graph fails the build.

**2. Auth and tenancy at plugin scope, never per route.** Every authenticated route is registered inside one parent plugin that carries the hooks; public routes live in a separately named plugin. Opting *out* of auth becomes the visible act:

```ts
// apps/api/src/app.ts
await app.register(publicRoutes,   { prefix: '/v1' });   // /healthz, /auth/*
await app.register(async (scoped) => {
  scoped.addHook('onRequest', authenticate);             // verify token → request.user
  scoped.addHook('onRequest', resolveTenant);            // → request.tenantId
  scoped.addHook('preHandler', openTenantTransaction);   // SET LOCAL app.tenant_id
  for (const m of modules) await scoped.register(m);
}, { prefix: '/v1' });
```

**3. Route-manifest test.** The control that actually closes the gap. Boot the app in a test, walk every registered route, and assert each one is either on the public allow-list or carries the tenancy hook:

```ts
test('every route is tenant-scoped or explicitly public', async () => {
  const app = await buildApp();
  for (const route of collectRoutes(app)) {
    if (PUBLIC_ROUTES.has(`${route.method} ${route.url}`)) continue;
    expect(route.onRequest, `${route.method} ${route.url} is unprotected`)
      .toEqual(expect.arrayContaining([authenticate, resolveTenant]));
  }
});
```

Adding a route without protection fails CI, and adding one to `PUBLIC_ROUTES` is a one-line diff a reviewer cannot miss. This is stronger than what Nest would have given us — Nest verifies that a guard decorator exists, not that every route has one.

## 5. Data model

Core tables, abbreviated. Every tenant-scoped table carries `tenant_id uuid not null` and an RLS policy.

```sql
create table tenants (
  id uuid primary key, name text not null, slug citext unique not null,
  sso_enforced_roles text[] default '{}', retention_days int default 730,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key, tenant_id uuid not null references tenants,
  email citext not null, name text not null, avatar_color text,
  role text not null check (role in ('admin','recruiter','hiring_manager','member')),
  timezone text not null default 'UTC', mfa_enabled boolean not null default false,
  unique (tenant_id, email)
);

create table jobs (
  id uuid primary key, tenant_id uuid not null,
  req_code text not null,                    -- ENG-204
  title text not null, department text not null, location text not null,
  employment_type text, band_min_cents bigint, band_max_cents bigint,
  currency char(3) not null default 'USD',
  status text not null check (status in ('draft','active','on_hold','closing','closed')),
  recruiter_id uuid references users, hiring_manager_id uuid references users,
  openings int not null default 1,
  stage_template_id uuid not null references stage_templates,
  unique (tenant_id, req_code)
);

create table job_stages (                    -- per-job, ordered, SLA-bearing
  id uuid primary key, tenant_id uuid not null, job_id uuid not null references jobs,
  name text not null, position int not null,
  canonical text not null                     -- applied|screen|onsite|offer|hired|rejected
    check (canonical in ('applied','screen','onsite','offer','hired','rejected','withdrawn')),
  sla_days int, is_terminal boolean not null default false,
  unique (job_id, position)
);

create table candidates (
  id uuid primary key, tenant_id uuid not null,
  name text not null, email citext, phone text, location text,
  current_title text, current_company text,
  links jsonb not null default '{}',          -- resume, linkedin, github
  anonymized_at timestamptz,                  -- GDPR erasure tombstone
  search_vector tsvector generated always as (...) stored
);
create index on candidates using gin (search_vector);
create index on candidates using gin (name gin_trgm_ops);

create table applications (
  id uuid primary key, tenant_id uuid not null,
  candidate_id uuid not null references candidates,
  job_id uuid not null references jobs,
  current_stage_id uuid not null references job_stages,
  stage_entered_at timestamptz not null,      -- denormalized from transitions; drives "3d in stage"
  board_rank text not null,                   -- lexorank, ordering within column
  source text not null,                       -- referral|outbound|careers_page|agency|import
  referred_by_id uuid references users,
  status text not null default 'active' check (status in ('active','hired','rejected','withdrawn')),
  rejection_reason text,
  comp_expectation_min_cents bigint, comp_expectation_max_cents bigint,
  comp_expectation_currency char(3),           -- a candidate's expectation may differ from the job's band currency
  constraint comp_expectation_currency_required
    check ((comp_expectation_min_cents is null and comp_expectation_max_cents is null)
           or comp_expectation_currency is not null),
  notice_period_days int,
  version int not null default 1,             -- optimistic concurrency for drag/drop
  created_at timestamptz not null default now(),
  unique (tenant_id, candidate_id, job_id)    -- one application per person per role
);
create index on applications (tenant_id, job_id, current_stage_id, board_rank);

-- Composite FKs, not plain ones. FK validation bypasses RLS, so a plain
-- reference can point at another tenant's row and the database will happily
-- accept it. These make cross-tenant and cross-job references structurally
-- impossible rather than merely discouraged:
--   applications (tenant_id, candidate_id) -> candidates (tenant_id, id)
--   applications (tenant_id, job_id)       -> jobs (tenant_id, id)
--   applications (job_id, current_stage_id)-> job_stages (job_id, id)
-- The last one is the important one: without it, an application can sit in a
-- stage belonging to a different job, and every derived metric silently lies.
-- Requires a unique constraint on the referenced pair, e.g.
--   alter table job_stages add unique (job_id, id);

create table stage_transitions (              -- APPEND ONLY. every metric derives from this.
  id bigserial primary key, tenant_id uuid not null,
  application_id uuid not null references applications,
  from_stage_id uuid references job_stages,   -- null on creation
  to_stage_id uuid not null references job_stages,
  actor_id uuid references users,             -- null = system
  reason text, occurred_at timestamptz not null default now()
);
create index on stage_transitions (tenant_id, application_id, occurred_at);
create index on stage_transitions (tenant_id, to_stage_id, occurred_at);  -- funnel + median-time-in-stage queries join here

create table interviews (
  id uuid primary key, tenant_id uuid not null, application_id uuid not null,
  loop_id uuid,                                -- groups rounds into one onsite
  kind text not null,                          -- coding|system_design|values|hiring_manager
  duration_min int not null,
  scheduled_start timestamptz, scheduled_end timestamptz,
  status text not null check (status in ('unscheduled','pending','confirmed','declined','completed','cancelled')),
  external_event_id text, external_provider text
);

create table interview_panelists (
  interview_id uuid references interviews, user_id uuid references users,
  response text not null default 'pending',    -- pending|accepted|declined
  is_required boolean not null default true,
  primary key (interview_id, user_id)
);

create table scorecards (
  id uuid primary key, tenant_id uuid not null,
  interview_id uuid not null references interviews, author_id uuid not null references users,
  rating smallint check (rating between 1 and 4),
  recommendation text check (recommendation in ('strong_no','no','hire','strong_hire')),
  competencies jsonb not null default '[]', notes text,
  submitted_at timestamptz,                    -- null = draft; blindness rule keys off this
  unique (interview_id, author_id)
);

create table offers (
  id uuid primary key, tenant_id uuid not null, application_id uuid not null,
  version int not null, level text,
  base_cents bigint not null, currency char(3) not null default 'USD',
  equity_units int, equity_vesting_years int, signon_cents bigint,
  start_date date, expires_at date,
  status text not null check (status in ('draft','pending_approval','approved','sent','accepted','declined','rescinded','expired')),
  out_of_band_justification text,
  created_by uuid references users, created_at timestamptz not null default now(),
  unique (application_id, version)
);

create table offer_approvals (
  id uuid primary key, tenant_id uuid not null, offer_id uuid not null references offers,
  step int not null, approver_id uuid references users, approver_role text not null,
  status text not null check (status in ('pending','approved','changes_requested','skipped')),
  comment text, decided_at timestamptz,
  unique (offer_id, step)
);

create table activities (                      -- the candidate timeline
  id bigserial primary key, tenant_id uuid not null, application_id uuid not null,
  type text not null,                          -- note|email|stage_change|scorecard|interview|offer|system
  actor_id uuid references users, body text, meta jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index on activities (tenant_id, application_id, occurred_at desc);

create table interview_loops (                 -- groups rounds into one onsite; owns hold state
  id uuid primary key, tenant_id uuid not null,
  application_id uuid not null references applications,
  status text not null check (status in ('draft','proposed','held','confirmed','completed','cancelled')),
  target_date date, timezone text not null,
  held_by uuid references users, hold_expires_at timestamptz,   -- the 24h soft reservation
  created_at timestamptz not null default now(),
  unique (application_id, id)
);
-- interviews.loop_id references interview_loops(id)

create table outbox (                          -- domain events, written in the state-change txn
  id bigserial primary key, tenant_id uuid not null,
  event_type text not null,                    -- ApplicationAdvanced, OfferApproved, ...
  aggregate_type text not null, aggregate_id uuid not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,                    -- null = not yet relayed
  attempts int not null default 0, last_error text
);
create index on outbox (published_at, id) where published_at is null;

create table audit_log (                       -- immutable, no update/delete grant
  id bigserial primary key, tenant_id uuid, actor_id uuid, action text not null,
  entity_type text not null, entity_id uuid,
  before jsonb, after jsonb, ip inet, request_id text,
  occurred_at timestamptz not null default now()
);
```

**Money columns** are `bigint` cents with an explicit `char(3)` currency alongside — never a default. A column defaulting to `'USD'` is an assumed currency wearing a constraint, and the caller that omitted it is the caller who got it wrong. Currency is required at the API contract layer, so omission is a validation error rather than a silent guess.

**RLS pattern**

```sql
alter table applications enable row level security;
create policy tenant_isolation on applications
  using (tenant_id = current_setting('app.tenant_id')::uuid);
```

The API sets `app.tenant_id` and `app.user_id` on every checked-out connection inside the request transaction. Application code is the primary guard; RLS is the backstop that catches the query someone forgot to scope. A CI test suite runs as tenant B and asserts every endpoint returns 404 for tenant A's IDs.

**Why `stage_entered_at` is denormalized:** the board renders 200 cards and each needs time-in-stage. Deriving it from `stage_transitions` per card is a correlated subquery per row. It's written in the same transaction as the transition, and a nightly job asserts the two agree — drift becomes an alert, not a silent bug.

## 6. The three hard subsystems

### 6.1 Kanban: ordering and concurrency

**Ordering** uses lexorank strings (`board_rank`), so inserting between two cards is a single-row update with no reindexing. Ranks are rebalanced by a background job when neighbors' keys grow past a length threshold.

**Concurrency.** The move request carries the application's `version` and its `from_stage_id`:

```
PATCH /v1/applications/:id/stage
{ toStageId, beforeId, afterId, version, reason? }
```

- Version mismatch → `409` with current state; the client rolls back its optimistic update and refetches that column.
- `from_stage_id` mismatch (someone else already moved it) → `409` regardless of version, because silently re-applying a stage change corrupts the transition log.
- Pure reorder within a column is last-write-wins — position isn't worth a conflict dialog.

**`version` counts stage changes only.** A rank-only update does **not** bump `version`. If it did, user A dragging a card within a column would invalidate user B's in-flight stage move on a different card and produce a 409 that has nothing to do with any real conflict — flaky board behavior that looks like a race and isn't. Repositories therefore expose two distinct writes: `updateRank` (touches `board_rank` and `updated_at`) and `moveStage` (touches stage, `stage_entered_at`, and `version`). An integration test asserts a reorder leaves `version` unchanged.

Every successful move writes the transition, updates `stage_entered_at`, appends an activity, and inserts an `outbox` row — all in one transaction. Nothing is published inline; a failed publish must never roll back a state change, and a committed state change must never lose its event.

**The relay** is a dedicated worker (`workers-outbox`, §9.2). It polls unpublished rows every 2s using `select ... for update skip locked` in batches of 100, publishes to EventBridge, and stamps `published_at`. Failures increment `attempts` with exponential backoff; rows past 10 attempts alarm rather than retry forever. Delivery is **at-least-once**, so every consumer must be idempotent — keyed on `outbox.id`, which is monotonic and unique. A consumer that isn't idempotent is a bug, not a tuning problem.

**Realtime:** clients hold an SSE stream per board; the relay fans out to Redis pub/sub, API instances forward to their subscribers. Payloads are ids + versions only — the client refetches what it needs, so a stale broadcast can never write bad data into a cache. On reconnect the client refetches the board wholesale rather than replaying missed events; with id-only payloads there is nothing to replay.

Two operational details that bite if unhandled:
- **ALB idle timeout** defaults to 60s and will silently kill idle streams. Set it to 300s on the listener and emit an SSE comment heartbeat every 25s.
- **Autoscaling metric.** Long-lived connections make request-count-per-target meaningless as a load signal. The API service scales on CPU and memory, not request count; request-count scaling stays on the `web` service only.

### 6.2 Scheduling

Three separate problems that get conflated: **availability**, **solving**, and **committing**.

**Availability.** Per-panelist OAuth (Google) or app-only-with-consent (Graph). Free/busy is pulled for a rolling 21-day window and cached in Redis keyed `freebusy:{tenant}:{user}:{date}` with a 5-minute TTL, warmed by push notifications: Google watch channels and Graph subscriptions post to a webhook that invalidates the affected days. Private/unreadable calendars are treated as **fully busy** — the failure mode must be "we didn't offer a slot" and never "we double-booked an interviewer."

**Solving.** Inputs: rounds (duration, required panelists, swappable flag), candidate availability window in their timezone, business-hours policy, and a max-loop-span. This is a small constraint problem — for a 4-round loop it's a permutation search over ordered rounds against 15-minute grid starts:

1. Build a busy bitmap per panelist over the day at 15-minute granularity.
2. For each candidate ordering of rounds (fixed rounds pinned; swappable ones permuted, capped at 4! = 24), walk grid starts and greedily place rounds back-to-back, allowing configurable gaps.
3. Score candidates: fewer gaps, earlier finish, fewer required-panelist substitutions.
4. Time-box to 200ms; return the top 3 arrangements. If none, return the **specific blocker** — the panelist and time causing the failure — which is what powers "Maya Reyes is busy at 10:00. Pick a clear row or the loop needs a gap."

**Committing.** A hold takes a Redis lock plus a tentative DB row with a 24h expiry and writes tentative calendar blocks. Sending invites runs a **re-validation** against fresh free/busy inside a transaction; if anything changed, it aborts and shows the diff rather than sending. Calendar writes go through the queue with idempotency keys so a retry can't create duplicate events. Panelist declines arrive via webhook, flip the round to `Pending`, and raise a next-action on the candidate profile.

**Timezones.** All storage UTC. Every user and candidate carries an IANA zone. Rendering converts at the edge. DST-boundary cases are fixture-tested in CI — this is the one bug class that directly humiliates the recruiter in front of a candidate.

### 6.3 Offer approvals

A state machine in `packages/domain`, not conditionals scattered across services:

```
draft ──submit──> pending_approval ──all steps approved──> approved
  ▲                    │                                      │
  └──changes_requested─┘                                    send
                                                              │
                                                            sent ──> accepted | declined | expired
                                                              └──rescind──> rescinded
```

Rules: approval steps are evaluated in order; an out-of-band base salary injects a Finance step automatically; editing a field on an approved offer creates **version n+1** and invalidates approvals at or after the first step whose scope covers the changed field (a title change doesn't need Finance to re-approve; a base change does). `expires_at` is enforced by a scheduled job, not by the read path, so an expired offer is expired everywhere at once.

## 7. API conventions

- `GET /v1/jobs?status=active&cursor=...&limit=50` — cursor pagination on `(sort_key, id)`, never OFFSET.
- Mutations accept `Idempotency-Key`; keys live in Redis for 24h with the stored response.
- Errors are RFC 9457 problem+json with a stable `type` the client switches on.
- Rate limits: per tenant and per user, sliding window in Redis, returned as `RateLimit-*` headers.
- Writes return the full updated resource with its new `version`, so the client never needs a follow-up GET.
- OpenAPI is generated from Zod schemas in `packages/contracts` and published to the frontend as types — a contract drift breaks the build, not production.

Representative surface:

```
POST   /v1/jobs                     GET /v1/jobs/:id/pipeline
PATCH  /v1/applications/:id/stage   POST /v1/applications/:id/notes
GET    /v1/review-queue             POST /v1/review/:id/decision
POST   /v1/interviews/loops         POST /v1/interviews/loops/:id/hold
POST   /v1/interviews/loops/:id/send
POST   /v1/offers  PATCH /v1/offers/:id  POST /v1/offers/:id/approvals/:step
GET    /v1/reports/funnel           GET /v1/search?q=
POST   /v1/imports  (presign) → POST /v1/imports/:id/commit
GET    /v1/streams/board/:jobId     (SSE)
```

## 8. Bulk import pipeline

```
client → POST /v1/imports (presigned S3 PUT) → upload
       → POST /v1/imports/:id/analyze
            → SQS → import-worker: sniff dialect, infer columns, sample 100 rows
       → client maps columns (saved mappings per tenant)
       → POST /v1/imports/:id/dry-run → per-row validation report + error CSV
       → POST /v1/imports/:id/commit
            → worker streams rows in batches of 500, upserts inside a transaction per batch
            → progress written to Redis, streamed to the client via SSE
```

Idempotency: each row gets a deterministic hash of `(import_id, row_index, natural_key)`; re-running skips rows already committed. Duplicate matching is email first, then `pg_trgm` similarity on `name + company` above a threshold, surfaced for confirmation rather than merged silently.

## 9. AWS infrastructure

### 9.1 Network

- One VPC per environment, 3 AZs. Public subnets (ALB, NAT), private-with-egress (ECS tasks), isolated (Aurora, ElastiCache).
- VPC endpoints for S3, ECR, Secrets Manager, CloudWatch Logs, SQS — cuts NAT cost and keeps traffic off the internet.
- Security groups reference each other by ID; no CIDR allow-lists between tiers.

### 9.2 Compute

- ECS Fargate services: `web`, `api`, `workers-default`, `workers-calendar` (isolated so third-party rate limits can't starve email or imports), `workers-outbox` (the event relay, §6.1 — separated because it must keep draining even when other workers are backed up).
- Autoscaling on ALB request count per target for `api`/`web`, on SQS `ApproximateAgeOfOldestMessage` for workers.
- Rolling deploys with circuit breaker + auto-rollback; ALB health checks hit `/healthz` (liveness) and `/readyz` (DB + Redis reachable).
- Lambda for: cron (offer expiry, SLA/stall sweep, report rollup, rank rebalance, retention purge), inbound SES mail processing, and calendar webhook receivers.

### 9.3 Data

- Aurora PostgreSQL Serverless v2, writer + one reader; reports and search route to the reader via a separate connection pool. Min 0.5 ACU in dev, 2 ACU in prod. PgBouncer-style pooling via RDS Proxy so Fargate scale-out doesn't exhaust connections.
- Automated backups 35 days, PITR, deletion protection, encrypted with a customer-managed KMS key.
- ElastiCache Serverless for Redis.
- S3: `talon-{env}-uploads` (versioned, SSE-KMS, lifecycle to IA at 90d), `talon-{env}-exports` (7-day expiry), `talon-{env}-inbound-mail`. All buckets block public access; access only via presigned URLs.

### 9.4 Identity (Cognito) and edge

One user pool per environment, shared across all tenants.

- **Sign-in methods:** email + password (SRP, via the SDK against our own forms — the managed login UI can't match the reference screens), Google as a social IdP, and one SAML IdP per tenant that enables SSO.
- **MFA:** TOTP enabled, `OPTIONAL` at the pool level so policy is enforced in our application layer per the PRD (required for admins, tenant-configurable for everyone else). Ten recovery codes are ours, hashed in our DB — Cognito doesn't provide them.
- **Per-tenant SAML:** an IdP is created in the pool when an admin configures SSO, with `IdpIdentifier` set to the tenant's email domain so `/authorize` can route by domain. These are created at runtime through the API, **not** in Terraform — they're tenant data, not infrastructure. Terraform managing them would mean a customer onboarding requires a deploy.
- **Advanced security features** on for compromised-credential detection and adaptive auth.

**The hazard — read before writing the pool resource.** Cognito's schema attributes are immutable after pool creation, and `aws_cognito_user_pool` forces replacement when `schema` changes. A replacement **destroys every user**. Two consequences that shape the design:

1. **No custom attributes for tenancy.** `tenant_id`, roles, and job membership live in our `users` table keyed by Cognito `sub`. A **pre-token-generation Lambda** reads that table and injects claims at token issue. The IdP answers "who is this"; our database answers "what may they do." This is the right architecture regardless, and it happens to make the pool schema stable forever.
2. **`ignore_changes = [schema]`** on the pool, plus a CI check that fails the build if a plan shows `aws_cognito_user_pool` being replaced. A destroy-and-recreate must be a deliberate, manual act. Note this deliberately does **not** use `prevent_destroy` — see §9.5a: that would block `scripts/down.sh`, and one-command teardown is a requirement. Protection comes from the stack split and the `--all` confirmation gate instead.

```hcl
resource "aws_cognito_user_pool" "main" {
  name = "talon-${var.env}"
  lifecycle {
    ignore_changes = [schema]   # schema changes require a documented migration, never a silent replace
  }                             # no prevent_destroy — it would block scripts/down.sh (§9.5a)
}
```

**Edge:** CloudFront in front of the ALB with WAF — managed common rule set, a rate-based rule per IP, and a stricter rule on `/v1/auth/*`. ACM certs and a Route 53 hosted zone per environment.

### 9.5 Terraform layout

```
infra/terraform/
  modules/
    network/        VPC, subnets, endpoints, security groups
    data/           Aurora, RDS Proxy, ElastiCache, S3, KMS
    identity/       Cognito pool, Google IdP, app clients, pre-token Lambda
    messaging/      SQS queues + DLQs, EventBridge bus, SES config set
    compute/        ECR, ECS cluster, task definitions, services, autoscaling
    edge/           CloudFront, WAF, ACM, Route 53
    observability/  log groups, dashboards, alarms, SNS
  envs/
    dev/            main.tf, backend.tf, terraform.tfvars
    staging/
    prod/
  global/
    state/          S3 state bucket + DynamoDB lock table (bootstrapped once)
    oidc/           GitHub OIDC provider + per-account deploy roles
```

**State:** S3 backend with versioning and a DynamoDB lock table, one key per environment. The state bucket is bootstrapped separately in `global/state` and never destroyed — chicken-and-egg, so it gets created once by hand and then left alone.

**Environments: one AWS account, environments separated by name prefix and tag.** Not three accounts under an Organization — that was the earlier plan and it is wrong for this project. The deploy identity is a company `PowerUserAccess` role in a single account; there is no Organization to join, and joining one is out of scope.

Every resource is named `talon-${var.env}-*` and tagged `Project=talon, Env=${var.env}, ManagedBy=terraform`. Each env is still its own root module with its own state key — **not** Terraform workspaces, which share a state file and blur blast radius. Workspaces are reserved for ephemeral PR environments.

Practically, only `dev` exists until there is something worth staging. Build the module structure so a second account is a variable change rather than a rewrite, and don't pay for environments nobody is using.

**IAM lives in its own stack, by design rather than by necessity.** The deploy identity has been granted `iam:CreateRole`, `PassRole`, `AttachRolePolicy`, `PutRolePolicy`, and `CreatePolicy` — all verified against the live account — so `stacks/iam` is self-serve and runs as a normal stage of `up.sh`.

It stays a separate stack anyway. Role definitions change rarely, are the highest-privilege thing in the repo, and a small isolated stack is reviewable in a way a role buried among sixty resources is not. Every other module still takes role ARNs as **input variables**, which keeps the `TALON_ROLE_ARNS` path in §9.5a working for anyone cloning this without the same grant.

Check whether the grant is scoped to a name prefix. If it is, every role Terraform creates must respect it — a role named `ecs-task-execution` failing at apply looks nothing like a permissions problem and will cost an hour.

**CI:** `terraform fmt -check`, `tflint`, and `checkov` on every PR. `terraform plan` is posted as a PR comment and `apply` runs on merge to main, gated on the plan being unchanged. A plan showing replacement of any protected resource (`aws_cognito_user_pool`, `aws_rds_cluster`, state buckets) fails the check and needs a manual override with a written reason.

**Protection:** not `prevent_destroy` — it can't be parameterized and it blocks one-command teardown (§9.5a). Stateful resources are protected by living in `stacks/persistent`, by `down.sh` requiring `--all` plus a typed confirmation to touch them, and by the CI check that fails any plan replacing them.

**Ephemeral PR environments** use workspaces over the `compute` + `edge` modules only, pointing at the shared dev database with a per-PR tenant. Standing up full data infrastructure per PR is too slow and too expensive to be worth it. Workspaces are the right tool here and the wrong tool for environments — the difference is lifetime and blast radius.

### 9.5a Single-command provisioning — the actual deliverable

The requirement is not "Terraform exists." It is: **hand someone a script, they run it once, and a working Talon is reachable at a URL they can sign into.** That is a harder target, and it drives several structural decisions.

Terraform alone does not get you there. Four ordering problems sit outside its graph:

| Problem | Why Terraform can't solve it alone |
|---|---|
| State backend | The S3 bucket must exist before `terraform init` can use it |
| Container image | ECR must exist, then the image must be built and pushed, before a task definition can reference the tag |
| Migrations and seed | Aurora lives in isolated subnets — your laptop can't reach it. These run as ECS one-off tasks inside the VPC |
| Demo login | The Cognito user must exist and its `sub` must reach the seed, or you get a URL nobody can sign into |

**`scripts/up.sh`** encodes that ordering:

```bash
0. preflight        aws sts get-caller-identity, terraform >= 1.9, docker running;
                    fail loudly and early with what's missing
1. bootstrap        create the state bucket + lock table via AWS CLI if absent (idempotent)
2. iam              terraform apply stacks/iam
                    SKIPPED when TALON_ROLE_ARNS is set — see below
3. persistent       terraform apply stacks/persistent  → ECR URL, Cognito pool + client ids
4. image            docker build, tag with the git SHA, push to ECR
5. ephemeral        terraform apply stacks/ephemeral -var image_tag=$SHA → app URL
6. migrate          aws ecs run-task, migration entrypoint, wait for exit 0
7. demo user        create the Cognito user, capture its sub
8. seed             aws ecs run-task, seed entrypoint, passing that sub
9. verify           poll /readyz until healthy, then print the URL and demo credentials
```

Requirements on that script, all of which are testable:

- **Idempotent.** Running it twice is a no-op, not a second stack. Every step checks before it creates.
- **Resumable.** A failure at step 6 is fixed and re-run from the top, not unwound by hand.
- **Loud.** Every step prints what it's doing and what it produced. A fifteen-minute silent script is indistinguishable from a hung one.
- **Ends with the thing you asked for** — a URL and credentials, printed. Not "apply complete."

**`scripts/down.sh`** mirrors it: destroys `ephemeral` by default; `--all` additionally destroys `persistent` after an explicit typed confirmation, because that deletes the Cognito pool and every user in it.

**IAM as an input, not an assumption.** The deploy identity here denies `iam:*`. So `stacks/iam` is a *separate stage the script can skip*: if `TALON_ROLE_ARNS` is set (an admin ran it, or created the roles by hand), every other stack takes those ARNs as input variables and the single click still works end to end. If the permission is granted later, unset the variable and stage 2 runs itself. Design for both from the start — a script that only works with elevated permissions isn't the deliverable.

**`prevent_destroy` cannot be parameterized.** Terraform requires a literal in `lifecycle` blocks, so it can't vary by profile — and a `prevent_destroy` on Cognito or the database directly blocks `down.sh`. Resolution: **no `prevent_destroy` in this project's stacks.** Protection comes from the persistent/ephemeral split, the `--all` confirmation gate, and the CI check that fails any plan replacing a stateful resource. Reintroduce it only if a genuine prod stack is ever added, where teardown should be hard. This supersedes the earlier guidance in §9.4 — the Cognito `ignore_changes = [schema]` guard **stays**, since that one prevents accidental user destruction without blocking deliberate teardown.

**Acceptance for spec 002 is behavioral, not structural:** on a clean machine with only AWS credentials, `./scripts/up.sh` completes and prints a URL that signs in. Verified by tearing down completely and running it again from nothing. A Terraform config that has never been applied from zero is a config that does not work from zero.

### 9.6 Cost profiles and teardown

This runs on a company account. The full architecture left running costs real money, so cost shape is an architectural constraint, not an afterthought.

Rough monthly figures if left running 24/7 — **estimates, verify with the AWS pricing calculator before committing to anything**:

| Resource | Spec profile | Dev profile |
|---|---|---|
| Postgres | Aurora Serverless v2, 0.5 ACU floor — ~$45 | RDS `db.t4g.micro` single-AZ — ~$13 |
| Redis | ElastiCache Serverless, ~1GB floor — ~$60 | `cache.t4g.micro` node — ~$11 |
| Egress | NAT Gateway — ~$32 + data | NAT instance `t4g.nano` — ~$3 |
| Load balancer | ALB — ~$16 | ALB — ~$16 |
| Compute | Fargate, 2 services — ~$20 | Fargate, 0.25 vCPU — ~$9 |
| **Total** | **~$175/mo** | **~$52/mo** |

Two levers, both structural:

**1. A `profile` variable.** `var.profile` (`dev` \| `spec`) selects instance classes and engine choices. Same modules, same resource graph, different sizes — so the spec-faithful topology is always one apply away for a demo, and the everyday cost is a third of it.

**2. Split stacks by lifetime.**

```
stacks/persistent/   Cognito, S3, ECR, KMS, state  → apply once, torn down only via down.sh --all
stacks/ephemeral/    VPC, NAT, RDS, Redis, ECS, ALB → destroy between sessions
```

`scripts/down.sh` (ephemeral only, the default) between work sessions takes the bill to near zero without losing users, images, or uploaded files. `scripts/up.sh` brings it back in one command. The split is what makes routine teardown safe — and it's why nothing here uses `prevent_destroy`, which would fight the teardown it's meant to protect (§9.5a).

RDS keeps `skip_final_snapshot = false` in the ephemeral stack, so a teardown snapshots rather than discards; `pnpm db:seed` reproduces the reference data anyway, which is what makes routine teardown safe.

**Deferred deliberately:** the reporting read replica. It doubles Aurora cost for query volume that doesn't exist yet. Reports run against the writer until p95 on report queries exceeds 1s or they measurably slow writes — then add the replica, which is a one-line module change.

**Set a budget alarm before the first apply.** AWS Budgets at a threshold you and the account owner agree on, with an SNS email. This is the cheapest possible insurance and takes two minutes.

### 9.7 Where Terraform costs more than CDK here

Recorded so nobody rediscovers these mid-build and thinks something is broken:

- **No type sharing.** The app is TypeScript; HCL is a separate language with separate tooling. Resource names and ARNs cross the boundary as strings via SSM parameters or state outputs, not as types.
- **Cognito is the sharpest edge.** See §9.4 — schema changes force pool replacement and destroy users. `prevent_destroy` plus a plan check is mandatory, not optional.
- **ECS task definitions churn.** Every image tag change produces a new revision and a diff. Either template the tag from CI or `ignore_changes = [task_definition]` on the service and let the deploy pipeline own it — pick one and be consistent, or plans become unreadable.
- **Lambda source packaging** needs an explicit build step and `source_code_hash`; there is no equivalent of CDK's bundling.
- **No `cdk-nag`.** `checkov` plus `tflint` covers most of the same ground but needs its rule set configured deliberately rather than arriving on by default.

None of these is a reason to switch. They're the reason the infra work is a real milestone rather than an afternoon.

### 9.8 Observability and SLOs

- OTel auto-instrumentation for HTTP, Postgres, Redis, and outbound HTTP; trace ID propagated into every log line and returned as `X-Request-Id`.
- Dashboards: API latency by route, queue depth and oldest-message age, DB connections and slow queries, third-party API error rate per provider.
- Alarms: p95 latency > 800ms for 5 min, DLQ depth > 0, oldest SQS message > 15 min, 5xx rate > 1%, calendar sync failure rate > 5%, Aurora CPU > 80%.
- SLOs: API availability 99.9%, p95 read latency 300ms, p95 write 600ms, invite delivery within 60s of send.

### 9.9 Security

- Encryption in transit everywhere; at rest with customer-managed KMS keys per environment.
- Secrets in Secrets Manager with rotation; nothing in environment variables except ARNs.
- Least-privilege task roles — the calendar worker cannot read the uploads bucket.
- PII: candidate email and phone are column-encrypted with envelope encryption so a database dump alone isn't a breach; access is logged.
- Retention job purges per tenant policy; erasure anonymizes `candidates` in place and scrubs `activities` bodies while leaving `stage_transitions` intact so historical funnels survive.
- GuardDuty, Security Hub, CloudTrail. With a single account, CloudTrail logs go to a dedicated bucket with object lock rather than a separate logging account.

### 9.10 Candidate file handling

Resumes are attacker-controlled files uploaded by strangers and opened by your recruiters. This is the highest-risk surface in an ATS and it gets explicit handling, not general S3 hygiene.

**On ingest**
- Presigned PUT with a content-length cap (10MB) and an allow-list of extensions and sniffed MIME types: PDF, DOC, DOCX, TXT, RTF. The sniffed type must match the claimed one — trusting the client's `Content-Type` is trusting the uploader.
- Land in a quarantine bucket. A scanner Lambda (ClamAV layer, or GuardDuty Malware Protection for S3) runs before the object moves to the served bucket. Until it clears, the file is not downloadable and the UI shows "Scanning" rather than a broken link.
- Strip nothing, transform nothing. Resume parsing reads from quarantine and writes extracted text; the original is preserved byte-for-byte because it may matter in a hiring dispute.

**On serve**
- Presigned GET, 5-minute expiry, `ResponseContentDisposition=attachment` always. Never inline — an inline-rendered HTML or SVG file executes in your origin.
- Served from a separate CloudFront distribution on its own subdomain, so a bypassed content-type check still can't reach app cookies or localStorage.
- `X-Content-Type-Options: nosniff` and a restrictive CSP on that distribution.
- Never reflect the original filename into a header without sanitizing it — filenames are user input and carry header-injection and path-traversal payloads.

**Preview**
- In-browser preview renders extracted text or a server-generated image, never the original file in an iframe or object tag.

This is one of the four expensive areas in practice: a malicious resume that runs script in a recruiter's session has access to every candidate in the tenant.

## 10. Testing

| Layer | Tool | What it covers |
|---|---|---|
| Unit | Vitest | Domain logic: state machines, lexorank, the scheduling solver, signal scoring. Solver and rank code get property-based tests via `fast-check`. |
| Integration | Vitest + Testcontainers (Postgres, Redis, LocalStack) | Repositories, RLS policies, outbox, queue handlers against real services. |
| Contract | OpenAPI diff in CI | Breaking API change fails the build. |
| Tenant isolation | Dedicated suite | Runs every endpoint as a hostile tenant, asserts 404. Non-negotiable gate. |
| Route manifest | Vitest, boots the app | Every route is tenant-scoped or explicitly allow-listed public (§4.1). Catches the unprotected route the isolation suite didn't know to test. |
| Module boundaries | `eslint-plugin-boundaries` in CI | An import outside the declared module graph fails the build (§4.1). |
| E2E | **Playwright** | Below. |
| a11y | `@axe-core/playwright` in the E2E run | AA violations fail CI. |
| Load | k6 against staging | 200-card board, 50k-row import, 100 concurrent report queries. |

**Playwright suite** — page-object model, `storageState` per persona so login runs once, one worker per persona for parallelism, seeded per-run tenant so tests never share data, `trace: 'on-first-retry'` plus video on failure.

Flows covered:
1. Sign in with email + TOTP; Google path stubbed at the IdP boundary.
2. Create a job through the four-step wizard; verify it appears grouped under its department.
3. Triage the review inbox by keyboard only (`A`/`R`/arrows) and verify the resulting stage transition.
4. Drag a card across stages; assert optimistic update, persisted state after reload, and the activity entry.
5. Two-tab concurrency: move the same card in both tabs, assert the 409 path recovers cleanly.
6. Schedule a 4-round loop against mocked free/busy, hit the conflict message, resolve it, hold the slot, send invites.
7. Build an offer out of band, confirm the extra approver appears, walk the approval chain, preview the letter.
8. Import a 500-row CSV with 12 deliberately bad rows; verify the error report and that only good rows committed.
9. `⌘K` search from any screen to a candidate profile.
10. Reports: apply a date filter and assert numbers match a fixture computed independently from the seeded event log.

Third-party boundaries (Google, Graph, SES, Cognito) are stubbed at the network layer with Playwright route interception so the suite is deterministic and runs offline. A separate nightly job runs the same flows against real sandbox credentials.

## 11. Scaling path

| Trigger | Move |
|---|---|
| Report queries slow the writer | Already on a reader; next add a nightly rollup table for funnel and KPI tiles |
| Search p95 > 300ms or >1M candidates/tenant | OpenSearch, fed from the outbox — Postgres stays the source of truth |
| Calendar sync starves other work | Already an isolated worker service; next shard by tenant |
| One tenant dwarfs the rest | Move that tenant to a dedicated Aurora cluster; tenant→cluster routing already exists in the connection layer |
| Board fanout heavy | SSE fanout to a dedicated service, or move to AppSync events |

Deliberately **not** doing at v1: microservice split, Kafka, EKS, CQRS with separate read stores, or a service mesh. Each of those solves a problem Talon does not yet have, and every one of them makes the scheduling subsystem — the actual hard part — harder to get right.