# Spec 007 — Review inbox, candidates, offers, reports

**Status:** draft, awaiting review
**Milestone:** M2
**Depends on:** spec 001 (app shell, session), spec 003 (board — the card grammar these screens reuse), spec 005 (jobs list — the row grammar `/candidates` and `/offers` inherit)
**Blocks:** nothing. Every screen here is read-only and every write it draws is inert by design (§6).

---

## 1. Context and goal

Four of the nine reference screens have never been built: `04-review-inbox`, `05-candidate-profile`, `07-offer-builder`, `08-reports`. Their nav rows shipped disabled in PR #25 because linking to them answered 404.

The goal is those four screens, reference-faithful, fed by fixtures through a mock endpoint, with no writes.

**Why now:** the shell advertises eight destinations and delivers one. Every demo path that isn't the board dead-ends. These four are the whole remainder of the designed surface except scheduling, which spec 004 owns.

**Why read-only:** three of the four draw actions that must not have a second implementation. Advancing a candidate from the review inbox is the same user intent as dragging them on the kanban, and §4.5 says one path per action. A mocked advance here is that second path, built before the first one has an endpoint to share. See §6.

---

## 2. Scope

**In:**
- A dev-only mock endpoint at `/api/mock/*` serving fixtures, with comp gated by role (§5).
- Zod schemas in `packages/contracts` for all five payloads, written before any screen (§5 of CLAUDE.md — contracts first).
- `/review-inbox` — queue and detail, keyboard navigation.
- `/candidates` — list. `/candidates/:id` — profile with activity timeline and details rail.
- `/offers` — list. `/offers/:id` — offer builder with approval chain.
- `/reports` — four stat tiles, pipeline conversion, hires by source, eight-week interview trend.
- Default, loading and empty states for each.
- Enabling the four routes in the shell's `BUILT` set.

**Out:**
- **Scheduling.** Spec 004 owns it. Its nav row stays disabled.
- **`/pipeline`.** It is the highlight key for `/jobs/:id/pipeline` (`JOB_PIPELINE` in `app-shell.tsx`), not a route. PR #25 established this.
- **All writes.** Advance, reject, send-for-approval, add-note render and do nothing (§6).
- **Real endpoints, migrations, RLS, seed rows.** Nothing in `apps/api` or `packages/db` changes.
- **Permission-denied and error states** beyond a generic retry. They need real 403s to be honest.
- **Nav badge counts.** The reference shows Jobs 6, Pipeline 9, Review inbox 4, Scheduling 4, Offers 1. `app-shell.tsx` records why they were removed: they were invented and answered to nothing. Restoring them needs a tenant-wide endpoint, which does not exist.
- **Candidate profile tabs other than Activity.** Emails, Interviews, Scorecards and Files render with their counts, disabled. No design exists for their bodies, and Scorecards cannot be built casually — §4.3 blindness is enforced in the query, and there is no query.
- **Realtime, optimistic updates, rollback.** Nothing here mutates.

---

## 3. Data model changes

**None.** No migration, no rollback, no backfill. This spec adds no table, column, constraint or policy. Every payload is a fixture served from `apps/web`.

This is deliberate and it is the reason the spec can be one document instead of five: there is no schema to get wrong, so the only durable artifacts are the contracts in §4, which the real endpoints will implement unchanged.

---

## 4. Contracts

New file `packages/contracts/src/people.ts`, re-exported from `index.ts`.

Response objects are plain `z.object` and deliberately **not** `.strict()`. An earlier draft of this spec said the opposite and was wrong: stripping is the property the real routes depend on. `applications/routes.ts` parses on the way out precisely so a field added to a record later cannot leak through, and `.strict()` would convert that silent, safe strip into a 500.

Existing schemas are reused rather than restated: `SourceSchema` and `ApplicationStatusSchema` from `pipeline.ts`, and `CanonicalStageSchema` from `jobs.ts` for every stage name below — verified present, not assumed.

### 4.1 `ReviewQueueItemSchema`

```
id                 uuid          the application
candidateId        uuid          avatar hue hashes off this, not `id` (spec 003)
name               string
currentTitle       string
currentCompany     string
location           string
appliedDaysAgo     int >= 0
coverNote          string | null
resumeHighlights   string[]      0..6
signal: {
  yearsExperience  int >= 0
  stackMatch       'strong' | 'partial' | 'weak'
  locationFit      'remote_ok' | 'onsite' | 'relocation'
}
```

