/**
 * Stand-in for the board endpoints — spec 003 §4. None of these routes exist yet.
 *
 * This mock holds real state and enforces real semantics, because the two things most
 * likely to be got wrong on this screen are only observable in the server's behaviour:
 *
 *  1. A rank-only reorder must NOT bump `version` (CLAUDE.md non-negotiable #18).
 *     Modelled as two separate routes rather than one with an optional field, so the
 *     real client inherits the separation instead of a convention.
 *  2. A version mismatch and a from-stage mismatch are DIFFERENT failures with
 *     different client behaviour (ARCHITECTURE §6.1). A mock that always says yes
 *     would let the client collapse them and nobody would notice until production.
 *
 * A stub that accepted everything would have made the screen easier to build and
 * wrong in exactly the ways that matter.
 */
import { json, type Route } from './fetch-stub';
import {
  type ApplicationCard,
  type Board,
  BoardSchema,
  ApplicationCardSchema,
  ConflictProblemSchema,
  MoveStageBodySchema,
  PIPELINE_ERROR_TYPES,
  ReorderBodySchema,
} from '../lib/pipeline-contract';
import { emptyBoard, eng204Board } from './pipeline-fixtures';

type Scenario = 'empty' | 'error' | 'slow' | 'forbidden' | 'conflict-version' | 'conflict-stage';

let board: Board = eng204Board();
/** Armed by the GET, fired by the next stage PATCH, then disarmed — one conflict per
 *  arming, so a scenario can be walked through in the browser without every
 *  subsequent move failing. */
let armedConflict: 'conflict-version' | 'conflict-stage' | null = null;
/**
 * The board is rebuilt when the scenario CHANGES, never on every GET. Rebuilding per
 * request would discard completed moves on the next refetch — and the client refetches
 * immediately after every 409, so the rollback path would have looked correct while
 * silently reverting work the server had actually accepted.
 */
let servedScenario: Scenario | null = null;

/** Tests reset between cases; `setup.ts` does not, because only pipeline tests care. */
export function resetPipelineState(): void {
  board = eng204Board();
  armedConflict = null;
  servedScenario = null;
}

function findCard(applicationId: string) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((c) => c.id === applicationId);
    if (index !== -1) return { column, index, card: column.cards[index] as ApplicationCard };
  }
  return null;
}

/** `beforeId`/`afterId` name neighbours rather than an index, so a concurrent insert
 *  cannot silently shift the intended position — the same reason the real endpoint
 *  takes them (ARCHITECTURE §6.1, lexorank). */
function insertionIndex(cards: ApplicationCard[], beforeId?: string | null, afterId?: string | null): number {
  if (beforeId) {
    const i = cards.findIndex((c) => c.id === beforeId);
    if (i !== -1) return i;
  }
  if (afterId) {
    const i = cards.findIndex((c) => c.id === afterId);
    if (i !== -1) return i + 1;
  }
  return cards.length;
}

function syncCounts(): void {
  for (const column of board.columns) column.count = column.cards.length;
}

function conflict(type: string, title: string, detail: string, current: ApplicationCard, currentStageName: string) {
  // Validated like every other response: §4.1's whole claim is that a fixture cannot
  // drift from the shape the screen is built against, and an unvalidated error body is
  // exactly where that drift hides.
  return json(ConflictProblemSchema.parse({ type, title, status: 409, detail, current, currentStageName }), 409);
}

function notFound(detail: string) {
  return json({ type: 'urn:talon:error:not-found', title: 'Application not found', status: 404, detail }, 404);
}

/*
  Path matching, previously msw's job. The patterns are anchored on the full
  pathname rather than left as `*`-prefixed globs, so `/v1/jobs` (the list) and
  `/v1/jobs/:id/board` cannot answer for one another.
*/
const BOARD = /^\/v1\/jobs\/([^/]+)\/board$/;
const STAGE = /^\/v1\/applications\/([^/]+)\/stage$/;
const RANK = /^\/v1\/applications\/([^/]+)\/rank$/;

/** The client always sends a JSON string body; msw used to parse this for us. */
const body = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}');

/**
 * One route rather than three handlers, because the fetch stub takes a single
 * function per registration. `undefined` means "not mine" and the stub moves on.
 */
