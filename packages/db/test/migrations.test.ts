// Acceptance 4: up → down → up is exercised in test/setup.global.ts on every run,
// from an empty database. This file just pins the visible outcome.
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { OWNER_URL } from './urls.js';

it('up → down → up (run in global setup) left a fully migrated, seeded database', async () => {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const applied = await sql`select name from _migrations order by name`;
    expect(applied.map((r) => r['name'])).toEqual([
      '0001_init',
      '0002_drop_avatar_color',
      '0003_local_identities',
      '0004_users_external_id',
      '0005_audit_authentication',
      '0006_outbox',
      '0007_definer_rls_exemption',
      '0008_jobs_version',
      '0009_scheduling',
    ]);
    // 0002 dropped users.avatar_color — the UI hashes the id over the avatar.1–8
    // token palette, so a stored hex has no reader (CLAUDE.md §4.8).
    const avatarColor = await sql`
      select 1 from information_schema.columns
      where table_name = 'users' and column_name = 'avatar_color'`;
    expect(avatarColor.length).toBe(0);
    const [tables] = await sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name <> '_migrations'`;
    // 10 from 0001, plus local_identities from 0003, outbox from 0006, and 0009's five
    // scheduling tables.
    expect(tables?.['n']).toBe(17);
    // The security definer surface must survive down → up as well, and its size
    // is the thing to watch: 0003's two readers are the only way sign-in can
    // read a users row (spec 001 §11b), and 0005's writer is the only way it can
    // record that it happened (CLAUDE.md §4). A fourth appearing here without a
    // migration explaining itself is the finding, not the count.
    const definers = await sql<{ proname: string; proconfig: string[] | null }[]>`
      select proname, proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef order by proname`;
    expect(definers.map((r) => r.proname)).toEqual([
      'audit_sign_in',
      'auth_user_by_email',
      'auth_user_by_sub',
    ]);
    for (const definer of definers) {
      // An unpinned search_path on a definer function is the classic way to have
      // it execute someone else's `users` — or write someone else's audit_log.
      expect(definer.proconfig, definer.proname).toContain('search_path=pg_catalog, public');
    }
    // 0006's two exception policies, pinned by SHAPE rather than by existence.
    // The one on audit_log must stay INSERT-only: a `using` clause on it would
    // hand the owner a way to READ every tenant's audit rows, which is a
    // different and much larger change than letting the sign-in writer write.
    const exceptions = await sql<{ tablename: string; cmd: string; qual: string | null }[]>`
      select tablename, cmd, qual from pg_policies
      where schemaname = 'public' and policyname in ('auth_bootstrap_read', 'audit_sign_in_write')
      order by policyname`;
    expect(exceptions).toHaveLength(2);
    expect(exceptions[0]).toMatchObject({ tablename: 'audit_log', cmd: 'INSERT', qual: null });
    expect(exceptions[1]?.tablename).toBe('users');
    expect(exceptions[1]?.cmd).toBe('SELECT');
    // 0004 retyped auth_user_by_sub's parameter uuid → text. Pinned here because
    // the signature is what the repository's cast has to agree with: while it was
    // uuid, a non-UUID subject raised 22P02 before the lookup ran.
    const [subFn] = await sql`
      select pg_get_function_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'auth_user_by_sub'`;
    expect(subFn?.['args']).toBe('p_sub text');
    // 0004 added users.external_id and nothing else column-wise.
    const externalId = await sql`
      select data_type, is_nullable from information_schema.columns
      where table_name = 'users' and column_name = 'external_id'`;
    expect(externalId).toHaveLength(1);
    expect(externalId[0]?.['data_type']).toBe('text');
    expect(externalId[0]?.['is_nullable']).toBe('YES');
    const [tenants] = await sql`select count(*)::int as n from tenants`;
    expect(tenants?.['n']).toBe(2);
  } finally {
    await sql.end();
  }
});
