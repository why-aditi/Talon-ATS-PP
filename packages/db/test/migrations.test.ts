// Acceptance 4: up → down → up is exercised in test/setup.global.ts on every run,
// from an empty database. This file just pins the visible outcome.
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { OWNER_URL } from './urls.js';

it('up → down → up (run in global setup) left a fully migrated, seeded database', async () => {
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    const applied = await sql`select name from _migrations order by name`;
    expect(applied.map((r) => r['name'])).toEqual(['0001_init']);
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
