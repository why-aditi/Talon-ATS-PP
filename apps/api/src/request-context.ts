/**
 * What the auth chain establishes for a request: who the caller is, and the
 * transaction their tenant is pinned to (spec 001 §6.3).
 *
 * Deliberately typed here, at the api root, rather than inside a module: every
 * module's `service.ts` and `repository.ts` receives these, and a type owned by
 * one module would make every other module cross a boundary to name it.
 */
import type { Role, Scope } from '@talon/domain';
import type postgres from 'postgres';

/** The resolved caller: the `users` row plus what it is allowed to see. */
export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  timezone: string;
  scopes: readonly Scope[];
}

export interface TenantTransaction {
  readonly tenantId: string;
  readonly userId: string;
  /**
   * A connection reserved for this request, inside `BEGIN`, with
   * `app.tenant_id` and `app.user_id` set via `SET LOCAL`. Every query a
   * repository runs on it is filtered by the RLS policies as the app role.
   */
  readonly sql: postgres.ReservedSql;
  /** COMMIT and release. Idempotent — a second call after rollback does nothing. */
  commit(): Promise<void>;
  /** ROLLBACK and release. Idempotent, and safe to call on an already-finished tx. */
  rollback(): Promise<void>;
}
