# 003 — Job template modal

## Context and goal

`+ New job` currently points at `/jobs/new`, which does not exist. The route 404s from two
places: the primary button in the jobs header and the dashed button in the sidebar.

Screen 09 designs that destination as a full-page four-step wizard (`Role basics → Pipeline →
Hiring team → Review`). The wizard is M1 and not built. Until it is, `+ New job` should do
something useful rather than land on a dead page.

This spec covers that stopgap: a read-only job-description template, shown in a modal, with
clipboard buttons so a recruiter can paste the sections into wherever they write job
descriptions today.

**This is a deliberate deviation from screen 09, recorded as temporary.** The reference stays
authoritative for the eventual wizard. When the wizard lands, this modal is deleted and
`+ New job` returns to navigating to `/jobs/new`. Nothing in this spec should be treated as the
designed new-job flow.

### Why a template at all

No screen in the reference set contains job-description content — not the wizard, not the job
row, not the candidate profile. `Job` in `packages/contracts` and `jobs` in `packages/db` have no
description column. Job-description content is therefore new scope, not an unimplemented part of
an existing design. Keeping it static and unsaved is what keeps this a UI-only change instead of
a schema, contract, API and RLS change.

## Scope

In scope:

- A modal containing seven fixed sections of job-description boilerplate.
- Per-section "Copy" buttons and one "Copy all".
- Both `+ New job` triggers opening the same modal.
- Removal of both links to the non-existent `/jobs/new`.

Out of scope, explicitly:

- Persisting anything. No job is created, no draft is stored, nothing survives close.
- Editing the template text.
- Per-department or per-seniority variants. One generic template.
- Rich text of any kind.
- The wizard itself (screen 09), and any route at `/jobs/new`.
- Any change to `packages/contracts`, `packages/db`, or `apps/api`.

## Data model changes

**None.** No migration, no rollback, no backfill. The template is a module-level constant in
`apps/web`.

## API contract

**None.** No route is added, called, or changed. The modal issues no network request in any
state, so it has no loading state and no server error state.

## Architecture

### Modal primitive: native `<dialog>`

`HTMLDialogElement.showModal()` provides focus trapping, `Escape` to dismiss, top-layer stacking
above every `z-index`, focus restoration to the invoking element on close, and a styleable
`::backdrop`. That is the entire accessibility surface this feature needs, from the platform.

Radix Dialog was considered and rejected here. The `Select` in `components/ui.tsx` uses Radix
because the platform genuinely could not do the job — a native `<select>` popup is an OS widget
that ignores every design token. That reasoning does not transfer: nothing about `<dialog>` is
outside our control, so a dependency would buy nothing the platform is not already giving.

Consequence to accept: jsdom implements neither `showModal()` nor `close()`, so the test setup
needs a shim. Radix would have needed its own pointer-capture shim, so this is not a cost the
other option avoided.

### Shared open state: context in `app-shell.tsx`

The two triggers live in components that are not in a props relationship — the sidebar button is
inside `AppShell`, the header button is inside `JobsScreen`, and they meet only as `children`
through `(app)/layout.tsx`.

Non-negotiable #5 requires both to be one code path, so the state has to be shared. A ~12-line
context provider in `app-shell.tsx` does it: `AppShell` owns the `useState`, renders exactly one
`<JobTemplateModal>`, and exposes `useJobTemplate().open`.

The alternative was URL-driven state (`?new=1`), which would additionally give back-button
dismissal and a linkable modal. It was rejected for this stopgap because reading
`useSearchParams()` inside a layout forces a Suspense boundary in Next 15, which is a structural
change to `(app)/layout.tsx` for a component scheduled for deletion. Worth revisiting if the
modal outlives the wizard's arrival.

## UI spec

The modal has one visual state. There is no loading, empty, error, or permission-denied state,
because there is no request and no per-role behaviour (see Permissions).

### Backdrop

`dialog::backdrop` uses `--color-bg-overlay`. The dialog sits in the top layer, so it needs no
`z-index`; `--z-modal` is deliberately unused rather than applied defensively.

### Dialog container

| Element | Token |
|---|---|
| Surface | `--color-bg-surface` |
| Border radius | `--radius-xl` |
| Shadow | `--shadow-lg` |
| Width | `w-full max-w-2xl` — Tailwind's container scale, which the token build leaves intact (`sign-in.tsx` already uses `max-w-xl`). No new token: a `--layout-*` addition was considered and dropped as unnecessary once the container scale was confirmed to survive the `--spacing-*: initial` reset. |
| Max height | `85vh`, body scrolls, header and footer stay fixed |
| Padding | `--spacing-6` |

### Header

- Title "Job description template", `--text-page-title`, `--color-text-primary`.
- Supporting line, `--text-body`, `--color-text-secondary`: names this as a starting point and
  says plainly that nothing here is saved. A recruiter must not be able to mistake it for a
  draft.
- "Copy all" button, `buttonClass('secondary')`.
- Close button, ghost variant, `aria-label="Close"`.

### Section

Seven of them, in this order:

1. About the role
2. Responsibilities
3. Minimum qualifications
4. Preferred qualifications
5. Compensation and benefits
6. Interview process
7. Equal opportunity

