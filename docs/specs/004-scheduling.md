# Spec 004 — Scheduling (M2)

**Status:** partially implemented — PR A (data model, solver, contracts, UI) lands the pure and presentational halves. Radicale, holds, and invite send are PR B and are unbuilt.
**Milestone:** M2
**Depends on:** spec 001 (applications, users), spec 003 (board — advancing to Onsite is what triggers a loop)
**Blocks:** interviews, scorecards, and the candidate profile's next-action banner

---

## 1. Context and goal

Reference screen: `docs/reference/06-scheduling@2x.png`. A recruiter has advanced Ana Petrova to Onsite and now has to place four interview rounds across four people's calendars, on one day, inside the candidate's stated availability. Today that is twenty messages and a spreadsheet. The goal is one screen.

This is the hardest thing in the project, and the reason is that **three separate problems get conflated**: reading availability, solving an arrangement, and committing it. Each fails differently and each needs its own boundary. Conflating them is how this becomes unfixable — a solver that reads calendars inline can't be tested, and a commit path that trusts stale availability double-books an interviewer.

The failure mode that matters: **a candidate shows up and nobody is there.** Every design decision below is downstream of preventing that.

## 2. Scope

**In:** `CalendarProvider` interface; Radicale (CalDAV) as the provider; free/busy reads with caching; the availability grid; a loop solver (subset, §7); **manual placement as a peer of the solver (§7a)**; specific conflict messaging; 24h slot holds; invite send with pre-send re-validation; `interview_loops` and `interviews` persistence; decline handling.

**Out:** Google Calendar and Microsoft Graph adapters (deferred — the interface makes them additive); swappable-round permutation (§7); scorecards; the candidate-facing reschedule link; recurring availability rules; room and resource booking; timezone-aware working-hours policy per user beyond a single business-hours window.

## 3. Why Radicale, and what it costs us

Radicale is a real CalDAV server in one Docker container. That gives genuine calendar sync — RFC 4791 `REPORT` free-busy queries, real `VEVENT` writes — with no OAuth, no cloud project, no account approval, and **deterministic behavior in CI**. A test suite that depends on Google's availability fails for reasons unrelated to your code.

Honest limitations, stated so nobody discovers them mid-build:

- **Radicale does not implement iTIP/iMIP scheduling.** It won't email invitations or track attendee responses. So "send invites" means: write a `VEVENT` to each panelist's calendar, and generate an `.ics` for the candidate. Attendee accept/decline is modeled in **our** database, not read back from the server (§10).
- **`free-busy-query` support is thin.** Plan to fetch `VEVENT`s in a time range and compute busy intervals ourselves. That code is needed regardless — every provider returns something different and the solver needs one normalized shape.
- **No push notifications.** No watch channels, so no webhook invalidation. Cache TTL only.

None of these change the interface. A Google adapter later implements the same five methods and gets push invalidation as a bonus.

## 4. `CalendarProvider`

```ts
interface CalendarProvider {
  getBusy(userIds: string[], from: Date, to: Date): Promise<Record<string, BusyInterval[]>>;
  createEvent(userId: string, event: CalendarEvent): Promise<{ externalId: string }>;
  updateEvent(userId: string, externalId: string, event: CalendarEvent): Promise<void>;
  deleteEvent(userId: string, externalId: string): Promise<void>;
  isConnected(userId: string): Promise<boolean>;
}
```

`BusyInterval` is `{ start, end }` in UTC, merged and sorted. Normalization happens in the adapter, never in the solver.

**An unreadable or disconnected calendar returns one interval covering the entire window — fully busy.** This is the single most important line in the spec. The failure mode must be "we didn't offer a slot," never "we double-booked an interviewer." A provider error is *never* interpreted as free.

Implementations: `RadicaleCalendarProvider` (default), `SeededCalendarProvider` (unit tests — no container needed).

## 5. Data model

`interview_loops` already exists (ARCHITECTURE §5). Additions:

```sql
create table interview_rounds (          -- the template: what the loop must contain
  id uuid primary key, tenant_id uuid not null,
  loop_id uuid not null references interview_loops,
  kind text not null,                     -- coding | system_design | values | hiring_manager
  duration_min int not null,
  position int not null,                  -- order within the loop
  is_swappable boolean not null default false,   -- reserved; see §7
  unique (loop_id, position)
);

create table interview_round_panelists (
  round_id uuid references interview_rounds,
  user_id uuid references users,
  is_required boolean not null default true,
  primary key (round_id, user_id)
);
```

`interviews` (already specced) holds the *scheduled instance* of a round: `scheduled_start`, `scheduled_end`, `status`, `external_event_id`. A round with no interview row is unscheduled.

**Holds** live on `interview_loops.hold_expires_at` + `held_by`, with a Redis key `hold:{loopId}` at matching TTL for fast conflict checks. Postgres is the source of truth; Redis is the index. A sweep job expires holds whose `hold_expires_at` has passed — expiry must not depend on the read path, or an expired hold stays visible until someone happens to look.

## 6. Availability

- Fetch a rolling 21-day window per panelist; cache in Redis at `freebusy:{tenant}:{user}:{date}` with a **5 minute TTL**.
- Cache is per user per day, so one panelist's refresh doesn't invalidate the grid.
- Fetches are batched and parallel with a concurrency cap; one slow calendar must not serialize the others.
- **Candidate availability** ("candidate available 9 to 4") is stored on the loop in the candidate's IANA zone and rendered in the organizer's. It constrains the solver as a hard bound.
- Business hours: a single per-tenant window in M2. Per-user working hours are out of scope.

## 7. The solver

Inputs: rounds (duration, required panelists), per-panelist busy intervals, candidate window, business hours, max loop span, allowed gap.

**M2 scope — fixed round order.** Rounds are placed in their `position` order.

```
1. Build a busy bitmap per panelist over the day at 15-minute granularity.
   Bitmaps make overlap a bitwise AND instead of interval arithmetic — the
   difference between readable code and a subtle off-by-one at boundaries.
2. For each grid start within the candidate window:
     place rounds sequentially, back to back, allowing gaps up to maxGapMin.
     A round fits when every required panelist is free for its full duration.
3. Score valid arrangements: fewer gaps, earlier finish, shorter total span.
4. Return the top 3.
5. Time-box to 200ms. If the box is hit, return the best found so far and
   flag the result as partial — never hang the screen.
```

**Deferred: swappable-round permutation.** `is_swappable` exists in the schema but is ignored in M2. The follow-up permutes swappable rounds (capped at 4! = 24 orderings) and scores across all of them. Isolated by design — it wraps step 2 without changing anything else.

**When no arrangement exists, the solver returns the blocker, not an empty list.** This is what produces the reference screen's message. Specifically: the round that failed to place, the earliest grid time it was attempted, and the required panelist(s) busy at that time. That structured result renders as *"Maya Reyes is busy at 10:00. Pick a clear row or the loop needs a gap."* — never a generic "no availability found," which tells a recruiter nothing about what to change.

**The blocker is a union, not one case.** This section originally named only `panelist_busy`. Eight reasons ship, because §12 and §7a each demand distinctions a single case can't carry:

| Reason | Why it must be distinguishable |
|---|---|
| `panelist_busy` | The §7 case — renders the reference screen's message |
| `window_too_narrow` | §12.2 requires this be stated, not folded into a generic failure |
| `span_too_short` | Max loop span excludes what the candidate window would allow |
| `timed_out` | §12.11 — pairs with the partial flag |
| `no_rounds` | A loop with no round template is a data problem, not a scheduling one |
| `outside_window` | Manual placement only (§7a) |
| `rounds_overlap` | Manual placement only (§7a) |
| `unknown_round` | Manual placement only (§7a) — a client-supplied round id not in this loop needs an answer that isn't a 500 |

The last three exist because §7a made `validateArrangement` a server-side gate over client-supplied input. A contracts test compares the Zod union's literals against the domain's `BLOCKER_REASONS` so the two cannot drift.