`GET /api/mock/review-queue` → `{ items: ReviewQueueItem[], waiting: int, reviewedToday: int }`.

The reference reads "Review queue · 4 waiting" and "0 of 4 reviewed today" over a progress bar, so `reviewedToday` is a separate field and not `items.length` arithmetic.

### 4.2 `CandidateSummarySchema`

```
id                 uuid          the candidate
applicationId      uuid          the application this row links to
name               string
currentTitle       string
currentCompany     string
jobTitle           string        the job they are in
stage              CanonicalStageSchema
daysInStage        int >= 0
source             SourceSchema
status             ApplicationStatusSchema
```

`GET /api/mock/candidates` → `{ items: CandidateSummary[] }`.

### 4.3 `CandidateProfileSchema`

```
id                 uuid
name               string
currentTitle       string
currentCompany     string
location           string
stage              CanonicalStageSchema
stages             string[]       the rail: Applied, Screen, Onsite, Offer, Hired
daysInStage        int >= 0
nextAction         { text: string, href: string | null } | null
tabCounts          { emails: int, interviews: int, scorecards: int, files: int }
activity           ActivityEntry[]
details            CandidateDetails
job                { id, title, reference, recruiterName }
links              { label: string, href: string }[]
```

```
ActivityEntry:
  id               uuid
  kind             'scheduling' | 'scorecard' | 'stage' | 'email' | 'note'
  title            string
  body             string
  at               ISO 8601 UTC        rendered in the viewer's zone (§4.7 non-negotiable)
```

```
CandidateDetails:
  email            string
  phone            string
  source           string
  recruiterName    string
  compExpectation  { minCents: bigint-as-string, maxCents, currency } | null   ← gated, §5
  noticePeriod     string | null
```

`kind` drives the timeline dot colour and nothing else. It is a closed union so a fixture cannot introduce a dot the design has no colour for.

`compExpectation` is `null` — not absent — when the caller lacks the scope. Absent would be indistinguishable from "this candidate never stated one", and the UI renders those differently (§7.3).

`GET /api/mock/candidates/:id` → `CandidateProfile`.

### 4.4 `OfferSchema`

```
id                 uuid
candidateId        uuid
candidateName      string
level              string                      'L5 Senior'
status             'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'declined'
version            int >= 1                    the reference reads "v2 · edited 3h ago"
editedAt           ISO 8601 UTC
startDate          ISO date
expiresDate        ISO date
comp               OfferComp | null            ← gated in full, §5
approvals          ApprovalStep[]
letterBody         string[]                    paragraphs, pre-rendered
```

```
OfferComp:
  baseCents        string (bigint)             §4.9 — never a float, never an assumed currency
  currency         ISO 4217, required, no default
  bandMinCents     string (bigint)
  bandMaxCents     string (bigint)
  equityUnits      int
  equityYears      int
  equityNote       string                      'band midpoint'
  signOnCents      string (bigint)
```

```
ApprovalStep:
  id               uuid
  name             string
  role             string                      'Hiring manager', 'VP Engineering', 'Comp review'
  state            'approved' | 'pending' | 'rejected'
```

Money is a bigint-as-string in JSON with an explicit `currency`, per §4.9. There is no default and no assumed USD; a fixture omitting `currency` fails schema parse, which is the point.

`GET /api/mock/offers` → `{ items: OfferSummary[] }` where `OfferSummary` is `Offer` minus `comp`, `approvals` and `letterBody`.
`GET /api/mock/offers/:id` → `Offer`.

### 4.5 `ReportsOverviewSchema`

```
period             string                      'Last 30 days · all departments'
tiles: [{
  key              'time_to_hire' | 'offer_accept_rate' | 'active_candidates' | 'interviews_this_week'
  label            string
  value            string                      pre-formatted: '24d', '86%', '9', '22'
  delta            string | null               '3d faster than last month'
  direction        'up' | 'down' | 'flat'      drives colour AND an icon — §4.15, never colour alone
}]
conversion: [{ stage: CanonicalStageSchema, label: string, count: int }]
sources:    [{ key: 'referral'|'outbound'|'careers_page'|'agency', label: string, hires: int }]
interviewsPerWeek: [{ label: string, count: int }]
```

`GET /api/mock/reports/overview` → `ReportsOverview`.

