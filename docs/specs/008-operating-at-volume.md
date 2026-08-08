# Spec 008 — Operating at Volume

**Status:** draft, awaiting review
**Milestone:** M4 (Part A can land in M1)
**Depends on:** spec 001, spec 003 (board), spec 005 (candidate intake — imports write the same rows), spec 007 (the screens a search result navigates to)
**Blocks:** nothing

> **Renumbered from 005.** `005-job-and-candidate-creation.md` already exists, shipped in `7ba6caa`, and spec 007 cites it as a dependency. Two specs sharing a number would break those references and collide on `feat/NNN-slug` branch names (CLAUDE.md §8). Numbering is otherwise unchanged from the draft.

Three features bundled because they share one theme — acting on or finding many records at once — and one mechanism: the async job pattern in §4.

**They are otherwise independent and should ship as three PRs**, not one. Part A can land as soon as the board does; B and C can wait. Bundling them into a single PR would produce a diff nobody can review properly, which is how the expensive bugs get through.

---

## 1. Context and goal

A recruiter with 400 applications does three things Talon can't currently do: reject twelve candidates at once after a hiring-manager review, bring 500 candidates over from a spreadsheet, and find a person by name without remembering which job they're on.

**Part A — Bulk actions.** Board selection plus reject / move / tag / email.
**Part B — CSV import.** Candidate and application ingest with mapping, validation, and dedupe.
**Part C — ⌘K search.** Candidates, jobs, and actions in one ranked palette.

## 2. Scope

**In:** multi-select on the board with keyboard support; bulk reject with reason, move stage, add tag; CSV upload with column mapping, dry-run, error report, and duplicate strategy; command palette over candidates, jobs, and actions.

**Out:** bulk email send (needs the messaging module — M3); ATS-migration presets for specific vendors; saved searches; search filters/operators (`is:active`, `job:ENG-204`); bulk actions on the candidates list (board only for now); import of interviews, scorecards, or offers.

## 3. Sequencing note

**Part A changes the board's interaction model.** Multi-select has to coexist with drag: a click that starts a selection must not start a drag, and a drag on a selected card should move the whole selection. Retrofitting that into a board built purely for single-card drag is meaningfully more work than building it in.

So even if A ships later, **read §5.1 before the board is finalized** and leave room for it.

**Amendment — the board has already shipped.** Spec 003's board is merged, so this is now a retrofit rather than a warning. The keyboard path is dnd-kit's `KeyboardSensor` plus `boardCoordinateGetter` in `apps/web/src/lib/board-state.ts`; the `Space` mode switch in §5.1 is a sensor-wiring change, not a handler branch. Budget for that.

## 4. Shared: the async job pattern

Imports and bulk actions over ~50 items are async. One mechanism serves both.

```sql
create table jobs_async (              -- "job" is taken; this is a background task
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('import','bulk_action')),
  status text not null check (status in ('pending','running','succeeded','failed','partial')),
  total int, processed int not null default 0, failed int not null default 0,
  params jsonb not null, result jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now(), finished_at timestamptz,

  -- Non-negotiable #10: composite, not a plain `references users`. FK validation
  -- bypasses RLS, so a plain FK will happily point at another tenant's user row and
  -- Postgres will accept it. The pair is what makes that structurally impossible.
  constraint jobs_async_creator_fk
    foreign key (tenant_id, created_by) references users (tenant_id, id),

  -- Own uniqueness on the pair so children can reference it compositely too.
  constraint jobs_async_tenant_id_key unique (tenant_id, id)
);

alter table jobs_async enable row level security;
alter table jobs_async force row level security;   -- the owner is not exempt

create policy jobs_async_tenant on jobs_async
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
```

- Progress is written to Redis (`asyncjob:{id}`) and streamed to the client via SSE; the DB row is updated at batch boundaries, not per item.
- **`partial` is a first-class outcome**, not an error. Nineteen of twenty succeeding is the normal case and the UI must show which one didn't and why.
- Every async job writes an `audit_log` entry per affected entity, not one for the batch. An audit trail that says "bulk action affected 20 records" is not an audit trail.

