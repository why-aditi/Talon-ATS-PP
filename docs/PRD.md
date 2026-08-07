# Talon — Product Requirements

**Product:** Talon, a multi-tenant applicant tracking system for in-house recruiting teams.
**Positioning line (from the sign-in screen):** *Hiring, coordinated.* One pipeline for every role, every interview, every offer.
**Status:** v1 scope, derived from nine reference screens.
**Owner:** Aditi Kala

---

## 1. Problem

Recruiting coordination lives in threads. A hiring team runs five to ten open roles at once, and the state of each candidate — who reviewed the resume, who has a scorecard outstanding, whether the onsite panel actually confirmed, where the offer is stuck in approvals — is spread across email, calendar invites, and a spreadsheet. The cost is not that data is missing; it's that nobody can see the whole pipeline at once, so candidates stall silently and good ones drop out.

Talon's job is to make the state of every candidate legible in one place, and to make the two most coordination-heavy steps — scheduling an interview loop and getting an offer approved — take one screen instead of twenty messages.

## 2. Goals and non-goals

**Goals**

| # | Goal | How we know it worked |
|---|---|---|
| G1 | One canonical pipeline view per role | ≥90% of stage moves happen in Talon, not retroactively logged |
| G2 | Kill the scheduling thread | Median time from "advance to onsite" to "invites sent" under 30 min |
| G3 | Make stalls visible before they cost a candidate | Stalled-candidate count trending down month over month |
| G4 | Offer approvals with a visible chain | Median offer approval cycle under 24h |
| G5 | Fast resume triage | Review inbox cleared daily; median under 20s per candidate |

**Non-goals for v1**

- Sourcing / outbound prospecting tools (a CRM for passive candidates).
- Candidate-facing job board and application portal — v1 ingests applications, it does not host the careers site. Applications arrive by API, CSV import, or manual add.
- AI resume scoring beyond deterministic signal rules (see §5.3).
- Interview question banks, structured-interview content libraries.
- Payroll / HRIS / onboarding after hire. On `Hired`, Talon emits an event and stops.
- Mobile app. The product is responsive down to tablet; the kanban is desktop-first.

## 3. Users and permissions

| Persona | In the screens | What they need |
|---|---|---|
| **Recruiting lead** (Maya Reyes) | Signed-in user across all screens | Owns roles end to end. Full pipeline, scheduling, offers, reports. |
| **Hiring manager** (Sam Altmann) | Owns SAL-076, approves Sofia's offer | Their roles only. Advance/reject, submit scorecards, approve offers. |
| **Interviewer** (Lin Chen, David Osei) | Panel members, submit scorecards | Their own interviews and scorecards. No comp, no other candidates' feedback until they've submitted their own. |
| **Approver** (Rina Patel, Finance) | Approval chain on the offer screen | Offer terms and band context. Nothing else. |
| **Admin** | Not shown | Tenant settings, SSO/SAML, members, stage templates, bands, integrations. |

**Permission model:** role-based at the tenant level, with an object-level grant for job membership. `Interviewer` is not a tenant role a person holds permanently — it's derived from being on an interview panel.

Two rules that matter and are easy to get wrong:

1. **Scorecard blindness.** An interviewer cannot read other panelists' scorecards for a candidate until their own is submitted. This is a product requirement, not a nicety — it's what makes the scores worth anything.
2. **Comp is a separate scope.** Base salary, equity, band, and comp expectation are readable only by recruiting lead, hiring manager, approvers, and admin. Interviewers never see them, even on the candidate profile they otherwise have access to.

## 4. Core domain model (product-level)

```
Tenant ──< Job ──< Application >── Candidate
                      │
                      ├──< StageTransition   (append-only, drives every metric)
                      ├──< Interview ──< Scorecard
                      ├──< Offer ──< OfferApproval
                      └──< Activity  (notes, emails, system events)
```