Tile values arrive pre-formatted as strings. Formatting "24d" from a number means encoding a unit convention in the component, and the real endpoint is the thing that knows whether a metric is days, points or a bare count.

`direction` exists so the delta is not communicated by green-vs-red alone (§4.15).

### 4.6 Status codes and errors

| Case | Status | Body |
|---|---|---|
| Found | 200 | the schema above |
| Unknown id | 404 | `application/problem+json`, `type: ERROR_TYPES.NOT_FOUND` |
| No/!bearer token | 401 | `application/problem+json`, `type: ERROR_TYPES.UNAUTHENTICATED` |
| Unknown mock path | 404 | problem+json |

RFC 9457 shape throughout, matching the real API (§9), so the client error handling written here is the client error handling that survives the swap.

No `Idempotency-Key`, no `version` echo, no cursor pagination: there are no writes and no list long enough to page. When `/candidates` gets a real endpoint it gets a cursor; the contract does not pretend to have one now.

---

## 5. The mock endpoint

One file: `apps/web/src/app/api/mock/[...path]/route.ts`.

**Why a catch-all rather than a route file per resource:** five resources is five files of near-identical boilerplate around a fixture lookup. One dispatcher is the whole thing, and deleting the directory is the entire cleanup when the real endpoints land.

**Why `/api/mock/*` and not `/v1/*`:** `next.config.mjs` rewrites `/v1/:path*` to the API. A mock under `/v1` would race that rewrite and depend on Next's rewrite-versus-filesystem ordering to resolve correctly — a thing that is true today and is not a thing to build on. A separate namespace cannot collide. Each query module points its `API_BASE` at `/api/mock`; swapping to real is one string per module.

### 5.1 Comp gating

The handler strips comp before serialising when the caller's role lacks the scope:

- `CandidateProfile.details.compExpectation` → `null`
- `Offer.comp` → `null`, and `OfferSummary` never carries it at all

Roles with comp scope: `recruiter`, `recruiting_lead`, `hiring_manager`, `admin`. Without: `interviewer`, `coordinator`.

The role is read from the `Authorization: Bearer` JWT the client already sends, base64-decoding the payload **without verifying the signature**. That is acceptable *only* because this endpoint serves fixtures and grants nothing; the file carries a comment saying exactly that, and the real endpoint verifies.

**The review queue is the board's Applied column.** An earlier draft of this spec asserted these four were new people invented for screen 04. They are not: `pipeline-fixtures.ts` already carries Tess (4d), Omar (3d), Jordan (2d) and Priya (1d) in ENG-204's Applied column, every one with `nextAction: 'Review'`, and screen 04 shows exactly those four with exactly those ages. The review inbox is a different view of the same population, not a separate one.

That has a consequence worth stating: `appliedDaysAgo` here must equal `daysInStage` there, or the two screens contradict each other about the same person on the same afternoon. §12 asserts it rather than trusting it, and asserts the pinned candidate ids match as well — the avatar hue hashes off the candidate id, so a second id list gives one person two colours across two screens, which is a drift nobody would think to look for.

**Why gate at all in a mock.** §4.2 says comp is scope-gated at the API layer and hiding a field in the UI is not access control. A mock that always returns comp produces components written to render it unconditionally — and then the real endpoint's `null` is a crash, discovered in staging. `pipeline-handlers.ts` makes the same argument for `version` and conflict types: "A stub that accepted everything would have made the screen easier to build and wrong in exactly the ways that matter."

### 5.2 Fixtures

`apps/web/src/lib/mock-fixtures.ts`. Candidate UUIDs are **reused from `test/pipeline-fixtures.ts`** — Elena, Marcus, Ana, Sofia, David — because `Avatar` hashes its hue off `candidateId`, and a second set of ids gives one person two colours across two screens.

People the reference screens name, and where they come from:

| Person | Screen | Id source |
|---|---|---|
| Ana Petrova | 05 profile | existing `CANDIDATES.ana` |
| Sofia Lindqvist | 07 offer | existing `CANDIDATES.sofia` |
| Jordan Cole, Priya Nair, Omar Haddad, Tess Bianchi | 04 review inbox | existing — they **are** ENG-204's Applied column |

Fixture values match the screenshots exactly: 4 waiting / 0 reviewed, 24d / 86% / 9 / 22, conversion 412/96/31/12/9, sources 4/2/2/1, trend 12/18/14/22/19/26/22/28.

