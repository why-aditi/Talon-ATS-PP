# Talon — Design System

How `design-tokens.json` becomes components. Read alongside the reference screens.

---

## 1. The visual thesis

Talon looks like a tool, not a dashboard. Three decisions carry the whole identity, and every component should be checked against them:

1. **Warm neutrals, not gray.** The canvas is `#F6F4F1` — a paper-warm off-white against pure-white surfaces, and together those two account for ~95% of every screen. This is what stops it reading as generic SaaS. Never substitute a cool gray; the warmth is the brand.
2. **Borders over shadows.** Surfaces separate with a 1px `border.default` and a background-value step. Elevation is reserved for things that are genuinely floating: dragged cards, popovers, modals. A shadow on a static card is a bug.
3. **Indigo is scarce.** One saturated indigo (`#4C56C8`) appears in exactly three places — the primary button, the active nav item, and the selected state. Everything else is neutral or a status hue. The moment indigo appears on a fourth kind of element, the primary action stops reading as primary.

The one place to spend boldness is the **stage-hue system**: each pipeline stage owns a hue that stays consistent across the kanban column header, the candidate header chips, and the funnel bars. That consistency is what makes the product feel coordinated rather than assembled, and it costs nothing at runtime.

## 2. Token pipeline

```
design-tokens.json
  → packages/tokens/build.mjs
      → packages/tokens/dist/tokens.css        (Tailwind v4 @theme block; emits :root
                                                custom properties and the utilities)
      → packages/tokens/src/tokens.generated.ts (typed keys for JS consumers, committed)
```

**Amended 2026-08-07 (spec 001 step 5).** This originally specified style-dictionary emitting three files. It is a ~140-line script emitting two, because SD would have needed custom transforms for the composite `typography.scale` entries, the `{ref}` syntax and the `layout`/`motion` groups — more configuration than the script is code. Revisit if a second platform ever needs the same tokens; that is what SD actually buys. The CSS and the TS map are one file each because Tailwind's `@theme` already emits the custom properties, so a separate `tokens.css` would be the same content twice.

Two consequences worth knowing:

- The block is `@theme static`. Without `static`, Tailwind emits only the variables some utility references, and tokens reached through inline `var()` — the avatar fills, picked by a hash at runtime — vanish from the output.
- It opens by clearing Tailwind's own scales (`--color-*: initial`, `--spacing-*: initial`, and so on). `bg-slate-500` and `text-sm` therefore do not compile at all, which is a stronger guarantee than a lint rule. The cost is that a utility naming a value we don't ship (`top-1.5`) silently produces no declaration rather than an error — `apps/web/src/test/token-usage.test.ts` is the guard for that.

Rules:
- Components consume **semantic** tokens only. A component referencing `--color-indigo-600` instead of `--color-action-primary-bg` fails lint (`stylelint-declaration-strict-value` with a token allow-list).
- Raw hex in `.tsx` or `.css` outside `packages/tokens` fails CI.
- Dark theme is a second `[data-theme="dark"]` block over the same semantic names — no component changes required. Not shipping in v1, but the naming is already dark-ready, which is the only expensive part.

### 2.1 Pinning typography (do this in M1)

Type sizes in the tokens are provisional — the source file isn't available, and font metrics can't be recovered reliably from raster. Don't try to fix this by measuring pixels harder. Fix it by comparison, once there's something to compare:

1. Build the Jobs list screen against the current tokens.
2. Screenshot it at 1440×900, then at 2x.
3. Open it beside `docs/reference/02-jobs-list@2x.png` in Claude in Chrome and difference the two. Type that's a point too small shows up immediately as drifting baselines down the column — much more visible than any single glyph measurement.
4. Adjust the scale, not individual components. If `pageTitle` is off, it's off everywhere by the same amount.
5. Once the Jobs screen lands, the other eight will be close, because they share the ramp.

Do the same for the font family. `Inter Tight` is a stand-in for a warm geometric grotesk; render the hero line "Hiring, coordinated." in two or three candidates and compare letterforms against `01-sign-in@2x.png` — the lowercase **g**, the **a**, and the terminal on the **t** are where grotesks differ most visibly.

When the type scale is confirmed, update `_meta.confidence.typography` in the tokens file to `HIGH` and say what pinned it. Leaving a stale `LOW` on a value that's since been verified is its own kind of bug.

## 3. Primitives

### Button

| Variant | Background | Text | Border | Use |
|---|---|---|---|---|
| `primary` | `action.primaryBg` | `text.onPrimary` | none | One per view. Sign in, + New job, Advance, Send invites, Send for approval |
| `secondary` | `action.secondaryBg` | `text.primary` | `action.secondaryBorder` | Edit job, Preview letter, Schedule |
| `ghost` | transparent → `action.ghostBgHover` | `text.secondary` | none | Icon buttons, table row actions |
| `danger` | transparent → `action.dangerBgHover` | `action.dangerText` | `border.danger` | Reject |