**Two fail-closed boundary rules**, decided where this spec was silent, both chosen so the error direction is "no slot offered":
- A panelist absent from the busy map entirely is **fully busy**, not free — "no intervals" and "we never read it" must not be the same value with opposite meanings.
- A busy interval covering *any part* of a 15-minute slot blocks the **whole** slot, so a 10:05 meeting does not leave the 10:00 row looking free.

The solver is a **pure function**. No I/O, no database, and no ambient clock — the 200ms time box takes an injected `now: () => number` defaulting to `Date.now`, and every test passes `() => 0` so property runs are genuinely deterministic. It lives in `packages/domain` and gets `fast-check` property tests: no arrangement ever overlaps a busy interval; every arrangement lies inside the candidate window; a fully-busy panelist always yields zero arrangements.

## 7a. Manual placement

**Decided 2026-08-08 (§14 Q1): in scope for M2.** The recruiter can place rounds by hand instead of taking a solver arrangement.

This adds no second code path, and must not. The solver already answers one question internally — *does this round fit at this start, for every required panelist* — and manual placement asks exactly that question, one round at a time. So:

- `validateArrangement(arrangement, inputs)` is extracted from the solver and becomes the shared predicate. It is pure, lives beside the solver in `packages/domain`, and returns **the same structured blocker shape** as §7. The solver calls it; manual placement calls it; hold and send call it server-side.
- A manually placed arrangement and a solved one are the same `Arrangement` value downstream. Hold, send, and the §10 re-validation cannot tell them apart and must not try.
- **The server never trusts a client-supplied arrangement.** Manual placement is validated at the API boundary on hold and again on send, against freshly fetched availability. The client-side check is for feedback speed, not for correctness.

**Overriding a hard constraint.** A recruiter often knows something the calendar doesn't ("she said she'd move that"). So a violation is not a hard block: the same conflict callout renders with a "Place anyway" confirmation, and taking it records `manual_override = true` plus the acknowledged blocker on the interview row, so the audit trail says a human chose it. Soft-constraint violations (gaps, span, late finish) place silently — they were only ever scoring inputs.

<!-- ponytail: one override flag covering every constraint class, not a per-constraint policy
     matrix. Ceiling: if we ever need "candidate window is overridable but a known-busy
     panelist is not", that becomes a per-constraint enum. It does not need to be one now. -->

Out of scope even so: dragging to resize a round's duration, and reordering rounds by drag (position is the template's, and §7's swappable permutation is still deferred).

## 8. Timezones

All storage UTC. Every user and candidate carries an IANA zone. Conversion happens at render.

**DST is the bug class that humiliates a recruiter in front of a candidate**, so it gets explicit tests: a loop spanning a spring-forward boundary, a candidate in a zone with a 30-minute offset (Asia/Kolkata against America/Chicago), and a panelist whose zone changes DST on a different date than the organizer's. Fixture-based, in CI.

> **Corrected 2026-08-08.** An earlier draft of this section claimed "a 10:00–14:00 window is one hour shorter in wall-clock terms" on a spring-forward day. That is arithmetically wrong: the US transition is at 02:00 local, so a 10:00–14:00 window on 8 March 2026 is a full four hours. **Only a window containing the transition loses an hour.** The fixture therefore uses 01:00–05:00 — four wall-clock hours, three real ones — and a companion test asserts 10:00–14:00 is *un*affected, so the correction can't quietly regress.

## 9. Holds

"Hold slot for 24h" — a soft reservation so the recruiter can confirm with the candidate without losing the slot.

1. Acquire the Redis lock `hold:{loopId}`; reject if another user holds it.
2. Write `hold_expires_at = now() + 24h`, `held_by`, status `held`.
3. Write **tentative** `VEVENT`s (`STATUS:TENTATIVE`) to each panelist's calendar so the time visibly blocks. **The event names the candidate** — decided 2026-08-08 (§14 Q3): `SUMMARY:Interview — Ana Petrova (System design)`. A panelist seeing "Interview loop — Talon" with no name can't tell one hold from another and can't prepare. The privacy cost is real and accepted: in a calendar configuration where a panelist's event titles are company-visible, the candidate's name is too.
4. Sweep job expires holds and deletes the tentative events.

