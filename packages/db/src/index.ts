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