---

## 6. Why the writes are inert

Three buttons are drawn and do nothing: **Advance to Screen**, **Reject** (review inbox), **Send for approval** (offer). "Add note" on the profile renders disabled.

§4.5: *"Advancing from the review inbox and dragging on the kanban call the same service method. Two code paths for one user intent will diverge."* The board already advances through `PATCH /v1/applications/:id/stage`. Wiring the review inbox to a mock advance creates the second path in the exact place the rule names, and it would be written against fixture semantics rather than the real service's version-conflict behaviour.

The offer's send-for-approval is worse: it starts an approval chain, which is state that outlives the screen.

They render at full contrast with `aria-disabled` and a title explaining why, rather than being hidden. Hiding them would lose the reference fidelity that is the point of the batch.

---

## 7. UI spec

Tokens only. Every token named below was checked against `packages/tokens/src/tokens.generated.ts` rather than written from memory — the class names follow the `<property>-<token-path-kebab>` convention the existing components use (`bg-bg-selected`, `text-text-secondary`, `border-border-subtle`).

Two things fell out of that check and are worth stating, because they change how much of this screen set is actually designed:

- **The layout tokens for these screens already exist.** `layout.reviewListWidth`, `layout.detailRailWidth`, `layout.progressRuleHeight`, `layout.rowHeight` were measured off these four PNGs when the tokens were extracted, before any of them was built. No width below is a new number.
- **`color.semantic.stage.*` and `color.semantic.source.*` map one-to-one onto the reports panels** — five stages for five conversion bars, four sources for four swatches. That is not a coincidence; the palette was cut for this screen.

The single exception was the eight-week trend, which had no token at all. PR A measured and added it — OQ-6.

### 7.1 `/review-inbox` — reference `04`

Two panes under the topbar. Left `--layout-review-list-width`, right fills. Both widths were already measured from this screen when the tokens were extracted; neither is a new value.

**Queue header:** "Review queue" `text-body` semibold + "4 waiting" `text-text-secondary`. Under it a progress bar, `bg-bg-surface-sunken` track and `bg-action-primary-bg` fill, width `reviewedToday / waiting`. At 0 the fill is absent, not a zero-width sliver. Caption "0 of 4 reviewed today" in `text-caption text-text-secondary`.

**Queue rows:** `Avatar` 32, name `text-body` semibold, subtitle `{currentTitle} at {currentCompany}` in `text-text-secondary`, right-aligned age (`2d`) in `text-text-tertiary`. Selected row: `bg-bg-selected`, a 2px `bg-action-primary-bg` left marker, same grammar as the nav's active row. Rows are `<button>`s in a `<ul>`, not links — selection is local state, not navigation.

**Detail header:** `Avatar` 44, name `text-section-title`, subtitle `{title} at {company} · {location} · applied {n}d ago`. Right: Reject (secondary, `text-action-danger-text` label, `R` keycap) and Advance to Screen (primary, `A` keycap). Both inert (§6).

**Detail body:** two columns. Left: "COVER NOTE" and "RESUME HIGHLIGHTS" cards (`Eyebrow` + `bg-bg-surface` + `border-border-subtle` + `rounded-lg`). Right rail `--layout-detail-rail-width`: "SIGNAL" card, three label/value rows with value as a pill — `stackMatch: strong` and `locationFit: remote_ok` use `bg-feedback-success-bg`, `yearsExperience` uses a neutral pill. Below the card, unboxed: "Keyboard: **A** advance, **R** reject, ↑ ↓ navigate".

**States.** Loading: queue shows 4 skeleton rows, detail pane empty. Empty (`waiting === 0`): queue replaced by "Nothing waiting for review", detail pane shows the same, centred, `text-text-secondary`. Error: centred message + Retry button, matching the board's error state.

### 7.2 `/candidates` — no reference screen (see OQ-1)

Header "Candidates" `text-page-title`. Rows reuse the jobs-list grammar because it is the only list grammar the design has: `Avatar` 24, name + subtitle, job title, stage pill, days-in-stage, source. Row height `--layout-row-height`, grid tracks declared once and shared with the skeleton so the two cannot drift (the pattern `jobs-screen.tsx` already uses and comments).

Each row is a `Link` to `/candidates/:id`.

Loading: 6 skeleton rows. Empty: "No candidates yet".