**A hold does not guarantee the slot.** An interviewer can still book over it in their own calendar — Radicale won't stop them. That is why §10's re-validation exists, and why "held" is not "confirmed."

## 10. Sending invites

The step where correctness matters most.

```
1. Re-fetch free/busy for every panelist, bypassing cache.
2. Diff against the held arrangement.
3. If ANYTHING changed → abort. Show what changed and offer to re-solve.
   Do not send. Do not "try anyway."
4. Otherwise, in one transaction: write interviews rows, status confirmed.
5. Queue calendar writes with idempotency keys — a retry must not create
   duplicate events.
6. Replace tentative VEVENTs with confirmed ones (STATUS:CONFIRMED).
7. Generate an .ics for the candidate and attach it to the itinerary email.
```

Step 1–3 is the whole point. Availability is up to 5 minutes stale from cache, and 5 minutes is enough for someone to book over your slot.

**Attendee responses:** Radicale has no iTIP, so responses aren't read back. `interview_panelists.response` is updated through the app — a panelist marks accepted or declined in Talon. A decline flips the round to `pending`, raises a next-action on the candidate profile, and offers a re-solve. When a Google adapter lands, responses arrive via push and this becomes automatic; the data model doesn't change.

## 11. UI

Per DESIGN_SYSTEM §4 (SchedulingGrid).

Left pane: rounds as cards with panelist avatar, kind and duration, confirmed/pending pill. Conflict callout in `feedback.warningBg` naming the person and the time. Bottom: "Hold slot for 24h" (secondary), "Send invites, 10:00 AM Aug 6" (primary — the label states the exact commitment).

Grid: one column per panelist, sticky headers, `schedulingRowHeight` rows. Busy blocks use `calendar.busyFill` with a **45° hatch** — the hatch, not the fill, is what makes busy readable in greyscale and for colorblind users. Selected loop slot spans contiguous columns with a 2px stroke. Free rows annotated "All free."

**States:** loading (skeleton grid), no-arrangement (blocker message + suggestions), partial-solve (top arrangements plus a note that the search was time-boxed), calendar-disconnected (per-panelist indicator — that person shows fully busy and the UI says why), hold-held-by-someone-else, send-blocked-by-drift (the §10 diff).

Keyboard: the grid is navigable and a slot selectable without a pointer. Day/Week toggle.

**Manual placement (§7a):** selecting a round then a grid slot places it there — pointer or keyboard, the same two-step, no drag required. Placement runs `validateArrangement` and renders any violation as the same conflict callout the solver produces, with "Place anyway" alongside it. There is no separate "manual mode" toggle; a solved arrangement is simply the starting point you can move.

## 12. Edge cases

1. **Panelist's calendar unreachable** → fully busy, with a visible per-panelist indicator. Never silently free.
2. **Candidate window narrower than the loop's total duration** → solver returns zero with that as the stated reason, not a generic failure.
3. **A required panelist has no calendar connected at all** → block sending; name the person.
4. **Two recruiters hold the same loop** → Redis lock; the second sees who holds it and until when.
5. **Hold expires while the send is in flight** → the transaction re-checks `hold_expires_at`; expired means abort and re-solve.
6. **Calendar write partially succeeds** (2 of 4 events created) → the queue retries with idempotency keys; the loop stays `pending` until all four confirm. Never report success on a partial write.
7. **Loop spans a DST boundary** → §8.
8. **Panelist removed from the tenant between hold and send** → abort, name them.
9. **Candidate withdraws mid-loop** → cancel the loop, delete events, release the hold.
10. **Duplicate send** (double-click, retry) → idempotency key on the send action; the second is a no-op returning the first result.
11. **Solver times out** → return partial with the flag, never hang.
12. **All rounds already scheduled** → the screen shows the confirmed loop, not the solver.

## 13. Test plan

