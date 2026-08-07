import { useQuery } from '@tanstack/react-query';
import { jobListResponseSchema, type JobListResponse } from './jobs-contract';

export type JobFilters = {
  status?: string | undefined;
  department?: string | undefined;
  /** Mock-only; see mocks/handlers.ts. Ignored by the real endpoint. */
  scenario?: string | undefined;
};

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';

export function jobsUrl(filters: JobFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.department) params.set('department', filters.department);
  if (filters.scenario) params.set('_scenario', filters.scenario);
  const query = params.toString();
  return `${API_BASE}/v1/jobs${query ? `?${query}` : ''}`;
}

export async function fetchJobs(filters: JobFilters, signal?: AbortSignal): Promise<JobListResponse> {
  const response = await fetch(jobsUrl(filters), {
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    // The body is problem+json; the screen shows its own copy, so only the status is
    // carried up. Nothing user-facing ever renders a server error string verbatim.
    throw new Error(`GET /v1/jobs failed with ${response.status}`);
  }
  return jobListResponseSchema.parse(await response.json());
}

export function useJobs(filters: JobFilters) {
  return useQuery({
    queryKey: ['jobs', filters.status ?? null, filters.department ?? null, filters.scenario ?? null],
    queryFn: ({ signal }) => fetchJobs(filters, signal),
  });
}