### 7.3 `/candidates/:id` — reference `05`

Breadcrumb in the topbar: `{job.title} / {name}`.

**Header:** `Avatar` 44, name `text-page-title`, subtitle `{title} at {company} · {location}`. Right: Reject (secondary danger), Schedule (secondary), Advance → (primary). All inert.

**Stage rail:** pills separated by `›`. Past and future stages `border-border-default text-text-secondary`; current stage `border-action-primary-bg text-text-link bg-bg-selected`. Trailing "3d in Onsite" in `text-text-secondary`.

**Tabs:** Activity (active, `border-b-2 border-text-primary`), then Emails 2, Interviews 4, Scorecards 2, Files 3 — rendered with counts, `aria-disabled`, `text-text-tertiary`. Out of scope per §2.

**Next-action banner:** `bg-bg-selected`, `rounded-lg`. `Eyebrow` "NEXT ACTION", text `text-body`, right-aligned primary button from `nextAction.href`. Absent entirely when `nextAction` is null — not an empty banner.

**Note composer:** input + "Add note", both disabled (§6).

**Timeline:** left rule `border-border-subtle`, a dot per entry coloured by `kind` — scheduling `bg-feedback-info-fg`, scorecard/stage `bg-feedback-success-fg`, email/note `bg-text-tertiary`. Entry card `bg-bg-surface`, title `text-body` semibold, body `text-text-secondary`, right-aligned relative time `text-text-tertiary`. Times convert from UTC to the viewer's IANA zone (§4.7).

**Details rail** `--layout-detail-rail-width`: `Eyebrow` "DETAILS", then label/value pairs. `compExpectation`:
- present → `$205k to $220k`, formatted from cents with the payload's currency
- `null` **and the role has scope** → "Not stated"
- `null` **and the role lacks scope** → the row is not rendered at all

The last two are different and the distinction is why §4.3 makes the field nullable rather than optional. Then "JOB" (title as a link to the board, reference and recruiter beneath) and "LINKS" (pill links, `rel="noopener noreferrer"`).

Loading: header and rail skeletons. 404: the segment's `not-found.tsx`.

### 7.4 `/offers` and `/offers/:id` — reference `07`

`/offers` is a list in the same row grammar: candidate name, level, status pill, version and edited-at. No comp — `OfferSummary` does not carry it (§5.1). Links to `/offers/:id`.

`/offers/:id`, breadcrumb `{candidateName}, {level}`:

**Header:** "Offer: {name}" `text-section-title`, status pill (`pending_approval` → `bg-status-pending-bg text-status-pending-text`), right-aligned `v2 · edited 3h ago` in `text-text-tertiary`.

**Terms card:** label/value rows separated by `border-border-subtle`. Base salary shows a right-aligned band pill `band $190k to $225k` in `bg-feedback-success-bg`; equity shows `band midpoint` the same way. Money formats from bigint cents with the payload currency — never a float, never an assumed `$` (§4.9). Buttons: Send for approval (primary, inert), Preview letter (secondary, inert).

**When `comp` is null** (role lacks scope): the terms card is replaced by a single row — "Compensation is not visible to your role." The card is not rendered empty and the labels are not shown with blanks, because the field names themselves are the information being withheld.

**Approval chain:** `Eyebrow` "APPROVAL CHAIN", one card per step, a state dot (`approved` → `bg-feedback-success-fg`, `pending` → `bg-feedback-warning-fg`) plus the state as **text** on the right — never the dot alone (§4.15). Name `text-body` semibold, role `text-text-secondary`.

**Letter preview:** right column, `bg-bg-surface`, `border-border-subtle`, paragraphs from `letterBody`. Rendered as text nodes from a `string[]`, never `dangerouslySetInnerHTML` — this is candidate-adjacent content and §4.17's reasoning about attacker-controlled documents applies to anything that reaches this pane later.

### 7.5 `/reports` — reference `08`

Topbar title "Recruiting overview". Page header "Reports" `text-page-title` + period `text-text-secondary`.

**Tiles:** four across, `bg-bg-surface`, `border-border-subtle`, `rounded-lg`. `Eyebrow` label, value `text-metric-xl` tabular-nums, delta in `text-feedback-success-fg` / `text-action-danger-text` by `direction`, **prefixed by an arrow glyph** so the direction is not colour-only (§4.15).

