import type { KeyboardCoordinateGetter } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { ApplicationCard, BoardColumn } from '@talon/contracts';

export type Located = { columnIndex: number; cardIndex: number; card: ApplicationCard; column: BoardColumn };

export function locate(columns: BoardColumn[], cardId: string): Located | null {
  for (const [columnIndex, column] of columns.entries()) {
    const cardIndex = column.cards.findIndex((c) => c.id === cardId);
    if (cardIndex !== -1) {
      return { columnIndex, cardIndex, card: column.cards[cardIndex] as ApplicationCard, column };
    }
  }
  return null;
}

/**
 * Pure. Returns new column and card arrays rather than splicing in place — the
 * argument is usually the query cache's own data, and mutating it would corrupt the
 * cache in a way that only shows up after a refetch fails to change anything.
 *
 * Used for both the optimistic apply and the reorder, so the two cannot disagree about
 * what "move to index N" means.
 */
export function moveCardTo(
  columns: BoardColumn[],
  cardId: string,
  toStageId: string,
  beforeId: string | null,
  afterId: string | null,
): BoardColumn[] {
  const found = locate(columns, cardId);
  if (!found) return columns;

  const sameColumn = found.column.stageId === toStageId;
  return columns.map((column) => {
    const isFrom = column.stageId === found.column.stageId;
    const isTo = column.stageId === toStageId;
    if (!isFrom && !isTo) return column;

    let cards = column.cards;
    if (isFrom) cards = cards.filter((c) => c.id !== cardId);
    if (isTo) {
      const next = [...cards];
      // A cross-stage move resets time-in-stage the way the server will, so the
      // optimistic card and the confirmed one never visibly disagree for a frame.
      next.splice(insertionIndex(next, beforeId, afterId), 0, sameColumn ? found.card : { ...found.card, daysInStage: 0 });
      cards = next;
    }
    return { ...column, cards, count: cards.length };
  });
}

/**
 * Neighbours by id, never an index — the same rule the endpoint applies, computed over
 * the array with the card already removed. An index would be read against a different
 * array on each side and the optimistic position would drift from the confirmed one by
 * one row on every same-column move downward.
 *
 * This is deliberately duplicated in `test/pipeline-handlers.ts` rather than shared:
 * one is the client's guess and one is the server's decision, and the real server will
 * own its own copy in another language of the stack. They have to agree, which is what
 * the tests check — they do not have to be the same function.
 */
export function insertionIndex(cards: ApplicationCard[], beforeId: string | null, afterId: string | null): number {
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

/**
 * Where the card lands, expressed as its neighbours. Computed against the target column
 * with the dragged card already removed, so a same-column move downward lands past the
 * card it was dropped on rather than back where it started.
 */
export function neighboursFor(
  from: Located,
  target: BoardColumn,
  over: Located | null,
): { beforeId: string | null; afterId: string | null; index: number } {
  const ids = target.cards.map((c) => c.id).filter((id) => id !== from.card.id);
  const sameColumn = from.column.stageId === target.stageId;

  let at = ids.length;
  if (over) {
    if (over.card.id === from.card.id) {
      // dnd-kit reports the dragged card as its own `over` on every pickup, and
      // again on a drop that never left the spot. That means "stay put", not "go
      // last" — and because the card is filtered out of `ids`, an indexOf lookup
      // misses and silently appends. Left unhandled it announces a move that did
      // not happen and relocates the card on drop.
      at = sameColumn ? from.cardIndex : ids.length;
    } else {
      const overIndex = ids.indexOf(over.card.id);
      if (overIndex !== -1) {
        const movingDown = sameColumn && from.cardIndex < over.cardIndex;
        at = movingDown ? overIndex + 1 : overIndex;
      }
    }
  }

  // `index` is returned so callers can tell a real move from a drop in place
  // without recomputing the rule and drifting from it.
  return { beforeId: ids[at] ?? null, afterId: at > 0 ? (ids[at - 1] ?? null) : null, index: at };
}

/**
 * Arrow keys move the lifted card between columns by COLUMN INDEX, not by geometry.
 *
 * dnd-kit's `sortableKeyboardCoordinates` finds the next target by collision detection
 * over rendered rects. On this board that fails in the one case that matters: a column
 * emptied by a move has no cards to collide with, so it becomes unreachable and the
 * keyboard path quietly stops being a way to fill it again. Indexing the columns
 * removes the dependency on geometry entirely; the up/down case has no such problem and
 * still defers to dnd-kit.
 *
 * The enforced min-height on an empty card list (pipeline-column.tsx) is the other half
 * — a zero-height column would still be a zero-height drop target once we got there.
 */
export const boardCoordinateGetter: KeyboardCoordinateGetter = (event, args) => {
  const { collisionRect, droppableContainers } = args.context;
  const horizontal = event.code === 'ArrowRight' || event.code === 'ArrowLeft';
  if (!horizontal || !collisionRect) return sortableKeyboardCoordinates(event, args);

  // Terminal columns are deliberately included. They refuse the drop and say so when
  // reached; skipping them made the refusal silent for anyone not looking at the screen
  // (see the note in pipeline-column.tsx).
  const columns = droppableContainers
    .getEnabled()
    .filter((container) => container.data.current?.['type'] === 'column')
    .sort((a, b) => (a.data.current?.['position'] as number) - (b.data.current?.['position'] as number));

  const centre = collisionRect.left + collisionRect.width / 2;
  const current = columns.findIndex((container) => {
    const rect = container.rect.current;
    return rect ? centre >= rect.left && centre <= rect.right : false;
  });

  const step = event.code === 'ArrowRight' ? 1 : -1;
  for (let i = (current === -1 ? 0 : current) + step; i >= 0 && i < columns.length; i += step) {
    const rect = columns[i]?.rect.current;
    if (rect) return { x: rect.left, y: rect.top };
  }
  // No column that way: stay put rather than wrapping around, which would move the
  // card somewhere the user did not ask for.
  return undefined;
};

/**
 * `prefers-reduced-motion`, readable from JS.
 *
 * `globals.css` collapses CSS transitions and animations, but the drop animation runs
 * through the Web Animations API and the sortable's transition is an INLINE style —
 * inline beats the stylesheet, so neither is reached by the media query alone. Both
 * have to ask.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
