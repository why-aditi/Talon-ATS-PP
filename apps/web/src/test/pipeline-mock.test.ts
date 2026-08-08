/**
 * The mock layer holds real state and enforces real semantics (spec 003 §11,
 * tests 10–12). Those semantics are the thing this screen is most likely to get
 * wrong, and they are invisible from the UI, so they are tested directly.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BoardSchema, PIPELINE_ERROR_TYPES, type ApplicationCard, type Board } from '../mocks/pipeline-contract';
import { ENG204_JOB_ID, STAGE_IDS } from '../mocks/pipeline-fixtures';
import { resetPipelineState } from '../mocks/pipeline-handlers';
import { MoveFailure } from '../lib/board-query';

const API = 'http://localhost:3000';

const getBoard = async (scenario?: string): Promise<Board> => {
  const query = scenario ? `?_scenario=${scenario}` : '';
  const response = await fetch(`${API}/v1/jobs/${ENG204_JOB_ID}/board${query}`);
  // Parsing here rather than casting: every assertion below rests on the response
  // matching the contract, so a drifted fixture fails as a schema error, not as a
  // confusing downstream expectation.
  return BoardSchema.parse(await response.json());
};

const cardsIn = (board: Board, canonical: string) =>
  board.columns.find((c) => c.canonical === canonical)?.cards.map((c) => c.name) ?? [];

const find = (board: Board, name: string): ApplicationCard => {
  const card = board.columns.flatMap((c) => c.cards).find((c) => c.name === name);
  if (!card) throw new Error(`${name} is not on the board`);
  return card;
};

const reorder = (id: string, body: { beforeId?: string | null; afterId?: string | null }) =>
  fetch(`${API}/v1/applications/${id}/rank`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const moveStage = (
  id: string,
  body: { fromStageId: string; toStageId: string; version: number; beforeId?: string | null; afterId?: string | null },
) =>
  fetch(`${API}/v1/applications/${id}/stage`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => resetPipelineState());

describe('the board fixture', () => {
  it('serves the nine seeded candidates in 4 / 2 / 1 / 1 / 1', async () => {
    const board = await getBoard();
    expect(cardsIn(board, 'applied')).toEqual(['Tess Bianchi', 'Omar Haddad', 'Jordan Cole', 'Priya Nair']);
    expect(cardsIn(board, 'screen')).toEqual(['Elena Ruiz', 'Marcus Webb']);
    expect(cardsIn(board, 'onsite')).toEqual(['Ana Petrova']);
    expect(cardsIn(board, 'offer')).toEqual(['Sofia Lindqvist']);
    expect(cardsIn(board, 'hired')).toEqual(['David Kim']);
  });

  /**
   * Spec 003 §5.2. The stats are carried, not derived, and this asserts the value that
   * a derivation from the visible cards would NOT produce: Applied's four cards sit at
   * 4d/3d/2d/1d and reduce to 2.5d, while the real median over completed dwells is 2d.
   * If this ever reads 2.5, someone has started computing column stats from the column.
   */
  it('reports medians over completed dwells, not over the cards on screen', async () => {
    const board = await getBoard();
    const stats = Object.fromEntries(board.columns.map((c) => [c.canonical, c.stats]));

    expect(stats['applied']).toEqual({ passRatePct: 100, medianDaysInStage: 2 });
    expect(stats['screen']).toEqual({ passRatePct: 56, medianDaysInStage: 4 });
    expect(stats['onsite']).toEqual({ passRatePct: 33, medianDaysInStage: 6 });
    expect(stats['offer']).toEqual({ passRatePct: 22, medianDaysInStage: 3 });
    // Terminal: nobody leaves, so there is no dwell to take a median of.
    expect(stats['hired']).toEqual({ passRatePct: 11, medianDaysInStage: null });
  });

  it('omits scoreAvg entirely out of scorecard scope, rather than nulling it', async () => {
    const board = await getBoard('forbidden');
    for (const card of board.columns.flatMap((c) => c.cards)) {
      expect(card).not.toHaveProperty('scoreAvg');
    }
  });

  it('keeps every stage present on an empty board', async () => {
    const board = await getBoard('empty');
    expect(board.columns.map((c) => c.canonical)).toEqual(['applied', 'screen', 'onsite', 'offer', 'hired']);
    expect(board.columns.every((c) => c.cards.length === 0 && c.count === 0)).toBe(true);
  });
});

/**
 * CLAUDE.md non-negotiable #18. The failure this prevents does not look like a bug in
 * reordering — it looks like a flaky 409 on an unrelated card's stage move, which is
 * why it needs a test that spans both writes.
 */
describe('a rank-only reorder does not bump version', () => {
  it('leaves version untouched across repeated reorders', async () => {
    const before = find(await getBoard(), 'Tess Bianchi');
    expect(before.version).toBe(1);

    const priya = find(await getBoard(), 'Priya Nair');
    await reorder(before.id, { afterId: priya.id });
    await reorder(before.id, { beforeId: priya.id });

    expect(find(await getBoard(), 'Tess Bianchi').version).toBe(1);
  });

  it('still accepts a stage move carrying the pre-reorder version', async () => {
    const board = await getBoard();
    const tess = find(board, 'Tess Bianchi');
    const priya = find(board, 'Priya Nair');
    const jordan = find(board, 'Jordan Cole');

    // Two reorders in the column, then a stage move on a DIFFERENT card that was read
    // before any of it. If a reorder bumped version, this 409s for no reason.
    await reorder(tess.id, { afterId: priya.id });
    await reorder(jordan.id, { beforeId: tess.id });

    const response = await moveStage(priya.id, {
      fromStageId: STAGE_IDS.applied,
      toStageId: STAGE_IDS.screen,
      version: priya.version,
    });

    expect(response.status).toBe(200);
    expect(cardsIn(await getBoard(), 'screen')).toContain('Priya Nair');
  });

  it('does reorder the column', async () => {
    const board = await getBoard();
    const tess = find(board, 'Tess Bianchi');
    const priya = find(board, 'Priya Nair');

    await reorder(tess.id, { afterId: priya.id });

    expect(cardsIn(await getBoard(), 'applied')).toEqual([
      'Omar Haddad',
      'Jordan Cole',
      'Priya Nair',
      'Tess Bianchi',
    ]);
  });
});

