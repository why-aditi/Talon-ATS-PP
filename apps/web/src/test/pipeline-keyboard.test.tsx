/**
 * The keyboard path — spec 003 §11 tests 13–16.
 *
 * jsdom gives every element a zero rect, so dnd-kit's collision detection cannot run
 * here in any meaningful way; a full keyboard walk in jsdom would only prove that the
 * rects I mocked agree with the rects I mocked. The parts with real logic are tested
 * directly instead, and the end-to-end walk is done in a real browser (spec 003 §11.15,
 * verified manually and carried into the Playwright suite).
 *
 * `boardCoordinateGetter` is where the failure the user called out actually lives: a
 * column emptied by a move has nothing to collide with, and geometry-driven traversal
 * loses it. That is tested below with a genuinely empty column.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { PipelineBoard } from '../components/pipeline-board';
import { boardCoordinateGetter, moveCardTo, neighboursFor, locate } from '../lib/board-state';
import { SessionProvider } from '../lib/session';
import { ENG204_JOB_ID, STAGE_IDS, eng204Board } from './pipeline-fixtures';
import { resetPipelineState } from './pipeline-handlers';
import { pathname } from './setup';

/* ── The coordinate getter ─────────────────────────────────────────────────── */

type FakeColumn = { id: string; position: number; left: number; width: number; empty?: boolean };

/** Columns as dnd-kit sees them: droppable containers with rects and data. Terminal
 *  columns are simply absent, because `getEnabled()` is what drops them. */
function argsFor(columns: FakeColumn[], atLeft: number) {
  const containers = columns.map((column) => ({
    id: column.id,
    data: { current: { type: 'column', position: column.position } },
    rect: { current: { left: column.left, right: column.left + column.width, top: 100, width: column.width } },
  }));
  return {
    active: 'card-1',
    currentCoordinates: { x: atLeft, y: 100 },
    context: {
      collisionRect: { left: atLeft, width: 40 },
      droppableContainers: { getEnabled: () => containers },
    },
  } as never;
}

const COLUMNS: FakeColumn[] = [
  { id: 'applied', position: 0, left: 0, width: 100 },
  // No cards in it at all — the case geometry-driven traversal cannot see.
  { id: 'screen', position: 1, left: 120, width: 100, empty: true },
  { id: 'onsite', position: 2, left: 240, width: 100 },
];

const arrow = (code: string) => ({ code }) as KeyboardEvent;

describe('arrow traversal between columns', () => {
  it('reaches a column that has no cards in it', () => {
    // Starting inside Applied, one step right must land in the empty Screen column.
    const next = boardCoordinateGetter(arrow('ArrowRight'), argsFor(COLUMNS, 40));
    expect(next).toEqual({ x: 120, y: 100 });
  });

  it('moves back the other way', () => {
    const next = boardCoordinateGetter(arrow('ArrowLeft'), argsFor(COLUMNS, 160));
    expect(next).toEqual({ x: 0, y: 100 });
  });

  it('stays put at the end rather than wrapping around', () => {
    expect(boardCoordinateGetter(arrow('ArrowRight'), argsFor(COLUMNS, 280))).toBeUndefined();
    expect(boardCoordinateGetter(arrow('ArrowLeft'), argsFor(COLUMNS, 40))).toBeUndefined();
  });

  it('orders by column position, not by DOM or rect order', () => {
    const shuffled = [COLUMNS[2]!, COLUMNS[0]!, COLUMNS[1]!];
    expect(boardCoordinateGetter(arrow('ArrowRight'), argsFor(shuffled, 40))).toEqual({ x: 120, y: 100 });
  });
});

/* ── Where the card lands ──────────────────────────────────────────────────── */

