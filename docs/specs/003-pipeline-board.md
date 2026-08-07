# Spec 003 — Pipeline board (kanban)

**Status:** approved 2026-08-08 · **Owner:** ui stream · **Branch:** `feat/003-pipeline-board`
**Sources:** PRD §5.4 · ARCHITECTURE §6.1 · DESIGN_SYSTEM §3, §4 (PipelineBoard) · `docs/reference/03-pipeline-kanban@2x.png` · CLAUDE.md §4 non-negotiables 5, 14, 15, 18

---

## 1. Context and goal

Build the ENG-204 pipeline board as a real, interactive screen against MSW fixtures. The board is the product's centre of gravity — it is where a recruiter spends the day, and it is the screen every other one refers back to.

**Why now:** the jobs list (spec 001 step 5) proved the token pipeline, the AppShell, and the five-state discipline against a live endpoint. The board is the first screen with genuine interaction model risk — drag, keyboard, optimistic writes, concurrency — and that risk is worth isolating *before* the API exists, so the interaction is settled by the time there is a server to argue with.

**The job, in one sentence:** render ENG-204's five stage columns with their nine seeded candidates, and make a candidate move between stages by mouse or by keyboard with an optimistic update that correctly survives both kinds of 409.

**No API integration.** `PATCH /v1/applications/:id/stage` and `/rank` do not exist. The MSW layer implements them to the contract below so the client is written against real semantics, not a stub that always says yes.

---

## 2. Scope