| Layer | Covers |
|---|---|
| Unit (`fast-check`) | Solver: no overlap with busy, always within window, fully-busy yields zero, deterministic for a given input |
| Unit | Bitmap construction, interval merge, timezone conversion, DST fixtures |
| Unit | `validateArrangement` agrees with the solver: every arrangement the solver returns validates clean, and a hand-placed overlap produces the identical blocker shape |
| Integration (Testcontainers + Radicale) | Real CalDAV reads and writes, busy computation from real `VEVENT`s, idempotent event creation |
| Integration | Hold acquire/expire/conflict; the sweep job |
| Integration | **Send re-validation: mutate a panelist's calendar between hold and send, assert the send aborts.** The single most important test in this spec |
| E2E (Playwright) | Schedule a 4-round loop against a seeded Radicale, hit the conflict, resolve it, hold, send, verify events exist |
| a11y | Grid keyboard-navigable, hatch pattern present, axe clean |

## 14. Open questions

1. ~~**Does the recruiter need to override the solver and place rounds manually?**~~ **Answered 2026-08-08 (Aditi Kala): yes, in scope for M2.** See §7a. Note this contradicts "the reference screen doesn't show it" — the screen is still authoritative for everything it *does* show; manual placement is additive to it.
2. **What happens to a held slot when the recruiter navigates away?** Assumed: the hold persists for its 24h. Alternative is releasing on unload, which is worse — a refresh would drop it.
3. ~~**Should tentative events name the candidate?**~~ **Answered 2026-08-08 (Aditi Kala): yes, name the candidate.** See §9 step 3. The privacy trade-off is accepted deliberately, not overlooked.
4. **Is a single per-tenant business-hours window enough for M2?** Assumed yes. Per-user working hours are a real gap for distributed panels.
5. **Is "fewest gaps" really the top scoring key?** §7 step 3 orders by fewer gaps, then earlier finish, then shorter span, and it is implemented literally. The consequence: a back-to-back loop at 3pm outranks a 9am loop with one 15-minute gap, and the screen's primary button names arrangement 1. If recruiters would rather be offered the earliest start, the primary key should be finish time. **Owner: Aditi Kala.** Not silently re-weighted.
6. **A candidate window is a bare date with no zone, so it means that calendar date *in the candidate's zone*.** That is the only available reading, but it bites: Asia/Kolkata "6 Aug, 09:00–16:00" against America/Chicago business hours 09:00–17:00 **does not overlap at all**, and the solver correctly answers `window_too_narrow / availableMin: 0`. Correct, and probably surprising to a recruiter who sees "no availability" for what looks like a normal workday. Whether the UI should explain the zone collision specifically is open. **Owner: Aditi Kala.**

## 15. Definition of done

Ticked boxes are done and verified in PR A. Everything unticked is PR B, and none of it is started — no gate currently guards it, which is the point of saying so here rather than letting a green CI imply coverage.

- [~] `CalendarProvider` with Radicale and seeded implementations; nothing outside the adapter knows CalDAV exists — **interface + `SeededCalendarProvider` done; Radicale is PR B.** The interface names no CalDAV concept and the solver never sees a provider at all, so the boundary holds already.
- [x] Solver is pure, property-tested, time-boxed, and returns structured blockers
- [~] Manual placement shares the solver's validation predicate — no second path — **`validateArrangement` done and pinned by a test asserting a hand-placed overlap returns an object equal to the solver's own blocker. Server-side re-validation at hold and send is PR B — there are no routes yet.**
- [x] The reference screen reproduces: four rounds, two pending, Maya busy at 10:00, that exact conflict message — verified by rendering at 1440×900 @2x and comparing against `docs/reference/06-scheduling@2x.png`, not by assertion alone
- [ ] Holds acquire, expire, and conflict correctly — PR B
- [ ] **Send aborts on availability drift** — tested by mutating a calendar mid-flight — PR B
- [x] DST fixtures pass — all three §8 cases plus gap/ambiguous wall-clock resolution
- [x] Full keyboard path; axe clean — every control reached by Tab, no `.focus()` or `click()` in the keyboard suite; axe clean across 11 states
- [~] Unreadable calendar reads as fully busy — **rule implemented and unit-tested three ways (disconnected user, unknown user, panelist absent from the busy map). The kill-the-container test needs Radicale: PR B.**