describe('a stage move', () => {
  it('bumps version, resets time in stage, and returns the full resource', async () => {
    const elena = find(await getBoard(), 'Elena Ruiz');
    const response = await moveStage(elena.id, {
      fromStageId: STAGE_IDS.screen,
      toStageId: STAGE_IDS.onsite,
      version: elena.version,
    });

    expect(response.status).toBe(200);
    const moved = (await response.json()) as ApplicationCard;
    expect(moved.version).toBe(elena.version + 1);
    expect(moved.daysInStage).toBe(0);
    expect(moved.name).toBe('Elena Ruiz');

    const board = await getBoard();
    expect(cardsIn(board, 'onsite')).toEqual(['Ana Petrova', 'Elena Ruiz']);
    expect(board.columns.find((c) => c.canonical === 'screen')?.count).toBe(1);
  });

  it('honours beforeId when placing the card', async () => {
    const ana = find(await getBoard(), 'Ana Petrova');
    const elena = find(await getBoard(), 'Elena Ruiz');

    await moveStage(elena.id, {
      fromStageId: STAGE_IDS.screen,
      toStageId: STAGE_IDS.onsite,
      version: elena.version,
      beforeId: ana.id,
    });

    expect(cardsIn(await getBoard(), 'onsite')).toEqual(['Elena Ruiz', 'Ana Petrova']);
  });
});

/**
 * ARCHITECTURE §6.1 spends a paragraph keeping these two apart. A client that
 * collapsed them would silently re-apply a stage change over someone else's move and
 * corrupt the append-only transition log, so the mock has to be able to tell them
 * apart before the client can be tested on it.
 */
describe('the two 409s are different failures', () => {
  it('409s on a stale version', async () => {
    const elena = find(await getBoard(), 'Elena Ruiz');
    const response = await moveStage(elena.id, {
      fromStageId: STAGE_IDS.screen,
      toStageId: STAGE_IDS.onsite,
      version: elena.version + 5,
    });

    expect(response.status).toBe(409);
    const problem = await response.json();
    expect(problem.type).toBe(PIPELINE_ERROR_TYPES.STAGE_VERSION_CONFLICT);
    // The current state rides along, so the client reconciles without a second trip.
    expect(problem.current.name).toBe('Elena Ruiz');
  });

  it('409s on a from-stage mismatch even when the version matches', async () => {
    const elena = find(await getBoard(), 'Elena Ruiz');
    const response = await moveStage(elena.id, {
      // The client believed she was in Onsite; she is in Screen.
      fromStageId: STAGE_IDS.onsite,
      toStageId: STAGE_IDS.offer,
      version: elena.version,
    });

    expect(response.status).toBe(409);
    expect((await response.json()).type).toBe(PIPELINE_ERROR_TYPES.STAGE_MOVED);
  });

  it('does not move the card on either conflict', async () => {
    const elena = find(await getBoard(), 'Elena Ruiz');
    await moveStage(elena.id, {
      fromStageId: STAGE_IDS.screen,
      toStageId: STAGE_IDS.onsite,
      version: elena.version + 5,
    });
    await moveStage(elena.id, {
      fromStageId: STAGE_IDS.onsite,
      toStageId: STAGE_IDS.offer,
      version: elena.version,
    });

    expect(cardsIn(await getBoard(), 'screen')).toEqual(['Elena Ruiz', 'Marcus Webb']);
  });

  /**
   * `Error`'s constructor assigns an OWN `message` property, so a `get message()` on
   * the subclass is shadowed and never runs — the banner rendered the literal string
   * "version" instead of a sentence. Cheap to break again, so it is asserted.
   */
  it('carries a readable sentence, not the failure kind', async () => {
    expect(new MoveFailure('version', 'Elena Ruiz').message).toBe(
      'Elena Ruiz changed while you were dragging. The board has been refreshed.',
    );
    expect(new MoveFailure('moved', 'Elena Ruiz', undefined, 'Onsite').message).toBe(
      'Someone else already moved Elena Ruiz to Onsite.',
    );
    expect(new MoveFailure('unknown', 'Elena Ruiz').message).toContain("didn't reach the server");
    // The two 409s must never render the same sentence — that is the whole point of
    // keeping them apart (ARCHITECTURE §6.1).
    expect(new MoveFailure('version', 'X').message).not.toBe(new MoveFailure('moved', 'X').message);
  });

  it('names the stage the card actually sits in', async () => {
    const elena = find(await getBoard(), 'Elena Ruiz');
    const response = await moveStage(elena.id, {
      fromStageId: STAGE_IDS.onsite,
      toStageId: STAGE_IDS.offer,
      version: elena.version,
    });
    expect((await response.json()).currentStageName).toBe('Screen');
  });

  it('fires an armed conflict once, then lets the next move through', async () => {
    const elena = find(await getBoard('conflict-version'), 'Elena Ruiz');
    const move = () =>
      moveStage(elena.id, {
        fromStageId: STAGE_IDS.screen,
        toStageId: STAGE_IDS.onsite,
        version: elena.version,
      });

    expect((await move()).status).toBe(409);
    expect((await move()).status).toBe(200);
  });
});
