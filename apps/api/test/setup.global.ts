// Migrates and seeds the api suite's own database before any test runs. The
// suite asserts against the reference seed (Maya, Lin, ENG-204, Acme), so it has
// to exist and be identical on every run — seed() truncates first.
import postgres from 'postgres';
import { setupTestDatabase } from '@talon/testing';
import { TEST_DATABASE_NAME } from './urls.js';

export default async function globalSetup(): Promise<void> {
  const { owner } = await setupTestDatabase(TEST_DATABASE_NAME);

  // The seed writes `users`; credentials live in the identity provider's store,
  // which in AWS is not this database at all — so the seed neither knows about
  // local_identities nor clears it. Each run mints new user ids, and a stale
  // credential row would keep the old id under the same (unique) email.
  const sql = postgres(owner, { max: 1, onnotice: () => {} });
  try {
    await sql`truncate table local_identities`;
  } finally {
    await sql.end();
  }
  console.log(`global setup: migrated and seeded ${TEST_DATABASE_NAME}`);
}