**The application is the unit of work.** A candidate is a person; an application is that person's journey through one job. Ana Petrova is "3d in Onsite" on ENG-204 — that duration belongs to the application, not to Ana. The same person can hold two applications at different stages, and merging duplicate candidates must not lose either.

**Stages are per-job configuration, not an enum.** The default template is Applied → Screen → Onsite → Offer → Hired, with terminal states Rejected and Withdrawn. A job may add or rename stages. Reports roll job-specific stages up to their template's canonical stage so cross-role funnels still work.

**Every metric on screen is derived from StageTransition.** "3d in stage", "median 4d", "42% pass", the funnel on Reports, "time to hire 24d" — all of it. Nothing is a stored counter. That makes backfill, correction, and audit trivially consistent, and it means a mis-drag can be undone without arithmetic drift.

## 5. Scope by screen

### 5.1 Sign-in and account

- Email + password, Continue with Google, Continue with SAML SSO.
- TOTP two-factor: enrollment with QR, six-digit verify, ten single-use recovery codes shown once. Required for admin roles, optional-but-encouraged for everyone else, enforceable tenant-wide by policy.
- SSO discovery by email domain: a user at a SAML-enforced tenant who types their email is routed to their IdP rather than shown a password field.
- Password reset, session list with revoke, "SSO enforced for admin roles" surfaced as a real policy setting.

**Acceptance:** password auth rate-limited per account and per IP with exponential backoff; failed-login and MFA-change events land in the audit log; recovery codes are hashed at rest.

### 5.2 Jobs

List grouped by department with per-department counts, each row showing: title, req code (`ENG-204`), location, recruiter with avatar, a stage-distribution bar, in-process count, active count, and status (`Active` / `On hold` / `Closing` / `Draft` / `Closed`).

- Filter by status, department, recruiter, location. Sort by recency, active count, oldest-candidate-age.
- **New job wizard,** four steps: *Role basics* (title, department, location, salary band min/max) → *Pipeline* (stage template, optional per-stage SLA) → *Hiring team* (recruiter, hiring manager, default panel) → *Review*. Saves a draft at every step; the wizard is resumable.
- Job detail tabs: Pipeline, Candidates, Job details, Hiring team.

**Acceptance:** the stage-distribution bar is computed from live application counts; "18 in process" excludes terminal states; band min/max validate min < max and are the source of truth for the band chips on the offer screen.

### 5.3 Review inbox

A triage queue for new applications, one candidate at a time: cover note, resume highlights, and a signal panel (years of experience, stack match, location fit).

- Keyboard-first: `A` advance, `R` reject, `↑`/`↓` navigate. Every action is optimistic with an undo toast.
- Progress counter ("0 of 4 reviewed today") and a queue that refills.
- Reject requires a reason code; a rejection email is optional and templated.

**Signal is deterministic and explainable in v1.** Years of experience parsed from resume dates; stack match = overlap between job's required skills and parsed resume skills, bucketed Strong/Partial/Weak; location fit compared against the job's location policy. Each signal is hoverable to show what produced it. No opaque scoring — a recruiter who can't explain a score won't trust it, and an unexplainable score is a legal liability.

**Acceptance:** advancing from the inbox writes a StageTransition identical to a kanban drag; the two paths cannot diverge.

### 5.4 Pipeline (kanban)

Columns per stage, each with a header count, a conversion rate ("42% pass"), and median time in stage. Cards show candidate name, current title/company, source tags, skill tags, time in stage, next action, and a scorecard average where one exists.

- Drag to move between stages, with optimistic UI and rollback on conflict.
- **Stall detection:** a card exceeding the stage's SLA renders in the danger color with "Stalled 8d in stage". SLA defaults per stage template, overridable per job.
- Filters: stage, source, recruiter, free-text; sort by time in stage, recency, score.
- Horizontal scroll with sticky column headers. Bulk select for reject / move / add tag / email.

**Acceptance:** two users dragging the same card concurrently — last write wins on position, but the stage change is rejected with a 409 and refetch if the from-stage no longer matches. Moving to a terminal stage prompts for a reason.

