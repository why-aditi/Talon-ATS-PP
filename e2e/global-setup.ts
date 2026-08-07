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
 * This used to provision the credential itself, writing `local_identities`
 * directly with a second copy of the scrypt parameters and encoding from
 * `apps/api/src/modules/identity/password.ts` — because nothing could provision
 * one from outside the API process.
 *
 * `apps/api/src/scripts/seed-identities.ts` is now that entry point, it goes
 * through the provider's own `createUser`, and `pnpm db:seed` runs it. So the
 * duplicated KDF is gone, and with it the reason this file ever connected to the
 * database as the owner.
 *
 * What remains is a precondition check: sign in over the real endpoint and, if it
 * fails, say which command fixes it rather than letting every test fail as
 * "invalid credentials".
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

  throw new Error(
    `Cannot sign in as ${RECRUITER.email} (${response.status}). The e2e suite needs a migrated, ` +
      `seeded database with local credentials:\n\n` +
      `  docker compose up -d\n` +
      `  pnpm db:migrate && pnpm db:seed\n\n` +
      `\`db:seed\` runs \`seed:identities\`, which is what creates the password. If you set ` +
      `SEED_PASSWORD when seeding, set it here too.\n\nResponse: ${await response.text()}`,
  );
}
