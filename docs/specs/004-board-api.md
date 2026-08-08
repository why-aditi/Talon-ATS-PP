# Spec 004 — Board API

**Status:** approved 2026-08-08 · **Owner:** api stream · **Branch:** `feat/004-board-api`
**Sources:** PRD §5.4 · ARCHITECTURE §5, §6.1, §7 · `.claude/agents/api.md` · `packages/db/test/metrics.test.ts` · spec 003 (the client this serves)

---

## 1. Context and goal

Spec 003 shipped the pipeline board against MSW fixtures with a mock that enforces real semantics. This replaces the mock with the endpoints, so the board reads and writes the database.

**The job:** three endpoints — read the board, move an application between stages, reorder within a stage — with the column statistics derived from `stage_transitions` rather than from whatever happens to be in the column, and with the two 409 classes kept distinct.

**Why the mock is the specification.** `apps/web/src/mocks/pipeline-handlers.ts` already implements these routes and is covered by tests the UI depends on. Where this spec and that mock disagree, one of them is wrong and it gets resolved here, not papered over with an adapter.

---

## 2. Scope

### In
- `GET /v1/jobs/:jobId/board`
- `PATCH /v1/applications/:id/stage`
- `PATCH /v1/applications/:id/rank`
- `packages/contracts/src/pipeline.ts` — the real schemas, migrated from the UI's provisional file
- `packages/domain/lexorank.ts` — `between`, `rebalance`, with `fast-check` properties
- `outbox` table (§3) — **prerequisite, lands first**
- `nextAction` derivation (§5)

### Out
| Excluded | Why |
|---|---|
| SSE / realtime | ARCHITECTURE §6.1; needs the relay |
| Bulk actions | Spec 005+ |
| Terminal-stage reason modal | Spec 003 OQ-1; the API accepts `reason`, the UI does not send it yet |
| Scorecards, `scoreAvg` | No table; spec 003 OQ-2 territory |
| Candidate skills | No table; spec 003 OQ-2 |
| Rebalance **scheduling** | The path exists and is tested; nothing calls it yet |
| Idempotency-Key store | §9 OQ-3 |

---

## 3. Data model changes — **`outbox`, and it lands first**

`api.md`: *"If the schema you need doesn't exist yet, stop — `schema` goes first."* There is no `outbox` table in `packages/db`, and ARCHITECTURE §6.1 requires every successful move to insert one **in the same transaction as the state change**. Nothing else in this spec can be built correctly without it.

Shipped as **`0006_outbox`** — not 0004: `0004_users_external_id` already exists on main from the identity stream, and two migrations sharing a number makes ordering depend on alphabetical luck.

See `packages/db/migrations/0006_outbox.up.sql` for the DDL. Three decisions worth naming:

