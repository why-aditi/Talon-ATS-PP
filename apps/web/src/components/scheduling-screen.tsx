'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLoop } from '../lib/scheduling-query';
import {
  LoopLoadError,
  isScenario,
  type InterviewStatus,
  type Panelist,
  type Placement,
  type Scenario,
  type SchedulingLoop,
  type SolveBlocker,
} from '../lib/scheduling-fixtures';
import {
  arrangementStart,
  blockerSentence,
  busyDuring,
  busyForDay,
  commonStart,
  conflictAt,
  freeFor,
  nameList,
  panelistById,
  overrideSentence,
  requiredPanelistIds,
  roundKindLabel,
  roundPlacedAt,
  roundStatus,
  rowSpans,
  rowsForDay,
  solvedArrangement,
  statusLabel,
  unreadableBlocker,
  unreadableCalendar,
  unreadableGroups,
  unreadableNote,
  unreadableSentence,
  unreadableWhy,
  validateArrangement,
  type CalendarUnreadable,
} from '../lib/scheduling-state';
import {
  clockLabel,
  dateLabel,
  dayLabel,
  hourLabel,
  timeLabel,
  weekdayLabel,
  zoneLabel,
} from '../lib/scheduling-time';
import { BusySwatch, SchedulingGrid, SchedulingGridSkeleton, type GridColumn, type GridRow } from './scheduling-grid';
import { Avatar, Button, Eyebrow, cx } from './ui';

/* ── Small parts ───────────────────────────────────────────────────────────── */

const TONES = {
  warning: 'bg-feedback-warning-bg text-feedback-warning-fg',
  info: 'bg-feedback-info-bg text-feedback-info-fg',
  success: 'bg-feedback-success-bg text-feedback-success-fg',
} as const;

/**
 * The block under the round list. `feedback.warningBg` per DESIGN_SYSTEM §4, and the
 * copy always names a person and a time — the callout exists to say what to change.
 */
function Callout({
  tone,
  children,
  action,
}: {
  tone: keyof typeof TONES;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={cx('rounded-md px-3 py-3 text-body', TONES[tone])}>
      <p>{children}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Colour per `interviews.status`, exhaustive so a new status has to be given one.
 *
 * `declined` is warning, not pending: a panelist has said no and §10 turns that into a
 * re-solve, so it must not read as "still waiting". `cancelled` and `completed` are
 * both settled and neither is an action, so they sit at secondary.
 */
const STATUS_CLASSES: Record<InterviewStatus, string> = {
  unscheduled: 'text-text-secondary',
  pending: 'text-status-pending-text',
  confirmed: 'text-status-confirmed-text',
  declined: 'text-feedback-warning-fg',
  completed: 'text-text-secondary',
  cancelled: 'text-text-secondary',
};

/**
 * A round in the loop, and the first half of the two-step placement (§7a).
 *
 * The card is the button. Pressing it picks the round up; the next grid activation
 * puts it down. Two steps rather than a drag, because the two-step is the same
 * gesture by pointer and by keyboard — a drag would need a keyboard route bolted on
 * beside it, which is exactly the retrofit the a11y contract exists to avoid.
 */
function RoundCard({
  panelist,
  kind,
  durationMin,
  status,
  unreadable,
  movedTo,
  placing,
  onPick,
}: {
  panelist: Panelist;
  kind: string;
  durationMin: number;
  status: InterviewStatus;
  /** Set when this person's availability could not be read at all — §12.1. */
  unreadable: CalendarUnreadable | null;
  /** The time it now sits at, when that is not the loop's own start. */
  movedTo: string | null;
  placing: boolean;
  onPick: () => void;
}) {
  /*
    The reference renders the status as a coloured word rather than a filled pill —
    see the note in the PR. It is still label + colour, never colour alone, so the
    accessibility contract in DESIGN_SYSTEM §5 holds either way.

    An unreadable calendar replaces it rather than sitting beside it: "Confirmed" next
    to a person whose availability we cannot read is a claim the screen is not entitled
    to make. It goes on its own line, not in the status slot — the left pane is 288px and
    a phrase that long in a `shrink-0` slot squeezed the name down to "Maya R...".
    Clipping whose interview it is, to fit a sentence about our own failure, is the wrong
    thing to lose.
  */
  return (
    <li>
      <button
        type="button"
        aria-pressed={placing}
        onClick={onPick}
        className={cx(
          'flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left',
          'transition-colors duration-[var(--duration-instant)] ease-standard',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
          placing
            ? 'border-border-focus bg-bg-selected'
            : 'border-border-default bg-bg-surface-sunken hover:bg-bg-surface-hover',
        )}
      >
        <Avatar id={panelist.id} name={panelist.name} size={24} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-card-title text-text-primary">{panelist.name}</span>
          <span className="block truncate text-meta text-text-secondary">
            {kind}, {durationMin} min{movedTo ? ` · moved to ${movedTo}` : ''}
          </span>
          {unreadable ? (
            <span className="block truncate text-meta text-feedback-warning-fg">{unreadableNote(unreadable)}</span>
          ) : null}
        </span>
        {unreadable ? null : (
          <span className={cx('shrink-0 text-body', STATUS_CLASSES[status])}>{statusLabel(status)}</span>
        )}
      </button>
    </li>
  );
}

/**
 * Day / Week, as a radiogroup — one choice, so arrows move within it and the group is
 * a single tab stop, matching `ChipGroup` in the wizard.
 *
 * The arrow handler reads the radios out of the DOM rather than keeping a ref map:
 * they are already there, already in order, and the alternative is a second source of
 * truth for something the browser is holding for us.
 */
function RangeToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: View[] = ['day', 'week'];

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;
    event.preventDefault();
    const index = (options.indexOf(view) + (forward ? 1 : options.length - 1)) % options.length;
    onChange(options[index] as View);
    // Selection follows focus in a radiogroup, so focus has to follow selection back —
    // otherwise it strands on a control that has just become untabbable.
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Grid range"
      onKeyDown={onKeyDown}
      className="flex items-center gap-1 rounded-md border border-border-default bg-bg-surface p-1"
    >
      {options.map((option) => {
        const active = view === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option)}
            className={cx(
              'h-[var(--control-height-sm)] rounded-sm px-3 text-body',
              'transition-colors duration-[var(--duration-instant)] ease-standard',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
              active ? 'bg-bg-selected text-text-link' : 'text-text-secondary hover:bg-action-ghost-bg-hover',
            )}
          >
            {option === 'day' ? 'Day' : 'Week'}
          </button>
        );
      })}
    </div>
  );
}

