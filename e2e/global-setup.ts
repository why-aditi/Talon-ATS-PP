import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import postgres from 'postgres';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://talon:talon@localhost:5432/talon';
export const API_URL = process.env['TALON_API_URL'] ?? 'http://localhost:3001';

/** The seeded recruiter. Her six jobs are what the jobs list renders. */
export const RECRUITER = { email: 'maya@taloninc.com', password: 'e2e-local-password' };

/**
 * Mirrors `apps/api/src/modules/identity/password.ts`, whose stored form is
 * `scrypt$N=16384,r=8,p=1$<salt b64>$<hash b64>` with the parameters travelling
 * alongside the hash.
 *
 * Duplicating a security-critical routine is a real cost, and it is deliberate
 * here for one reason: nothing can provision a credential from outside the API
 * process. The seed writes `users` rows only — by design, because credentials
 * live in the identity provider's own store, which in AWS is Cognito and not
 * this database — and `identityService.provisionCredential` is reachable only
 * through the DI container. There is no script and no route.
 *
 * The duplication is made safe by `provision()` below, which signs in over the
 * real endpoint immediately after writing. If these parameters ever drift from
 * the API's, setup fails on the spot with a message naming the cause, rather
 * than every test failing later as "invalid credentials".
 *
 * Delete this the moment `apps/api` exposes a provisioning entry point.
 */
async function hashPassword(password: string): Promise<string> {
  const params = { N: 16384, r: 8, p: 1 } as const;
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { ...params, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', `N=${params.N},r=${params.r},p=${params.p}`, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function provision(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const [user] = await sql<{ id: string; email: string }[]>`
      select id, email from users where email = ${RECRUITER.email}
    `;
    if (!user) {
      throw new Error(
        `No users row for ${RECRUITER.email}. Run \`pnpm db:migrate && pnpm db:seed\` before the e2e suite.`,
      );
    }
    const passwordHash = await hashPassword(RECRUITER.password);
    await sql`
      insert into local_identities (sub, email, password_hash)
      values (${user.id}, ${user.email}, ${passwordHash})
      on conflict (sub) do update set password_hash = excluded.password_hash
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }

  // The self-check that makes the duplication above safe.
  const response = await fetch(`${API_URL}/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: RECRUITER.email, password: RECRUITER.password }),
  });
  if (response.status !== 200) {
    throw new Error(
      `Provisioned a credential but POST /v1/auth/sign-in returned ${response.status}. ` +
        `The scrypt parameters in e2e/global-setup.ts have almost certainly drifted from ` +
        `apps/api/src/modules/identity/password.ts. Body: ${await response.text()}`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  await provision();
}
