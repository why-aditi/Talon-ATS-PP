import { HoldLoopResponseSchema, InterviewLoopSchema, SendLoopResponseSchema, type Arrangement, type InterviewLoop } from '@talon/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadLoop, type Scenario, type SchedulingLoop } from './scheduling-fixtures';
import { useOptionalSession } from './session';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';
function liveView(loop: InterviewLoop): SchedulingLoop {
  if (!loop.candidateWindow || !loop.searchWindow) {
    throw new Error('This loop has no candidate availability yet.');
  }
  const start = Date.parse(loop.searchWindow.startUtc); const end = Date.parse(loop.searchWindow.endUtc);
  const rows = [] as { startUtc: string }[];
  for (let at = start; at < end; at += 15 * 60_000) rows.push({ startUtc: new Date(at).toISOString() });
  const arrangement = loop.solve?.arrangements[0] ?? null;
  const dayUtc = loop.searchWindow.startUtc;
  return {
    loopId: loop.id, candidate: loop.candidate, jobTitle: loop.jobTitle, organizerZone: loop.organizerZone,
    dayUtc, panelists: loop.panelists, rounds: loop.rounds, rows, busy: loop.busy,
    // The endpoint currently solves the target date. Keep Week conservative until it
    // returns per-day windows: repeating this availability onto another date would offer
    // a slot the server has never checked.
    week: [{ dayUtc, busy: loop.busy }], candidateWindow: loop.candidateWindow,
    selectedStartUtc: arrangement?.startUtc ?? null, blocker: loop.solve?.blocker ?? null,
    partial: loop.solve?.partial ?? false,
    holdByOther: loop.hold ? { heldById: loop.hold.heldById, heldByName: loop.hold.heldByName, expiresUtc: loop.hold.expiresUtc } : null,
    drift: null, version: loop.version,
  };
}

export function useLoop(loopId: string, scenario: Scenario) {
  const auth = useOptionalSession(); const session = auth?.session ?? null; const ready = auth?.ready ?? false;
  return useQuery<SchedulingLoop>({
    queryKey: ['scheduling-loop', loopId, scenario, session?.user.id ?? null],
    queryFn: async ({ signal }) => {
      // Scenario fixtures remain a component-test seam; production never compiles with
      // NODE_ENV=test and always exercises the authenticated endpoint.
      if (process.env.NODE_ENV === 'test') return loadLoop(scenario);
      const response = await fetch(`${API_BASE}/v1/interview-loops/${loopId}`, { signal, headers: {
        accept: 'application/json', ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
      } });
      if (!response.ok) throw new Error(`GET /v1/interview-loops/${loopId} failed with ${response.status}`);
      return liveView(InterviewLoopSchema.parse(await response.json()));
    },
    enabled: process.env.NODE_ENV === 'test' || (ready && session !== null),
    retry: false,
  });
}

async function post<T>(path: string, body: unknown, token: string, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} failed with ${response.status}`);
  return parse(await response.json());
}

export function useHoldLoop(loopId: string) {
  const session = useOptionalSession()?.session ?? null; const client = useQueryClient();
  return useMutation({ mutationFn: async (input: { arrangement: Arrangement; version: number }) => {
    if (process.env.NODE_ENV === 'test') return { loop: null };
    if (!session) throw new Error('No session');
    return post(`/v1/interview-loops/${loopId}/hold`, input, session.accessToken, (v) => HoldLoopResponseSchema.parse(v));
  }, onSuccess: () => client.invalidateQueries({ queryKey: ['scheduling-loop', loopId] }) });
}

export function useSendLoop(loopId: string) {
  const session = useOptionalSession()?.session ?? null; const client = useQueryClient();
  return useMutation({ mutationFn: async (input: { arrangement: Arrangement; version: number; idempotencyKey: string }) => {
    if (process.env.NODE_ENV === 'test') return { status: 'sent' as const, loop: null, candidateIcs: '' };
    if (!session) throw new Error('No session');
    return post(`/v1/interview-loops/${loopId}/send`, input, session.accessToken, (v) => SendLoopResponseSchema.parse(v));
  }, onSuccess: () => client.invalidateQueries({ queryKey: ['scheduling-loop', loopId] }) });
}