/** The whole screen when there is nothing to schedule against. */
function Blocked({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-border-default bg-bg-surface px-6 py-12 text-center">
      <p className="text-body-strong text-text-primary">{title}</p>
      <p className="max-w-md text-body text-text-secondary">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ── Screen ────────────────────────────────────────────────────────────────── */

type View = 'day' | 'week';

/** "Values" — the human label for a round the recruiter is holding. */
const pickedKind = (loop: SchedulingLoop, roundId: string): string => {
  const round = loop.rounds.find((r) => r.id === roundId);
  return round ? roundKindLabel(round.kind) : 'That round';
};

/** "the Values round" — used only where the sentence needs to name the held round. */
const pendingKind = (loop: SchedulingLoop, roundId: string): string =>
  `the ${pickedKind(loop, roundId)} round`;

export function SchedulingScreen({
  loopId,
  now = Date.now,
}: {
  loopId: string;
  /**
   * The clock, injected — spec §9 step 2 puts the hold at `now() + 24h`, and that has to
   * be testable without pinning it to something else. Same seam and same reason as
   * `SolveOptions.now` in `packages/domain`: a test passes a fixed clock rather than the
   * screen substituting a different quantity to make an assertion stable.
   */
  now?: () => number;
}) {
  const searchParams = useSearchParams();
  const raw = searchParams.get('state') ?? '';
  const scenario: Scenario = isScenario(raw) ? raw : 'default';

  const query = useLoop(loopId, scenario);
  const loop = query.data;

  const [view, setView] = useState<View>('day');
  const [dayUtc, setDayUtc] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /*
    Manual placement (§7a). `manual` is the whole arrangement once the recruiter has
    touched it — not a patch on the solver's, because a solved arrangement and a
    hand-placed one are the same value and nothing downstream may tell them apart.
    `null` means "still the solver's".
  */
  const [manual, setManual] = useState<Placement | null>(null);
  const [placingRoundId, setPlacingRoundId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ roundId: string; startUtc: string; blocker: SolveBlocker } | null>(null);
  /*
    §7a's override, named for the two columns it becomes: an entry here is
    `interviews.manual_override = true`, and its value is `interviews.acknowledged_blocker`
    — what the recruiter was actually shown when they chose to place it anyway. Storing
    the blocker rather than re-deriving it is the point: the audit trail has to say what
    they saw, not what the calendar says now.
  */
  const [acknowledgedBlockers, setAcknowledgedBlockers] = useState<Record<string, SolveBlocker>>({});
  const manualOverride = (roundId: string): boolean => acknowledgedBlockers[roundId] !== undefined;
  /*
    Hold and send have no endpoint to call — spec 004's write paths belong to the api
    stream (§9, §10). What is modelled here is the screen's half of each: the label the
    button commits to, the confirmation that repeats the button's verb, and every way
    the action can be refused. Wiring it up replaces these two pieces of state with
    mutations and changes nothing else on the screen.
  */
  const [heldUntil, setHeldUntil] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [driftCleared, setDriftCleared] = useState(false);

  if (query.isPending) {
    return (
      <Layout
        left={
          <div role="status" aria-busy="true" aria-label="Loading the loop" className="flex flex-col gap-3">
            <span className="h-8 w-3/4 animate-pulse rounded-xs bg-border-subtle" />
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-[var(--layout-scheduling-row-height)] animate-pulse rounded-md bg-border-subtle" />
            ))}
          </div>
        }
        right={<SchedulingGridSkeleton />}
      />
    );
  }

  if (query.isError || !loop) {
    const forbidden = query.error instanceof LoopLoadError && query.error.kind === 'forbidden';
    return (
      <Layout
        left={null}
        right={
          forbidden ? (
            <Blocked
              title="You can't open this loop."
              body="Scheduling is limited to the recruiter and coordinators on this job. Ask them to add you, or open the candidate's profile instead."
            />
          ) : (
            <Blocked
              title="The schedule didn't load."
              body="The connection dropped before the panel's availability arrived. Nothing has been sent — try again."
              action={
                <Button variant="primary" onClick={() => void query.refetch()}>
                  Try again
                </Button>
              }
            />
          )
        }
      />
    );
  }

  const zone = loop.organizerZone;
  const day = dayUtc ?? loop.dayUtc;
  const busy = busyForDay(loop, day);
  const starts = rowsForDay(loop, day);
  // Rows are irregular (…12:00, 1:00, 2:30), so each one's span comes off its
  // neighbour. Busy is an overlap against that span, never a match on the start.
  const spans = rowSpans(starts);
  // Untouched, on the loop's own day, this is exactly what the solver returned.
  const arrangement: Placement =
    manual ??
    (dayUtc === null && loop.selectedStartUtc ? solvedArrangement(loop, loop.selectedStartUtc) : {});
  const selected = arrangementStart(arrangement);
  /*
    Everyone whose column reads as fully busy for a reason that is ours, not theirs — a
    calendar that is not connected, or one whose read never came back (§12.1). Both block
    the send (§12.3) and both are named, because §11 requires a per-panelist indicator
    saying *why* somebody shows fully busy.
  */
  const unreadable = unreadableGroups(loop, busy);
  const drift = driftCleared ? null : loop.drift;

  /*
    The live conflict in the arrangement on screen, or the solver's own blocker when
    nothing is placed at all. Rounds the recruiter has already said "place anyway" to
    are held out — the fact is still reported, but as the acknowledgement below rather
    than as advice they have already declined once.
  */
  const unacknowledged: Placement = Object.fromEntries(
    Object.entries(arrangement).filter(([roundId]) => !manualOverride(roundId)),
  );
  const blocker =
    Object.keys(arrangement).length > 0 ? validateArrangement(loop, busy, unacknowledged) : loop.blocker;
  const overrides = loop.rounds
    .filter((round) => manualOverride(round.id) && arrangement[round.id] !== undefined)
    .map((round) => ({ id: round.id, blocker: acknowledgedBlockers[round.id] as SolveBlocker }));

  const dayColumns: GridColumn[] = loop.panelists.map((p) => {
    const why = unreadableCalendar(loop, busy, p.id);
    return {
      id: p.id,
      label: p.shortName,
      avatar: { id: p.id, name: p.name },
      ...(why ? { note: unreadableNote(why) } : {}),
    };
  });

  const dayRows: GridRow[] = spans.map(({ startUtc: start, endUtc: rowEnd }) => {
    const label = timeLabel(start, zone);
    const busyHere = loop.panelists.filter((p) => busyDuring(busy, p.id, start, rowEnd));
    return {
      key: start,
      label,
      description: `${label}, ${busyHere.length === 0 ? 'all free' : `${nameList(busyHere.map((p) => p.name))} busy`}`,
      cells: loop.panelists.map((p, index) => {
        const panelistBusy = busyDuring(busy, p.id, start, rowEnd);
        // A round of the loop sits in this panelist's column on this row — the solver's
        // placement and a hand-placed one are indistinguishable here, by design (§7a).
        const round = roundPlacedAt(loop, arrangement, p.id, start);
        /*
          A busy cell only draws the slot when the recruiter explicitly overrode it.
          The reference shows Maya busy at 10:00 with no slot box even though her round
          hangs off that start — an unacknowledged conflict is a conflict, not a
          placement, and drawing it as one would say the loop is fine when it isn't.
        */
        const override = round !== undefined && panelistBusy && manualOverride(round.id);
        const placed = round !== undefined && (!panelistBusy || override);
        const state = panelistBusy ? 'busy' : placed ? 'selected' : 'free';
        const visible = panelistBusy
          ? override
            ? 'Loop slot, busy'
            : 'Busy'
          : placed
            ? 'Loop slot'
            : busyHere.length === 0 && index === 0
              ? 'All free'
              : undefined;
        // Why this cell looks the way it does. A person's own full day and a calendar we
        // could not read are both "busy" in the grid and must never read the same in
        // words — one is a fact about them, the other about us (§11, §12.1).
        const cannotRead = unreadableCalendar(loop, busy, p.id);
        const why = panelistBusy
          ? override
            ? `${p.name} is busy at ${label}, and the loop slot was placed there anyway`
            : cannotRead
              ? `${p.name} reads as busy at ${label} — ${unreadableWhy(cannotRead)}`
              : `${p.name} is busy at ${label}`
          : placed
            ? `${p.name} is holding the loop slot at ${label}`
            : `${p.name} is free at ${label}`;
        return { state, ...(visible ? { label: visible } : {}), description: why, placed };
      }),
    };
  });

  const weekColumns: GridColumn[] = loop.week.map((d) => ({ id: d.dayUtc, label: weekdayLabel(d.dayUtc, zone) }));

  const weekRows: GridRow[] = loop.rows.map((row, rowIndex) => {
    const label = timeLabel(row.startUtc, zone);
    return {
      key: `week-${row.startUtc}`,
      label,
      description: label,
      cells: loop.week.map((d) => {
        const daySpans = rowSpans(rowsForDay(loop, d.dayUtc));
        const span = daySpans[rowIndex] as { startUtc: string; endUtc: string };
        /*
          Through `busyForDay`, never `d.busy` — the week array carries its own copy of the
          loop's day, and the scenarios that make a calendar unreadable (§12.1) edit only
          `loop.busy`. Reading the week's copy served the un-edited one, so the same day
          said "Availability didn't load" in the Day view and offered 11:00 as "All free"
          in the Week view. Non-negotiable 6 has a direction: absent reads as busy in both
          views or the screen is offering a slot it cannot stand behind.
        */
        const dayBusy = busyForDay(loop, d.dayUtc);
        const busyHere = loop.panelists.filter((p) => busyDuring(dayBusy, p.id, span.startUtc, span.endUtc));
        const free = busyHere.length === 0;
        return {
          state: free ? ('free' as const) : ('busy' as const),
          label: free ? 'All free' : `${busyHere.length} busy`,
          description: `${weekdayLabel(d.dayUtc, zone)} at ${label}, ${
            free ? 'all four panelists free' : `${nameList(busyHere.map((p) => p.name))} busy`
          }`,
        };
      }),
    };
  });

  /** Moves the whole loop onto one row — the solver's shape, chosen by hand. */
  function selectStart(start: string, rowEnd: string) {
    const at = loop as SchedulingLoop;
    setManual(solvedArrangement(at, start));
    setAcknowledgedBlockers({});
    setPending(null);
    setPlacingRoundId(null);
    setSentAt(null);
    setHeldUntil(null);
    const conflict = conflictAt(at, busy, start);
    const label = timeLabel(start, zone);
    setAnnouncement(
      conflict
        ? `${label} selected. ${blockerSentence(conflict, zone)}`
        : `${label} selected. ${nameList(freeFor(at, busy, start, rowEnd).map((p) => p.name))} are free.`,
    );
  }

  /** The second half of the two-step: the picked-up round goes down on this row (§7a). */
  function place(roundId: string, start: string, anyway: boolean) {
    const at = loop as SchedulingLoop;
    const round = at.rounds.find((r) => r.id === roundId);
    if (!round) return;
    const kind = roundKindLabel(round.kind);
    const label = timeLabel(start, zone);
    // Scoped to the one round being placed: the arrangement may already carry an
    // unrelated conflict, and reporting that one here would name the wrong person.
    const conflict = validateArrangement(at, busy, { [roundId]: start });

    if (conflict && !anyway) {
      setPending({ roundId, startUtc: start, blocker: conflict });
      setAnnouncement(`${blockerSentence(conflict, zone)} Place anyway to put ${kind} there regardless.`);
      return;
    }

    setManual({ ...arrangement, [roundId]: start });
    // The blocker as shown, verbatim. A placement that violated nothing overrides
    // nothing, so the entry is removed rather than set to null — same invariant the
    // contract refines on (`acknowledgedBlocker` only exists when `manualOverride`).
    setAcknowledgedBlockers((current) => {
      const next = { ...current };
      if (conflict) next[roundId] = conflict;
      else delete next[roundId];
      return next;
    });
    setPending(null);
    setPlacingRoundId(null);
    setSentAt(null);
    setHeldUntil(null);
    setAnnouncement(conflict ? `${kind} placed at ${label}. Recorded as an override.` : `${kind} placed at ${label}.`);
  }

  function activate(rowIndex: number, columnIndex: number) {
    if (view === 'week') {
      const target = loop?.week[columnIndex];
      if (!target) return;
      const start = rowsForDay(loop as SchedulingLoop, target.dayUtc)[rowIndex] as string;
      setDayUtc(target.dayUtc);
      setView('day');
      setManual(solvedArrangement(loop as SchedulingLoop, start));
      setAcknowledgedBlockers({});
      setPending(null);
      setPlacingRoundId(null);
      setAnnouncement(`${dayLabel(target.dayUtc, zone)} opened at ${timeLabel(start, zone)}.`);
      return;
    }
    const span = spans[rowIndex];
    if (!span) return;
    // The column is the round's own panelist, so placement reads the row only.
    if (placingRoundId) place(placingRoundId, span.startUtc, false);
    else selectStart(span.startUtc, span.endUtc);
  }

  function pickRound(roundId: string) {
    const picked = placingRoundId === roundId ? null : roundId;
    setPlacingRoundId(picked);
    setPending(null);
    const round = loop?.rounds.find((r) => r.id === roundId);
    setAnnouncement(
      picked && round
        ? `${roundKindLabel(round.kind)} picked up. Choose a row in the grid to place it, or press Escape to leave it where it is.`
        : 'Nothing picked up.',
    );
  }

  /*
    What stops the invites going out, most specific first.

    A busy panelist on the selected row is deliberately NOT one of them. The reference
    screen shows Maya busy at 10:00, the conflict callout naming her, and "Send invites,
    10:00 AM Aug 6" enabled — because the row is the loop's START and the rounds are
    placed sequentially after it, so one person busy at the opening minute does not mean
    their round is double-booked. It is a warning about the arrangement, and §10's
    pre-send re-validation on the server is the thing that actually refuses to
    double-book. The three blockers below are the ones the spec states outright.
  */
  const sendBlockers: string[] = [];
  if (loop.rounds.length === 0) sendBlockers.push('This loop has no rounds yet.');
  if (!selected) sendBlockers.push('Pick a row before sending.');
  if (pending) sendBlockers.push(`Say where ${pendingKind(loop, pending.roundId)} goes before sending.`);
  // §12.3, and the absent-key case with it: if we could not read a required panelist's
  // calendar, we cannot claim the slot is clear, so the send is refused rather than
  // attempted. Fully busy has to be as blocking as no calendar at all.
  for (const group of unreadable) {
    sendBlockers.push(unreadableBlocker(group.panelists.map((p) => p.name), group.reason));
  }
  if (loop.holdByOther) sendBlockers.push(`${loop.holdByOther.heldByName} is holding this slot.`);
  if (drift) sendBlockers.push('Availability moved — re-solve before sending.');

  const canSend = sendBlockers.length === 0;
  const commitment = selected ? `${clockLabel(selected, zone)} ${dateLabel(selected, zone)}` : null;

  const windowLabel = `${hourLabel(loop.candidateWindow.startUtc, zone)} to ${hourLabel(loop.candidateWindow.endUtc, zone)}`;
  const candidateZoneNote =
    loop.candidate.zone === zone ? '' : ` (${loop.candidate.name.split(' ')[0]} is in ${zoneLabel(loop.candidateWindow.startUtc, loop.candidate.zone)})`;

  return (
    <Layout
      left={
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="flex items-center gap-3">
            <Avatar id={loop.candidate.id} name={loop.candidate.name} size={32} />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-section-title font-display text-text-primary">{loop.candidate.name}</span>
              <span className="block truncate text-body text-text-secondary">Onsite loop · {loop.jobTitle}</span>
            </span>
          </div>

          <Eyebrow>Loop, {loop.rounds.length} rounds</Eyebrow>

          {loop.rounds.length === 0 ? (
            <p className="rounded-md border border-border-default bg-bg-surface-sunken px-3 py-4 text-body text-text-secondary">
              No rounds in this loop yet. Add rounds to the interview template, then Talon can place them across the panel.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {loop.rounds.map((round) => {
                // M2 shows one required panelist per round; the schema allows more (§5),
                // and the extras are on the round's own detail, not this card.
                const panelist = panelistById(loop, requiredPanelistIds(round)[0] ?? '');
                if (!panelist) return null;
                const at = arrangement[round.id];
                const bulk = commonStart(arrangement);
                return (
                  <RoundCard
                    key={round.id}
                    panelist={panelist}
                    kind={roundKindLabel(round.kind)}
                    durationMin={round.durationMin}
                    status={roundStatus(round)}
                    unreadable={unreadableCalendar(loop, busy, panelist.id)}
                    movedTo={at !== undefined && at !== bulk ? timeLabel(at, zone) : null}
                    placing={placingRoundId === round.id}
                    onPick={() => pickRound(round.id)}
                  />
                );
              })}
            </ul>
          )}

          {/* Ordered by what stops the send first. Each names a person and a next move. */}
          {placingRoundId && !pending ? (
            <Callout tone="info">
              {pickedKind(loop, placingRoundId)} picked up. Choose a row in the grid to place it, or press Escape to
              leave it where it is.
            </Callout>
          ) : null}

          {/*
            The same callout the solver produces, with the same sentence — §7a is
            explicit that a violation must not get a second conflict UI. What is added
            is the confirm beside it: the recruiter often knows something the calendar
            doesn't, so a hard constraint is overridable and the override is recorded.
          */}
          {pending ? (
            <Callout
              tone="warning"
              action={
                <Button onClick={() => place(pending.roundId, pending.startUtc, true)}>Place anyway</Button>
              }
            >
              {blockerSentence(pending.blocker, zone)}
            </Callout>
          ) : null}

          {/* §7a: the override is recorded, so it is also said. An override that the
              screen stops mentioning is an audit trail nobody can read. */}
          {overrides.map((override) => (
            <Callout key={override.id} tone="info">
              {overrideSentence(override.blocker, zone)}
            </Callout>
          ))}

          {drift ? (
            <Callout
              tone="warning"
              action={
                <Button
                  onClick={() => {
                    setDriftCleared(true);
                    const next = spans.find((span) => !conflictAt(loop, busy, span.startUtc));
                    if (next) selectStart(next.startUtc, next.endUtc);
                  }}
                >
                  Find another slot
                </Button>
              }
            >
              {drift
                .map(
                  (change) =>
                    `${change.panelistName} booked ${timeLabel(change.fromUtc, zone)} to ${timeLabel(change.toUtc, zone)} while this was open.`,
                )
                .join(' ')}{' '}
              Nothing was sent.
            </Callout>
          ) : null}

          {loop.holdByOther ? (
            <Callout tone="warning">
              {loop.holdByOther.heldByName} is holding this slot until {clockLabel(loop.holdByOther.expiresUtc, zone)}{' '}
              {dateLabel(loop.holdByOther.expiresUtc, zone)}. Ask them to release it, or pick another row.
            </Callout>
          ) : null}

          {unreadable.map((group) => (
            <Callout key={group.reason} tone="warning">
              {unreadableSentence(group.panelists.map((p) => p.name), group.reason)}
            </Callout>
          ))}

          {blocker ? <Callout tone="warning">{blockerSentence(blocker, zone)}</Callout> : null}

          {loop.blocker && !selected ? (
            <Callout tone="warning">
              No arrangement fits inside {windowLabel} on {dateLabel(loop.dayUtc, zone)}. Try another day, or drop a round.
            </Callout>
          ) : null}

          {loop.partial ? (
            <Callout tone="info">
              The search ran out of time, so these are the best rows found so far. There may be better ones on another day.
            </Callout>
          ) : null}

          {heldUntil ? (
            <Callout tone="success">
              Slot held until {clockLabel(heldUntil, zone)} {dateLabel(heldUntil, zone)}. A hold is not a booking — an
              interviewer can still book over it, so send the invites once the candidate confirms.
            </Callout>
          ) : null}

          {sentAt ? (
            <Callout tone="success">Invites sent, {commitment}. The panel and Ana have the itinerary.</Callout>
          ) : null}

          <div className="mt-auto flex flex-col gap-2 pt-4">
            {/* §9 step 2: the hold runs 24h from NOW, not 24h from the slot. The callout
                below states the expiry to the recruiter, so a time measured from the wrong
                quantity is a commitment the screen cannot keep. */}
            <Button
              disabled={!selected || loop.holdByOther !== null}
              onClick={() => selected && setHeldUntil(new Date(now() + 24 * 60 * 60 * 1000).toISOString())}
            >
              Hold slot for 24h
            </Button>
            {/*
              The label states the exact commitment (DESIGN_SYSTEM §4) — the one place a
              verbose button is correct, because pressing it writes to four calendars.
              With nothing selected there is no commitment to state, so it says so
              rather than naming a time it would not send.
            */}
            <Button
              variant="primary"
              disabled={!canSend}
              title={canSend ? undefined : sendBlockers[0]}
              onClick={() => selected && setSentAt(selected)}
            >
              {commitment ? `Send invites, ${commitment}` : 'Send invites'}
            </Button>
            {!canSend ? (
              <p className="text-meta text-text-secondary">{sendBlockers[0]}</p>
            ) : null}
          </div>
        </div>
      }
      right={
        <>
          <div className="flex items-center gap-3 pb-3">
            <h1 className="text-section-title font-display text-text-primary">{dayLabel(day, zone)}</h1>
            <RangeToggle view={view} onChange={setView} />
            <p className="flex-1 text-body text-text-secondary">
              Times in {zoneLabel(day, zone)}, candidate available {windowLabel}
              {candidateZoneNote}
            </p>
            <p className="flex items-center gap-2 text-meta text-text-secondary">
              <BusySwatch />
              busy
            </p>
            <p className="flex items-center gap-2 text-meta text-text-link">
              <span aria-hidden="true" className="size-4 rounded-xs border-2 border-calendar-selected-stroke bg-calendar-selected-fill" />
              selected loop
            </p>
          </div>

          {loop.panelists.length === 0 ? (
            <Blocked
              title="No panel to show."
              body="This loop has no rounds, so there are no calendars to read. Add rounds to the interview template first."
            />
          ) : view === 'day' ? (
            <SchedulingGrid
              caption={`Availability for ${dayLabel(day, zone)}, times in ${zoneLabel(day, zone)}`}
              columns={dayColumns}
              rows={dayRows}
              onActivate={activate}
              // Only while something is picked up, so Escape stays the platform's
              // everywhere else on the screen.
              {...(placingRoundId ? { onCancel: () => pickRound(placingRoundId) } : {})}
            />
          ) : (
            <SchedulingGrid
              caption={`Availability for the week of ${dateLabel(loop.week[0]?.dayUtc ?? day, zone)}`}
              columns={weekColumns}
              rows={weekRows}
              onActivate={activate}
            />
          )}

          {/* The grid's own announcements. Only one live region on this screen. */}
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </>
      }
    />
  );
}

/**
 * Two panes.
 *
 * The negative margin undoes `main`'s page gutter, because the reference puts the left
 * pane flush against the sidebar with a hairline divider rather than floating it inside
 * the gutter — the pane is a continuation of the chrome, not a card on the canvas. The
 * offset is the gutter token, not a number.
 */
function Layout({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="-m-[var(--layout-page-gutter)] flex h-[calc(100%_+_2_*_var(--layout-page-gutter))] min-h-0">
      {left === null ? null : (
        <div className="w-[var(--layout-scheduling-left-pane)] shrink-0 overflow-y-auto border-r border-border-default bg-bg-surface p-4">
          {left}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col bg-bg-canvas p-5">{right}</div>
    </div>
  );
}
