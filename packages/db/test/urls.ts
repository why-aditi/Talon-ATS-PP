// DEVIATION FROM CLAUDE.md §6 (Testcontainers), reviewer finding 3 — read this before
// changing anything here.
//
// The suite in this package runs against the local Postgres from docker-compose rather
// than a Testcontainers-managed instance. That is a deliberate, cheaper choice for M0a,
// and it is recorded in the step-3 PR description.
//
// What it must never do again: the suite used to point at the SAME database as
// `pnpm dev` / `pnpm db:seed` and open with `drop schema public cascade`, so a developer
// running the root `pnpm test` silently destroyed their working state. Every URL below
// therefore targets a SEPARATE database (`talon_test` by default), created on demand by
// setup.global.ts. The dev database is never opened by this suite.
//
// Escape hatches: TEST_DATABASE_URL overrides the whole thing; TEST_DATABASE_NAME
// overrides just the database name. Swapping in Testcontainers later means setting
// TEST_DATABASE_URL to the container's URL and deleting ensureTestDatabase().

const DEV_URL = process.env['DATABASE_URL'] ?? 'postgres://talon:talon@localhost:5432/talon';

export const TEST_DATABASE_NAME = process.env['TEST_DATABASE_NAME'] ?? 'talon_test';

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Owner (migration) role: docker superuser, bypasses RLS — setup and metric assertions. */
export const OWNER_URL = process.env['TEST_DATABASE_URL'] ?? withDatabase(DEV_URL, TEST_DATABASE_NAME);

/**
 * Maintenance connection used only to `create database` — you cannot create a database
 * from inside a connection to it. Postgres always ships with a `postgres` database.
 */
export const MAINTENANCE_URL = withDatabase(OWNER_URL, 'postgres');

/** App role: created by ensureAppRole(), subject to RLS (no BYPASSRLS). */
export const APP_URL = (() => {
  const u = new URL(OWNER_URL);
  u.username = 'talon_app';
  u.password = process.env['TALON_APP_PASSWORD'] ?? 'talon_app';
  return u.toString();
})();

export const TENANT_TABLES = [
  'users',
  'stage_templates',
  'jobs',
  'job_stages',
  'candidates',
  'applications',
  'stage_transitions',
  'activities',
  'audit_log',
  // Scheduling (migration 0009). Listed because the seed writes rows for BOTH tenants —
  // Ana's four-round loop and Acme's one-round loop — so the sweep is not vacuous.
  'interview_loops',
  'interview_rounds',
  'interview_round_panelists',
  'interviews',
  'interview_panelists',
  // `outbox` (migration 0006) is deliberately NOT here, and it is worth saying why
  // rather than leaving it looking forgotten. The sweep asserts that tenant A sees
  // rows and none of tenant B's — it needs SEEDED DATA to mean anything, and an empty
  // table passes it vacuously. The seed writes no outbox rows because nothing mutates
  // during seeding. `test/outbox.test.ts` covers the same policy directly by inserting
  // its own rows in both tenants, which is stronger than a vacuous sweep entry.
  // Add it here the day the seed produces a row.
] as const;
