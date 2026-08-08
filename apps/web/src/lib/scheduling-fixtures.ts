/**
 * The scheduling screen's data, as fixtures — spec 004 §11.
 *
 * The types below **mirror `packages/contracts/src/scheduling.ts`**, which landed on the
 * API stream's branch. They are re-declared rather than imported because that contract
 * is not in this worktree yet; the day it is, this file's type block is deleted and the
 * import takes its place, and nothing above it moves. That is only true because the
 * shapes match, so keep them matching: enum `kind` not a label, busy as intervals not
 * row starts, the scheduled instance nested under `round.interview`.
 *
 * Three things here are deliberately NOT on the wire and stay local: `rows` and `week`
 * are grid view-model, and `drift` belongs to the send response.
 *
 * What is NOT modelled here, on purpose: no solver runs, no free/busy is read, nothing
 * is written to a calendar. Each scenario is the *result* of those things, captured, so
 * that all ten states in §11 and §12 are reachable in a browser and in a test without
 * an API.
 */

export type Scenario =
  | 'default'
  | 'loading'
  | 'empty'
  | 'no-arrangement'
  | 'window-narrow'
  | 'declined'
  | 'partial'
  | 'disconnected'
  | 'unreadable'
  | 'hold-taken'
  | 'drift'
  | 'error'
  | 'forbidden';

export const SCENARIOS: Scenario[] = [
  'default',
  'loading',
  'empty',
  'no-arrangement',
  'window-narrow',
  'declined',
  'partial',
  'disconnected',
  'unreadable',
  'hold-taken',
  'drift',
  'error',
  'forbidden',
];

export const isScenario = (value: string): value is Scenario => (SCENARIOS as string[]).includes(value);

export type Panelist = {
  id: string;
  name: string;
  /** "Lin C." — the grid header, which has ~200px and four columns to fit. */
  shortName: string;
  /**
   * False means the provider could not be read for this person. Spec §4: that is
   * fully busy, never free, and the column has to say so — an unexplained wall of
   * busy is indistinguishable from a genuinely packed day.
   */
  calendarConnected: boolean;
};

/** `interview_rounds.kind`. The wire carries the enum; "System design" is presentation. */
export const ROUND_KINDS = ['coding', 'system_design', 'values', 'hiring_manager'] as const;
export type RoundKind = (typeof ROUND_KINDS)[number];