describe('placement', () => {
  const board = eng204Board();
  const applied = board.columns[0]!;
  const screenCol = board.columns[1]!;

  it('places a card dropped on another card ahead of it', () => {
    const from = locate(board.columns, applied.cards[3]!.id)!; // Priya, last
    const over = locate(board.columns, applied.cards[0]!.id)!; // onto Tess, first
    expect(neighboursFor(from, applied, over)).toEqual({ beforeId: applied.cards[0]!.id, afterId: null, index: 0 });
  });

  /**
   * The off-by-one that a naive index would produce. Moving DOWN within a column, the
   * card is removed before it is reinserted, so landing "on" the card below means
   * landing *after* it — otherwise the move is a no-op and the row never budges.
   */
  it('places a card moving down within its column after the card it landed on', () => {
    const from = locate(board.columns, applied.cards[0]!.id)!; // Tess, first
    const over = locate(board.columns, applied.cards[2]!.id)!; // onto Jordan, third
    const { beforeId, afterId } = neighboursFor(from, applied, over);
    expect(afterId).toBe(applied.cards[2]!.id);

    const moved = moveCardTo(board.columns, from.card.id, applied.stageId, beforeId, afterId);
    expect(moved[0]!.cards.map((c) => c.name)).toEqual(['Omar Haddad', 'Jordan Cole', 'Tess Bianchi', 'Priya Nair']);
  });

  /**
   * dnd-kit reports the dragged card as its own `over` on every pickup, and again on a
   * drop that never left the spot. Unhandled, the id is filtered out of the candidate
   * list, indexOf returns -1, and the card silently appends — announcing a move that
   * had not happened and relocating the card on Space-Space. It looked correct only on
   * a card alone in its column, which is exactly what the first manual check used.
   */
  it('treats "over is the dragged card itself" as staying put, not as appending', () => {
    for (const [index, card] of applied.cards.entries()) {
      const self = locate(board.columns, card.id)!;
      expect(neighboursFor(self, applied, self).index).toBe(index);
    }
    const first = locate(board.columns, applied.cards[0]!.id)!;
    expect(neighboursFor(first, applied, first).index).not.toBe(applied.cards.length - 1);
  });

  it('appends when dropped on the column rather than on a card', () => {
    const from = locate(board.columns, applied.cards[0]!.id)!;
    expect(neighboursFor(from, screenCol, null)).toEqual({
      beforeId: null,
      afterId: screenCol.cards.at(-1)!.id,
      index: screenCol.cards.length,
    });
  });

  it('resets time in stage on a cross-stage move, the way the server will', () => {
    const tess = applied.cards[0]!;
    expect(tess.daysInStage).toBe(4);
    const moved = moveCardTo(board.columns, tess.id, STAGE_IDS.screen, null, null);
    expect(moved[1]!.cards.at(-1)).toMatchObject({ name: 'Tess Bianchi', daysInStage: 0 });
    // ...and leaves it alone on a reorder, where nothing about the stage changed.
    const reordered = moveCardTo(board.columns, tess.id, STAGE_IDS.applied, null, null);
    expect(reordered[0]!.cards.at(-1)).toMatchObject({ name: 'Tess Bianchi', daysInStage: 4 });
  });

  it('does not mutate the columns it was given', () => {
    const before = board.columns[0]!.cards.map((c) => c.id);
    moveCardTo(board.columns, before[0]!, STAGE_IDS.screen, null, null);
    // The argument is usually the query cache's own array; splicing it in place would
    // corrupt the cache in a way that only shows up when a refetch changes nothing.
    expect(board.columns[0]!.cards.map((c) => c.id)).toEqual(before);
  });
});

/* ── The live region ───────────────────────────────────────────────────────── */

beforeEach(() => resetPipelineState());

describe('announcements', () => {
  it('mounts exactly one live region', async () => {
    pathname.current = `/jobs/${ENG204_JOB_ID}/pipeline`;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { baseElement } = render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <PipelineBoard jobId={ENG204_JOB_ID} />
        </SessionProvider>
      </QueryClientProvider>,
    );
    await screen.findByText('Tess Bianchi');

    // dnd-kit mounts its own. Adding a second would announce every move twice — a bug
    // that is invisible unless you actually listen to it.
    // toBe(1), not toBeLessThanOrEqual(1) — the loose form also passes at zero, so it
    // would survive dnd-kit's region vanishing and no move ever being spoken. The
    // selector counts bare role="status" too: that is an implicit live region, and is
    // what the failure banner and the loading skeleton are.
    const live = baseElement.querySelectorAll(
      '[aria-live="assertive"], [aria-live="polite"], [role="status"]:not([aria-live="off"])',
    );
    expect(live.length).toBe(1);
  });
});
