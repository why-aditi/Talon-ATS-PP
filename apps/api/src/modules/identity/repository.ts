/**
 * The ONLY file in this module allowed to touch the database (the file @talon/db
 * imports are permitted in — these queries are hand-written SQL rather than
 * Drizzle because they are two function calls and a transaction primitive, which
 * a query builder makes longer, not clearer).
 *
 * It owns two things: the §11b bootstrap lookup, and the per-request tenant
 * transaction primitive.
 *
 * The local credential store is gone with `LocalIdentityProvider` (spec 002 open
 * question 1). `local_identities` and `auth_user_by_email` are deliberately
 * still in the database — dropping a table holding password hashes is a
 * migration with a real rollback story (spec 003 §6 owns it), and a table
 * nothing reads is harmless where a rushed `drop table` is not. Nothing in
 * `src/` reaches either any more, which is the part that matters here.
 */
import { isRole, type Role } from '@talon/domain';
import type postgres from 'postgres';
import type { TenantTransaction } from '../../request-context.js';

export interface UserRecord {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
  timezone: string;
  mfaEnabled: boolean;
  tokensValidAfter: Date | null;
}

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: string;
  timezone: string;
  mfa_enabled: boolean;
  tokens_valid_after: Date | null;
}

function toUser(row: UserRow | undefined): UserRecord | null {
  if (!row) return null;
  // The enum exists in three places (SQL check, Drizzle column, contracts) with
  // nothing yet testing that they agree — open question 9. Until that test lands,
  // an unrecognised role is refused rather than carried into a scope lookup that
  // would silently resolve to no scopes.
  if (!isRole(row.role)) throw new Error(`users.role holds an unknown role: ${row.role}`);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    name: row.name,
    role: row.role,
    timezone: row.timezone,
    mfaEnabled: row.mfa_enabled,
    tokensValidAfter: row.tokens_valid_after,
  };
}

export class IdentityRepository {
  readonly #sql: postgres.Sql;
  #roleAudited = false;

  constructor({ sql }: { sql: postgres.Sql }) {
    this.#sql = sql;
  }

  // ── §11b bootstrap: runs before app.tenant_id exists ──────────────────────
  // Goes through a security definer function with a pinned search_path
  // (migrations 0003/0004). The app role has no other way past the users policy,
  // and the function returns no password material.
  //
  // `auth_user_by_email` has no caller any more — it existed for the local
  // provider's "verify the hash, then find the person" step, and Cognito answers
  // both halves. The function stays in the database (see the file header); the
  // wrapper does not, because a repository method nothing calls is a query
  // surface nothing reviews.

  /**
   * `::text`, not `::uuid`. Migration 0004 retyped the parameter and dropped the
   * uuid overload deliberately: a Cognito sub is the IdP's string, and casting it
   * client-side would raise 22P02 on any non-UUID subject (a SAML NameID, a
   * hostile token) before the function's own guard could return zero rows.
   */
  async findUserBySub(sub: string): Promise<UserRecord | null> {
    const rows = await this.#sql<UserRow[]>`select * from auth_user_by_sub(${sub}::text)`;
    return toUser(rows[0]);
  }

  // ── the sign-in audit row (CLAUDE.md §4) ──────────────────────────────────

  /**
   * Records one sign-in attempt, successful or not.
   *
   * Outside any transaction, and it has to be: sign-in runs before tenant
   * context exists, so there is no `openTenantTransaction` to enlist in, and a
   * failed attempt never acquires a tenant at all. It goes through
   * `audit_sign_in` (migration 0005), a `security definer` writer granted only
   * this one row shape — see that migration for why a second owner-privileged
   * connection was refused.
   *
   * Not wrapped in a try/catch anywhere down this path. A sign-in that cannot be
   * audited does not happen (CLAUDE.md §4), and swallowing the failure would
   * make the guarantee a hope. It is also uniform: nothing here depends on
   * whether the address exists, so a broken audit path cannot become the
   * enumeration oracle the sign-in path refuses to be.
   */
  async recordSignIn(input: {
    outcome: 'succeeded' | 'failed';
    /** The RFC 9457 `type` the caller was given. Never more than that. */
    reason: string | null;
    email: string;
    /** Non-null only on success — a failure proves no identity to attribute. */
    tenantId: string | null;
    actorId: string | null;
    ip: string | null;
    requestId: string | null;
  }): Promise<void> {
    await this.#sql`select audit_sign_in(
      ${input.outcome}::text,
      ${input.reason}::text,
      ${input.email}::text,
      ${input.tenantId}::uuid,
      ${input.actorId}::uuid,
      ${input.ip}::text,
      ${input.requestId}::text)`;
  }

  // ── the request transaction (spec 001 §6.3) ───────────────────────────────

  /**
   * Reserves a connection, opens a transaction, and pins the tenant to it.
   *
   * `set_config(..., true)` is `SET LOCAL`: the setting dies with the
   * transaction. A plain `SET` survives the commit, and on a pooled connection
   * the next request inherits this tenant — packages/db/test/leak.test.ts
   * demonstrates exactly that failure with a max-1 pool.
   */
  async beginTenantTransaction(tenantId: string, userId: string): Promise<TenantTransaction> {
    const reserved = await this.#sql.reserve();
    let settled = false;
    const finish = async (verb: 'commit' | 'rollback'): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        await reserved.unsafe(verb);
      } finally {
        // Always, even if COMMIT threw: a reserved connection that is never
        // released is a pool leak, and with a small pool the service stops
        // answering after `max` failures (§9 edge case 10).
        reserved.release();
      }
    };

    try {
      await this.#auditConnectionRole(reserved);
      await reserved.unsafe('begin');
      await reserved`select set_config('app.tenant_id', ${tenantId}, true)`;
      await reserved`select set_config('app.user_id', ${userId}, true)`;
    } catch (err) {
      await finish('rollback');
      throw err;
    }

    return {
      tenantId,
      userId,
      sql: reserved,
      commit: () => finish('commit'),
      rollback: () => finish('rollback'),
    };
  }

  /**
   * Refuses to serve a request on a connection that bypasses RLS. Running the
   * api as the owner or as a BYPASSRLS role turns every policy into decoration
   * and nothing else in the system would notice (spec 001 §11b). Checked once
   * per pool, on the first transaction.
   */
  async #auditConnectionRole(sql: postgres.Sql): Promise<void> {
    if (this.#roleAudited) return;
    const [row] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    if (!row) throw new Error('could not resolve the current database role');
    if (row.rolsuper || row.rolbypassrls) {
      throw new Error(
        'the api is connected as a role that bypasses row level security; ' +
          'set API_DATABASE_URL to the application role (talon_app), not the owner',
      );
    }
    this.#roleAudited = true;
  }
}