### In
- Route `/jobs/[jobId]/pipeline`, with the sidebar's Pipeline item active.
- Five columns — Applied, Screen, Onsite, Offer, Hired — with count, pass rate, median time in stage, and the stage-hue progress rule.
- Nine candidate cards, matching the reference in content and treatment.
- Elena Ruiz's stalled treatment: colour + weight + left edge.
- Drag to move between stages and to reorder within a stage.
- A complete keyboard path that does not depend on drag.
- Optimistic move with rollback, distinguishing the two 409 causes.
- Rank-only reorder that does **not** bump `version` (non-negotiable #18), modelled in the mock.
- Free-text, stage, source and recruiter filters, and the sort control — all as pictured.
- Horizontal board scroll with per-column vertical scroll and non-scrolling headers.
- All five states: default, loading, empty, error, permission-denied — plus per-column empty and empty-because-filtered.

### Out
| Excluded | Why | Follow-up |
|---|---|---|
| Bulk select (reject / move / tag / email) | Not this PR's shape | Spec 004 |
| Card detail drawer | Not this PR's shape | Spec 005 (candidate profile) |
| Real API integration | Endpoints do not exist | Spec 004 (api stream) |
| SSE / realtime board updates | Requires the API and the outbox relay | ARCHITECTURE §6.1; follows the endpoint |
| Terminal-stage reason prompt | Modal work, deliberately deferred | **§9 OQ-1 — drops into terminal columns are blocked until it lands** |
| Filters beyond the four pictured | Out of scope by instruction | — |
| Lexorank rebalancing | Server-side background job | ARCHITECTURE §6.1 |
| The three non-Pipeline tabs | Separate screens | Specs 005+ |

---

## 3. Data model changes

**None.** No migration, no rollback, no backfill. `packages/db` is untouched by this spec.

The tables this screen will eventually read already exist from spec 001: `applications` (`current_stage_id`, `stage_entered_at`, `board_rank`, `source`, `status`, `version`), `candidates`, `job_stages` (`sla_days`, `is_terminal`, `position`), `stage_transitions`.

**One gap recorded, not filled:** there is no home for candidate skills. The reference shows `Go`, `React`, `TypeScript`, `Platform` on cards; nothing in the schema stores them. This spec invents them in the fixture and files the real modelling as **§9 OQ-2**.

---

## 4. API contract

These routes do not exist yet. This section is the contract the MSW layer implements and the api stream inherits.

### 4.1 Schema location — approved deviation from CLAUDE.md §5

CLAUDE.md §5 requires `packages/contracts` to land before the ui stream builds. It does not here, deliberately.

`packages/contracts` is owned by the `api` agent, and a parallel session is working in that tree. The rule exists so that two agents building against one schema cannot drift — but there is exactly one consumer of this schema today, and cross-session file contention is a real cost against a theoretical benefit.

So the Zod schemas live in `apps/web/src/mocks/pipeline-contract.ts`, with a header comment marking them for a single-commit migration into `packages/contracts/src/pipeline.ts` when the api stream picks up the endpoint. **The handlers validate their own responses against these schemas**, exactly as `mocks/handlers.ts` does for `GET /v1/jobs` — that is the property that stops a fixture drifting from the shape the screen is built against, and it is preserved regardless of which package the schema sits in.

### 4.2 `GET /v1/jobs/:jobId/board`

```jsonc
{
  // The board is job-scoped and carries the job's own header. A second request for
  // four strings would put the page header and the columns on different loading
  // clocks — a guaranteed flash of a half-rendered screen.
  "job": {
    "id": "0198f3a2-0001-7000-8000-000000000001",
    "title": "Senior Product Engineer",
    "reqCode": "ENG-204",
    "status": "active",
    "location": "Remote (US)",
    "recruiter": { "id": "…", "name": "Maya Reyes" }
  },
  "columns": [
    {
      "stageId": "…",
      "name": "Applied",
      "canonical": "applied",
      "position": 0,
      "slaDays": null,          // null → the stage cannot stall
      "isTerminal": false,
      "count": 4,
      "stats": { "passRatePct": 100, "medianDaysInStage": 2 },
      "cards": [ /* ApplicationCard, already ordered */ ]
    }
  ]
}
```

`ApplicationCard`:

```jsonc
{
  "id": "…",                       // application id
  "candidateId": "…",              // avatar hue hashes off THIS, not the application id
  "name": "Elena Ruiz",
  "currentTitle": "Backend Engineer",
  "currentCompany": "Cove",
  "source": "outbound",            // enum, not a display string
  "skills": ["Go"],
  "status": "active",              // active | hired | rejected | withdrawn
  "daysInStage": 8,
  "nextAction": "Call Tue",
  "scoreAvg": null,                // number | null; omitted entirely when out of scope
  "version": 3
}
```

**`boardRank` is deliberately not on the wire.** An earlier draft of this section carried it. The client never reads it: cards arrive ordered, reordering splices the local array, and both mutations name neighbours by **id**, not by rank. Lexorank is how the server keeps an insert to a single-row update (ARCHITECTURE §6.1) — shipping it to a client that has no use for it would be a field to keep in sync for nothing. Removed during step 0.

### 4.3 `PATCH /v1/applications/:id/stage`

Body: `{ fromStageId, toStageId, beforeId?, afterId?, version, reason? }`. Returns the full updated card including its new `version` (CLAUDE.md §9).

**ARCHITECTURE §6.1 contradicts itself here, and this spec follows its prose.** The prose says "the move request carries the application's `version` and its `from_stage_id`". The code block directly beneath shows `{ toStageId, beforeId, afterId, version, reason? }` — no `fromStageId`.

The prose is right and the code block is wrong. Without `fromStageId` the server cannot know which stage the client *believed* the card was in, so "someone else already moved it" is undetectable independently and collapses into the version check — exactly the collapse §6.1 spends a paragraph forbidding, on the grounds that silently re-applying a stage change corrupts the append-only transition log. Surfaced in step 0; **ARCHITECTURE §6.1's code block should be corrected — owner: api.**

| Condition | Status | `type` | Client behaviour |
|---|---|---|---|
| Success | `200` | — | Reconcile optimistic card with the returned resource |
| `version` mismatch | `409` | `urn:talon:error:stage-version-conflict` | Roll back, refetch **the destination column** |
| `from_stage_id` mismatch | `409` | `urn:talon:error:stage-moved` | Roll back, refetch **both columns**, *regardless of `version`* |
| Terminal destination without `reason` | `422` | `urn:talon:error:reason-required` | Not reachable this PR — drops are blocked client-side (§9 OQ-1) |
| Unknown application | `404` | `urn:talon:error:not-found` | Roll back, refetch board |

The two 409s are **different failures and must not be collapsed into one handler.** A version mismatch means the card changed under you; re-reading it is enough. A from-stage mismatch means someone already moved it to a different stage, and silently re-applying your stage change corrupts the append-only transition log — which is why it 409s even when the version happens to match.

Both carry the current server state in the problem body under `current`, so the client can reconcile without a second round trip:

```jsonc
{
  "type": "urn:talon:error:stage-moved",
  "title": "Elena Ruiz has already moved",
  "status": 409,
  "detail": "Elena Ruiz is now in Onsite.",
  "current": { /* ApplicationCard */ },
  // `current` alone does not say WHERE the card is, and the client names the stage in
  // its own sentence rather than rendering the server's `detail` verbatim.
  "currentStageName": "Onsite"
}
```

Two new `ERROR_TYPES` entries are required (`STAGE_VERSION_CONFLICT`, `STAGE_MOVED`) and ride along with the §4.1 migration. Until then they are declared in `pipeline-contract.ts`. Per the `errors.ts` docstring, the client treats an unknown `type` as a generic error and stays correct — so shipping the UI ahead of the enum entry is safe by design.

### 4.4 `PATCH /v1/applications/:id/rank`

Body: `{ beforeId?, afterId? }`. **Carries no `version` and returns no new one.**

Last-write-wins. Position is not worth a conflict dialog (ARCHITECTURE §6.1). This route exists as a route *separately from* `/stage` precisely so that non-negotiable #18 is structural rather than conditional — there is no code path on which a reorder can reach the version-bumping write.

### 4.5 Mock scenarios

`_scenario` follows the `mocks/handlers.ts` precedent: mock-only, never sent outside development.

| `_scenario` | Produces |
|---|---|
| *(absent)* | The nine seeded candidates |
| `empty` | A job with all five columns present and zero cards |
| `slow` | `delay('infinite')` — holds loading open for screenshot and axe |
| `error` | `500` problem+json |
| `forbidden` | `scoreAvg` omitted from every card (see §7) |
| `conflict-version` | Next `/stage` PATCH returns the version-mismatch 409 |
| `conflict-stage` | Next `/stage` PATCH returns the from-stage-mismatch 409 |

---

## 5. Fixture data

Derived from `packages/db/src/seed.ts`, **not** read off the reference screen. Where they disagree the seed wins — the screen is a picture, the seed is what the API will aggregate.

### 5.1 The nine candidates

| Candidate | Title / company | Stage | Days | Source | Skills | Score | Next action |
|---|---|---|---|---|---|---|---|
| Tess Bianchi | Frontend Engineer at Halo | Applied | 4 | `agency` | — | — | Review |
| Omar Haddad | Platform Engineer at Trellis | Applied | 3 | `careers_page` | — | — | Review |
| Jordan Cole | Fullstack at Beacon | Applied | 2 | `careers_page` | — | — | Review |
| Priya Nair | SWE II at Loft | Applied | 1 | `referral` | — | — | Review |
| **Elena Ruiz** | Backend Engineer at Cove | Screen | **8** | `outbound` | Go | — | Call Tue |
| Marcus Webb | SWE at Northwind | Screen | 5 | `outbound` | TypeScript | — | Call Mon |
| Ana Petrova | Senior SWE at Meridian | Onsite | 3 | `referral` | React, Go | 4.2 | Loop Thu |
| Sofia Lindqvist | Staff Eng at Polar | Offer | 1 | `outbound` | Platform | 4.6 | Offer out |
| David Kim | Sr SWE at Argo | Hired | 0 | `referral` | — | — | Starts Sep 1 |

### 5.2 Column statistics — **do not derive these from the visible cards**

This is the single easiest thing to get wrong on this screen, and getting it wrong is silent.

`medianDaysInStage` is the median of **completed** dwells — candidates who have *left* that stage — computed over all nine histories. The four Applied cards you can see (4d, 3d, 2d, 1d) contribute nothing to Applied's median and would produce 2.5d if naively reduced. The real value is 2d, from the five candidates who exited Applied.

`passRatePct` is `count(distinct applications that ever reached this stage) / total applications on the job`, per `packages/db/test/metrics.test.ts:121`.

| Column | Count | Pass % | Median | Derivation |
|---|---|---|---|---|
| Applied | 4 | 100 | 2d | 9/9 reached; exits at 2,2,2,2,2 |
| Screen | 2 | 56 | 4d | 5/9 reached; exits at 4,4,4 |
| Onsite | 1 | 33 | 6d | 3/9 reached; exits at 6,6 |
| Offer | 1 | 22 | 3d | 2/9 reached; one exit at 3 |
| Hired | 1 | 11 | *(none — renders `closed`)* | 1/9 reached; terminal, no exits |

The fixture carries these as explicit values on each column. It does not compute them, because a fixture that recomputes them from four cards would be reproducing the bug this section exists to prevent.

### 5.3 Recorded delta from the reference screen

**The reference shows 100% / 42% / 21% / 8%. This board renders 100% / 56% / 33% / 22%.**

Those pictured percentages are the ratios of a **38-application** population (16/38 = 42%, 8/38 = 21%, 3/38 = 8%) — which agrees with the "38 active" cell for ENG-204 on `02-jobs-list@2x.png`, and disagrees with the nine cards drawn beside it on its own screen. Two internally consistent readings of the same job.

Spec 001 open question 5, answered 2026-08-07, resolved this **toward the board**: nine candidates, no filler, real derived values, discrepancy recorded rather than closed by inventing rows. `metrics.test.ts:121` already asserts 100/56/33/22. Hard-coding the pictured percentages would make this board a picture that disagrees with its own API on the day the endpoint lands.

**Confirmed by Aditi 2026-08-08. Do not "fix" these to match the screenshot.**

### 5.4 Other deltas, all deliberate

1. **`LinkedIn` is not a source.** The reference tags Marcus Webb `LinkedIn`; the source enum is `careers_page | outbound | referral | agency | import`, and the seed has him as `outbound`, which renders "Outbound". The designer was loose with the enum. **The enum is not widened to match a pixel.**
2. **`Hired` on David Kim's card is a status, not a tag.** It renders from `application.status` in terminal columns, ahead of the skills and source tags, styled identically per DESIGN_SYSTEM §3.
3. **Skills are invented.** No schema, no seed, no contract backs them — see §9 OQ-2.
4. **`scoreAvg` is invented.** No scorecards table exists. Only Ana (4.2) and Sofia (4.6) carry one, matching the reference. The fixture header says so in as many words.
5. **"Starts Sep 1"** is a reconstruction — David Kim's next action is clipped by the right edge of the reference at "Starts S…".
6. **Avatar hues are hash-derived** (`avatarToken()`, FNV-1a over the id), so candidate ids were *searched for* rather than chosen. **All nine land on the reference hue exactly** — Tess red, Omar green, Jordan and Priya amber, Elena and Ana violet, Marcus and David blue, Sofia green — so there is no residual delta here after all. Had one remained it would have been accepted, not special-cased: a per-candidate hue override would break the property that a rename never reshuffles the board.

---

## 6. UI spec

Reference is 1440×900 CSS at 2x — every measurement below is CSS px, already halved.

### 6.1 Layout

The board **legitimately overflows**: 5 columns × `layout.kanbanColumnWidth` (252px) + 4 gaps × `layout.kanbanColumnGap` (12px) = 1308px against `layout.contentMaxWidth` 1162px. The reference itself clips the Hired column mid-card. A correct render is cut off in the same place.

Structure — this shape is chosen for correctness, not just brevity:

```
board            overflow-x: auto          ← the only horizontal scroller
  column         flex column, fixed width  ← bg.surfaceSunken, radius lg
    header       flex: none                ← never scrolls: no `sticky` required
    cardlist     flex: 1, overflow-y: auto ← the vertical scroller, min-height enforced
```

`position: sticky` is deliberately **not** used. `overflow-x` on an ancestor establishes a containing block that breaks `sticky` on a descendant header; making the header a non-scrolling flex sibling of the scrolling list gets the same result with no positioning at all. The enforced `min-height` on the card list is not cosmetic — it is what keeps an emptied column a reachable drop target (§6.6, §8 edge 6).

### 6.2 Column header

| Element | Token |
|---|---|
| Stage hue square, 6px | `stage.{canonical}` |
| Stage name | `bodyStrong`, `text.primary` |
| Count | `caption`, `text.tertiary` |
| `+` button | ghost, **disabled** (§6.8) |
| Progress rule, 3px | track `border.subtle`, fill `stage.{canonical}`, `layout.progressRuleHeight`, radius `full` |
| Pass rate, right-aligned | `meta`, `text.tertiary` — "56% pass" |
| Median, below | `meta`, `text.tertiary` — "median 4d" |

**Terminal columns** render the pass rate normally and replace the median line with `closed`. A terminal stage has no exits, so a median time-in-stage is not a small number — it does not exist.

The progress rule's fill width is the pass rate. `role="img"` with an `aria-label` carrying both figures, since neither is recoverable from a bar by a screen reader.

### 6.3 Card

`bg.surface`, radius `md`, `border.default`, padding `space.3`, `shadow.xs`, width `layout.kanbanCardWidth` (228px), gap `layout.kanbanCardGap` (10px).

| Element | Token |
|---|---|
| Avatar, 24px | `var(--color-avatar-N)` via `avatarToken(candidateId)` |
| Name | `cardTitle`, `text.primary` |
| Title at company | `meta`, `text.secondary` |
| Tag row | radius `xs`, `bg.canvas` fill, `text.secondary`, `caption`, no border |
| Footer | `meta`, `text.tertiary` — "3d in stage · Loop Thu" |
| Score chip, top-right | `caption` on `bg.canvas`, radius `sm` |

Tag order: **status** (terminal columns only) → **skills** → **source**. All three styled identically per DESIGN_SYSTEM §3 — they are metadata, not status, and keeping them neutral is what lets the stage hues stay meaningful.

Minimum hit target 32×32 on anything inside a card, per DESIGN_SYSTEM §5 — a mis-tap here moves a candidate.

### 6.4 Stalled treatment

A card is stalled when **`daysInStage > column.slaDays`**, strictly greater, and `slaDays` is non-null.

**This threshold was derived from the reference, not stated in any doc.** Marcus Webb sits at 5d in Screen with `slaDays: 5` and renders normally; Elena Ruiz at 8d is stalled. `>=` would stall Marcus and contradict the screen. Written down here because it is a pixel-derived off-by-one and the next person will not otherwise know it was a decision.

**The reference does not draw the left edge.** Cropping Elena Ruiz's card at 2x shows a uniform border. DESIGN_SYSTEM §4 specifies the edge explicitly and Aditi confirmed the three-signal requirement on 2026-08-08, so the doc and the instruction win over the picture here — recorded rather than silently resolved.

Three independent signals, so the state survives colourblindness *and* a greyscale print:
1. **Colour** — footer swaps to `text.danger`
2. **Weight** — footer swaps to `bodyStrong`
3. **Position** — a 2px `border.danger` left edge on the card

Copy: "Stalled 8d in stage", replacing "8d in stage". The word carries the meaning; the three signals only make it findable.

### 6.5 The five states

| State | Treatment |
|---|---|
| **Default** | The board |
| **Loading** | Skeletons at real card height so nothing shifts. `role="status"`, `aria-busy`, `aria-label="Loading pipeline"` |
| **Empty (no data)** | All five columns render with their headers and zero counts. The board's shape *is* the information — collapsing to a single message would hide which stages exist |
| **Empty (column)** | Per DESIGN_SYSTEM §6: "No candidates in Screen yet. Advance someone from Applied, or add a candidate directly." |
| **Empty (filtered)** | A **distinct** state: "No candidates match those filters." with a **Clear filters** button. A filtered-empty board offers to clear the filter, never to create a record |
| **Error** | Problem-shaped card with a retry. Never renders a server error string verbatim |
| **Permission-denied** | `scoreAvg` absent from every card; cards render without the chip. Not an error, not a zero, not a lock icon (§7) |

### 6.6 Drag

Per DESIGN_SYSTEM §4: source card drops to `opacity.dragSource` (0.4); the lifted card takes `shadow.dragging` and a 2° tilt; the target column tints to `bg.selected`; the drop settles with `motion.easing.spring` at `duration.base`.

`prefers-reduced-motion` collapses the transforms and the tilt. **Opacity fades stay** — they are what makes the state change perceivable at all, and removing them would make reduced-motion users worse off than the animation does.

### 6.7 Keyboard path — built first, drag second

Deliberate build order. A keyboard path retrofitted onto a working drag is a keyboard path that was never the primary route.

| Key | Action |
|---|---|
| `Tab` | Move between cards |
| `Space` | Lift the focused card |
| `←` `→` | Move the lifted card between columns |
| `↑` `↓` | Move the lifted card within its column |
| `Space` | Drop |
| `Esc` | Cancel, restoring the original position |

Announcements are configured through **dnd-kit's own `announcements` object**, never a second live region. dnd-kit mounts one already; adding ours gives screen-reader users every message twice. A test asserts exactly one live region is present.

Announcement copy: "Picked up Ana Petrova from Onsite, position 1 of 1." → "Ana Petrova moved to Offer, position 2 of 2." → "Ana Petrova dropped into Offer, position 2 of 2." → on cancel, "Move cancelled. Ana Petrova returned to Onsite."

`sortableKeyboardCoordinates` moves focus by collision detection over rendered rectangles, which fails on exactly this board — see §8 edge 6 and the test that covers it.

### 6.8 Disabled controls — pictured, not interactive

The per-column `+`, `+ Add candidate`, `Edit job`, and the Candidates / Job details / Hiring team tabs are all rendered `disabled`, and are therefore **out of the tab order**.

This follows the sign-in SSO buttons and the reviewer's blocking finding on the jobs screen. A focusable control that does nothing is a dead-end tab stop — it costs a keyboard user a tab press and a moment working out whether something broke, in exchange for visual fidelity they cannot see. Disabled preserves the fidelity and removes the trap.

---

## 7. Permissions

Nothing on this screen is comp-scoped. Base, equity, band and comp expectation do not appear on the board, so non-negotiable #2 has no surface here.

**`scoreAvg` is scorecard-adjacent and is gated at the API layer.** A column average is an aggregate over panelists' scorecards, and non-negotiable #3 says an interviewer cannot read other panelists' scorecards for a candidate until their own `submitted_at` is set. The real endpoint therefore **omits the field entirely** for a caller who has not submitted — not null, not zero, not a masked value. The client renders no chip when the field is absent, which is the same rendering as a candidate who genuinely has no scores yet.

That collapse is intentional here and worth naming: the board should not leak "there is a score you may not see." A recruiter with full scope sees the chip; anyone else sees a card without one, indistinguishable from an unscored card.

The `forbidden` mock scenario produces exactly this shape so the state is reachable and axe-checkable before the endpoint exists.

---

## 8. Edge cases

1. **Reorder within a column, twice, then move stage.** The stage move must succeed. If either reorder bumped `version`, it 409s — the exact flaky-board failure non-negotiable #18 exists to prevent. **Covered by test.**
2. **409 version mismatch.** Roll back, refetch the destination column, toast: "Elena Ruiz changed while you were dragging."
3. **409 from-stage mismatch.** Roll back, refetch *both* columns regardless of version, toast: "Someone else already moved Elena Ruiz to Onsite."
4. **Esc mid-drag.** Restores the original position through the **same reducer action** as a 409 rollback. One user intent, one code path (non-negotiable #5) — three rollback triggers converging on one `revert(snapshot)`.
5. **Network failure mid-drag.** Same rollback path, generic copy. The board never stays lying (non-negotiable #14).
6. **Move the only card out of a column, then move another card in — by keyboard.** The emptied column has no cards to collide with, so a geometry-driven coordinate getter cannot find it and the column becomes unreachable. This is the precise failure that turns the keyboard path into decoration, and it does not surface when testing a populated board. Mitigated by a column-indexed coordinate getter plus the enforced `min-height` from §6.1. **Covered by a dedicated test.**
7. **Drop into a terminal column.** **Blocked this PR.** PRD §5.4 requires a reason prompt for terminal stages; that prompt is out of scope (§9 OQ-1). Shipping the drop without it would ship a path that violates the acceptance criterion silently. Terminal columns are therefore reachable droppables that **refuse and explain**: the column is announced as unavailable on arrival, shows a dashed hint during a drag, and answers the drop attempt with "Sofia Lindqvist was not moved. Hired needs a reason." Disabling the droppable was tried first and made the refusal silent — see §8b item 5.
8. **Drag *out of* a terminal column.** Also blocked: cards in a terminal column are not draggable at all. The column header reads `closed`; a closed application is not in play. Recorded as a decision, not an oversight.
9. **Filter to zero results.** Empty-because-filtered, distinct copy, Clear filters action (§6.5).
10. **A card whose `slaDays` is null** (Applied, and all terminal stages). Never stalls, whatever the dwell. Tess Bianchi at 4d in Applied is not stalled.
11. **`daysInStage: 0`** (David Kim). Renders "0d in stage", not "today" and not an empty string.
12. **A candidate with no skills** (five of the nine). The tag row renders with the source tag alone, never an empty row that collapses the card height.
13. **Concurrent moves in two tabs.** Verified manually per CLAUDE.md §6 — one tab's move must produce the correct 409 class in the other.
14. **Reduced motion during a drag.** Transforms collapse, opacity fades remain (§6.6).
15. **Nine cards, one column.** Filtering to a single stage puts all matching cards in one column; the column scrolls vertically while the board still scrolls horizontally.

---

## 8b. Found during the build

Recorded because a spec that only describes the plan is half a spec.

**Fixed:**

1. **The mock rebuilt board state on every GET.** Every test that moved a card and re-read the board saw the move vanish. Worse in the real client than in a test: it refetches immediately after every 409, so the rollback path would have *looked* right while quietly reverting moves the server had accepted. The board is now rebuilt only when the `_scenario` changes, and `forbidden` is projected onto the response instead of mutated into the state.
2. **The pickup announcement was overwritten within the same tick.** dnd-kit fires `onDragOver` immediately after `onDragStart`, so "Picked up Ana Petrova from Onsite" was replaced by "Ana Petrova moved to Onsite, position 1 of 1" before a screen reader could speak it — announcing a move that had not happened, and never announcing the pickup. `onDragOver` now returns nothing while the card is still in its starting position.
3. **Focus was lost to `<body>` after every drop.** dnd-kit restores focus to the node it lifted; React has already replaced that node, and both the optimistic render and the confirmed one replace it again. A keyboard user dropped a card and the next Tab restarted at the top of the page. Focus is now re-asserted by `data-card-id` and stays armed until the write settles and the refetch lands.

**Found in step 6, driving the real UI:**

4. **`MoveFailure.message` rendered as the literal string `"version"`.** `Error`'s constructor assigns an *own* `message` property, which shadows a `get message()` on the subclass — so the accessor never ran and the conflict banner showed the failure kind instead of a sentence. The message is now built and passed to `super()`. Asserted in `pipeline-mock.test.ts`, including that the two 409s never render the same sentence.
5. **The terminal-column block was silent for anyone not looking at the screen.** Hired was a *disabled* droppable, and dnd-kit never resolves `over` to a disabled droppable — so the announcement explaining the refusal was dead code, and a screen-reader user pressing ArrowRight simply found that nothing happened. Terminal columns are now enabled droppables that **refuse the drop and say why**: "Hired is not available — moving there needs a reason" on arrival, the dashed hint visually, and "Sofia Lindqvist was not moved. Hired needs a reason." on the attempt. `handleDragEnd` is what refuses. This also deleted the coupling between `getEnabled()` and the traversal rule.
6. **Two-tab concurrency cannot be checked against MSW.** The mock's state is module state inside the page, so two tabs get two independent boards and neither can observe the other's write. The 409 classes are covered by the `conflict` / `moved` scenarios and by the mock-layer tests instead; the genuine two-tab check in CLAUDE.md §6 lands with the real endpoint. Recorded rather than quietly skipped.

**Verified in the browser (2026-08-08):** keyboard walk including into and out of an emptied column · Esc cancel leaves board and `version` untouched · pointer drag moves across columns and bumps `version` 1→2 · a same-column reorder leaves `version` at 1 · both 409s roll back with distinct copy · terminal refusal announced at every step · focus stays on the moved card · no spurious requests on the normal path.

One note on driving it: Playwright's `dragTo` issues a single jump and dnd-kit's `PointerSensor` reads nothing from it — the drag registers as a same-column reorder. Pointer drags have to be driven with intermediate `pointermove` events. Worth knowing before the Playwright suite is written.

**Deltas from the reference, all measured rather than eyeballed:**

4. Columns carry a 1px `border.default` — confirmed by scanning the reference at 2x (border at the column edge, 24px/12 CSS gap between columns). DESIGN_SYSTEM §4 does not mention it; §1 ("surfaces separate with a border and a background step") does.
5. The column count sits in a `bg.canvas` chip, not as bare text.
6. The stage square renders sharp. `radius.xs` is 4px, which CSS clamps to 50% on a 6px box and turns the square into a circle; the reference softens the corners by roughly 1.5px and the scale has no step that small. **Token gap, not a component decision.**
7. **Typography was ~25% too large on the body family — now pinned.** The symptoms on this screen were Elena Ruiz's stalled footer wrapping to two lines and Ana Petrova's subtitle truncating, both of which fit comfortably in the reference. Fixed in step 6; see §8c.
8. The topbar breadcrumb reads "Jobs / Pipeline" where the reference reads "Jobs / Senior Product Engineer". The shell cannot know the job's title — it lives in the board's response, a component away — and the title is in the page header directly below. A shell-level breadcrumb nested routes can fill is worth doing when a second screen needs it, not for one.

**New tokens** (both measured, neither invented): `layout.stageDotSize` 6px, `layout.filterFieldWidth` 205px.

## 8c. Typography pinned (step 6)

DESIGN_SYSTEM §2.1 asks for this to be settled by comparison once there is a second built screen to compare. There now is, so it was.

**Method.** Compare the *rendered width* of long text runs, reference against build — not glyph heights. The endpoints of a long run are strong stems that survive anti-aliasing; cap heights do not, which is what made every previous attempt land somewhere different.

**Finding: the two families were wrong in different directions, so no single factor fixes the scale.** This is why §2.1's "if `pageTitle` is off, it's off everywhere by the same amount" does not hold, and why spec 001's measured table appeared to climb monotonically.

| Family | Verdict | Evidence |
|---|---|---|
| **Body** (Inter) — `cardTitle`, `bodyLg`, `body`, `bodyStrong`, `meta`, `caption`, `code`, `eyebrow` | **×0.80** | Six long runs: 0.755–0.817. `code` independently implied 10.4px against its new 10px |
| **Display** (Inter Tight) — `hero`, `metricXl`, `pageTitle`, `sectionTitle` | **unchanged** | `pageTitle` 0.99 on "Welcome back" (12 chars); `sectionTitle` 1.03 on "Senior Product Engineer" (23 chars) |

After the change, all eight measured runs on this screen sit within **5.3%** of the reference (0.947–1.039), and both layout symptoms are gone.

**This corrects spec 001 §2.1's table**, updated in the same PR. Its `pageTitle 0.73` was a cap-height artifact — a 4-character sample ("Jobs") reproduces it convincingly, which is why it survived. Its `cardTitle 0.80` was right.

**Also fixed:** the job header used `pageTitle`. `sectionTitle`'s own token description names this exact string — "'Senior Product Engineer' detail header" — and a job's board is a detail view under Jobs, not a top-level page. That wrong token is what made the title look correct while the body text did not, and it hid the family split for most of the investigation.

**Still unverified:** `metricXl` (Reports is not built, no sample exists) and `eyebrow` (no clean run isolated; it keeps its step below `caption`). `_meta.confidence.typography` moved `LOW` → `MEDIUM`, not `HIGH`: the residual gap between width-derived (~0.79) and height-derived (~0.87) sizes is the **font family**, not the sizes. The reference face is narrower than Inter. Pin the family before claiming `HIGH`.

**Blast radius:** this changes every screen. The jobs list and sign-in are in other sessions' hands — their tests pass here, but a visual pass on both is worth doing before merge.

## 9. Open questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| **OQ-1** | The terminal-stage reason prompt. Until it ships, drops into and out of Hired/Rejected/Withdrawn are blocked (§8 edge 7–8). It is the follow-up that unblocks them. | ui, next spec | No — blocked path is explained, not silent |
| **OQ-2** | **Skills need a real home.** The board shows them; nothing stores them. A `candidate_skills` table (or a parsed-resume projection) is M1 work. Filed here so it does not arrive as a surprise when the endpoint is built and the field has nowhere to come from. | schema, M1 | No — fixture-only for now |
| **OQ-3** | `ERROR_TYPES` needs `STAGE_VERSION_CONFLICT` and `STAGE_MOVED`. They ride along with the §4.1 contracts migration. | api | No |
| **OQ-4** | Does the board need its own `GET /v1/jobs/:id/board`, or does it compose `GET /v1/applications?job_id=` plus a stats endpoint? §4.2 assumes the former because the column stats are not derivable client-side (§5.2) and a second round trip for them would be a guaranteed loading-order bug. | api | No |
| **OQ-5** | Sidebar Pipeline count reads 9 (all ENG-204 applications) while the board's in-process count is 8. Same tension as spec 001 OQ-7 on where AppShell counts come from. Not resolved here. | Aditi | No |

---

## 10. Events emitted

**None from the UI.** Recorded because the absence is a decision, not an omission.

When the real endpoint lands, a successful move writes the stage transition, updates `stage_entered_at`, appends an activity, and inserts an `outbox` row — all in one transaction, with nothing published inline (ARCHITECTURE §6.1). The relay publishes `ApplicationStageChanged` to EventBridge; consumers are the SLA/stall evaluator and the reports aggregator, and every one of them must be idempotent on `outbox.id` (non-negotiable #19).

The board is a consumer too, eventually — via SSE, id-and-version payloads only, refetching rather than trusting a broadcast. Out of scope here (§2).

---

## 11. Test plan

Keyed to the acceptance criteria in §12.

### Unit / component — Vitest + Testing Library
1. Nine cards render in 4 / 2 / 1 / 1 / 1, by name.
2. Column headers carry count, pass rate and median; **Hired renders `closed`** in place of a median.
3. Column stats come from the fixture, not from visible cards — asserts Applied reads "median 2d" and not 2.5d.
4. Elena Ruiz carries all three stall signals; Marcus Webb at 5d with `slaDays: 5` carries none (the `>` boundary).
5. All five states render and are axe-clean, including per-column empty and empty-filtered as distinct copy.
6. **Exactly one `aria-live` region** exists during a drag.
7. Disabled controls are absent from the tab order.
8. Tag order is status → skills → source; David Kim renders `Hired` from status.
9. `scoreAvg` absent → no chip, indistinguishable from unscored.

### Mock-layer — Vitest
10. **Reorder does not bump `version`;** reorder twice then move stage → the move succeeds. (§8 edge 1, non-negotiable #18.)
11. Version mismatch produces the version-conflict 409; from-stage mismatch produces the stage-moved 409 **even when the version matches**.
12. Every handler response validates against its own Zod schema.

### Keyboard — Vitest, plus a real browser

jsdom gives every element a zero rect, so dnd-kit's collision detection cannot run there in any meaningful way. A full keyboard walk in jsdom would only prove that the rects I mocked agree with the rects I mocked. The parts carrying real logic are unit-tested; the walk itself is done where rects exist.

13. `boardCoordinateGetter` reaches a column with **no cards in it**, moves back the other way, skips terminal columns, does not wrap at the ends, and orders by column position rather than DOM order.
14. `neighboursFor` places a card moving *down* within its column after the card it landed on — the off-by-one a raw index produces, which would make the move a silent no-op.
15. `moveCardTo` resets `daysInStage` across stages, leaves it alone on a reorder, and does not mutate the array it was given.
16. Exactly one live region is mounted.
17. **The walk itself, in a real browser** — Ana Petrova out of Onsite by keyboard, emptying it, then Marcus Webb into the now-empty Onsite by keyboard. Verified 2026-08-08: "Marcus Webb moved to Onsite, position 1 of 1", one PATCH per move, focus left on the moved card. Carried into the Playwright suite; it cannot live in jsdom.

### Manual — Claude in Chrome (CLAUDE.md §6)
17. Screenshot at 1440×900 diffed against `03-pipeline-kanban@2x.png`: spacing, weight, hue, alignment. Expected deltas are §5.3 and §5.4 only.
18. Keyboard-only, mouse untouched, end to end.
19. Drag with the network failing mid-flight.
20. Two tabs side by side for both 409 classes.
21. Drag feel: does the drop settle correctly, does the optimistic update ever flash the wrong state, does the loading state flicker.

Findings recorded as a delta list against this spec. Fix or file, never silently accept.

---

## 12. Acceptance criteria

- [ ] Route `/jobs/[jobId]/pipeline` renders; sidebar lights Pipeline.
- [ ] Nine named candidates in Applied 4 / Screen 2 / Onsite 1 / Offer 1 / Hired 1.
- [ ] Headers carry count, pass rate and median; values are 100/56/33/22 per §5.3, with Hired reading `closed`.
- [ ] Elena Ruiz renders the stalled treatment with three independent signals; Marcus Webb does not.
- [ ] Complete keyboard path with a single live region, including into and out of an emptied column.
- [ ] Optimistic move rolls back on both 409 classes, with distinct copy, through one code path shared with Esc.
- [ ] A rank-only reorder leaves `version` untouched, asserted by test.
- [ ] Board scrolls horizontally; column headers do not scroll; columns scroll vertically.
- [ ] Five states reachable and axe-clean.
- [x] Terminal drops blocked with an explanation — announced, not silent.
- [ ] Pictured-but-inactive controls disabled and out of the tab order.
- [ ] `pnpm lint`, `typecheck`, `test` green — including the token-usage guard.

---

## 13. Build order

Each step is verifiable before the next begins.

| Step | Deliverable |
|---|---|
| 0 | `mocks/pipeline-{contract,fixtures,handlers}.ts` + mock-layer tests (11.10–11.12) |
| 1 | Static board: columns, headers, cards, stalled treatment |
| 2 | Board state reducer with one `revert(snapshot)`; all five states |
| 3 | **Keyboard path first**, then pointer drag over it |
| 4 | Optimistic move, both 409 classes, rollback |
| 5 | Filters and sort; unlocks empty-filtered |
| 6 | axe over every state, then Claude in Chrome (11.17–11.21) |

### Files

**New:** `app/(app)/jobs/[jobId]/pipeline/page.tsx` · `components/pipeline-board.tsx` · `components/pipeline-column.tsx` · `components/pipeline-card.tsx` · `lib/board-state.ts` · `lib/board-query.ts` · `mocks/pipeline-contract.ts` · `mocks/pipeline-fixtures.ts` · `mocks/pipeline-handlers.ts` · `test/pipeline-board.test.tsx` · `test/pipeline-keyboard.test.tsx` · `test/pipeline-mock.test.ts`

**Touched:** `components/app-shell.tsx` (nav active matcher, one line) · `mocks/handlers.ts` (one entry) · `apps/web/package.json` (`@dnd-kit/core`, `@dnd-kit/sortable`)

`zod` is added to `apps/web` as a direct dependency. It is not new to the repo — `packages/contracts` already depends on it — but the mock contract imports it directly, and a package that imports a module should declare it rather than rely on hoisting. Pinned to `^3.25.76` so it dedupes onto the copy `packages/contracts` resolves; the exact `3.25.0` tarball ships `src/` with no `dist/` and fails to resolve under Vite.

**New dependency justification** (CLAUDE.md §9): `@dnd-kit` is the decided stack (CLAUDE.md §2). It replaces hand-rolled pointer capture *and* a hand-rolled keyboard sensor. The platform's own answer — HTML5 drag-and-drop — has no touch support, no keyboard path, and an uncontrollable drag image; it is not a candidate. `@dnd-kit/core@6.3.1` declares open React peer ranges, so React 19 needs no override.