Heights `controlHeight.sm|md|lg`; radius `md`; padding `space.3` / `space.4`; label `bodyStrong` at md. Focus is `shadow.focusRing` — never `outline: none` without a replacement. Disabled uses `action.disabledBg` + `action.disabledText`, not opacity, so text stays legible.

Buttons that carry a keyboard shortcut render it as a `code`-styled chip inside the button at `text.tertiary` (Reject `R`, Advance to Screen `A`).

### Pill / Badge

Radius `sm`, padding `2px 8px`, type `caption`, `bg`/`text` pair from `status.*`. Status is never color-only — the label is always present. Count badges (sidebar `6`, `9`, `4`) use `caption` at `text.tertiary`, switching to `bg.selected` + `text.link` when the row is active.

### Tag

Source and skill tags on pipeline cards: radius `xs`, `bg.canvas` fill, `text.secondary`, no border, `caption`. They are metadata, not status — keeping them neutral is what lets the stage hues stay meaningful.

### Avatar

Circle, `full` radius, initials in `caption` bold, white on a color from `avatar.1–8` chosen by a stable hash of the entity id. Sizes 20 / 24 / 32 / 44. Never let two teammates in one view collide — the hash is on id, not name, so a rename doesn't reshuffle the board's colors.

### Input / Select

Height `controlHeight.lg`, radius `md`, `border.default`, placeholder `text.placeholder`, focus swaps border to `border.focus` plus `shadow.focusRing`. Labels sit above at `bodyStrong`. Error state: `border.danger` + a message at `feedback.dangerFg` — the message says what to do, never just "Invalid".

### Progress rule

The thin capsule under kanban column headers and in the job-list rows: 3px tall, `full` radius, track `border.subtle`, fill in the stage hue (or a left-to-right gradient across stage hues for the job-row distribution bar).

## 4. Composite components

### AppShell

Sidebar `layout.sidebarWidth`, `bg.surface`, right border `border.default`. Sections labelled with `eyebrow` at `text.tertiary` (RECRUIT / COORDINATE / INSIGHTS). Nav items: 32px tall, radius `md`, `text.secondary` → active state `bg.selected` + `text.link` + a 2px indigo left marker. User block pinned to the bottom with a sign-out icon button.

Topbar `layout.topbarHeight`: breadcrumb at `meta` with the current page in `bodyStrong`, a centered-right search field that opens the `⌘K` palette, and a notification bell with a `red.500` dot when unread.

### JobRow

Full-width surface card, radius `lg`, `border.default`, `rowHeight` 52px, hover raises background to `bg.surfaceHover` and border to `border.strong` (no shadow, no lift). Grid: title + `code · location` in `code`/`meta` → recruiter avatar + name → distribution bar with "18 in process" beneath at `meta` → active count → status pill. Department groups are separated by an `eyebrow` header, not a divider.

### PipelineBoard

Columns at `kanbanColumnWidth`, background `bg.surfaceSunken`, radius `lg`. Column header is sticky: a 6px stage-hue square, name, count, and a `+` ghost button; below it the conversion rate right-aligned at `meta` and median time in stage at `text.tertiary`.

**Card**: `bg.surface`, radius `md`, `border.default`, padding `space.3`, `shadow.xs`. Name at `cardTitle`, sub at `meta`, tags row, then a footer line "3d in stage · Loop Thu" at `text.tertiary`. Optional score chip top-right at `caption` on `bg.canvas`. A stalled card swaps its footer to `text.danger` at `bodyStrong` and gets a 2px `red.500` left edge — color plus weight plus position, so the signal survives a colorblind viewer and a grayscale print.

**Drag**: source card drops to `opacity.dragSource`; the lifted card takes `shadow.dragging` and a 2° tilt; the target column tints to `bg.selected`; drop settles with `motion.easing.spring` at `duration.base`. Keyboard path: focus a card, `Space` to pick up, arrows to move, `Space` to drop, `Esc` to cancel — with a live region announcing "Ana Petrova moved to Onsite, position 1 of 2."

### ReviewInbox

Two panes. Left `reviewListWidth`: a thin progress rule at the top, then rows with avatar, name, subtitle, and age; the selected row is `bg.selected` with an indigo left marker. Right pane: candidate header with the two shortcut buttons, then bordered sections — COVER NOTE and RESUME HIGHLIGHTS as `eyebrow`-labelled cards, with a SIGNAL panel in a narrow right column where each signal is a label plus a value pill. Keyboard legend sits under the signal panel at `meta`, `text.tertiary`. Each signal pill is hoverable to reveal how it was computed.

### CandidateProfile

