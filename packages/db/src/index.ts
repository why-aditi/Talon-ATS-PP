// @talon/db — importable only from a module's repository.ts (lint-enforced).
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';
export { schema };

export type Db = PostgresJsDatabase<typeof schema>;

export interface CreateDbOptions {
  /** Pool size. The request chain checks out one connection per request transaction. */
  max?: number;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const client = postgres(connectionString, { max: options.max ?? 10, onnotice: () => {} });
  const db: Db = drizzle(client, { schema });
  return { db, client };
}

/**
 * Primary keys, for the repositories that write rows.
 *
 * UUIDv7 is not interchangeable with v4 here. `id` carries creation order —
 * `jobs` pages on `first_value(id) over (partition by department order by id)`,
 * and `applications` breaks board-rank ties on `id` — so a random uuid would
 * shuffle the jobs list and the kanban. Every table's `id()` uses this; a raw
 * INSERT in a repository must too, because the column has no database default.
 */
export { uuidv7 as newId } from 'uuidv7';