**Pipeline conversion:** label, track, count per stage. Track `bg-bg-surface-sunken`, fill width `count / max(count)`, fill colour `color.semantic.stage.{applied,screen,onsite,offer,hired}` — the tokens exist and map one-to-one onto the five bars. Count right-aligned, tabular-nums.

**Hires by source:** a `color.semantic.source.*` swatch, label, right-aligned "4 hires". Again the tokens map one-to-one onto the four sources.

**Interviews per week:** eight columns, height proportional to count, value above, week label below. All bars `bg-chart-bar-idle` except the last, `bg-chart-bar-current` — added in PR A, measured — see OQ-6. A single series, so no legend and no CVD exposure. Rendered as a flex row of divs — five bars and eight columns of known height do not justify a charting dependency.

The conversion and trend panels get `role="img"` with an `aria-label` summarising the series, plus a visually-hidden table of the same numbers. A bar chart that only exists as coloured divs is invisible to a screen reader (§4.15).

**Every bar and legend row is directly labelled and carries its count, and that is load-bearing rather than decorative.** OQ-8 records that the stage and source palettes fail adjacent-pair CVD separation — `screen` and `onsite` are indistinguishable to deuteranopes. The written label beside each bar is what carries identity; the fill reinforces it. Do not refactor these panels toward a stacked bar or a legend-only chart on this palette: that removes the only thing making it legible.

Loading: tile and panel skeletons at final height, so the page does not reflow.

---

## 8. Behavior

**Keyboard — review inbox.** `↑` / `↓` move the selection, wrapping at neither end (first and last are absorbing). `Home` / `End` jump. Selection follows focus and the detail pane updates with it. `A` and `R` are drawn in the reference and are **not bound**, because binding them to nothing trains a reflex that will later fire on a real advance; they light up with the endpoint. The queue is a roving-tabindex listbox: one tab stop, `aria-activedescendant` on the container.

**Keyboard — everywhere else.** Standard tab order. Disabled controls use `aria-disabled` and stay focusable, so a keyboard user can reach one and hear why, rather than tabbing past a button they can see.

**Optimistic updates: none.** Nothing mutates, so §4.14's rollback requirement has nothing to attach to. When the writes land they bring their own rollback and their own spec section.

**Realtime: none.** No subscription, no invalidation beyond TanStack Query defaults.

**Motion.** Selection and hover transitions use `--duration-instant` and `ease-standard`. `prefers-reduced-motion` removes them, via the existing helper in `board-state.ts`.

---

## 9. Permissions

| Role | `/review-inbox` | `/candidates` | profile comp | `/offers` | offer comp | `/reports` |
|---|---|---|---|---|---|---|
| `admin` | read | read | visible | read | visible | read |
| `recruiter` | read | read | visible | read | visible | read |
| `hiring_manager` | read | read | visible | read | visible | read |
| `member` | read | read | **hidden** | read | **hidden** | read |

**Corrected.** An earlier draft of this table listed `recruiting_lead`, `coordinator` and `interviewer`. None of them exist: `ROLES` in `@talon/domain` is `admin | recruiter | hiring_manager | member`, and the `users.role` check constraint matches it. The table above is now the real four.

The visibility column is not restated here either — it is `hasScope(role, 'comp:read')` against `ROLE_SCOPES` in `@talon/domain`, which is the same table `contracts` derives `RoleSchema` from and every service checks. A second copy of it in the mock is what produced the phantom roles in the first place.

Enforced in `route.ts` before serialisation, per field, not in the component (§4.2).

The screens themselves are not role-gated in this batch — every signed-in role may load all four. Route-level gating needs the real endpoints' 403s to be meaningful; a mock that 403s teaches the client an error shape the real API might not use.

---

## 10. Edge cases