export const pipelineRoute: Route = async (url, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();

  if (method === 'GET' && BOARD.test(url.pathname)) {
    // An empty `?_scenario=` is the same as no scenario at all. Treating '' as its own
    // key made a bare probe URL look like a scenario change and silently rebuild the
    // board mid-session.
    const scenario = (url.searchParams.get('_scenario') || null) as Scenario | null;

    if (scenario === 'error') {
      return json(
        {
          type: 'urn:talon:error:internal',
          title: 'The pipeline could not be loaded',
          status: 500,
          detail: 'The pipeline service did not respond.',
        },
        500,
      );
    }

    // Holds the loading state open so it can be screenshotted and axe-checked.
    if (scenario === 'slow') await new Promise(() => {});

    const scenarioChanged = scenario !== servedScenario;
    if (scenarioChanged) {
      board = scenario === 'empty' ? emptyBoard() : eng204Board();
      servedScenario = scenario;
    }
    // Armed only when the scenario CHANGES. Re-arming on every GET latched the
    // failure on: `onSettled` refetches after each 409, which would re-arm the next
    // one and make every subsequent move fail — the opposite of what a walkthrough
    // scenario is for.
    if (scenarioChanged) {
      armedConflict = scenario === 'conflict-version' || scenario === 'conflict-stage' ? scenario : null;
    }

    // Out of scorecard scope: the field is OMITTED, not nulled, so a caller who cannot
    // read scorecards sees a card indistinguishable from an unscored one and the board
    // never leaks "there is a score you may not see" (spec 003 §7, non-negotiable #3).
    // Projected onto the response rather than into `board` — a view of the state, not
    // a mutation of it, so switching scenarios does not permanently lose the scores.
    const response =
      scenario === 'forbidden'
        ? {
            ...board,
            columns: board.columns.map((column) => ({
              ...column,
              cards: column.cards.map(({ scoreAvg: _scoreAvg, ...card }) => card),
            })),
          }
        : board;

    // The mock validates its own response against the contract, so a fixture can never
    // drift out of the shape the screen is built against.
    return json(BoardSchema.parse(response));
  }

  /*
   * Stage move. Bumps `version`, resets `daysInStage`, and is the ONLY write that does.
   */
  const stage = method === 'PATCH' ? STAGE.exec(url.pathname) : null;
  if (stage) {
    const move = MoveStageBodySchema.parse(body(init));
    const found = findCard(stage[1] as string);
    if (!found) return notFound('That application is no longer on this board.');
    const { column: from, index, card } = found;

    if (armedConflict === 'conflict-version') {
      armedConflict = null;
      return conflict(
        PIPELINE_ERROR_TYPES.STAGE_VERSION_CONFLICT,
        `${card.name} has changed`,
        `${card.name} was updated while you were dragging.`,
        { ...card, version: card.version + 1 },
        from.name,
      );
    }
    if (armedConflict === 'conflict-stage') {
      armedConflict = null;
      const elsewhere = board.columns.find((c) => c.stageId !== from.stageId && !c.isTerminal);
      return conflict(
        PIPELINE_ERROR_TYPES.STAGE_MOVED,
        `${card.name} has already moved`,
        `${card.name} is now in ${elsewhere?.name ?? 'another stage'}.`,
        card,
        elsewhere?.name ?? from.name,
      );
    }

    // Checked BEFORE the version, and answered regardless of it. Silently re-applying
    // a stage change when someone else has already moved the card corrupts the
    // append-only transition log, which is a worse outcome than a stale version.
    if (move.fromStageId !== from.stageId) {
      return conflict(
        PIPELINE_ERROR_TYPES.STAGE_MOVED,
        `${card.name} has already moved`,
        `${card.name} is now in ${from.name}.`,
        card,
        from.name,
      );
    }

    if (move.version !== card.version) {
      return conflict(
        PIPELINE_ERROR_TYPES.STAGE_VERSION_CONFLICT,
        `${card.name} has changed`,
        `${card.name} was updated while you were dragging.`,
        card,
        from.name,
      );
    }

    const to = board.columns.find((c) => c.stageId === move.toStageId);
    if (!to) return notFound('That stage is not on this board.');

    from.cards.splice(index, 1);
    const moved: ApplicationCard = {
      ...card,
      version: card.version + 1,
      // A stage change resets time-in-stage: `stage_entered_at` is written in the same
      // transaction as the transition (ARCHITECTURE §5).
      daysInStage: 0,
      status: to.canonical === 'hired' ? 'hired' : 'active',
    };
    to.cards.splice(insertionIndex(to.cards, move.beforeId, move.afterId), 0, moved);
    syncCounts();

    // Writes return the full updated resource including its new version (CLAUDE.md §9).
    return json(ApplicationCardSchema.parse(moved));
  }

  /*
   * Rank-only reorder. Last-write-wins, no version in, no version out.
   *
   * The absence of a version bump here is non-negotiable #18. Bumping it would make
   * user A's reorder invalidate user B's in-flight stage move on an unrelated card —
   * a 409 with no real conflict behind it, which reads as a race and isn't.
   */
  const rank = method === 'PATCH' ? RANK.exec(url.pathname) : null;
  if (rank) {
    const reorder = ReorderBodySchema.parse(body(init));
    const found = findCard(rank[1] as string);
    if (!found) return notFound('That application is no longer on this board.');
    const { column, index, card } = found;

    column.cards.splice(index, 1);
    column.cards.splice(insertionIndex(column.cards, reorder.beforeId, reorder.afterId), 0, card);

    return json(ApplicationCardSchema.parse(card));
  }

  return undefined;
};
