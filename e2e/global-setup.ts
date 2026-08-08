export const API_URL = process.env['TALON_API_URL'] ?? 'http://localhost:3001';

/**
 * The seeded recruiter. Her six jobs are what the jobs list renders.
 *
 * The password comes from `pnpm --filter api seed:identities`, which `pnpm db:seed`
 * now runs — same default, same `SEED_PASSWORD` override.
 */
export const RECRUITER = {
  email: 'maya@taloninc.com',
  password: process.env['SEED_PASSWORD']?.trim() || 'talon-dev-password',
};

/**
 * A precondition check: sign in over the real endpoint and, if it fails, say
 * which command fixes it rather than letting every test fail as "invalid
 * credentials".
 *
 * This once provisioned the credential itself, with a second copy of the scrypt
 * parameters from `identity/password.ts`. That file no longer exists — the
 * Cognito-only refactor deleted it along with `local-provider.ts` — and
 * `apps/api/src/scripts/seed-identities.ts` is the entry point now.
 *
 * That script does two things, and the second is the one that bites:
 *
 *   1. creates the person in the Cognito pool, and
 *   2. writes the sub Cognito allocated back to `users.external_id`.
 *
 * Migration 0004's `auth_user_by_sub` resolves a user only where `external_id`
 * matches, so with step 1 done and step 2 missing Cognito authenticates the
 * password correctly and the api still answers **`user_not_provisioned`**. That
 * failure reads like a broken account and is actually an unfinished seed, which
 * is why §41 below names the command instead of reporting the status alone.
 */
export default async function globalSetup(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/v1/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: RECRUITER.email, password: RECRUITER.password }),
    });
  } catch (cause) {
    throw new Error(`Could not reach the API at ${API_URL}. Is it built (\`pnpm build\`) and running?`, { cause });
  }

  if (response.status === 200) return;

  const body = await response.text();
  // Named explicitly: this is the one failure whose message points somewhere
  // misleading. "No user record exists for this identity" sounds like the users
  // row is missing, when the row is there and only `external_id` is unset.
  const unlinked = body.includes('user-not-provisioned');

  throw new Error(
    `Cannot sign in as ${RECRUITER.email} (${response.status}). The e2e suite needs a migrated, ` +
      `seeded database whose users are linked to the Cognito pool:\n\n` +
      `  docker compose up -d\n` +
      `  pnpm db:migrate && pnpm db:seed\n` +
      `  COGNITO_USER_POOL_ID=… COGNITO_CLIENT_ID=… AWS_REGION=… pnpm --filter api seed:identities\n\n` +
      (unlinked
        ? `The response is \`user-not-provisioned\`, which almost always means the pool user ` +
          `exists but \`users.external_id\` was never written — run \`seed:identities\` against ` +
          `THIS database and THIS pool.\n\n`
        : '') +
      `If you set SEED_PASSWORD when seeding, set it here too.\n\nResponse: ${body}`,
  );
}
