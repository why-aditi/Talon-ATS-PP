/**
 * Spec 001 §11b: the sign-in bootstrap, and how narrow it actually is.
 *
 * The decision was a `security definer` function with a pinned search_path,
 * rather than a bootstrap connection. This suite is the evidence for "narrow":
 * as the app role, the only thing reachable outside a tenant context is one
 * users row by exact key, with no password material — and every ordinary table
 * read still returns nothing.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadFixtures, type Fixtures } from './helpers.js';
import { APP_URL, OWNER_URL } from './urls.js';

let sql: postgres.Sql;
let fixtures: Fixtures;
/**
 * The recruiter's TOKEN SUBJECT, which is not the same thing as their id: other
 * files in this suite provision against the fake pool and write
 * `users.external_id`, and `auth_user_by_sub` matches `users.id` only where
 * `external_id is null` (migration 0004). Reading it here rather than assuming
 * keeps this file order-independent.
 */
let subject: string;

beforeAll(async () => {
  fixtures = await loadFixtures();
  sql = postgres(APP_URL, { max: 1, onnotice: () => {} });
  const owner = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const [row] = await owner<{ sub: string }[]>`
      select coalesce(external_id, id::text) as sub from users
      where id = ${fixtures.talon.recruiter.id}::uuid`;
    if (!row) throw new Error('seed is missing the recruiter');
    subject = row.sub;
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  await sql.end();
});

it('the app role cannot bypass RLS', async () => {
  const [row] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  expect(row).toEqual({ rolsuper: false, rolbypassrls: false });
});

it('without tenant context, ordinary reads return nothing — including users', async () => {
  // This is the problem §11b describes: sign-in has to read a users row here.
  for (const table of ['users', 'tenants', 'jobs', 'applications']) {
    expect(await sql`select * from ${sql(table)} limit 1`, table).toHaveLength(0);
  }
});

it('the bootstrap function returns exactly the one row sign-in needs', async () => {
  const rows = await sql<Record<string, unknown>[]>`
    select * from auth_user_by_email(${fixtures.talon.recruiter.email}::citext)`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: fixtures.talon.recruiter.id,
    tenant_id: fixtures.talon.tenantId,
    role: 'recruiter',
  });
});

it('the bootstrap functions expose no password material and no other columns', async () => {
  const columns = Object.keys(
    (await sql<Record<string, unknown>[]>`
      select * from auth_user_by_sub(${subject}::text)`)[0] ?? {},
  ).sort();
  expect(columns).toEqual([
    'email',
    'id',
    'mfa_enabled',
    'name',
    'role',
    'tenant_id',
    'timezone',
    'tokens_valid_after',
  ]);
});

it('the bootstrap is an exact-match lookup, not a query surface', async () => {
  // No pattern, no wildcard, no "list everyone in this tenant".
  expect(await sql`select * from auth_user_by_email(${'%@taloninc.com'}::citext)`).toHaveLength(0);
  expect(await sql`select * from auth_user_by_email(${''}::citext)`).toHaveLength(0);
  // …and it is case-insensitive, because users.email is citext and people type
  // their address however they like.
  expect(
    await sql`select * from auth_user_by_email(${'MAYA@TalonInc.com'}::citext)`,
  ).toHaveLength(1);
});

it('the SECURITY DEFINER surface is three functions, and their search_path is pinned', async () => {
  const rows = await sql<{ proname: string; proconfig: string[] | null }[]>`
    select p.proname, p.proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
    order by p.proname`;
  // Two readers (0003/0004) and one writer (0005). Every one of them exists
  // because sign-in runs before app.tenant_id does; anything else appearing in
  // this list is a privilege escalation waiting to be found by someone else.
  expect(rows.map((r) => r.proname)).toEqual([
    'audit_sign_in',
    'auth_user_by_email',
    'auth_user_by_sub',
  ]);
  for (const row of rows) {
    // An unpinned search_path on a definer function is the classic way to have
    // it execute someone else's `users`.
    expect(row.proconfig, row.proname).toContain('search_path=pg_catalog, public');
  }
});

it('local_identities is reachable only as the credential store it is', async () => {
  // The app process verifies passwords, so it can read hashes. What it must not
  // be able to do is reach them through the RLS-bypassing path above, or write
  // history it cannot be audited on.
  const [privileges] = await sql<{ del: boolean }[]>`
    select has_table_privilege(current_user, 'local_identities', 'delete') as del`;
  expect(privileges?.del).toBe(false);
});