### 5.5 Candidate profile

Header with stage chips showing progress and time in current stage, primary actions (Reject / Schedule / Advance), and tabs: Activity, Emails, Interviews, Scorecards, Files.

- **Activity is the unified, reverse-chronological timeline** of system events, emails, scorecards, stage changes, and human notes with `@`-mentions.
- **Next action banner** — the single most useful element on the screen. Derived: unconfirmed panel → "Values round with Maya Reyes is still unconfirmed"; scorecard overdue > 24h → nudge; offer expiring in ≤3 days → warn.
- Right rail: contact details, source and referrer, recruiter, comp expectation, notice period, linked job, resume/LinkedIn/GitHub links.
- Email threading, two-way, with open tracking ("opened 3 times, replied in 12 min").

**Acceptance:** timeline is paginated and filterable by event type; notes are editable for 15 minutes then immutable; PII fields (email, phone) are redacted for users lacking the contact scope.

### 5.6 Scheduling

The hardest screen and the one with the most product value. A multi-interviewer availability grid for one day (or week), with the loop's rounds listed alongside and each round's confirmation status.

- Reads real free/busy from Google Calendar and Microsoft 365 for every panelist.
- Overlays the candidate's stated availability window ("candidate available 9 to 4", in the candidate's timezone, displayed in the organizer's).
- **Conflict messaging is specific and actionable:** "Maya Reyes is busy at 10:00. Pick a clear row or the loop needs a gap." Never a generic "no availability."
- Proposes valid loop arrangements: given N rounds with durations and required interviewers, find contiguous or gapped arrangements where everyone is free. Rounds can be marked swappable in order.
- **Hold slot for 24h** — a soft reservation on panelist calendars that auto-expires, so a recruiter can confirm with the candidate without losing the slot.
- Send invites: one calendar event per round plus a candidate-facing itinerary email with a reschedule link.

**Acceptance:** free/busy is never more than 5 minutes stale at send time — the system re-validates immediately before sending and blocks with a diff if anything changed. Timezone handling is tested across DST boundaries. A declined invite reopens the round as `Pending` and fires a next-action.

### 5.7 Offers

Offer builder with band context, an approval chain, and a live letter preview.

- Fields: level, base salary, equity, sign-on bonus, start date, expiry. Base and equity show band position inline (`band $190k to $225k`, `band midpoint`); out-of-band values are allowed but force a justification note and add an extra approver.
- **Versioned.** The screen shows `v2 · edited 3h ago`. Editing an approved offer resets approvals downstream of the change and records why.
- Approval chain is sequential with named approvers and roles; each step shows Approved / Pending / Changes requested, with timestamp and comment.
- Letter preview renders the same template that gets sent; e-signature is out of scope for v1, so the send action produces a PDF and an email.
- On acceptance: application → Hired, an event fires for downstream HRIS, the req's remaining openings decrement, and the job may auto-close.

**Acceptance:** an offer cannot be sent until every approval is green; approval state transitions are audit-logged with actor and IP; comp fields are scope-gated at the API layer, not just hidden in the UI.

### 5.8 Reports

Four KPI tiles (time to hire, offer accept rate, active candidates, interviews this week) each with a period-over-period delta; a funnel from Applied → Hired; hires by source; and an eight-week interview-volume trend.

- Filters: date range, department, job, recruiter.
- Definitions are documented in-product on hover — "time to hire" means application-created to offer-accepted, median not mean, and every tile says so. Undefined metrics are worse than no metrics.
- CSV export for every chart. Scheduled email digest is v1.1.

**Acceptance:** report queries run against a read replica and are cached for 5 minutes; every number is reproducible from the raw event log.

### 5.9 Global search and navigation

- `⌘K` palette: candidates, jobs, and actions in one ranked list, keyboard-navigable, recents first when the query is empty.
- Sectioned sidebar (Recruit / Coordinate / Insights) with live counts.
- Notification bell: mentions, scorecard requests, approval requests, declined invites, stalled candidates.