1. **Empty review queue** — `waiting === 0`. Both panes show the empty message; the progress bar is not rendered (a full bar reading "0 of 0" is a lie).
2. **Review queue of one** — `↑` and `↓` are no-ops. No wrap, no flicker.
3. **Candidate with no cover note** — `coverNote: null`. The COVER NOTE card is omitted; RESUME HIGHLIGHTS moves up. No empty card.
4. **Candidate with no resume highlights** — empty array. Same treatment.
5. **Profile with no next action** — `nextAction: null`. Banner absent, not empty.
6. **Profile with empty activity** — "No activity yet", timeline rule not drawn.
7. **Comp expectation absent but role has scope** — renders "Not stated". Distinct from case 8.
8. **Comp expectation withheld for role** — row not rendered. The label is itself information.
9. **Offer with no comp for role** — terms card replaced wholesale by the explanatory row (§7.4). Field labels are not shown blank.
10. **Offer approval chain all approved** — no pending step; the chain still renders, every state dot green.
11. **Reports with a zero series** — `max(count) === 0`. Every bar renders at zero width, not `NaN%`. Explicit guard.
12. **Reports tile with no delta** — `delta: null`. The line is omitted and the tile keeps its height so the row does not jag.
13. **Unknown candidate/offer id** — mock 404s, the segment renders `not-found.tsx`.
14. **Signed out mid-view** — the mock 401s, `RequireSession` redirects to sign-in. Already the shell's behaviour.
15. **Timezone** — a viewer in `Asia/Kolkata` and one in `America/Los_Angeles` see different local times for the same activity entry. Stored UTC, converted at render (§4.7).
16. **DST boundary in the activity timeline** — an entry at 01:30 on a fall-back date renders once, in the offset the instant actually had. Covered by a unit test on the formatter, per §4.7's rule that scheduling-adjacent changes ship with a DST test.
17. **Very long candidate name or job title** — truncates with an ellipsis at the grid track, `title` attribute carries the full value. No wrap, no row-height change.
18. **Mock reached with no bearer token** — 401 problem+json. Reachable in dev by clearing the token; must not 500.
19. **Malformed bearer token** — role parse fails. Treated as **no comp scope**, not as an error. Failing closed is the only safe direction on a comp gate.
20. **Fixture that violates its own schema** — the handler parses before sending and 500s in dev. A fixture drifting from the contract is a bug we want loud, not a screen rendering `undefined`.

---

## 11. Events emitted

**None.** No mutation, no `audit_log` row, no outbox entry, no consumer. §4.13 binds mutations, and this spec has none.

When the writes in §6 land, each brings its own audit entry and its own event, specified there.

---

## 12. Test plan

Vitest + Testing Library, in `apps/web/src/test/`. No Testcontainers — nothing here touches a database.

**Mock endpoint** (`mock-endpoint.test.ts`)
- Each of the five paths returns a payload that parses against its contract schema.
- Unknown path → 404 problem+json. Unknown id → 404. No token → 401.
- **Comp gating, both directions:** a `recruiter` token yields `comp` and `compExpectation`; an `interviewer` token yields `null` for both and `OfferSummary` never carries comp. This is the test that fails if someone later "simplifies" the gate away.
- Malformed token → treated as no scope (case 19), not a 500.

**Review inbox** (`review-inbox.test.tsx`)
- Renders queue and detail from fixture; first item selected on load.
- `↓` moves selection and swaps the detail pane; `↑` at the top is a no-op (cases 1–2).
- Empty queue renders both empty states and no progress bar.
- Advance and Reject are present and `aria-disabled` — asserting the §6 decision, so removing it fails a test rather than passing silently.

**Candidates** (`candidates.test.tsx`)
- List renders rows and links to `/candidates/:id`.
- Profile renders timeline, stage rail, details rail.
- Comp: visible for recruiter, "Not stated" when null-with-scope, row absent when withheld (cases 7–8, all three).
- Disabled tabs carry their counts and are not clickable.
- Activity timestamps render in the session's zone; one DST-boundary case (case 16).

**Offers** (`offers.test.tsx`)
- List omits comp entirely.
- Detail renders terms, band pills, approval chain with state as text as well as colour.
- `comp: null` renders the explanatory row and no field labels (case 9).
- Money formats from bigint cents with the payload currency; a fixture without `currency` fails schema parse.

**Reports** (`reports.test.tsx`)
- Four tiles, five conversion bars, four sources, eight columns from fixture.
- Zero series renders 0-width bars, no `NaN` (case 11).
- Tile with null delta omits the line (case 12).
- Each panel exposes its `aria-label` and hidden table.