### 4.1 Amendment — RLS and the worker

The DDL above adds what the draft omitted: an RLS policy, `force row level security`, and a composite FK. All three are non-negotiables (§4.1, §4.10), and a table carrying `tenant_id` without a policy is the exact shape of the bug those rules exist to prevent.

**The worker is the harder half.** `params` holds `applicationIds`, and the worker executes *later*, on a different connection, possibly after the enqueuing session is gone. Setting `app.tenant_id` inside the worker's transaction from `jobs_async.tenant_id` is therefore not a convenience — it is the only thing standing between a queued id list and a cross-tenant write. The worker reads the row, sets the GUC from it, and does all subsequent work inside that transaction. An integration test asserts a worker handed another tenant's `applicationIds` writes nothing.

### 4.2 Amendment — verify SSE through the rewrite before depending on it

The browser calls `/v1/*` on its own origin and `next.config.mjs` rewrites to the API (spec 001). Whether an SSE stream flushes through that rewrite rather than buffering is unverified, and the whole progress design rests on it.

**Task, before §6's UI is built:** stand up a trivial `/v1/_sse-probe` and confirm events arrive incrementally through the Next dev server *and* through a production build. If they buffer, the fallback is polling `GET /v1/async-jobs/:id` on an interval — less elegant, and it must be chosen deliberately rather than discovered during E2E.

## 5. Part A — Bulk actions

### 5.1 Selection model

- A checkbox appears on card hover and on focus; once anything is selected, all checkboxes stay visible.
- Click toggles. **Shift-click selects a range within a column** (ranges across columns are meaningless — the board is not a list).
- Column header gains "select all in column" once selection is active.
- Selection survives filtering but is **scoped to what's currently visible**: filtering to Screen then selecting all must not silently include hidden Applied cards. Show the count as "4 selected" and, when a filter is active, "4 selected (12 hidden by filter)".
- **Keyboard:** `Space` toggles selection on the focused card, `Shift+↑/↓` extends. This collides with the board's existing `Space` to lift for drag — resolve by mode: `Space` lifts when nothing is selected, toggles when selection is active. Document it in the keyboard legend, because an undocumented modal keybinding is a bug with good intentions.
- Selection clears on `Esc`, on navigation, and after an action completes.

### 5.2 Drag interaction

Dragging a **selected** card moves the entire selection. Dragging an **unselected** card clears the selection and moves just that card — the common case must not require deselecting first.

### 5.3 Actions

| Action | Behavior |
|---|---|
| Reject | Reason required. Confirmation dialog naming the count. Optional templated email deferred to M3 |
| Move to stage | Stage picker. Terminal stages require a reason, same as single moves |
| Add tag | Free text with autocomplete over existing tags |
| Email | **Deferred to M3.** Render disabled, not inert |

### 5.4 The API

```
POST /v1/applications/bulk
Idempotency-Key: <uuid>                 -- required, see below
{ applicationIds: [...], action: 'reject'|'move_stage'|'add_tag',
  params: {...}, expectedVersions: { [id]: number } }
```

Semantics that matter:

- **Per-item results, not all-or-nothing.** Response is `200` with `{ results: [{ id, status: 'ok'|'conflict'|'forbidden', error? }] }`. One stale version must not block the other nineteen — a recruiter who selected twenty cards should not have the whole action fail because someone else moved one.
- **Each item goes through the same service method as a single move** — non-negotiable #5. The bulk endpoint is a loop over the single-item service inside one transaction, not a second implementation with its own SQL. If bulk move and single move ever diverge, the transition log becomes untrustworthy.
- Conflicts return per item; the UI keeps those cards selected and shows what happened.
- Synchronous under 50 items; above that, returns a `jobs_async` id and streams progress.

