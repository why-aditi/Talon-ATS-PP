# CLAUDE.md — Talon ATS

Project memory for coding agents. Read this before doing anything in this repo.

Talon is a multi-tenant applicant tracking system built from nine reference screens. Full stack, real AWS infra, real calendar sync, real tests.

**Source of truth, in priority order:**
1. `docs/PRD.md` — what we're building and why. Scope and acceptance criteria live here.
2. `docs/ARCHITECTURE.md` — stack, data model, the three hard subsystems, AWS topology.
3. `docs/design-tokens.json` — every color, type, space, radius, motion value.
4. `docs/DESIGN_SYSTEM.md` — how tokens become components, screen by screen.
5. `docs/reference/*@2x.png` — the nine screens, extracted losslessly from the source PDF at 2880×1800 (the design is **1440×900 CSS at 2x**). When a doc and a screen disagree, **ask**; don't pick one.

Colors and layout in `design-tokens.json` were measured pixel-wise from these files and are authoritative — do not "correct" them by eye. Typography is the exception: sizes are still provisional and flagged as such in `_meta.confidence`.

If a task isn't covered by those, that's a gap to surface, not a blank to fill in silently.

---

## 1. How we work — follow this loop, always

This is not optional and not a suggestion for "big" tasks. It applies to every non-trivial change.

### Phase 1 — Listen
Read the request fully. Read the relevant docs and the relevant existing code **before** forming an opinion. Do not start proposing solutions in your first response.

### Phase 2 — Ask
Ask as many clarifying questions as you actually have. Batch them; don't drip one at a time. Good questions are specific and decision-shaped:

> "The PRD says stage SLAs default per template and are overridable per job. Should an SLA change apply retroactively to cards already in that stage, or only to cards that enter after the change? This determines whether stall detection reads the SLA at write time or at read time."

Bad question: "Do you want me to add SLAs?"

If you genuinely have zero questions, say so explicitly and say why — that's a claim you're accountable for.

### Phase 3 — Identify problems
Before planning, list what will go wrong. Actively hunt for:
- Ambiguity and contradiction between the docs and the screens
- Edge cases (empty, one, many, concurrent, offline, timezone, permission-denied)
- Places the existing code already conflicts with the new requirement
- Anything that touches tenancy, comp visibility, scorecard blindness, calendar writes, or candidate file handling — these are the five areas where a bug is expensive
- Work that's larger than it looks, and work that's smaller than it looks

State these plainly. "I found no problems" is almost always wrong on a first pass.

### Phase 4 — Plan
Write a plan: ordered steps, files touched, decisions made and their alternatives, what's explicitly out of scope, and how it will be verified. Keep it readable in one sitting.

### Phase 5 — Review gate
**Stop. Present the plan and wait.** Do not write implementation code before the plan is approved. Incorporate the changes the user makes; if a change creates a new problem, say so before proceeding.

### Phase 6 — Spec
After the plan is approved, write a **very detailed spec document** to `docs/specs/NNN-<slug>.md`. This is the artifact implementation is built from, and it must be complete enough that someone else could build it without asking you anything.

Every spec contains:
- **Context and goal** — the one-sentence job, and why now
- **Scope / out of scope** — explicit both ways
- **Data model changes** — exact DDL, migration and rollback plan, backfill strategy
- **API contract** — routes, Zod schemas, status codes, error `type` values, idempotency and concurrency behavior
- **UI spec** — every state: default, loading, empty, error, permission-denied, and the specific token used for each element
- **Behavior** — keyboard paths, optimistic updates and their rollback, realtime effects
- **Permissions** — per role, per field, at the API layer
- **Edge cases** — as a numbered list, each with expected behavior
- **Events emitted** and who consumes them
- **Test plan** — unit, integration, E2E, keyed to the acceptance criteria
- **Open questions** — with a named owner, not left implicit

### Phase 7 — Build with sub-agents
Split the spec across parallel sub-agents by boundary, not by "half the files." See §5.

### Phase 8 — Test
Write tests, run them, and **verify the real UI in Claude in Chrome** before calling anything done. See §6. A feature is not complete because the code compiles and the unit tests pass.

### Phase 9 — Ship
Open a PR, run the `reviewer` agent, fix every blocking finding, re-review the fixes, then merge. **Never push to `main` directly.** Full loop in §8.

