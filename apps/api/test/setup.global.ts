// Migrates and seeds the api suite's own database before any test runs. The
// suite asserts against the reference seed (Maya, Lin, ENG-204, Acme), so it has
// to exist and be identical on every run — seed() truncates first.
import { setupTestDatabase } from '@talon/testing';
import { TEST_DATABASE_NAME } from './urls.js';

export default async function globalSetup(): Promise<void> {
  await setupTestDatabase(TEST_DATABASE_NAME);
  // Nothing to clear beyond the seed's own truncate: credentials live in the
  // identity provider's store, which is a fake Cognito created fresh per worker
  // (`cognito-stub.ts`). `local_identities` still exists in the schema and is
  // now written by nothing — see `modules/identity/repository.ts`.
  console.log(`global setup: migrated and seeded ${TEST_DATABASE_NAME}`);
}