- **`id` is `bigserial`, not `uuid`.** Delivery is at-least-once and consumers are idempotent keyed on it (non-negotiable #19), so it has to be a total ordering as well as unique.
- **No `unique (aggregate_id, event_type)`.** One application legitimately produces many `ApplicationStageChanged` events. Deduplication is the consumer's job.
- **Append-only for `talon_app`** — `select, insert`, the same treatment `stage_transitions` and `audit_log` get. Only the relay stamps `published_at`, as its own role. That role is *not* created here: migrations never create roles (non-negotiable #11), and `talon_relay` needs `bypassrls` because a poller that could only see one tenant would never drain the table.

**Found by writing the test, not by review:** `0001`'s `grant usage, select on all sequences in schema public` is a **point-in-time** grant and does not reach a sequence created by a later migration. Without an explicit `grant ... on sequence outbox_id_seq`, the app role has INSERT and still fails with `permission denied for sequence outbox_id_seq` — which would have broken every stage move, since the outbox insert shares their transaction. Any future migration adding a table with a sequence needs the same line.

`packages/db/test/outbox.test.ts` covers tenant isolation in both directions (`using` and `with check`), the append-only grants, and the shape the relay depends on.

Rollback: `drop table outbox`. No backfill — there is no history to replay, and inventing one would publish events for transitions that already happened.

---

## 4. Column statistics — derived, and the subtle part

Both figures come from `stage_transitions`. **The cards currently in a column are not the population** — they have incomplete dwells and would produce a different number, which is exactly the bug spec 003 §5.2 exists to prevent on the client side.

### 4.1 Median time in stage

Median of **completed** dwells for that stage: entered → left, across every application on the job.

```sql
-- The earliest exit AFTER each entry. A naive self-join on
-- (nxt.from_stage_id = ent.to_stage_id) pairs entry #1 with EVERY later exit, so an
-- application that re-entered a stage — which is legal, because stage_transitions is
-- append-only and "a correction is a new row" (non-negotiable #4) — inflates the
-- median. The ENG-204 seed has no re-entries, so `metrics.test.ts` passes either way
-- and the bug is invisible there.
select js.canonical,
       percentile_cont(0.5) within group (order by extract(epoch from (exit_at - ent.occurred_at)))::float8 / 86400
         as median_days
from stage_transitions ent
join job_stages js on js.id = ent.to_stage_id and js.job_id = $1
cross join lateral (
  select min(nxt.occurred_at) as exit_at
  from stage_transitions nxt
  where nxt.application_id = ent.application_id
    and nxt.from_stage_id  = ent.to_stage_id
    and nxt.occurred_at    > ent.occurred_at
) x
where x.exit_at is not null
group by js.canonical
```

**Null on a terminal stage**, and null when nobody has left yet — nobody leaves Hired, so no completed dwell exists. The UI renders `closed` for null (spec 003 §6.2).

### 4.2 Pass rate

`count(distinct applications that ever reached S) / count(all applications on the job)`.

**This is a cumulative reach rate — funnel depth — not a stage-to-stage conversion.** It is worth stating because PRD §5.4 calls it a "conversion rate", the label reads `% pass`, and both suggest a different formula. A stage-to-stage conversion on ENG-204 computes to 56/60/67/50 and would not put Applied at 100%. The agreed figures are **100 / 56 / 33 / 22 / 11**, pinned by `metrics.test.ts:121` and already rendered by the merged board.

`distinct` matters for the same re-entry reason as above. The denominator is every application on the job including rejected and withdrawn — they reached those stages, and a funnel that drops them overstates every rate.

### 4.3 One query, not seven

Both aggregates are computed for all stages in a single statement per board load. Seven correlated aggregates per request is the shape to avoid; `stage_transitions_tenant_to_stage_idx (tenant_id, to_stage_id, occurred_at)` covers the reach count. **The lateral needs `(application_id, from_stage_id, occurred_at)`** and the only comparable index is `(tenant_id, application_id, occurred_at)`, which does not cover `from_stage_id` — see §9 OQ-1.

---

## 5. `nextAction` — defined

The board renders one on every card and nothing produced it; spec 003 invented it in the fixture. Defining it is the price of removing that invention.

**The verb comes from the canonical stage and is available today. The qualifier comes from subsystems that do not exist yet.**

| Canonical | Today | With scheduling / offers |
|---|---|---|
| `applied` | `Review` | `Review` |
| `screen` | `Call` | `Call Tue` — day of the scheduled screen |
| `onsite` | `Loop` | `Loop Thu` — day the loop starts |
| `offer` | `Offer out` | `Offer out` |
| `hired` | `Hired` | `Starts Sep 1` — accepted offer's start date |
| `rejected` | `Rejected` | `Rejected` |
| `withdrawn` | `Withdrawn` | `Withdrawn` |

Lives in `packages/domain` as `nextActionFor(canonical, qualifier?)` — a pure function, no I/O — so the qualifier can be threaded in when interviews and offers land without the shape changing.

**Recorded delta:** 5 of the 9 reference cards reproduce exactly (`Review` ×4, `Offer out`). Four lose their qualifier — Elena `Call Tue` → `Call`, Marcus `Call Mon` → `Call`, Ana `Loop Thu` → `Loop`, David `Starts Sep 1` → `Hired`. That is a visible regression against the reference screen and it is deliberate: the alternative is the endpoint returning a value it cannot derive.

---

## 6. API contract

Migrated from `apps/web/src/mocks/pipeline-contract.ts` into `packages/contracts/src/pipeline.ts`. The shape is honoured; three changes, each with a reason.

1. **`skills` and `scoreAvg` are dropped.** No `candidate_skills` table, no scorecards table. Fields the endpoint cannot populate do not belong in the contract. The UI drops the tag and the chip in the migration commit.
2. **`nextAction` stays**, now derived (§5).
3. **`fromStageId` is required** on the move body. Already correct in the merged provisional file.

`ERROR_TYPES` gains `STAGE_VERSION_CONFLICT` and `STAGE_MOVED` (spec 003 OQ-3).

### 6.1 `PATCH /v1/applications/:id/stage`

Body `{ fromStageId, toStageId, beforeId?, afterId?, version, reason? }`.

| Condition | Status | `type` |
|---|---|---|
| Success | `200` — full card, new `version` | — |
| `from_stage_id` mismatch | `409` **regardless of version** | `urn:talon:error:stage-moved` |
| `version` mismatch | `409` | `urn:talon:error:stage-version-conflict` |
| Unknown / other tenant / other job's stage | `404` | `urn:talon:error:not-found` |

From-stage is checked **first and answered regardless of version**: silently re-applying a stage change over someone else's move corrupts the append-only transition log, which is worse than a stale read.

**ARCHITECTURE §6.1's code block is wrong and is corrected in this PR.** Its prose requires `from_stage_id`; the block beneath omits it, which makes the second 409 undetectable. Raised in spec 003 §4.3, fixed here.

On success, **one transaction**: insert `stage_transitions`, update `current_stage_id` + `stage_entered_at` + `board_rank`, bump `version`, insert `activities`, insert `outbox`. The version check is a **conditional update** (`where version = $n`), never read-then-write — two concurrent moves both pass a read.

### 6.2 `PATCH /v1/applications/:id/rank`

Body `{ beforeId?, afterId? }`. Last-write-wins. Touches `board_rank` and `updated_at` **only**.

**No `version` in, none out** (non-negotiable #18). Two routes rather than one with an optional field, so there is no code path on which a reorder reaches the version-bumping write. `beforeId` wins when both resolve.

### 6.3 One service method

`ApplicationsService.moveStage` is the single entry point (non-negotiable #5). The review inbox's advance action calls **this**, not a second implementation. It has no second caller yet, which is the only reason the rule can't be demonstrated rather than asserted — recorded so the inbox does not reimplement it.

---

## 7. Permissions

Tenancy is the plugin-scope hook chain; no per-route auth, ever. Cross-tenant reads return **404, not 403**. The composite FK `(job_id, current_stage_id) → job_stages (job_id, id)` already makes a cross-job stage move structurally impossible — but the service validates first so it surfaces as a 404 rather than a constraint violation escaping as a 500.

No comp fields on this surface. `scoreAvg` is out of scope entirely, so scorecard blindness (#3) has nothing to gate here yet.

---

## 8. Edge cases

1. **Reorder twice, then move stage with the original `version`** — succeeds. The point of #18.
2. Re-entry to a stage: median uses the earliest exit after each entry (§4.1).
3. `beforeId`/`afterId` naming a card that has since moved or been deleted → fall back to the other, then to append. Never a 500.
4. Both neighbours null → append.
5. Adjacent lexorank keys → `between` extends length rather than returning a duplicate.
6. Move to a terminal stage **without** `reason` → `422`. Not reachable from the UI yet.
7. Empty column, empty job, job with no stages.
8. Cross-tenant application id → 404.
9. A stage id belonging to another job → 404.
10. `version` in the future (client ahead of server) → treated as a mismatch, 409.
11. Board with 2000 applications — see §9 OQ-2.

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | The median lateral keys on `(application_id, from_stage_id, occurred_at)`; the existing index is `(tenant_id, application_id, occurred_at)`. Needs measuring on a realistic row count before adding an index. | schema |
| OQ-2 | **The board has no pagination.** PRD §5.4 says it renders 200 cards; a busy job has thousands. The nine-candidate fixture hides this completely. Needs a per-column cap and a load-more story. | Aditi |
| OQ-3 | `Idempotency-Key` is required by `api.md` and CLAUDE.md §9 and has no implementation anywhere. `version` already blocks a double-applied stage move, and `/rank` is last-write-wins, so the header is accepted and ignored for now. | api |
| OQ-4 | `stage_entered_at` drift check. ARCHITECTURE §5 promises a nightly job asserting it agrees with `stage_transitions`. Not built. | api |
| OQ-5 | `daysInStage` is elapsed days (`floor(age/86400)`), matching `metrics.test.ts` — not calendar days in the viewer's zone. A recruiter in Sydney may count differently (#7). | Aditi |

---

## 10. Test plan

1. **Reorder twice, then a stage move on the original `version` — succeeds.** `version` unchanged by both reorders.
2. Both 409s, distinguished; from-stage mismatch 409s **with a matching version**.
3. One transaction: on a forced failure after the transition insert, nothing is committed — no orphan `outbox` row, no bumped `version`.
4. ENG-204 stats from the real query equal **100/56/33/22/11** and medians **2/4/6/3** — the same numbers `metrics.test.ts` pins.
5. Re-entry fixture: an application that leaves and re-enters `screen` does not inflate the median.
6. Tenant isolation: every route as a hostile tenant returns 404.
7. Route manifest: all three routes inside the authenticated scope.
8. `fast-check`: `between(a, b)` is always strictly between, never equal to either, and total over adjacent keys.
9. Contract snapshot matches the merged UI's expectations.

---

## 11. Build order

| Step | Deliverable |
|---|---|
| 1 | ✅ **`0006_outbox` migration** (§3) — landed, 78 db tests green |
| 2 | `packages/domain`: lexorank + `nextActionFor`, with property tests |
| 3 | `packages/contracts/src/pipeline.ts` + the two error types |
| 4 | `applications/repository.ts` — board read, the stats query, `updateRank`, `moveStage` |
| 5 | `applications/service.ts` — the single `moveStage`, transaction boundary, both 409s |
| 6 | `applications/routes.ts`, `events.ts` |
| 7 | Integration + isolation tests |
| 8 | UI migration: import from `@talon/contracts`, drop `skills`/`scoreAvg`, delete the mock handlers |
