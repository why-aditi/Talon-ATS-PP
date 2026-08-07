import { ListJobsResponseSchema, type ListJobsResponse } from '@talon/contracts';
import { useQuery } from '@tanstack/react-query';

export type JobFilters = {
  status?: string | undefined;
  department?: string | undefined;
  /** Mock-only; see mocks/handlers.ts. Never sent outside development. */
  scenario?: string | undefined;
};

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';

export function jobsUrl(filters: JobFilters): string {
  // Built key by key, never by forwarding `searchParams`. ListJobsQuerySchema is
  // `.strict()`, so one stray param — a `utm_source` on a shared link — would 400
  // the whole page.
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.department) params.set('department', filters.department);
  // `_scenario` is not in the query schema and would itself 400. It exists to reach
  // states the fixtures cannot otherwise produce, so it stays out of production.
  if (filters.scenario && process.env.NODE_ENV !== 'production') params.set('_scenario', filters.scenario);
  const query = params.toString();
  return `${API_BASE}/v1/jobs${query ? `?${query}` : ''}`;
}

export async function fetchJobs(filters: JobFilters, signal?: AbortSignal): Promise<ListJobsResponse> {
  const response = await fetch(jobsUrl(filters), {
    headers: { accept: 'application/json' },
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
  return useQuery({
    queryKey: ['jobs', filters.status ?? null, filters.department ?? null, filters.scenario ?? null],
    queryFn: ({ signal }) => fetchJobs(filters, signal),
  });
}
