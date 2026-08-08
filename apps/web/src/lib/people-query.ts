/**
 * Queries for the four screens spec 007 builds.
 *
 * Every URL points at `/api/mock/*` — the fixtures endpoint, not the API (spec 007 §5).
 * When a real endpoint lands, the change is `MOCK_BASE` → `/v1` on that one resource and
 * nothing else moves: the schemas are already the real ones, and the parse on the way in
 * is already the real parse.
 */
import {
  CandidateProfileSchema,
  ListCandidatesResponseSchema,
  ListOffersResponseSchema,
  OfferSchema,
  ReportsOverviewSchema,
  ReviewQueueResponseSchema,
  type CandidateProfile,
  type ListCandidatesResponse,
  type ListOffersResponse,
  type Offer,
  type ReportsOverview,
  type ReviewQueueResponse,
} from '@talon/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ZodSchema } from 'zod';
import { useSession } from './session';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';
const MOCK_BASE = `${API_BASE}/api/mock`;

async function get<T>(path: string, schema: ZodSchema<T>, signal?: AbortSignal, accessToken?: string): Promise<T> {
  const response = await fetch(`${MOCK_BASE}${path}`, {
    headers: {
      accept: 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    // Only the status travels. Nothing user-facing renders a server error verbatim —
    // the screens carry their own copy, the way `jobs-query.ts` does.
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  // Parsed on the way in as well as out. A fixture that drifts from its contract fails
  // here rather than rendering `undefined` three components deep.
  return schema.parse(await response.json());
}

/**
 * Shared query wiring. `ready` gates on the refresh cookie having been offered and
 * answered — firing before that sends no bearer, 401s, and with `retry: false` paints
 * the error state, so a reload would read error → skeleton → content. The user id is in
 * every key so signing in as someone else refetches rather than serving the previous
 * identity's page from cache. Both behaviours are `jobs-query.ts`'s, for its reasons.
 */
function useMock<T>(key: readonly unknown[], path: string, schema: ZodSchema<T>): UseQueryResult<T> {
  const { session, ready } = useSession();
  return useQuery({
    queryKey: [...key, session?.user.id ?? null],
    queryFn: ({ signal }) => get(path, schema, signal, session?.accessToken),
    enabled: ready && Boolean(session),
    retry: false,
  });
}

export const useReviewQueue = (): UseQueryResult<ReviewQueueResponse> =>
  useMock(['review-queue'], '/review-queue', ReviewQueueResponseSchema);

export const useCandidates = (): UseQueryResult<ListCandidatesResponse> =>
  useMock(['candidates'], '/candidates', ListCandidatesResponseSchema);

export const useCandidateProfile = (id: string): UseQueryResult<CandidateProfile> =>
  useMock(['candidate', id], `/candidates/${id}`, CandidateProfileSchema);

export const useOffers = (): UseQueryResult<ListOffersResponse> =>
  useMock(['offers'], '/offers', ListOffersResponseSchema);

export const useOffer = (id: string): UseQueryResult<Offer> =>
  useMock(['offer', id], `/offers/${id}`, OfferSchema);

export const useReports = (): UseQueryResult<ReportsOverview> =>
  useMock(['reports'], '/reports/overview', ReportsOverviewSchema);

// ---------------------------------------------------------------------------
// Formatting shared by the screens
// ---------------------------------------------------------------------------

/**
 * Cents → "$205k". The reference writes comp in thousands everywhere it appears, and
 * these are whole-thousand figures; a value that is not a round thousand keeps its
 * full digits rather than being rounded into a number nobody quoted.
 */
export function formatCompactMoney(cents: string, currency: string): string {
  const units = Number(BigInt(cents) / 100n);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return units % 1000 === 0 ? `${symbol}${units / 1000}k` : `${symbol}${units.toLocaleString('en-US')}`;
}

/**
 * A UTC instant in the viewer's zone (§4.7). The zone comes from the session, never
 * from the browser: a recruiter working from a laptop set to the wrong zone should see
 * the times their colleagues see, and a DST-boundary instant must render in the offset
 * that instant actually had — which `Intl` does and manual arithmetic does not.
 */
export function formatInZone(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
}