**Acceptance:** search returns in under 150ms at p95 for a tenant with 100k candidates; results are tenant-scoped and permission-filtered *before* ranking, never after.

### 5.10 Bulk import

- CSV upload for candidates and applications, plus an ATS-migration mode.
- Column mapping UI with saved mappings, dry-run validation returning a per-row error report, and a downloadable error CSV.
- Duplicate strategy chosen at import: skip / update / create-anyway, matched on email then on name+company.
- Imports are resumable and idempotent — re-uploading the same file does not double-create.
- Bulk actions from the pipeline: reject with reason, move stage, tag, email.

**Acceptance:** a 50k-row import completes without blocking the UI, reports progress, and is fully rolled back if the file fails structural validation.

## 6. Cross-cutting requirements

**Audit.** Every mutation records actor, tenant, entity, before/after, timestamp, IP, and request ID. The sign-in screen claims SOC 2 Type II; that claim is only defensible if the audit log is complete and immutable.

**Candidate data rights.** Per-tenant retention policy with automatic purge, plus on-demand export and erasure for a candidate. Erasure anonymizes the candidate record while preserving aggregate metrics — you must be able to delete a person without corrupting last quarter's funnel.

**Notifications.** In-app plus email, per-user digest preferences, and quiet hours.

**Accessibility.** WCAG 2.1 AA. Specifically: the kanban must be fully operable by keyboard (move-card dialog as the non-drag path), status is never encoded by color alone, and all interactive targets are ≥24×24 CSS px.

**Performance budgets.** Pipeline board interactive in <1.5s on a 3-column, 200-card job; drag-to-drop feedback <100ms; report page LCP <2.5s.

**Internationalization.** v1 ships English only but stores all timestamps in UTC with explicit timezone rendering, and all money with an explicit currency code. Retrofitting currency is expensive; skipping i18n copy is cheap.

## 7. Release plan

| Milestone | Contents | Why this order |
|---|---|---|
| **M0 — Foundations** | Boundary scaffolding (ARCHITECTURE §4.1), Terraform network/data/identity/compute, Cognito pool + pre-token Lambda, auth (email + Google + TOTP), tenancy, users, jobs list + wizard, CI/CD, seed data | Nothing is demoable without a tenant and a job — and the scaffolding must precede parallel feature work, not follow it |
| **M1 — Pipeline core** | Candidates, applications, stage transitions, kanban with drag, candidate profile, activity timeline, review inbox | This is the product's spine and the first thing worth showing |
| **M2 — Coordination** | Calendar integration, scheduling grid, loop proposals, holds, invites, interviews, scorecards | Highest-value, highest-complexity; needs M1's data |
| **M3 — Offers and insights** | Offer builder, approval chain, letter render, reports, exports | Depends on complete stage history to be meaningful |
| **M4 — Scale and polish** | Bulk import, ⌘K search at scale, notifications, bulk actions, full Playwright suite, a11y audit | Correctness before throughput |

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Calendar free/busy is stale or partially readable (private events show as opaque) | Wrong slots proposed, invites bounce | Re-validate at send; treat unreadable calendars as fully busy; per-panelist connection health indicator |
| Scheduling solver is combinatorially expensive for large loops | Slow or hanging UI | Cap search space, time-box the solver, degrade to "show me free rows" manual mode |
| Timezone and DST bugs | Candidate shows up an hour late — a trust-destroying failure | UTC storage, IANA zone per user and per candidate, DST-boundary tests in CI |
| Signal scoring is perceived as biased | Legal and reputational exposure | Deterministic and explainable only; no protected-attribute inputs; log every signal computation |
| Multi-tenant data leak | Existential | Tenant ID on every row, Postgres RLS as the backstop, tenant-isolation tests in CI that run as a hostile tenant |
| Kanban concurrency conflicts | Cards jumping, lost moves | Optimistic UI with version checks, 409 + refetch, realtime board updates |
