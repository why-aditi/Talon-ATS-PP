// Acceptance harness (spec 001 §5.4): from an EMPTY database, migrate up, then
// down (must leave nothing behind), then up again, then seed. If any step fails
// the whole suite fails — reversibility is proven on every run.
import postgres from 'postgres';
import { migrate } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import { OWNER_URL } from './urls.js';

export default async function globalSetup(): Promise<void> {
  const admin = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe('drop schema if exists public cascade; create schema public;');
  await admin.end();

  await migrate('up', OWNER_URL);
  await migrate('down', OWNER_URL);

  const check = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const [row] = await check`
    select count(*)::int as n from information_schema.tables
    where table_schema = 'public' and table_name <> '_migrations'`;
  await check.end();
  if (row?.['n'] !== 0) {
    throw new Error(`migrate down left ${row?.['n']} tables behind — down migration is not clean`);
  }

  await migrate('up', OWNER_URL);
  await seed(OWNER_URL);
  console.log('global setup: up → down → up clean, seed applied');
}
