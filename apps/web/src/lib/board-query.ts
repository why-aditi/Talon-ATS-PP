import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import {
  BoardSchema,
  StageConflictSchema,
  ERROR_TYPES,
  type Board,
  type ApplicationCard,
} from '@talon/contracts';
import { moveCardTo } from './board-state';
import { useSession } from './session';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';

export const boardKey = (jobId: string, scenario: string | undefined, userId: string | null) =>
  ['board', jobId, scenario ?? null, userId] as const;

export function boardUrl(jobId: string, scenario?: string): string {
  const params = new URLSearchParams();
  // `_scenario` reaches states a real endpoint cannot be asked for on demand. It is
  // mock-only and never leaves development — the same rule `jobs-query.ts` follows,
  // for the same reason: the real query schema will be `.strict()` and 400 on it.
  if (scenario && process.env.NODE_ENV !== 'production') params.set('_scenario', scenario);
  const query = params.toString();
  return `${API_BASE}/v1/jobs/${jobId}/board${query ? `?${query}` : ''}`;
}

export async function fetchBoard(jobId: string, scenario?: string, signal?: AbortSignal, accessToken?: string): Promise<Board> {
  const response = await fetch(boardUrl(jobId, scenario), {
    headers: {
      accept: 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`GET board failed with ${response.status}`);
  // Parsed, not cast: the screen is built against this shape, so a drifted response
  // fails here rather than three components deep.
  return BoardSchema.parse(await response.json());
}

export function useBoard(jobId: string, scenario?: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: boardKey(jobId, scenario, session?.user.id ?? null),
    queryFn: ({ signal }) => fetchBoard(jobId, scenario, signal, session?.accessToken),
  });
}

/* ── Mutations ─────────────────────────────────────────────────────────────── */

/**
 * A move that failed for a reason the user needs told apart. The two 409s mean
 * different things — one says the card changed under you, the other says it is no
 * longer where you thought — so they carry different copy rather than one "try again".
 */
type MoveFailureKind = 'version' | 'moved' | 'unknown';

function moveFailureMessage(kind: MoveFailureKind, cardName: string, stageName?: string): string {
  switch (kind) {
    case 'version':
      return `${cardName} changed while you were dragging. The board has been refreshed.`;
    case 'moved':
      return `Someone else already moved ${cardName}${stageName ? ` to ${stageName}` : ''}.`;
    default:
      return `That move didn't reach the server. ${cardName} is back where they were.`;
  }
}

export class MoveFailure extends Error {
  constructor(
    readonly kind: MoveFailureKind,
    readonly cardName: string,
    readonly current?: ApplicationCard,
    readonly stageName?: string,
  ) {
    // The message is built here and handed to `super`, not exposed as a getter.
    // `Error`'s constructor assigns an OWN `message` property, which shadows any
    // accessor on the prototype — so a `get message()` silently loses to whatever was
    // passed up, and the banner renders the raw kind ("version") instead of a sentence.
    super(moveFailureMessage(kind, cardName, stageName));
    this.name = 'MoveFailure';
  }
}

async function patch(path: string, body: unknown, accessToken?: string): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export type MoveInput = {
  card: ApplicationCard;
  fromStageId: string;
  toStageId: string;
  /** Neighbours, never an index — see `insertionIndex` in board-state.ts. */
  beforeId: string | null;
  afterId: string | null;
};

/**
 * Optimistic stage move.
 *
 * Nothing is mutated while a drag is in flight — the card only moves on drop — so
 * cancelling with Esc needs no rollback at all. That is a stronger guarantee than
 * converging a cancel path onto the failure path: there is no state to get wrong.
 * The only rollback is this one, and it serves both 409s and the network failure.
 */
export function useMoveStage(jobId: string, scenario: string | undefined) {
  const { session } = useSession();
  const client = useQueryClient();
  const key = boardKey(jobId, scenario, session?.user.id ?? null);

  return useMutation({
    mutationFn: async (input: MoveInput) => {
      const response = await patch(
        `/v1/applications/${input.card.id}/stage`,
        {
          fromStageId: input.fromStageId,
          toStageId: input.toStageId,
          version: input.card.version,
          beforeId: input.beforeId,
          afterId: input.afterId,
        },
        session?.accessToken,
      );
      if (response.ok) return (await response.json()) as ApplicationCard;

      const problem = StageConflictSchema.safeParse(await response.json().catch(() => null));
      if (response.status === 409 && problem.success) {
        const kind = problem.data.type === ERROR_TYPES.STAGE_MOVED ? 'moved' : 'version';
        // `detail` already names the stage the card actually sits in; the client shows
        // its own sentence rather than the server's, so copy stays under our control.
        throw new MoveFailure(kind, input.card.name, problem.data.current, problem.data.currentStageName);
      }
      throw new MoveFailure('unknown', input.card.name);
    },

    onMutate: async (input) => {
      // Any in-flight refetch would land after the optimistic write and undo it.
      await client.cancelQueries({ queryKey: key });
      const snapshot = client.getQueryData<Board>(key);
      client.setQueryData<Board>(key, (board) =>
        board ? { ...board, columns: moveCardTo(board.columns, input.card.id, input.toStageId, input.beforeId, input.afterId) } : board,
      );
      return { snapshot };
    },

    onError: (_error, _input, context) => {
      // Restore, never patch: the server's view is authoritative and the refetch below
      // is what reconciles. Leaving the optimistic card in place would be the board
      // lying (non-negotiable #14).
      if (context?.snapshot) client.setQueryData(key, context.snapshot);
    },

    // Both outcomes refetch. ARCHITECTURE §6.1 asks for the affected column; the board
    // endpoint returns the whole board, so this is a whole-board refetch — recorded in
    // spec 003 §4.3 rather than pretending the granularity exists.
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

/**
 * Rank-only reorder. Carries no version and expects none back (non-negotiable #18) —
 * position is last-write-wins and is not worth a conflict dialog.
 */
export function useReorder(jobId: string, scenario: string | undefined) {
  const { session } = useSession();
  const client = useQueryClient();
  const key = boardKey(jobId, scenario, session?.user.id ?? null);

  return useMutation({
    mutationFn: async (input: MoveInput) => {
      const response = await patch(
        `/v1/applications/${input.card.id}/rank`,
        { beforeId: input.beforeId, afterId: input.afterId },
        session?.accessToken,
      );
      if (!response.ok) throw new MoveFailure('unknown', input.card.name);
      return (await response.json()) as ApplicationCard;
    },
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: key });
      const snapshot = client.getQueryData<Board>(key);
      client.setQueryData<Board>(key, (board) =>
        board ? { ...board, columns: moveCardTo(board.columns, input.card.id, input.toStageId, input.beforeId, input.afterId) } : board,
      );
      return { snapshot };
    },
    onError: (_error, _input, context) => {
      if (context?.snapshot) client.setQueryData(key, context.snapshot);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}