---

## 2. Stack (decided — don't re-litigate without asking)

Next.js 15 App Router · React 19 · TypeScript strict · Tailwind v4 driven by tokens · Radix + shadcn/ui · dnd-kit · TanStack Query · react-hook-form + Zod · **Fastify 5 on Node 22** with `fastify-type-provider-zod` and awilix · Drizzle · PostgreSQL 16 on Aurora Serverless v2 with RLS · Redis · SQS + EventBridge · S3 · SES · ECS Fargate · Playwright · OpenTelemetry.

**NestJS was evaluated and rejected** (ARCHITECTURE §2): it would fork the Zod contract chain into a second set of class-validator DTOs. The structure Nest would have enforced is replaced by the three controls in ARCHITECTURE §4.1, which are a **hard prerequisite** — if they are not in place, stop and build them before writing feature code.

### Decisions closed — do not re-litigate

| Decision | Choice | Note |
|---|---|---|
| Auth provider | **Cognito** | Only option inside the Terraform stack, so `terraform apply` yields a loginable system. Still behind an `IdentityProvider` interface — write against the interface, not the Cognito SDK, outside the adapter |
| IaC tool | **Terraform** | Root module per env, S3 + DynamoDB state, separate AWS accounts. Layout in ARCHITECTURE §9.5; known rough edges in §9.6 |

Rejected options and why are recorded in ARCHITECTURE §2. If you think one should be reopened, raise it — don't quietly switch.

## 3. Repo layout

```
apps/web        Next.js
apps/api        Fastify HTTP — one plugin per module, see ARCHITECTURE §4
apps/workers    queue consumers (same image, different entrypoint)
packages/domain     entities, state machines, invariants — NO I/O, NO imports from db
packages/db         Drizzle schema, migrations, RLS policies
packages/contracts  Zod schemas → generated OpenAPI + client types
packages/tokens     design-tokens.json → CSS vars + Tailwind theme
packages/testing    factories, fixtures, seed
infra/terraform     modules/ + envs/{dev,staging,prod}/ + global/
e2e/                Playwright
docs/               PRD, ARCHITECTURE, DESIGN_SYSTEM, tokens, specs/, reference/
```

Module boundaries inside `apps/api` are real and **lint-enforced**, not conventional. Each module is a Fastify plugin with a fixed internal shape (`routes` / `service` / `repository` / `container` / `events` / `index.public.ts`). Cross-module access goes through `index.public.ts` only; `repository.ts` is the single file in a module allowed to import `packages/db`. Adding a cross-module edge means editing the `eslint-plugin-boundaries` allow-list in a PR that explains why — never a local `eslint-disable`.

## 4. Non-negotiables

These are the rules that, if broken, mean the change gets reverted rather than patched.

