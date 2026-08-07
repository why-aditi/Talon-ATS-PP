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
import postgres from 'postgres';
import { loadConfig } from '../config.js';
import { buildContainer } from '../container.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);
const DEFAULT_PASSWORD = 'talon-dev-password';

/**
 * Provisioning connects as the OWNER, and this is the one place in `apps/api`
 * that does. The app role cannot read `users` directly — it goes through the
 * §11b security-definer functions, which are exact-key by design and so cannot
 * enumerate. Only the discovery select needs this; `local_identities` carries no
 * RLS and no tenant_id, so the write itself does not.
 *
 * Do NOT copy this into anything that serves a request. It builds its own pool
 * rather than overriding `API_DATABASE_URL`, because that variable existing
 * separately from `DATABASE_URL` is the reason the API cannot bypass RLS
 * (config.ts), and teaching `loadConfig` to accept an owner URL would put the
 * hazard one copy-paste away from a boot path.
 */
const OWNER_URL = process.env['DATABASE_URL'] ?? 'postgres://talon:talon@localhost:5432/talon';

const isLoopback = (url: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false; // Unparseable is not local.
  }
};

/**
 * The default password is published in this repo. Same posture as
 * `resolveAppRolePassword` in packages/db: a clean local clone needs no setup, a
 * remote target fails on the missing configuration rather than on a default that
 * replays into every environment it is ever pointed at.
 */
function resolvePassword(): { password: string; isDefault: boolean } {
  const fromEnv = process.env['SEED_PASSWORD']?.trim();
  if (fromEnv) return { password: fromEnv, isDefault: false };
  if (!isLoopback(OWNER_URL)) {
    throw new Error(
      'SEED_PASSWORD must be set when seeding a non-local database. The built-in ' +
        'password is published in this repository and is refused off loopback.',
    );
  }
  return { password: DEFAULT_PASSWORD, isDefault: true };
}

async function main(): Promise<void> {
  const { password, isDefault } = resolvePassword();
  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  const { identityProvider } = buildContainer(loadConfig()).cradle;

  try {
    const counted = await sql<{ total: number }[]>`select count(*)::int as total from users`;
    if ((counted[0]?.total ?? 0) === 0) {
      // Zero is never "nothing to do": it means unmigrated, unseeded, the wrong
      // database, or — the one that will bite on Aurora — an owner role without
      // BYPASSRLS, which sees nothing through `force row level security`.
      throw new Error(
        `no users found in ${OWNER_URL.replace(/:[^:@]*@/, ':***@')}. Run pnpm db:migrate && ` +
          'pnpm db:seed first, and check the role can bypass RLS.',
      );
    }

    const users = await sql<{ id: string; email: string; role: string }[]>`
      select u.id, u.email, u.role
      from users u
      left join local_identities li on li.sub = u.id
      where li.sub is null
      order by u.email
    `;

    if (users.length === 0) {
      console.log(`every user already has an identity (${counted[0]?.total ?? 0} total) — nothing to do`);
      return;
    }

    for (const user of users) {
      await identityProvider.createUser({ email: user.email, password, sub: user.id });
      console.log(`identity created: ${user.email} (${user.role})`);
    }

    // Only echoed when it is the published default. An operator-supplied
    // password would otherwise end up in a CI log, and this now runs as part of
    // `pnpm db:seed`.
    console.log(
      `\n${users.length} identities created.` +
        (isDefault ? ` Password: ${DEFAULT_PASSWORD}` : ' Password: as supplied in SEED_PASSWORD.'),
    );
  } finally {
    await sql.end();
  }
}

await main();