/** `interviews.status`. Six values, not two — a `declined` round is not a pending one. */
export const INTERVIEW_STATUSES = [
  'unscheduled',
  'pending',
  'confirmed',
  'declined',
  'completed',
  'cancelled',
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/** Merged and sorted by the adapter before it reaches the wire (§4). */
export type BusyInterval = { startUtc: string; endUtc: string };

/**
 * The scheduled INSTANCE of a round — an `interviews` row. `null` on the round means
 * unscheduled, which is the distinction the schema is built around: flattening it onto
 * the round loses `manualOverride`, and §7a's audit trail is that flag plus the blocker
 * the recruiter was shown when they overrode it.
 */
export type ScheduledInterview = {
  id: string;
  status: InterviewStatus;
  startUtc: string | null;
  endUtc: string | null;
  manualOverride: boolean;
  acknowledgedBlocker: SolveBlocker | null;
};

/** The TEMPLATE: what the loop must contain (§5). */
export type Round = {
  id: string;
  kind: RoundKind;
  durationMin: number;
  position: number;
  /** Reserved: the M2 solver places rounds in `position` order and ignores this (§7). */
  isSwappable: boolean;
  /** Required panelists are a hard constraint; optional ones never block a placement. */
  panelists: { userId: string; isRequired: boolean }[];
  interview: ScheduledInterview | null;
};

/** One grid row: a candidate start time for the loop. Instants, always UTC (§8). */
export type Row = { startUtc: string };

/**
 * The solver's structured blocker (§7) — eight reasons, not one.
 *
 * The screen composes every sentence from these fields rather than being handed prose,
 * so the copy lives in exactly one place and cannot drift between the "no arrangement"
 * state and the live conflict on a row the recruiter picked themselves. `panelist_busy`
 * is the reference screen's case and the only one with a person in it; the other seven
 * still have to say something specific, which is why they carry their own numbers.
 */
export type SolveBlocker =
  | { reason: 'no_rounds' }
  | { reason: 'window_too_narrow'; requiredMin: number; availableMin: number }
  | { reason: 'span_too_short'; requiredMin: number; maxSpanMin: number }
  | {
      reason: 'panelist_busy';
      roundId: string;
      roundKind: RoundKind;
      atUtc: string;
      busyPanelists: { id: string; name: string }[];
    }
  | { reason: 'outside_window'; roundId: string; roundKind: RoundKind; atUtc: string }
  | { reason: 'rounds_overlap'; roundId: string; roundKind: RoundKind; otherRoundId: string; atUtc: string }
  | { reason: 'unknown_round'; roundId: string }
  | { reason: 'timed_out' };

/**
 * Where each round sits: `roundId` → the instant it starts, UTC.
 *
 * Not the contract's `Arrangement` — that carries `endUtc`, `spanMin` and `totalGapMin`
 * and is what hold and send are given. This is the screen's working copy while the
 * recruiter is still moving rounds around, and it is named apart so nobody reads it as
 * the wire shape. §7a still holds over it: a solved placement and a hand-built one are
 * the same value and nothing here tells them apart.
 */
export type Placement = Record<string, string>;

export type HoldByOther = { heldById: string; heldByName: string; expiresUtc: string };

/** §10 step 3: what changed between the hold and the send. */
export type Drift = { panelistName: string; fromUtc: string; toUtc: string };

export type SchedulingLoop = {
  loopId: string;
  candidate: { id: string; name: string; zone: string };
  jobTitle: string;
  /** Everything on screen renders in this zone. */
  organizerZone: string;
  /** The day being shown, as an instant inside it. */
  dayUtc: string;
  panelists: Panelist[];
  rounds: Round[];
  /** Grid view-model, not on the wire: which starts the grid offers. */
  rows: Row[];
  /** panelistId → busy intervals. A disconnected panelist arrives as one interval
   *  covering the whole window, with `calendarConnected: false` saying why (§4). */
  busy: Record<string, BusyInterval[]>;
  /** The days offered by the Week toggle, each with its own busy map. View-model. */
  week: { dayUtc: string; busy: Record<string, BusyInterval[]> }[];
  /** Candidate's stated window, a hard bound on the solver (§6). */
  candidateWindow: { startUtc: string; endUtc: string };
  /** The arrangement the solver picked, or null when it found none. */
  selectedStartUtc: string | null;
  /** Set when the solver returned zero arrangements (§7). */
  blocker: SolveBlocker | null;
  /** The 200ms time box was hit; what is shown is the best found so far (§7 step 5). */
  partial: boolean;
  /** §12.4 — someone else got the Redis lock first. */
  holdByOther: HoldByOther | null;
  /** §10 — availability moved under the hold, so nothing was sent. */
  drift: Drift[] | null;
  /** Optimistic concurrency from the live loop. Fixtures predate writes and default to 1. */
  version?: number;
};

/* ── The reference loop ─────────────────────────────────────────────────────── */

/*
  Ids, not names, decide avatar colour (DESIGN_SYSTEM §3), so these are chosen to hash
  onto the hues the reference screen actually shows: Ana violet, Lin blue, David green,
  Maya amber, Sam violet. Maya's is the id the seeded tenant already uses for her.
*/
const ANA = '0198f3a6-0007-7000-8000-000000000001';
const LIN = '0198f3a6-0008-7000-8000-000000000001';
const DAVID = '0198f3a6-0009-7000-8000-000000000001';
const MAYA = '0198f3a1-0007-7000-8000-000000000001';
const SAM = '0198f3a6-0007-7000-8000-000000000009';
/** The other recruiter, who gets the hold first in §12.4. */
const DANA = '0198f3a6-000a-7000-8000-000000000001';

export const REFERENCE_LOOP_ID = '0198f3a7-0001-7000-8000-000000000001';

/*
  Thursday 6 August 2026, America/Chicago, which is CDT (UTC-5) — so 9:00 CT is
  14:00Z. Row starts are irregular (…12:00, 1:00, 2:30, 3:30) because the reference
  screen's are: the grid shows the day's candidate start times, not a uniform ruler.
  See the note in the report — this is the one place the screen follows the screenshot
  over what a solver would naturally emit.
*/
const ROW_STARTS = [
  '2026-08-06T14:00:00.000Z', // 9:00
  '2026-08-06T15:00:00.000Z', // 10:00
  '2026-08-06T16:00:00.000Z', // 11:00
  '2026-08-06T17:00:00.000Z', // 12:00
  '2026-08-06T18:00:00.000Z', // 1:00
  '2026-08-06T19:30:00.000Z', // 2:30
  '2026-08-06T20:30:00.000Z', // 3:30
];

/**
 * Busy intervals covering the given rows.
 *
 * The reference screen's busy blocks are one row tall, so each is an hour from the row
 * start. Real events will not line up with rows at all, which is why the grid decides
 * whether a row reads busy by *overlap* (`scheduling-state.busyDuring`) rather than by
 * matching a start — a 10:30 meeting has to darken the 10:00 row or the loop gets placed
 * into it.
 */
const at = (indexes: number[]): BusyInterval[] =>
  indexes.map((i) => ({
    startUtc: ROW_STARTS[i] as string,
    endUtc: new Date(new Date(ROW_STARTS[i] as string).getTime() + 60 * 60_000).toISOString(),
  }));

const PANELISTS: Panelist[] = [
  { id: LIN, name: 'Lin Chen', shortName: 'Lin C.', calendarConnected: true },
  { id: DAVID, name: 'David Osei', shortName: 'David O.', calendarConnected: true },
  { id: MAYA, name: 'Maya Reyes', shortName: 'Maya R.', calendarConnected: true },
  { id: SAM, name: 'Sam Altmann', shortName: 'Sam A.', calendarConnected: true },
];

/**
 * The four rounds of the reference screen, two confirmed and two pending.
 *
 * `interview` is the scheduled instance: present with a status for a round that has a
 * time, `null` for one that does not. Duration is a multiple of 15 because the solver's
 * grid is — a 50-minute round cannot be placed exactly and would silently round.
 */
const round = (
  id: string,
  kind: RoundKind,
  panelistId: string,
  durationMin: number,
  position: number,
  status: InterviewStatus,
): Round => ({
  id,
  kind,
  durationMin,
  position,
  isSwappable: false,
  panelists: [{ userId: panelistId, isRequired: true }],
  interview:
    status === 'unscheduled'
      ? null
      : {
          id: `${id}-interview`,
          status,
          startUtc: null,
          endUtc: null,
          manualOverride: false,
          acknowledgedBlocker: null,
        },
});

const ROUNDS: Round[] = [
  round('0198f3a8-0001-7000-8000-000000000001', 'coding', LIN, 60, 0, 'confirmed'),
  round('0198f3a8-0002-7000-8000-000000000001', 'system_design', DAVID, 60, 1, 'confirmed'),
  round('0198f3a8-0003-7000-8000-000000000001', 'values', MAYA, 45, 2, 'pending'),
  round('0198f3a8-0004-7000-8000-000000000001', 'hiring_manager', SAM, 45, 3, 'pending'),
];

/** Named so the scenarios below can reach for a round without indexing into the array. */
const [, SYSTEM_DESIGN, VALUES] = ROUNDS as [Round, Round, Round, Round];

/** Exactly the busy blocks on `06-scheduling@2x.png`. Maya at 10:00 is the conflict. */
const BUSY: Record<string, BusyInterval[]> = {
  [LIN]: at([0, 3]),
  [DAVID]: at([4]),
  [MAYA]: at([0, 1, 6]),
  [SAM]: at([3, 6]),
};

/**
 * An unreadable calendar, as §4 requires it: ONE interval over the whole window, not a
 * per-row list. The overlap test in the grid is what turns that into seven busy rows,
 * which is the point — a provider error must never be able to leave a gap that reads
 * as free.
 */
const FULLY_BUSY: BusyInterval[] = [
  { startUtc: '2026-08-06T14:00:00.000Z', endUtc: '2026-08-06T22:00:00.000Z' },
];

/** Mon–Fri of the reference week. Only Thursday is the reference day; the rest exist so
 *  the Week toggle has somewhere to go, and are stated rather than generated so a test
 *  can assert against them. */
const WEEK: SchedulingLoop['week'] = [
  {
    dayUtc: '2026-08-03T14:00:00.000Z',
    busy: { [LIN]: at([0, 1, 2]), [DAVID]: at([0, 1]), [MAYA]: at([3, 4]), [SAM]: at([0, 5, 6]) },
  },
  {
    dayUtc: '2026-08-04T14:00:00.000Z',
    busy: { [LIN]: at([2]), [DAVID]: at([2, 3, 4, 5]), [MAYA]: at([0, 6]), [SAM]: at([1]) },
  },
  {
    dayUtc: '2026-08-05T14:00:00.000Z',
    busy: { [LIN]: at([0, 1, 2, 3, 4, 5, 6]), [DAVID]: at([1]), [MAYA]: at([2]), [SAM]: at([4]) },
  },
  { dayUtc: '2026-08-06T14:00:00.000Z', busy: BUSY },
  {
    dayUtc: '2026-08-07T14:00:00.000Z',
    busy: { [LIN]: at([5, 6]), [DAVID]: at([0]), [MAYA]: at([0, 1]), [SAM]: at([3, 4]) },
  },
];

function referenceLoop(): SchedulingLoop {
  return {
    loopId: REFERENCE_LOOP_ID,
    candidate: { id: ANA, name: 'Ana Petrova', zone: 'America/Chicago' },
    jobTitle: 'Senior Product Engineer',
    organizerZone: 'America/Chicago',
    dayUtc: ROW_STARTS[0] as string,
    panelists: PANELISTS.map((p) => ({ ...p })),
    rounds: ROUNDS.map((r) => ({ ...r })),
    rows: ROW_STARTS.map((startUtc) => ({ startUtc })),
    busy: { ...BUSY },
    week: WEEK,
    // "candidate available 9 to 4" — 14:00Z to 21:00Z on this date.
    candidateWindow: { startUtc: '2026-08-06T14:00:00.000Z', endUtc: '2026-08-06T21:00:00.000Z' },
    selectedStartUtc: ROW_STARTS[1] as string,
    blocker: null,
    partial: false,
    holdByOther: null,
    drift: null,
  };
}

/* ── Scenarios ──────────────────────────────────────────────────────────────── */

/** A load that failed, told apart by kind so the screen can say the right thing. */
export class LoopLoadError extends Error {
  constructor(readonly kind: 'error' | 'forbidden') {
    super(kind);
    this.name = 'LoopLoadError';
  }
}

export function loopFor(scenario: Scenario): SchedulingLoop {
  const loop = referenceLoop();

  switch (scenario) {
    case 'empty':
      // A loop whose template has no rounds yet. Distinct from "the solver found
      // nothing": there is nothing to place, so the answer is to add rounds.
      return {
        ...loop,
        rounds: [],
        panelists: [],
        busy: {},
        selectedStartUtc: null,
        blocker: { reason: 'no_rounds' },
      };

    case 'no-arrangement':
      // §7: zero arrangements returns the blocker, not an empty list. Maya is required
      // for the Values round and is busy at the earliest time the solver reached.
      return {
        ...loop,
        selectedStartUtc: null,
        blocker: {
          reason: 'panelist_busy',
          roundId: VALUES.id,
          roundKind: 'values',
          atUtc: ROW_STARTS[1] as string,
          busyPanelists: [{ id: MAYA, name: 'Maya Reyes' }],
        },
        busy: { ...loop.busy, [MAYA]: FULLY_BUSY },
      };

    case 'window-narrow':
      // A blocker with nobody in it. The screen must still say what to change (§7).
      return {
        ...loop,
        selectedStartUtc: null,
        blocker: { reason: 'window_too_narrow', requiredMin: 210, availableMin: 120 },
      };

    case 'declined':
      /*
        §10: Radicale has no iTIP, so a panelist marks the decline in Talon. It flips the
        round back to pending on the server and raises a next action; on this screen the
        job is simply that `declined` never reads as anything else. A status that fell
        through to a default branch and rendered "Confirmed" would tell a recruiter the
        panel is set when somebody has said no.
      */
      return {
        ...loop,
        rounds: loop.rounds.map((r) =>
          r.id === SYSTEM_DESIGN.id && r.interview
            ? { ...r, interview: { ...r.interview, status: 'declined' as const } }
            : r,
        ),
      };

    case 'partial':
      // §7 step 5 — the 200ms box was hit. `timed_out` is the blocker that pairs with it.
      return { ...loop, partial: true };

    case 'disconnected':
      // §12.1 and §12.3. An unreadable calendar is ONE interval covering the whole
      // window — fully busy, never free — and the person is named.
      return {
        ...loop,
        panelists: loop.panelists.map((p) => (p.id === MAYA ? { ...p, calendarConnected: false } : p)),
        busy: { ...loop.busy, [MAYA]: FULLY_BUSY },
      };

    case 'unreadable': {
      /*
        §12.1, and the case a `calendarConnected` flag cannot express: the calendar IS
        connected, and the read still did not come back. The busy key is simply absent,
        which is the shape a provider error arrives in — and absence must read as fully
        busy, never as a free day (§7). Deleted rather than set to `[]`, because `[]` is
        the value that means "genuinely free" and the two must not be the same thing.
      */
      const busy = { ...loop.busy };
      delete busy[MAYA];
      return { ...loop, busy };
    }

    case 'hold-taken':
      // §12.4 — the second recruiter is told who holds it and until when.
      return {
        ...loop,
        holdByOther: { heldById: DANA, heldByName: 'Dana Whitfield', expiresUtc: '2026-08-07T21:30:00.000Z' },
      };

    case 'drift':
      // §10 step 3 — the re-fetch disagreed with the hold, so nothing was sent.
      return {
        ...loop,
        drift: [
          {
            panelistName: 'Maya Reyes',
            fromUtc: '2026-08-06T15:00:00.000Z',
            toUtc: '2026-08-06T15:45:00.000Z',
          },
        ],
      };

    default:
      return loop;
  }
}

/**
 * Stands in for `GET /v1/interview-loops/:id`.
 *
 * `loading` never settles, which is what lets the skeleton be screenshotted and
 * axe-checked rather than existing only between two frames.
 */
export function loadLoop(scenario: Scenario): Promise<SchedulingLoop> {
  if (scenario === 'loading') return new Promise<SchedulingLoop>(() => {});
  if (scenario === 'error' || scenario === 'forbidden') return Promise.reject(new LoopLoadError(scenario));
  return Promise.resolve(loopFor(scenario));
}
