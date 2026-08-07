// Plain-SQL migration runner. drizzle-kit cannot generate down migrations, so
// migrations are hand-written .up.sql/.down.sql pairs applied in filename order
// and tracked in _migrations. Laziest thing that satisfies "up → down → up is clean".
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const DEFAULT_DATABASE_URL = 'postgres://talon:talon@localhost:5432/talon';

/**
 * Local-only fallback password for the app role. Usable ONLY against a loopback
 * host — ensureAppRole throws rather than applying it anywhere else, so pointing
 * migrations at Aurora (spec 002) cannot silently provision a role whose password
 * is published in this repository.
 */
export const LOCAL_APP_PASSWORD = 'talon_app';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

function isLoopback(databaseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(databaseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Resolves the app-role password, or throws. Pure and side-effect free so migrate()
 * can call it BEFORE opening a connection — a misconfigured target must fail on the
 * configuration, not on whatever the network happens to say first.
 *
 * Local clean clone: no setup, no env var, `pnpm db:migrate` just works.
 * Anywhere else: TALON_APP_PASSWORD is required, and its absence is a hard failure
 * rather than a default.
 */
export function resolveAppRolePassword(databaseUrl: string): { password: string; explicit: boolean } {
  // `|| undefined` so TALON_APP_PASSWORD='' counts as unset rather than as an
  // operator asking for an empty password.
  const fromEnv = process.env['TALON_APP_PASSWORD'] || undefined;
  if (!fromEnv && !isLoopback(databaseUrl)) {
    throw new Error(
      'TALON_APP_PASSWORD must be set when migrating a non-local database. The built-in ' +
        'default is a published local-dev credential and is refused against remote hosts.',
    );
  }
  return { password: fromEnv ?? LOCAL_APP_PASSWORD, explicit: fromEnv !== undefined };
}

/**
 * Creates the app role if it is absent. Deliberately NOT in 0001_init.up.sql: a
 * password literal in a migration file replays verbatim into every environment
 * the migration is ever pointed at, so staging and prod would inherit the local
 * dev credential the first time someone runs this against Aurora.
 */
export async function ensureAppRole(sql: postgres.Sql, databaseUrl: string): Promise<void> {
  const { password, explicit } = resolveAppRolePassword(databaseUrl);
  // The password travels as a bound parameter into a GUC and is quoted by
  // format(%L) inside the block — it never becomes part of any SQL text we build.
  await sql`select set_config('talon.app_password', ${password}, false)`;
  await sql`select set_config('talon.app_password_explicit', ${explicit ? 'true' : 'false'}, false)`;
  try {
    await sql`
      do $$
      declare pw text := current_setting('talon.app_password');
      begin
        if not exists (select from pg_roles where rolname = 'talon_app') then
          execute format('create role talon_app login password %L', pw);
        elsif current_setting('talon.app_password_explicit') = 'true' then
          -- Only when an operator stated a password do we make it authoritative.
          -- Otherwise an existing role keeps whatever provisioned it (Terraform).
          execute format('alter role talon_app with login password %L', pw);
        end if;
      end $$`;
  } finally {
    await sql`select set_config('talon.app_password', '', false)`;
  }
}

/**
 * Applies every pending migration (`up`) or reverts exactly the most recent one
 * (`down`), and returns the names it touched. `down` is one step per call so
 * `pnpm db:migrate:down` can never unwind a whole database by accident; a caller
 * that wants the full stack (test/setup.global.ts) loops on the return value.
 */
export async function migrate(
  direction: 'up' | 'down',
  databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL,
): Promise<string[]> {
  // Validate the app-role credential before opening a socket, so pointing this at a
  // remote database without TALON_APP_PASSWORD fails on the misconfiguration rather
  // than on a DNS or TLS error that hides it.
  if (direction === 'up') resolveAppRolePassword(databaseUrl);

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = (await sql`select name from _migrations order by name`).map(
      (r) => r['name'] as string,
    );

    const touched: string[] = [];
    if (direction === 'up') {
      // 0001_init grants to talon_app, so the role has to exist first.
      await ensureAppRole(sql, databaseUrl);
      const ups = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.up.sql'))
        .sort();
      for (const file of ups) {
        const name = file.slice(0, -'.up.sql'.length);
        if (applied.includes(name)) continue;
        const ddl = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        await sql.begin(async (tx) => {
          await tx.unsafe(ddl);
          await tx`insert into _migrations (name) values (${name})`;
        });
        console.log(`migrated up: ${name}`);
        touched.push(name);
      }
    } else {
      const last = applied.at(-1);
      if (!last) {
        console.log('nothing to migrate down');
        return touched;
      }
      const ddl = readFileSync(path.join(MIGRATIONS_DIR, `${last}.down.sql`), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`delete from _migrations where name = ${last}`;
      });
      console.log(`migrated down: ${last}`);
      touched.push(last);
    }
    return touched;
  } finally {
    await sql.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  migrate(direction).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