1. **Tenancy.** Every tenant-scoped table has `tenant_id` and an RLS policy. Every request sets `app.tenant_id` on its connection inside the transaction. Never write a query that relies on the caller having filtered correctly. **Auth and tenancy hooks are registered at plugin scope, never per route** — a new route inherits protection by being registered in the right place, and the route-manifest test (ARCHITECTURE §4.1) fails CI if one slips out. Never attach `authenticate` to an individual route; that pattern makes the omission invisible.
2. **Comp is scope-gated at the API layer.** Base, equity, band, comp expectation. Hiding a field in the UI is not access control.
3. **Scorecard blindness.** An interviewer cannot read other panelists' scorecards for a candidate until their own `submitted_at` is set. Enforce in the query, not the component.
4. **`stage_transitions` is append-only.** No updates, no deletes. Every pipeline metric derives from it. A correction is a new row.
5. **One path per action.** Advancing from the review inbox and dragging on the kanban call the same service method. Two code paths for one user intent will diverge.
6. **Calendar failure mode is "no slot offered," never "double-booked."** Unreadable calendars count as fully busy. Always re-validate free/busy immediately before sending invites.
7. **Timezones:** store UTC, carry an IANA zone per user and per candidate, convert at render. Any scheduling change ships with a DST-boundary test.
8. **No raw hex, px color, or magic spacing in components.** Semantic tokens only. `--color-action-primary-bg`, never `--color-indigo-600` and never `#4F46C9`. CI fails on violations.
9. **Money is `bigint` cents + an explicit currency code.** Never a float, never an assumed USD.
10. **Every mutation writes to `audit_log`** with actor, before, after, IP, request id.
11. **Optimistic UI always has a rollback path.** A 409 from a stage move must restore the previous state and refetch, not leave the board lying.
12. **Accessibility is a gate, not a polish task.** Keyboard path for the kanban, visible focus, no color-only status, `prefers-reduced-motion` respected. `axe` violations fail CI.
13. **Never change the Cognito pool schema.** Attributes are immutable; Terraform force-replaces the pool on a schema diff and **every user is destroyed**. `tenant_id`, roles, and job membership belong in our `users` table keyed by `sub`, with claims injected by the pre-token-generation Lambda. The pool resource carries `prevent_destroy` and `ignore_changes = [schema]`, and CI fails any plan that would replace it. If you think you need a custom attribute, you need a database column.
14. **Candidate files are never rendered inline.** Resumes are attacker-controlled. Presigned GET with `ResponseContentDisposition=attachment`, served from a separate subdomain, scanned before they leave quarantine. An inline-rendered HTML or SVG resume runs script in a recruiter's session with access to every candidate in the tenant. ARCHITECTURE §9.10.
15. **A rank-only update never bumps `version`.** Reordering within a column and moving between stages are separate repository writes. Bumping `version` on a reorder produces 409s on unrelated stage moves — flaky board behavior that looks like a race and isn't. ARCHITECTURE §6.1.
16. **Every outbox consumer is idempotent.** Delivery is at-least-once, keyed on `outbox.id`. A consumer that can't handle a duplicate is a bug, not a tuning problem.
17. **Terraform plans are reviewed, not skimmed.** A plan touching `aws_cognito_user_pool`, `aws_rds_cluster`, KMS keys, or state buckets stops and gets a human. Replacement of a stateful resource is never routine.

## 5. Sub-agents

Split work by boundary so agents don't collide on the same files. Configs live in `.claude/agents/`.

| Agent | Owns | Never touches |
|---|---|---|
| `schema` | `packages/db` — migrations, RLS policies, indexes | app code |
| `api` | `apps/api` module implementation + `packages/contracts` | UI, infra |
| `ui` | `apps/web` components and screens | api, db |
| `tokens-guard` | `packages/tokens`, reviews UI diffs for token violations and contrast regressions | feature logic |
| `infra` | `infra/terraform`, CI workflows | app code |
| `test` | `e2e/`, integration suites, fixtures | source under test |
| `reviewer` | Reads diffs against §4 and the spec. Explicitly checks: no `eslint-disable` on a boundary rule, no per-route auth hook, no `packages/db` import outside a `repository.ts`, no new route missing from the manifest test. Writes no code. | everything |

Rules for parallel work:
- Contracts first. `packages/contracts` and the migration land **before** `api` and `ui` agents start, so both build against a fixed schema.
- One agent owns a file. If two need the same file, serialize them.
- Every agent reports back against the spec's acceptance criteria, not "done."
- `reviewer` runs on every feature branch before the work is considered finished.

## 6. Testing

| Layer | Tool | Gate |
|---|---|---|
| Unit | Vitest (+ `fast-check` for the solver and lexorank) | domain logic |
| Integration | Vitest + Testcontainers (Postgres, Redis, LocalStack) | repositories, RLS, outbox, queue handlers |
| Tenant isolation | dedicated suite, runs every endpoint as a hostile tenant | **hard gate — must be 404 across the board** |
| Route manifest | Vitest, boots the app and walks every route | **hard gate — unprotected route fails CI** |
| Module boundaries | `eslint-plugin-boundaries`, `--max-warnings 0` | undeclared cross-module import fails the build |
| Contract | OpenAPI diff | breaking change fails the build |
| E2E | Playwright, page-object model, seeded per-run tenant, `storageState` per persona | the ten flows in ARCHITECTURE §10 |
| a11y | `@axe-core/playwright` inside the E2E run | AA violations fail CI |

Third-party boundaries (Google, Graph, SES, the auth provider) are stubbed at the network layer with route interception so the suite is deterministic. A nightly job runs the same flows against sandbox credentials.

### Verifying in Claude in Chrome

