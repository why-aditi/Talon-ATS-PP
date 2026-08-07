// Plain-SQL migration runner. drizzle-kit cannot generate down migrations, so
// migrations are hand-written .up.sql/.down.sql pairs applied in filename order
// and tracked in _migrations. Laziest thing that satisfies "up → down → up is clean".
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const DEFAULT_DATABASE_URL = 'postgres://talon:talon@localhost:5432/talon';

export async function migrate(
  direction: 'up' | 'down',
  databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = (await sql`select name from _migrations order by name`).map(
      (r) => r['name'] as string,
    );

    if (direction === 'up') {
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
      }
    } else {
      const last = applied.at(-1);
      if (!last) {
        console.log('nothing to migrate down');
        return;
      }
      const ddl = readFileSync(path.join(MIGRATIONS_DIR, `${last}.down.sql`), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`delete from _migrations where name = ${last}`;
      });
      console.log(`migrated down: ${last}`);
    }
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