**Amendment — `Idempotency-Key` is required, not optional.** CLAUDE.md §9 asks for it on mutations, and this is the endpoint where it earns its keep: `stage_transitions` is append-only (#4), so a retried bulk reject writes twenty duplicate transitions that cannot be deleted — only corrected by twenty more rows. A network timeout on a 20-item reject is an ordinary event, and the retry is what does the damage. Key is scoped `(tenant_id, idempotency_key)`; a replay returns the original per-item result set rather than re-executing.

### 5.5 Undo

Bulk reject gets an undo toast, 10 seconds. `stage_transitions` is append-only, so undo writes **new** transitions back to the prior stage — it never deletes. The activity timeline honestly shows both the reject and the undo, which is correct: it happened.

## 6. Part B — CSV import

### 6.1 Flow

```
1. Presigned PUT to S3         POST /v1/imports          → { uploadUrl, importId }
2. Analyze                     POST /v1/imports/:id/analyze
                               worker: sniff dialect + encoding, infer columns, sample 100 rows
3. Map columns                 UI, with per-tenant saved mappings
4. Dry run                     POST /v1/imports/:id/dry-run
                               → per-row validation report + downloadable error CSV
5. Commit                      POST /v1/imports/:id/commit
                               worker: batches of 500, one transaction per batch
6. Progress                    SSE from the async job (see §4.2 — verify the transport first)
```

**Dry run is not optional and not skippable.** An import that fails halfway through 500 rows with no preview is worse than no import feature.

### 6.2 Validation and dedupe

- Structural failure (unparseable, missing required columns) rejects the whole file before anything is written.
- Row-level failures are collected, not fatal. The error CSV is the original rows plus an `_error` column — so the fix-and-reupload loop works on the same file shape.
- **Duplicate matching:** exact email first; then `pg_trgm` similarity on `name + company` above 0.8. Fuzzy matches are **surfaced for confirmation, never merged silently.**
- Strategy chosen at import: skip / update / create-anyway.
- **Idempotency:** each row hashes `(import_id, row_index, natural_key)`. Re-running skips committed rows, so a retry after a crash resumes rather than duplicating.

### 6.2a Amendment — the error CSV is an injection sink

The error CSV is built from attacker-controlled cells and handed to a recruiter, who opens it in Excel. A cell whose value begins `=`, `+`, `-`, `@`, tab or CR is a **formula**, not text: `=cmd|'/c calc'!A1` is the textbook payload, and it executes on open with the recruiter's privileges. The uploaded file is untrusted by definition — that is the entire premise of an import feature.

**Rule.** Every cell written to any generated CSV — the error report and anything that follows it — is escaped: if the value starts with one of `= + - @ \t \r`, prefix a single quote. Quote and double any embedded `"`. This applies to the echoed original columns too, not only to `_error`, because the original columns are exactly where the payload arrives.

This is §4.17's reasoning about attacker-controlled resumes applied to a document *we* generate: the danger is not that we store the bytes, it is that something else executes them. One helper, used by every CSV writer, with a unit test per dangerous prefix.

### 6.2b Amendment — the upload is a candidate file

The uploaded CSV lands in S3 from an untrusted source, which puts it under §4.17 / ARCHITECTURE §9.10 alongside resumes: quarantine bucket, scanned before it is read, never served back inline. The download link for the error CSV is a presigned GET with `ResponseContentDisposition=attachment` from the separate file subdomain — not a link into the app origin.

### 6.3 The thing that will be got wrong

**An imported application must write a `stage_transition` creation row**, exactly as the seed does. An import that sets `current_stage_id` without history produces applications with no dwell time, breaking every funnel and median on the reports screen — silently, and only visible weeks later when the numbers look wrong.

Same rule as spec 001 §5.4. State without history is a lie.

Spec 007 shipped `/reports` reading exactly those funnels, so this is no longer hypothetical: the conversion panel and every median on that screen derive from `stage_transitions`, and an import without them makes the screen quietly wrong rather than visibly broken.

### 6.4 Encoding

Sniff for BOM and encoding; accept UTF-8, UTF-8-BOM, and Latin-1. Excel on Windows exports Latin-1 with a BOM by default, and this is the single most common real-world import failure. Reject with a clear message rather than importing mojibake.

## 7. Part C — ⌘K search

### 7.1 Behavior

- `⌘K` / `Ctrl+K` from anywhere. Empty query shows recents (last 10 viewed, per user, in Redis).
- Groups: **Candidates**, **Jobs**, **Actions**. Each row: icon, primary label, dim context ("Senior Product Engineer · Onsite").
- Keyboard-only: arrows navigate, `Enter` opens, `Esc` closes, `Tab` cycles groups.
- Debounce 150ms; abort in-flight requests on new input — otherwise a slow earlier response overwrites a fast later one and the list flickers backwards.

**Amendment — this closes spec 007 OQ-1 and makes two shipped decorations real.** `app-shell.tsx` currently renders the topbar search field and the ⌘K chip as pictures, and says so: *"the search field and the bell are pictures, not controls."* Part C is what turns them into controls. It also answers spec 007 OQ-1 — whether `/candidates` should have been search-first — with **both**: the list stays, and the palette becomes the fast path. Update OQ-1 to resolved when this lands.

### 7.2 Implementation

```
GET /v1/search?q=&limit=20
```

- Postgres `tsvector` on candidates (name, email, current title, company) plus `pg_trgm` for fuzzy name matching. No OpenSearch — ARCHITECTURE §11 sets the trigger for that, and you are far from it.
- **Permission filtering happens before ranking, never after.** Filtering after ranking means a page of 20 can come back with 3 visible results while relevant matches sit unreturned. RLS handles tenant scope automatically; role scope (a hiring manager sees only their jobs) is a WHERE clause in the query, not a filter over results.
- Ranking: text rank × recency decay, with exact-prefix matches boosted. Jobs rank above candidates on ties — a recruiter typing "senior" usually wants the req.
- Target p95 under 150ms for 100k candidates.

**Amendment — "before ranking" means the same statement, not an earlier one.** The role-scope predicate belongs in the same `SELECT` as the rank and the `LIMIT`. A subquery that ranks, limits, then filters is the failure this rule names; so is filtering in the service after the repository returns rows. Reviewers should look for `LIMIT` appearing before the permission predicate in the plan, not merely for the predicate existing.

### 7.3 Actions

Static, filtered by permission: "Create job", "Import candidates", "Go to reports", "Go to review inbox". Non-navigational actions are deferred until the features exist — **disabled, not inert**.

All four destinations now exist: `/jobs/new` (spec 005), `/reports` and `/review-inbox` (spec 007), and "Import candidates" once Part B lands.

## 8. Edge cases

1. Selection includes a card another user just moved → per-item conflict, that card stays selected with an explanation.
2. Select-all with an active filter → count states hidden items explicitly.
3. Bulk move to a terminal stage → reason required, same as single.
4. Undo window expires mid-click → no-op with a message, not a silent failure.
5. CSV with 200 columns → mapping UI stays usable; unmapped columns are ignored, not errors.
6. CSV row with an email matching a candidate in **another** tenant → no match. RLS makes this automatic; a test asserts it.
7. Import commits while a bulk action runs on the same applications → row-level locks; the later one sees fresh versions.
8. Search query matching 50k candidates → limit plus cursor; never count exhaustively for a UI that shows 20.
9. Search for a candidate on a job the user can't see → not returned at all, not returned-and-hidden.
10. `⌘K` while a modal is open → palette takes precedence; `Esc` returns to the modal.
11. Import file deleted from S3 between analyze and commit → clear error, job marked failed, resumable by re-upload.
12. Two imports of the same file concurrently → idempotency hash makes the second a no-op.
13. **A cell in the uploaded CSV begins `=`, `+`, `-` or `@`** → imported as literal text, and escaped with a leading `'` in any generated CSV (§6.2a). Asserted per prefix.
14. **A worker picks up a `jobs_async` row whose `params` name another tenant's applications** → the worker sets `app.tenant_id` from the job row, so the ids resolve to nothing and the job finishes having written nothing (§4.1).
15. **A bulk request is retried with the same `Idempotency-Key`** → the original per-item results are replayed; no second set of transitions (§5.4).
16. **SSE buffers through the Next rewrite** → progress falls back to polling; chosen deliberately at §4.2, not discovered in E2E.

## 9. Test plan

| Layer | Covers |
|---|---|
| Unit | Selection reducer (range, filter interaction, mode switching); CSV dialect and encoding sniffing; ranking function; **CSV cell escaping, one case per dangerous prefix** |
| Integration | Bulk endpoint per-item results including mixed success/conflict; import idempotency on re-run; **imported applications have creation transitions**; search permission filtering as a hiring manager; **idempotent replay of a bulk request**; **a worker given another tenant's ids writes nothing** |
| Integration | Import of a 50k-row file completes, reports progress, and doesn't block the API |
| **Tenant isolation** | **`/v1/applications/bulk`, `/v1/imports/*`, `/v1/search` as a hostile tenant — 404 across the board. Hard gate (CLAUDE.md §6); search is where a leak reads as a ranking quirk rather than a breach** |
| **Route manifest** | **Every new route present and protected. Hard gate — a new route is covered by being registered in the authenticated scope, and this is what proves it was** |
| E2E | Select 4 cards → bulk reject with reason → undo → verify state and timeline; import 500 rows with 12 bad → error CSV correct, only good rows committed; ⌘K → candidate → profile |
| a11y | Selection reachable by keyboard; palette fully keyboard-operable; axe clean |
| Load | Search p95 under 150ms at 100k candidates; 50k-row import |

## 10. Open questions

1. **Does bulk reject send rejection emails?** Assumed no in M4 — messaging is M3, and sending twelve rejections by accident is unrecoverable. Confirm.
2. **Should import create *applications* or only *candidates*?** Assumed both, with a target job column. Candidates-only is simpler and less useful.
3. **Undo window length?** Assumed 10s. Longer is friendlier and complicates the audit story.
4. **Does search cover activities and notes?** Assumed no. The draft's reason was index shape; the stronger one is §4.2 — notes can contain comp discussion, and comp is scope-gated at the API layer. A search index over notes is a second read path that would need its own gate, and a snippet in a result row is a disclosure the gate never sees.
5. **Where does the import's target job come from?** A column per row, or one job chosen for the whole file? Per-row is more flexible and makes every row's validation depend on a lookup; whole-file is simpler and cannot express a mixed spreadsheet. Assumed per-row column with a whole-file default.
6. **Does the mapping UI persist per tenant or per user?** §6.1 says per-tenant. Two recruiters importing from different sources would then fight over one saved mapping. Confirm, or make it per-user with a tenant-level default.

## 11. Definition of done

- [ ] Selection works by pointer and keyboard, coexists with drag, and states hidden-by-filter counts
- [ ] Bulk endpoint returns per-item results; a mixed success/conflict batch is tested
- [ ] Bulk and single moves provably share one service method
- [ ] Bulk endpoint is idempotent under replay of the same key
- [ ] Undo writes new transitions rather than deleting
- [ ] `jobs_async` has RLS, `force row level security`, and a composite creator FK
- [ ] A worker handed another tenant's ids writes nothing — asserted
- [ ] Import: dry run, error CSV, dedupe confirmation, idempotent re-run
- [ ] **Imported applications carry creation transitions** — asserted by a test
- [ ] **Generated CSV cells are escaped against formula injection** — asserted per prefix
- [ ] Latin-1-with-BOM Excel export imports correctly or fails with a clear message
- [ ] Search filters by permission before ranking, verified as a hiring manager
- [ ] Tenant-isolation and route-manifest gates cover every new route
- [ ] Palette fully keyboard-operable; p95 under 150ms at 100k
- [ ] Three PRs, three reviews