After the automated suite passes, drive the real UI in Claude in Chrome against a local or preview environment. Automated tests confirm the assertions someone thought to write; this catches what nobody thought to assert.

Per feature, walk it as the actual persona and check:
- Does it match the reference screen — spacing, weight, hue, alignment — not just "looks similar"?
- Interaction feel: does drag settle correctly, does the optimistic update ever flash the wrong state, is the loading state visible or does it flicker?
- Keyboard only, mouse untouched, end to end.
- The unhappy paths: permission-denied, empty column, network failure mid-drag, expired session, a stalled card.
- Two tabs side by side for anything concurrent — the kanban and the offer approval chain especially.

Record what you find as a delta list against the spec. Fix or file, never silently accept.

## 7. Commands

```bash
pnpm dev                 # web + api + workers
pnpm db:migrate          # apply migrations
pnpm db:seed             # seed tenant with the reference data (Maya, ENG-204, the 9 candidates)
pnpm test                # unit + integration
pnpm test:isolation      # tenant isolation suite
pnpm test:routes         # route manifest — every route protected or allow-listed
pnpm e2e                 # Playwright
pnpm tokens:build        # design-tokens.json → CSS vars + Tailwind theme
pnpm lint                # includes the no-raw-color rule
pnpm typecheck
terraform -chdir=infra/terraform/envs/dev plan | apply
```

Seed data mirrors the reference screens exactly. If a screenshot shows "Stalled 8d in stage" for Elena Ruiz, the seed produces that state — so visual comparison against the reference is always possible without hand-setup.

## 8. Shipping: PR → review → fix → merge

**Never commit or merge directly to `main`.** Every change lands through a pull request that has been reviewed and has had its findings addressed. This is not ceremony — the `reviewer` agent's checklist is the only thing that systematically catches the quiet failures in §4, and a change that skips it has skipped the tenancy, comp-scope, and boundary checks entirely.

The loop, in order:

**1. Branch.** `feat/NNN-slug` matching the spec number. One spec step per PR where the step is large enough to stand alone — a PR that spans three steps cannot be reviewed meaningfully.

**2. Open the PR.** The description states: which spec and which step, each acceptance criterion with how it was verified, anything deliberately out of scope, and any deviation from the spec with its reason. "Implements step 3" is not a PR description.

**3. Run the `reviewer` agent on the diff.** Not a general "review this" — the agent has a fixed checklist in `.claude/agents/reviewer.md` and must run every item. It writes no code; it reports findings grouped as **blocking**, **should fix**, and **consider**.

**4. Fix.** The owning agent addresses findings — `reviewer` never fixes its own findings, because an agent that edits what it reviews stops being a check.
   - Every **blocking** finding is fixed, or the rule it violates is explicitly amended in CLAUDE.md in the same PR. Never waved through.
   - **Should fix** items are fixed or answered in a PR comment saying why not.
   - **Consider** items are your call.

**5. Re-review** after the fixes. Findings introduce new code, and new code is unreviewed code. A second pass on the fix commits only — not the whole diff again.

**6. Merge** once CI is green and no blocking findings remain. Squash merge, conventional commit title referencing the spec: `feat(db): data layer and RLS policies (spec 001 step 3)`. Delete the branch.

**7. Update the spec** if reality diverged from it, in the same PR. A spec that lies is worse than no spec.

CI gates — `lint`, `typecheck`, `test`, `test:isolation`, `test:routes`, `e2e`, contrast check — are required checks on `main`, all blocking. A red gate is never merged around; if a gate is wrong, fix the gate in its own PR.

Where branch protection is available, turn it on: no direct pushes to `main`, required status checks, required linear history.

## 9. Conventions

- Conventional commits. Branch `feat/NNN-slug` matching the spec number.
- Cursor pagination, never OFFSET. Errors are RFC 9457 problem+json. Mutations accept `Idempotency-Key`.
- Writes return the full updated resource including its new `version`.
- `pnpm lint` runs `eslint .` directly rather than through Turbo — the boundary graph needs a whole-repo view and cannot be computed per package. This is deliberate; don't "fix" it by routing it through the Turbo pipeline.
- Comments explain *why*, not *what*. The scheduling solver and the lexorank rebalancer get real explanatory comments; a mapping function gets none.
- Don't add a dependency without saying what it replaces and why the platform's own answer isn't enough.