Header: 44px avatar, name at `sectionTitle`, subtitle at `meta`, actions right-aligned (danger / secondary / primary). Beneath, the stage chip row — completed stages `bodyStrong` in `text.secondary` with hairline borders, current stage filled at `stage.*` 50-tint with the stage hue as text, future stages at `text.tertiary`, separated by `·`. Time in current stage trails at `meta`.

**Next action banner**: `feedback.infoBg`, radius `lg`, no border, `eyebrow` label "NEXT ACTION" then the sentence at `bodyStrong`, action button right-aligned. This is the most important element on the screen and should be the only indigo-adjacent block above the fold.

**Timeline**: a 1px `border.subtle` vertical rail with 8px dots colored by event type (stage change → stage hue, scorecard → `green.500`, email → `neutral.400`, system → `neutral.300`). Each entry is a bordered surface card with title at `bodyStrong`, detail at `body`, timestamp right at `text.tertiary`.

Right rail `detailRailWidth`: `eyebrow`-labelled groups (DETAILS / JOB / LINKS), each field a `caption` label over a `body` value. Links render as pill buttons in `bg.selected` / `text.link`.

### SchedulingGrid

Left pane lists loop rounds as cards with avatar, name, "Coding, 60 min" at `meta`, and a Confirmed/Pending pill. Conflict callout below in `feedback.warningBg` at `body` — the copy names the person and the time, never a generic failure.

Grid: one column per panelist with a sticky header, `schedulingRowHeight` rows, `calendar.gridLine` separators. Busy blocks use `calendar.busyFill` with a 45° hatch at `opacity.hatch` — the hatch, not the fill, is what makes busy readable in grayscale and for colorblind users. The selected loop slot spans contiguous columns with `calendar.selectedStroke` at 2px and `calendar.selectedFill`. Free rows are annotated "All free" in `calendar.freeText`. A legend sits top-right.

Bottom of the left pane: "Hold slot for 24h" as `secondary`, "Send invites, 10:00 AM Aug 6" as `primary` — the primary button states the exact commitment it makes, which is the one place verbosity in a label is correct.

### OfferBuilder

Two columns. Left: a definition table with `caption` labels and `bodyStrong` values, band chips right-aligned in `status.activeBg`/`activeText` when in band, switching to `feedback.warningBg`/`warningFg` when out of band. Version marker "v2 · edited 3h ago" sits at `text.tertiary` next to the status pill. Approval chain below: rows with a status dot, approver name and role, and a right-aligned status word — `green.700` approved, `amber.700` pending, `red.700` changes requested.

Right: the letter preview on `bg.surface` at `bodyLg` with `space.8` padding, terms bolded inline. It renders the same template the candidate receives; the preview is not a mockup.

### Reports

KPI tiles: surface card, radius `lg`, `eyebrow` label, `metricXl` value, delta beneath in `green.700` (up) or `red.700` (down) at `meta` — with an arrow glyph, since color alone can't carry direction. Every tile has an info affordance revealing the metric's definition.

Funnel: horizontal bars, label at `body`, track `border.subtle`, fill in the stage hue, value right-aligned in `bodyStrong` tabular. Bar length is proportional to count, never log-scaled — a funnel that hides its own drop-off is worse than no funnel.

Interview-volume chart: bars in `indigo.200` with the current week in `indigo.600`, values above at `caption`, week labels below at `text.tertiary`.

### CommandPalette

Modal at `zIndex.commandPalette`, width 560px, radius `xl`, `shadow.lg`, over `bg.overlay`. Input at `bodyLg` with no border. Results grouped by `eyebrow` section (CANDIDATES / JOBS / ACTIONS), each row with an icon, primary label, and dim context. Selected row `bg.selected`. Empty state shows recents, never a blank panel.

## 5. Accessibility contract

- Every `bg`/`text` semantic pair in the tokens file meets 4.5:1 for body and 3:1 for ≥19px. A contrast test runs over the token file in CI, so a token edit can't silently break AA.
- Status is always label + color. Calendar busy is pattern + color. Metric deltas are arrow + color.
- Focus is always visible: `shadow.focusRing`, never removed.
- The kanban has a complete keyboard path with live-region announcements; drag is an enhancement, not the only route.
- `prefers-reduced-motion` collapses transforms and durations; opacity fades remain so state changes are still perceivable.
- Minimum hit target 24×24 CSS px, 32×32 for anything on the kanban card where mis-taps move a candidate.

## 6. Copy rules

- Sentence case everywhere except `eyebrow` labels.
- Buttons name the outcome: "Send invites", "Send for approval", "Advance to Screen" — not "Submit" or "Confirm". The verb that appears on the button reappears in the confirmation toast.
- Errors and conflicts name the specific blocker and the next move: "Maya Reyes is busy at 10:00. Pick a clear row or the loop needs a gap." Never "No availability found."
- Empty states are invitations: "No candidates in Screen yet. Advance someone from Applied, or add a candidate directly."
- Never describe the machinery. "Calendar not connected" — not "OAuth token expired for provider google."
