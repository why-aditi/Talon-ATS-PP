/**
 * Non-negotiable #14 — optimistic UI always has a rollback path — tested against the
 * mutation that implements it, not against a manual browser walk.
 *
 * The previous suite covered the mock's 409 classification and the failure copy, and
 * nothing at all in between: no test moved a card optimistically, failed the write,
 * and asserted the board went back. That is the whole requirement.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MoveFailure, boardKey, fetchBoard, useMoveStage, useReorder } from '../lib/board-query';
import { SessionProvider } from '../lib/session';
import { locate } from '../lib/board-state';
import type { Board } from '../lib/pipeline-contract';
import { route } from './fetch-stub';
import { ENG204_JOB_ID, STAGE_IDS } from './pipeline-fixtures';
import { resetPipelineState } from './pipeline-handlers';

const wrapper = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <SessionProvider>{children}</SessionProvider>
      </QueryClientProvider>
    );
  };

/** Seeds the cache the way `useBoard` would, so the optimistic write has something to
 *  act on and the rollback has something to restore. */
async function seed(scenario?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const board = await fetchBoard(ENG204_JOB_ID, scenario);
  client.setQueryData(boardKey(ENG204_JOB_ID, scenario, null), board);
  return { client, board };
}

const columnOf = (board: Board, name: string) => locate(board.columns, name)?.column.name;
const cardId = (board: Board, name: string) =>
  board.columns.flatMap((c) => c.cards).find((c) => c.name === name)!.id;
const read = (client: QueryClient, scenario?: string) =>
  client.getQueryData<Board>(boardKey(ENG204_JOB_ID, scenario, null))!;

beforeEach(() => resetPipelineState());

describe('a failed stage move rolls the board back', () => {
  it.each([
    ['conflict-version', 'version'],
    ['conflict-stage', 'moved'],
  ])('restores the card after a %s conflict', async (scenario, kind) => {
    const { client, board } = await seed(scenario);
    const elena = cardId(board, 'Elena Ruiz');
    expect(columnOf(read(client, scenario), elena)).toBe('Screen');

    // Every value the cache takes, in order. Polling for the optimistic state races
    // an in-process mock that 409s in under a millisecond — and a test that only
    // checked the end state would pass just as happily if the card had never moved,
    // which is the failure mode this test exists to rule out.
    const seen: string[] = [];
    const stop = client.getQueryCache().subscribe(() => {
      const where = columnOf(read(client, scenario), elena);
      if (where && seen.at(-1) !== where) seen.push(where);
    });

    const { result } = renderHook(() => useMoveStage(ENG204_JOB_ID, scenario), { wrapper: wrapper(client) });

    result.current.mutate({
      card: locate(board.columns, elena)!.card,
      fromStageId: STAGE_IDS.screen,
      toStageId: STAGE_IDS.onsite,
      beforeId: null,
      afterId: null,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    stop();

    expect(result.current.error).toBeInstanceOf(MoveFailure);
    expect((result.current.error as MoveFailure).kind).toBe(kind);
    // Moved optimistically, then put back — both halves, in that order.
    expect(seen).toEqual(['Onsite', 'Screen']);
    expect(columnOf(read(client, scenario), elena)).toBe('Screen');
  });

  it('gives the two conflicts different copy', async () => {
    const version = new MoveFailure('version', 'Elena Ruiz');
    const moved = new MoveFailure('moved', 'Elena Ruiz', undefined, 'Onsite');
    expect(version.message).not.toBe(moved.message);
    expect(moved.message).toContain('Onsite');
  });
});

describe('a failed reorder rolls back too', () => {
  it('restores the original order when the write does not land', async () => {
    const { client, board } = await seed();
    const tess = cardId(board, 'Tess Bianchi');
    const priya = cardId(board, 'Priya Nair');
    const order = () => read(client).columns[0]!.cards.map((c) => c.name);
    const original = order();

    // A REAL card whose write fails at the network. An unknown id was the first
    // attempt and proved nothing: `moveCardTo` cannot find it, so no optimistic
    // change happened and the test passed with the rollback deleted.
    route((url, init) => {
      if ((init?.method ?? 'GET') === 'PATCH' && url.pathname.endsWith('/rank')) throw new TypeError('Failed to fetch');
      return undefined;
    });

    const { result } = renderHook(() => useReorder(ENG204_JOB_ID, undefined), { wrapper: wrapper(client) });

    // Sequence-captured, not polled: the refetch after onSettled restores the order on
    // its own, so a waitFor on the end state passes even with the rollback removed.
    const seen: string[][] = [];
    const stop = client.getQueryCache().subscribe(() => {
      const next = order();
      if (JSON.stringify(seen.at(-1)) !== JSON.stringify(next)) seen.push(next);
    });

    result.current.mutate({
      card: locate(board.columns, tess)!.card,
      fromStageId: STAGE_IDS.applied,
      toStageId: STAGE_IDS.applied,
      beforeId: priya,
      afterId: null,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    stop();

    // Reordered optimistically, then put back — the rollback, not the refetch.
    expect(seen[0]).not.toEqual(original);
    expect(seen.at(-1)).toEqual(original);
  });
});
