import { ListJobsResponseSchema, type ListJobsResponse } from '@talon/contracts';
import { useQuery } from '@tanstack/react-query';
import { useSession } from './session';

export type JobFilters = {
  status?: string | undefined;
  department?: string | undefined;
};

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';

export function jobsUrl(filters: JobFilters): string {
  // Built key by key, never by forwarding `searchParams`. ListJobsQuerySchema is
  // `.strict()`, so one stray param — a `utm_source` on a shared link — would 400
  // the whole page.
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.department) params.set('department', filters.department);
  const query = params.toString();
  return `${API_BASE}/v1/jobs${query ? `?${query}` : ''}`;
}

export async function fetchJobs(
  filters: JobFilters,
  signal?: AbortSignal,
  accessToken?: string | undefined,
): Promise<ListJobsResponse> {
  // GET /v1/jobs sits inside the authenticated scope, so the live path needs the
  // bearer. The token comes from session state, never from storage.
  const response = await fetch(jobsUrl(filters), {
    headers: {
      accept: 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    // The body is RFC 9457 problem+json; the screen shows its own copy, so only the
    // status is carried up. Nothing user-facing renders a server error string verbatim.
    throw new Error(`GET /v1/jobs failed with ${response.status}`);
  }
  return ListJobsResponseSchema.parse(await response.json());
}

export function useJobs(filters: JobFilters) {
  const { session } = useSession();
  return useQuery({
    // The token is in the key so a sign-in refetches rather than serving the
    // previous identity's page from cache.
    queryKey: ['jobs', filters.status ?? null, filters.department ?? null, session?.user.id ?? null],
    queryFn: ({ signal }) => fetchJobs(filters, signal, session?.accessToken),
  });
}
