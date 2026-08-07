/**
 * Test-database bootstrap shared by suites that need a real Postgres.
 *
 * It lives here rather than in `apps/api/test` because only `repository.ts` may
 * import `@talon/db` inside the api (CLAUDE.md §3), and a test harness is not a
 * repository. `packages/testing` is the documented home for fixtures and seed
 * (CLAUDE.md §3), and it is a devDependency of the api — never imported by
 * `apps/api/src`, which lint enforces.
 *
 * Every URL here targets a DEDICATED database. The dev database is never
 * opened: `packages/db/test/urls.ts` records what happened the last time a suite
 * pointed at it.
 */
import postgres from 'postgres';
import { migrate } from '@talon/db/migrate';
import { seed } from '@talon/db/seed';

const DEV_URL = process.env['DATABASE_URL'] ?? 'postgres://talon:talon@localhost:5432/talon';

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function withRole(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

/** Owner (migration) role: the docker superuser. Bypasses RLS — setup only. */
export function ownerUrl(database: string): string {
  return withDatabase(DEV_URL, database);
}

/**
 * The role the API actually runs as: subject to RLS, no BYPASSRLS. Created by
 * `ensureAppRole()` during migration.
 */
export function appUrl(database: string): string {
  return withRole(
    ownerUrl(database),
    'talon_app',
    process.env['TALON_APP_PASSWORD'] ?? 'talon_app',
  );
}

async function ensureDatabase(database: string): Promise<void> {
  // You cannot `create database` from inside a connection to it; `postgres`
  // always exists.
  const admin = postgres(withDatabase(ownerUrl(database), 'postgres'), {
    max: 1,
    onnotice: () => {},
  });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${database}`;
    if (existing.length > 0) return;
    // A database name cannot be a bound parameter, so validate then quote.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
      throw new Error(`refusing to create database with unsafe name: ${database}`);
    }
    await admin.unsafe(`create database "${database}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Creates the database if absent, applies every migration, and seeds the
 * reference data. Idempotent: `seed()` truncates first, so a suite always starts
 * from the same rows regardless of what the last run left behind.
 */
export async function setupTestDatabase(database: string): Promise<{ owner: string; app: string }> {
  await ensureDatabase(database);
  const owner = ownerUrl(database);
  await migrate('up', owner);
  await seed(owner);
  return { owner, app: appUrl(database) };
}