Each renders a heading (`--text-card-title`, `--color-text-primary`), its body as a `<ul>` of
`--text-body` / `--color-text-secondary` lines, and a per-section "Copy" button. Sections are
separated by `--color-border-subtle`.

Compensation and benefits contains **placeholder copy only** — no band, no figure, no reference
to any job's actual compensation. See Permissions.

### Copy feedback

On success the button label swaps to "Copied" for 2 seconds. On failure it swaps to "Couldn't
copy" in `--color-feedback-danger-fg` and stays until the next attempt. Both are announced
through one `aria-live="polite"` region, so the confirmation is never carried by colour or by a
visual-only label change.

## Behaviour

- Both `+ New job` triggers call the same `open()`. Neither navigates.
- Opening calls `showModal()`; closing calls `close()`.
- `Escape` closes. Native behaviour, not a key handler.
- Clicking the backdrop closes. This needs an explicit handler: a native `<dialog>` does not
  dismiss on backdrop click, and the click target is the dialog element itself, so the handler
  must compare `event.target === dialogRef.current` or it will also fire for clicks on the
  content.
- Focus moves into the dialog on open and returns to the trigger that opened it on close, both
  native.
- Body scroll is locked while open — `<dialog>` does not do this, so it is set explicitly and
  restored on close.
- Copy uses `navigator.clipboard.writeText`. Per-section copies that section as
  `"<heading>\n<line>\n<line>…"`; "Copy all" joins all seven with a blank line between.
- Transitions respect `prefers-reduced-motion` through the existing rule in `globals.css`.

## Permissions

None. The template is fixed marketing-shaped copy identical for every user, so there is no
role-dependent behaviour and nothing to gate at an API layer that this feature does not touch.

Non-negotiable #2 is relevant only as a constraint on the content: the compensation section must
never render a real band, a real figure, or anything derived from a job. If a future change wants
real compensation in this modal, it needs `comp:read` enforced server-side, and that makes it a
different feature with an API call in it.

## Edge cases

1. **Clipboard rejects** (insecure origin, denied permission, no user gesture) — caught; the
   section shows "Couldn't copy"; no unhandled rejection; the modal stays open and usable.
2. **`navigator.clipboard` undefined** (older browser, non-secure context) — treated exactly as a
   rejection. The button is never rendered as working-but-silent.
3. **Copy pressed twice quickly** — the 2-second reset timer is cleared and restarted, so the
   second press does not inherit the first one's expiry.
4. **Modal closed while a "Copied" timer is pending** — the timer is cleared on unmount, so no
   state update lands on an unmounted component.
5. **Both triggers pressed** — impossible to open twice; `open()` is idempotent and `showModal()`
   on an open dialog is a no-op guarded by the state check.
6. **Viewport shorter than the content** — body scrolls inside the dialog; header and footer stay
   put; the page behind does not scroll.
7. **Viewport narrower than 640px** — width falls back to `100vw - 2rem`; sections stack; nothing
   is clipped horizontally.
8. **`Escape` with a copy message showing** — closes normally; message state resets on next open.
9. **Screen reader opens the modal** — the dialog is labelled by its title through
   `aria-labelledby`; the supporting line is referenced by `aria-describedby`, so the "nothing is
   saved" caveat is announced rather than merely visible.
10. **Keyboard-only user** — every control (Copy all, seven Copy buttons, Close) is reachable by
    Tab, trapped inside the dialog, and focus returns to the trigger on close.

## Events emitted

None. No `audit_log` entry: non-negotiable #13 covers mutations, and this feature performs none.
Reading fixed boilerplate is not an auditable action.

## Test plan

Unit and component, in `apps/web/src/test/job-template-modal.test.tsx`:

1. The header trigger opens the dialog.
2. The sidebar trigger opens the same dialog — the assertion that both triggers are one path (#5).
3. All seven section headings render.
4. `Escape` closes the dialog and focus returns to the trigger.
5. Per-section copy calls `writeText` with that section's heading and body, and nothing else.
6. "Copy all" calls `writeText` once with all seven sections.
7. A rejected `writeText` renders "Couldn't copy" and throws nothing.
8. `navigator.clipboard` absent behaves as case 7.
9. `axe` reports no violations with the dialog open.
10. The token-usage guard covers the new file automatically, since it walks all of `src`.

E2E is deferred: `+ New job` has no flow to complete while the wizard does not exist, so there is
nothing end-to-end to assert beyond what the component tests cover.

### Blocked on

The web suite does not currently run. `jobs-screen.test.tsx` and `sign-in.test.tsx` fail to load
on stale `../mocks/node` and `../mocks/fixtures` imports left by the MSW-to-fetch-stub refactor,
and the jsdom shims the Radix `Select` needs were dropped from `setup.ts` in the same change.
Tests written against this spec cannot be demonstrated green until that is repaired. The repair
is not part of this spec.

## Open questions

1. **When the wizard lands, is this deleted or folded in?** The seven sections are content
   somebody wrote; the wizard has no place for them today. Owner: Aditi. Not blocking — the modal
   is self-contained either way.
2. **Should the template ever vary by department?** Deliberately generic for now. Owner: Aditi.
   Revisit only if a recruiter asks.