**Shell** — `nav-links.test.tsx` (shipped in PR #25) covers the four new rows automatically: each goes live only when its `page.tsx` exists on disk. No new assertion needed, which is the property that test was built for.

**a11y** — `@axe-core/playwright` over all four routes in the E2E run, per §6's gate.

**Reference comparison** — Claude in Chrome against `04`, `05`, `07`, `08` at 1440×900, per CLAUDE.md §6. Deltas recorded against this spec, fixed or filed, never silently accepted.

---

## 13. Delivery

Three PRs, contracts first (§5 of CLAUDE.md).

| PR | Branch | Contents | Gate |
|---|---|---|---|
| A | `feat/007-contracts-and-mock` | `packages/contracts/src/people.ts`, `app/api/mock/[...path]/route.ts`, `lib/mock-fixtures.ts`, `mock-endpoint.test.ts`, **plus the OQ-6 chart tokens** | contracts and tokens both fixed before any screen is built against them |
| B | `feat/007-review-inbox-candidates` | `/review-inbox`, `/candidates`, `/candidates/:id` + tests, and the `BUILT` entries for those two rows | a row goes live in the PR that builds its page, not in a later one |
| C | `feat/007-offers-reports` | `/offers`, `/offers/:id`, `/reports`, and their `BUILT` entries + tests | as above |

`reviewer` agent on each, findings fixed by the owning agent, re-reviewed, squash-merged (§8).

---

## 14. Open questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | `/candidates` has no reference screen. §7.2 borrows the jobs-list row grammar. Is that the intended list, or should Candidates be a search-first screen? The topbar's "Search candidates, jobs" suggests search may be the real entry point. | Aditi |
| OQ-2 | `/offers` likewise has no reference — the screenshot shows only the detail, with a nav count of 1. Is a list right, or does `/offers` go straight to the single open offer? | Aditi |
| OQ-3 | The reference sidebar gives **Pipeline a count of 9** — the ENG-204 board's candidate count. That implies the designer did intend `/pipeline` as a destination, which contradicts PR #25 treating it as a highlight key. Which is right? Does not block this spec; blocks ever enabling that row. | Aditi |
| ~~OQ-4~~ | **Resolved during PR A.** The premise was false — the four are already board fixtures and already seeded, being ENG-204's Applied column. `db:seed` needs nothing. | — |
| ~~OQ-6~~ | **Resolved in PR A.** Both bar colours were sampled off `08-reports@2x.png`: idle `#C9CCF3` (solid, single mode over 2176 interior samples) and current `#4C56C8`. The current bar is exactly `action.primaryBg`, so it references the primitive. The idle tint is genuinely new — notably it is *not* `indigo.200` (`#C2C6F1`), because the ramp between the measured 50 and 600 anchors is interpolated rather than measured and misses this value. Added as `color.semantic.chart.barIdle` / `barCurrent`. That the current bar round-tripped to an exact existing token is the evidence the PNG carries no colour shift, which is what makes the idle measurement trustworthy. | resolved |
| OQ-8 | **`color.semantic.stage.*` and `color.semantic.source.*` both fail adjacent-pair CVD separation, and it reaches past this spec.** Run through the palette validator, `stage.screen` (#2569C2) against `stage.onsite` (#6F4FC4) measures ΔE **0.6** for deuteranopes — visually identical — and ΔE **10.1** even with normal colour vision, below the readability floor. The same two hues are `source.careersPage` and `source.outbound`, adjacent in the legend. The stage pair is adjacent in pipeline order, which is the worst arrangement. `stage.applied` additionally reads as grey (chroma 0.015, under the floor). The tokens are measured from the reference and authoritative, so this spec does not "correct" them; `/reports` is legal because every bar and legend row is directly labelled with its count, which is the secondary encoding the reference itself carries. **What this does not cover:** `DistributionBar` in `ui.tsx` stacks applied→screen→onsite→offer as touching segments with colour as the only visual identity, so a sighted deuteranope sees screen and onsite as one band. It has `role="img"` + `aria-label`, so screen readers are unaffected. Does the palette get re-stepped, or does `DistributionBar` gain a 2px surface gap and per-segment labels? | Aditi |
| OQ-7 | The review queue's order is the reference's — Jordan, Priya, Omar, Tess — which is neither the board's rank order (Tess, Omar, Jordan, Priya) nor age order. The fixture copies it rather than sorting, because inventing a sort would assert an ordering rule the design has not stated. What actually orders this queue? | Aditi |
| OQ-5 | Profile tab bodies — Emails, Interviews, Scorecards, Files — have no design at all. Scorecards in particular needs §4.3 blindness specified before anything is drawn. Separate spec? | Aditi |
