// Acceptance 4: up → down → up is exercised in test/setup.global.ts on every run,
// from an empty database. This file just pins the visible outcome.
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { OWNER_URL } from './urls.js';

it('up → down → up (run in global setup) left a fully migrated, seeded database', async () => {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const applied = await sql`select name from _migrations order by name`;
    expect(applied.map((r) => r['name'])).toEqual(['0001_init', '0002_drop_avatar_color']);
    // 0002 dropped users.avatar_color — the UI hashes the id over the avatar.1–8
    // token palette, so a stored hex has no reader (CLAUDE.md §4.8).
    const avatarColor = await sql`
      select 1 from information_schema.columns
      where table_name = 'users' and column_name = 'avatar_color'`;
    expect(avatarColor.length).toBe(0);
    const [tables] = await sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name <> '_migrations'`;
    expect(tables?.['n']).toBe(10);
    const [tenants] = await sql`select count(*)::int as n from tenants`;
    expect(tenants?.['n']).toBe(2);
  } finally {
    await sql.end();
  }
});
