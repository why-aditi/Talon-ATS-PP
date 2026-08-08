import { ListStageTemplatesResponseSchema, ListUsersResponseSchema } from '@talon/contracts';
import {
  CreateApplicationResponseSchema,
  JobSchema,
  type CreateApplicationResponse,
  type Job,
  type StageTemplate,
  type UserSummary,
} from '@talon/contracts';
import { useQuery } from '@tanstack/react-query';
import { useSession } from './session';

/**
 * The two reads wizard steps 2 and 3 need. Spec 005 §6.3, §6.4.
 *
 * Both endpoints now EXIST — GET /v1/stage-templates and GET /v1/users. This file
 * used to say neither did, and cast the body `as T[]` on that basis. Both return
 * the project's standard `{ data: [...] }` envelope, so once they shipped the cast
 * silently handed the wizard an object: `templates.find is not a function` at
 * job-wizard.tsx:307, with a type signature still claiming an array.
 *
 * Hence the schema parameter below rather than a cast. The response is validated
 * against the same contract the api answers with, so a shape change is a loud
 * failure here instead of a TypeError three components away.
 *
 * A 404 is still treated as "not built yet" and resolves to an empty list, which
 * is the same state as a tenant with no templates. That is deliberate: the step
 * already has an honest empty state. Any OTHER failure still throws — "not built"
 * and "broken" are different, and collapsing them would hide a real outage.
 */

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? '';

/*
  Re-exported so components keep importing these from one place. They used to be
  hand-written interfaces here — { id, name } for a user, { name, slaDays } for a
  stage — which is how the fixtures and the components agreed on a shape the api
  never returned. Aliased from the contract now, so there is one definition.
*/
export type { StageTemplate };
export type UserOption = UserSummary;

/** Distinguishes "the endpoint answered with nothing" from "there is no endpoint". */
export interface Unbuilt<T> {
  data: T[];
  /** True when the route 404s — the step says which endpoint it is waiting for. */
  unavailable: boolean;
  isPending: boolean;
}

/**
 * `schema` is typed structurally rather than as a `z.ZodType` so this file needs no
 * zod import of its own — the contract package already owns the schemas, and this
 * only needs the one method.
 */
async function readOrEmpty<T>(
  url: string,
  accessToken: string | undefined,
  schema: { parse: (input: unknown) => { data: T[] } },
): Promise<T[] | null> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
  });
  // null is the sentinel for "no such route". An empty array would say the tenant
  // has none, which is a different thing to tell the person on step 2.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  // Unwraps the envelope AND validates it. Returning the parsed `data` is what
  // makes the declared `T[]` true rather than asserted.
  return schema.parse(await response.json()).data;
}

export function useStageTemplates(): Unbuilt<StageTemplate> {
  const { session, ready } = useSession();
  const query = useQuery({
    queryKey: ['stage-templates', session?.user.id ?? null],
    queryFn: () =>
      readOrEmpty<StageTemplate>(`${API_BASE}/v1/stage-templates`, session?.accessToken, ListStageTemplatesResponseSchema),
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
export function useAssignableUsers(role: 'recruiter' | 'hiring_manager'): Unbuilt<UserSummary> {
  const { session, ready } = useSession();
  const query = useQuery({
    queryKey: ['users', role, session?.user.id ?? null],
    queryFn: () => readOrEmpty<UserSummary>(`${API_BASE}/v1/users?role=${role}`, session?.accessToken, ListUsersResponseSchema),
    enabled: ready && session !== null,
    retry: false,
  });
  return { data: query.data ?? [], unavailable: query.data === null, isPending: query.isPending };
}

/**
 * POST /v1/jobs — spec 005 §4.2.
 *
 * Not a `useMutation`: the wizard needs the created job to navigate to it and
 * has one submit path, so the extra state machine would be ceremony. What it
 * does need is the failure distinguished, which `JobCreateError` carries.
 */
export class JobWriteError extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly detail?: string,
    /** The 409 body's `current` — what the caller is conflicting with. */
    readonly current?: Job,
  ) {
    super(detail ?? type);
    this.name = 'JobWriteError';
  }
}

/** Kept so the wizard's imports do not churn; one class, two names. */
export { JobWriteError as JobCreateError };

export async function createJob(
  payload: unknown,
  accessToken: string | undefined,
): Promise<{ id: string; reqCode: string }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/v1/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Genuinely offline — the one failure where retrying the same request is
    // the right advice, so it must not read as "the job was rejected".
    throw new JobWriteError('urn:talon:client:network', 0);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = (body ?? {}) as { type?: string; detail?: string };
    throw new JobWriteError(problem.type ?? 'urn:talon:error:internal', response.status, problem.detail);
  }
  return body as { id: string; reqCode: string };
}

/**
 * PATCH /v1/jobs/:id — spec 005 §4.3.
 *
 * A 409 is not an error to report and forget: it carries the current resource,
 * and the caller needs it to offer reload-or-overwrite rather than making the
 * user discard their edit blind.
 */
export async function updateJob(
  id: string,
  patch: Record<string, unknown>,
  accessToken: string | undefined,
): Promise<Job> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/v1/jobs/${id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(patch),
    });
  } catch {
    throw new JobWriteError('urn:talon:client:network', 0);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = (body ?? {}) as { type?: string; detail?: string; current?: Job };
    throw new JobWriteError(
      problem.type ?? 'urn:talon:error:internal',
      response.status,
      problem.detail,
      problem.current,
    );
  }
  return JobSchema.parse(body);
}

/**
 * POST /v1/applications — spec 005 §4.5.
 *
 * Returns the created card and the stage it landed on; the board refetches
 * rather than inserting it, because counts, medians and the distribution are all
 * derived and would go stale if only the card were spliced in.
 */
export async function createApplication(
  payload: unknown,
  accessToken: string | undefined,
): Promise<CreateApplicationResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/v1/applications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new JobWriteError('urn:talon:client:network', 0);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = (body ?? {}) as { type?: string; detail?: string };
    throw new JobWriteError(problem.type ?? 'urn:talon:error:internal', response.status, problem.detail);
  }
  return CreateApplicationResponseSchema.parse(body);
}
