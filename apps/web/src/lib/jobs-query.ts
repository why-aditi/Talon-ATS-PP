import { JobSchema, ListJobsResponseSchema, type ListJobsResponse } from '@talon/contracts';
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

/** A job counts as open unless it has been closed out. Shared so the sidebar badge
 *  and the "N open" header can never disagree about what they are counting. */
export const isOpenJob = (job: { status: string }) => job.status !== 'closed';

export function useJobs(filters: JobFilters) {
  const { session, ready } = useSession();
  return useQuery({
    // The signed-in user is in the key so a sign-in refetches rather than serving
    // the previous identity's page from cache.
    queryKey: ['jobs', filters.status ?? null, filters.department ?? null, session?.user.id ?? null],
    queryFn: ({ signal }) => fetchJobs(filters, signal, session?.accessToken),
    // Two conditions, for two different failures.
    //
    // `ready`: not until the cookie has been offered to /api/auth/refresh and
    // answered. Firing before that sends no bearer, 401s, and with retry:false
    // paints the error state — so a reload read error → skeleton → rows instead of
    // skeleton → rows. The query stays pending until then, which is the skeleton.
    //
    // `session`: an endpoint inside the authenticated scope has nothing to say to
    // a request with no bearer. Without this, signing out refetches once on the way
    // out — a guaranteed 401 whose only effect is to leave a failed entry in a
    // cache that was just deliberately cleared.
    enabled: ready && session !== null,
  });
}

/**
 * One job, in full. The board carries a `BoardJob` — id, title, req code,
 * status, location, recruiter — which is everything the header renders and not
 * enough to edit: no department, no band, and no `version`, without which a
 * write cannot be safe.
 *
 * `enabled` so nothing is fetched until somebody opens the editor. A board load
 * should not pay for a dialog most visits never see.
 */
export function useJob(id: string, enabled: boolean) {
  const { session, ready } = useSession();
  return useQuery({
    queryKey: ['jobs', 'one', id, session?.user.id ?? null],
    queryFn: async ({ signal }) => {
      const response = await fetch(`${API_BASE}/v1/jobs/${id}`, {
        headers: {
          accept: 'application/json',
          ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
        },
        signal,
      });
      if (!response.ok) throw new Error(`GET /v1/jobs/${id} failed with ${response.status}`);
      return JobSchema.parse(await response.json());
    },
    enabled: enabled && ready && session !== null,
    retry: false,
  });
}
