/**
 * Give every seeded user a password so the local provider can sign them in.
 *
 * The seed in packages/db writes `users` but not `local_identities`: password
 * hashing lives behind the IdentityProvider seam in this app, and the boundary
 * graph does not let packages/db reach it. Hashing the password there instead
 * would mean a second copy of the scrypt parameters and encoding, which drifts
 * silently the first time either changes.
 *
 * So this runs on the API side and goes through the provider's own createUser,
 * which is the documented provisioning path: the seeded user already exists, so
 * its id is handed in as the subject (see CreateUserInput.sub — locally the
 * token subject IS users.id).
 *
 *   pnpm --filter api seed:identities
 *
 * Idempotent: an existing identity is left alone rather than re-hashed, so
 * running it twice does not invalidate a session you are mid-test with.
 */
import { loadConfig } from '../src/config.js';
import { buildContainer } from '../src/container.js';

// Dev-only fixture credential. Not a secret, never leaves a local database, and
// the seed it belongs to is public — the reference screens are in the repo.
const DEMO_PASSWORD = process.env['SEED_PASSWORD'] ?? 'talon-dev-password';

/**
 * Provisioning runs as the owner, not `talon_app`. The app role deliberately
 * cannot read `users` directly — it goes through the §11b security-definer
 * functions — so a direct select fails with "permission denied for table users".
 * This is a one-off provisioning task like a migration, not a request path, and
 * it never serves a tenant, so the owner connection is the right one. Nothing
 * here opens a transaction or sets app.tenant_id.
 */
const OWNER_URL = process.env['DATABASE_URL'] ?? 'postgres://talon:talon@localhost:5432/talon';

async function main(): Promise<void> {
  const container = buildContainer(loadConfig({ ...process.env, API_DATABASE_URL: OWNER_URL }));
  const { sql, identityProvider } = container.cradle;

  try {
    const users = await sql<{ id: string; email: string; role: string }[]>`
      select u.id, u.email, u.role
      from users u
      left join local_identities li on li.sub = u.id
      where li.sub is null
      order by u.email
    `;

    if (users.length === 0) {
      console.log('every seeded user already has an identity — nothing to do');
      return;
    }

    for (const user of users) {
      await identityProvider.createUser({
        email: user.email,
        password: DEMO_PASSWORD,
        sub: user.id,
      });
      console.log(`identity created: ${user.email} (${user.role})`);
    }

    console.log(`\n${users.length} identities created. Password: ${DEMO_PASSWORD}`);
  } finally {
    await sql.end();
  }
}

await main();
