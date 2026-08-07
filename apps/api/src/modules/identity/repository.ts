/**
 * The ONLY file in this module allowed to touch the database (the file @talon/db
 * imports are permitted in — these queries are hand-written SQL rather than
 * Drizzle because they are two function calls and a transaction primitive, which
 * a query builder makes longer, not clearer).
 *
 * It owns three things: the local credential store, the two §11b bootstrap
 * lookups, and the per-request tenant transaction primitive.
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

export interface LocalIdentityRecord {
  sub: string;
  email: string;
  passwordHash: string;
  totpSecret: string | null;
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

interface IdentityRow {
  sub: string;
  email: string;
  password_hash: string;
  totp_secret: string | null;
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

function toIdentity(row: IdentityRow | undefined): LocalIdentityRecord | null {
  if (!row) return null;
  return {
    sub: row.sub,
    email: row.email,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
  };
}

export class IdentityRepository {
  readonly #sql: postgres.Sql;
  #roleAudited = false;

  constructor({ sql }: { sql: postgres.Sql }) {
    this.#sql = sql;
  }

  // ── §11b bootstrap: runs before app.tenant_id exists ──────────────────────
  // Both go through a security definer function with a pinned search_path
  // (migration 0003). The app role has no other way past the users policy, and
  // neither function returns password material.

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.#sql<UserRow[]>`select * from auth_user_by_email(${email}::citext)`;
    return toUser(rows[0]);
  }

  async findUserBySub(sub: string): Promise<UserRecord | null> {
    const rows = await this.#sql<UserRow[]>`select * from auth_user_by_sub(${sub}::uuid)`;
    return toUser(rows[0]);
  }

  // ── local credential store ────────────────────────────────────────────────

  async findIdentityByEmail(email: string): Promise<LocalIdentityRecord | null> {
    const rows = await this.#sql<IdentityRow[]>`
      select sub, email, password_hash, totp_secret
      from local_identities where email = ${email}::citext`;
    return toIdentity(rows[0]);
  }

  async findIdentityBySub(sub: string): Promise<LocalIdentityRecord | null> {
    const rows = await this.#sql<IdentityRow[]>`
      select sub, email, password_hash, totp_secret
      from local_identities where sub = ${sub}::uuid`;
    return toIdentity(rows[0]);
  }

  /**
   * Upsert keyed on EMAIL, not sub: email is the login identifier here, and
   * re-provisioning a person who was re-created upstream (a re-seeded database
   * hands the same people new ids) must replace the credential rather than
   * collide with the unique email. A new credential resets TOTP — an
   * authenticator enrolled against the old one is not this identity's.
   */
  async putIdentity(input: { sub: string; email: string; passwordHash: string }): Promise<void> {
    await this.#sql`
      insert into local_identities (sub, email, password_hash)
      values (${input.sub}::uuid, ${input.email}::citext, ${input.passwordHash})
      on conflict (email) do update
        set sub = excluded.sub,
            password_hash = excluded.password_hash,
            totp_secret = null,
            totp_enrolled_at = null`;
  }

  async setTotpSecret(sub: string, secret: string): Promise<void> {
    await this.#sql`
      update local_identities
      set totp_secret = ${secret}, totp_enrolled_at = now()
      where sub = ${sub}::uuid`;
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
