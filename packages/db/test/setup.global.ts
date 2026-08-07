// Acceptance harness (spec 001 §5.4): from an EMPTY database, migrate up, then
// down (must leave nothing behind), then up again, then seed. If any step fails
// the whole suite fails — reversibility is proven on every run.
//
// Runs against a DEDICATED test database (see test/urls.ts) — never the dev database.
import postgres from 'postgres';
import { migrate } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import { MAINTENANCE_URL, OWNER_URL, TEST_DATABASE_NAME } from './urls.js';

/** Creates the test database if it is absent, so the suite needs no manual setup. */
async function ensureTestDatabase(): Promise<void> {
  const admin = postgres(MAINTENANCE_URL, { max: 1, onnotice: () => {} });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${TEST_DATABASE_NAME}`;
    if (existing.length === 0) {
      // A database name cannot be a bound parameter, so validate then quote.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(TEST_DATABASE_NAME)) {
        throw new Error(`refusing to create database with unsafe name: ${TEST_DATABASE_NAME}`);
      }
      await admin.unsafe(`create database "${TEST_DATABASE_NAME}"`);
      console.log(`global setup: created test database ${TEST_DATABASE_NAME}`);
    }
  } finally {
    await admin.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await ensureTestDatabase();

  const admin = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe('drop schema if exists public cascade; create schema public;');
  await admin.end();

  await migrate('up', OWNER_URL);
  // `down` reverts one migration per call; unwind the whole stack so the
  // zero-tables assertion below stays a real test as more migrations land.
  while ((await migrate('down', OWNER_URL)).length > 0) {
    // keep stepping back
  }

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
  console.log(`global setup: up → down → up clean, seed applied to ${TEST_DATABASE_NAME}`);
}
