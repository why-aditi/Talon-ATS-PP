import { useQuery } from '@tanstack/react-query';
import { useSession } from './session';

/**
 * The two reads wizard steps 2 and 3 need. Spec 005 §6.3, §6.4.
 *
 * **Neither endpoint exists yet** (§12 step 4, and §15 OQ7 for the users one).
 * They are written against the contract anyway, so the steps populate the moment
 * the api ships them rather than needing a second pass — and so the shape the web
 * side expects is on record for whoever builds them.
 *
 * A 404 is treated as "not built yet" and resolves to an empty list, which is the
 * same state as a tenant with no templates. That is deliberate: the step already
 * has an honest empty state, and the alternative — an error banner on a wizard
 * step nobody has broken — would be a screen shouting about a roadmap.
 *
 * Any OTHER failure still throws. "Not built" and "broken" are different, and
 * collapsing them would hide a real outage behind a friendly message.
 */

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';

export interface StageTemplate {
  id: string;
  name: string;
  stages: { name: string; slaDays: number | null }[];
}

export interface UserOption {
  id: string;
  name: string;
}

/** Distinguishes "the endpoint answered with nothing" from "there is no endpoint". */
export interface Unbuilt<T> {
  data: T[];
  /** True when the route 404s — the step says which endpoint it is waiting for. */
  unavailable: boolean;
  isPending: boolean;
}

async function readOrEmpty<T>(url: string, accessToken: string | undefined): Promise<T[] | null> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
  });
  // null is the sentinel for "no such route". An empty array would say the tenant
  // has none, which is a different thing to tell the person on step 2.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return (await response.json()) as T[];
}

export function useStageTemplates(): Unbuilt<StageTemplate> {
  const { session, ready } = useSession();
  const query = useQuery({
    queryKey: ['stage-templates', session?.user.id ?? null],
    queryFn: () => readOrEmpty<StageTemplate>(`${API_BASE}/v1/stage-templates`, session?.accessToken),
    enabled: ready && session !== null,
    // A missing route will not start existing on retry, and the wizard should not
    // sit on a spinner for three round trips before showing its empty state.
    retry: false,
  });
  return { data: query.data ?? [], unavailable: query.data === null, isPending: query.isPending };
}

/**
 * Assignable people for step 3. `role` is the api-side filter; both calls are
 * separate queries because recruiters and hiring managers are different lists and
 * caching them together would refetch both when one changes.
 */
export function useAssignableUsers(role: 'recruiter' | 'hiring_manager'): Unbuilt<UserOption> {
  const { session, ready } = useSession();
  const query = useQuery({
    queryKey: ['users', role, session?.user.id ?? null],
    queryFn: () => readOrEmpty<UserOption>(`${API_BASE}/v1/users?role=${role}`, session?.accessToken),
    enabled: ready && session !== null,
    retry: false,
  });
  return { data: query.data ?? [], unavailable: query.data === null, isPending: query.isPending };
}
