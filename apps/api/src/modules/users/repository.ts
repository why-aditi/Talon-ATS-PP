/**
 * The ONLY file in this module allowed to touch the database.
 *
 * Every query runs on `tx.sql` — the request's reserved connection, inside its
 * transaction, with `app.tenant_id` set. The RLS policy makes another tenant's
 * row unreachable; the explicit `tenant_id` predicate is the application check
 * on top of it (spec 001 §6.3).
 */
import type { Role } from '@talon/contracts';
import type { TenantTransaction } from '../../request-context.js';

export interface UserSummaryRecord {
  id: string;
  name: string;
  role: Role;
}

export class UsersRepository {
  /**
   * `roles` empty means every role. The filter is passed as an array and
   * compared with `= any`, so one query serves "recruiters", "recruiters and
   * admins", and "everyone" without three code paths.
   */
  async findSummaries(tx: TenantTransaction, roles: readonly Role[]): Promise<UserSummaryRecord[]> {
    return tx.sql<UserSummaryRecord[]>`
      select id, name, role
      from users
      where tenant_id = ${tx.tenantId}::uuid
        and (${roles.length === 0} or role = any(${roles as string[]}::text[]))
      order by name`;
  }
}
