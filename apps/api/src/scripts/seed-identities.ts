/**
 * Gives every seeded person a credential with the configured identity provider,
 * and points their `users` row at the subject that provider issued.
 *
 * `pnpm db:seed` writes `users` rows and nothing else — credentials live in the
 * identity provider's store, which under Cognito is not this database at all.
 * This script is the second half of provisioning, and it is a SCRIPT rather than
 * an endpoint on purpose: it writes `users.external_id`, and the api process
 * must not be able to do that. Writing `users` outside a tenant context needs
 * either RLS bypass or a `security definer` *writer*; spec 001 §11b accepted two
 * definer *readers* after some argument, and a writer is a different animal
 * entirely. An operator script on the owner connection is the honest shape.
 *
 *   pnpm --filter api seed:identities
 *   TALON_IDENTITY_PROVIDER=cognito COGNITO_USER_POOL_ID=... \
 *   COGNITO_CLIENT_ID=... AWS_REGION=us-east-1 TALON_JWT_SECRET=... \
 *   pnpm --filter api seed:identities
 *
 * Re-runnable: both providers treat re-provisioning an existing email as an
 * update, not a collision.
 *
 * ── `external_id` is exclusive, and that is deliberate ────────────────────
 * Migration 0004's `auth_user_by_sub` resolves `users.id` only where
 * `external_id is null`, so that revoking an identity at the IdP cannot leave
 * the raw `users.id` working as a token subject. The consequence is that a
 * person is provisioned against ONE provider at a time: seeding for `local`
 * clears `external_id`, seeding for `cognito` sets it. Flipping
 * TALON_IDENTITY_PROVIDER is therefore an env change *and* a re-provision, not
 * an env change alone.
 */
import postgres from 'postgres';
import { loadConfig } from '../config.js';
import { buildContainer } from '../container.js';

/** Same published local constant as packages/db — worthless as a secret, obviously so. */
const DEFAULT_OWNER_URL = 'postgres://talon:talon@localhost:5432/talon';
const DEFAULT_PASSWORD = 'talon-dev-password';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

const isLoopback = (url: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false; // Unparseable is not local.
  }
};

/**
 * The default password is published in this repo. Same posture as
 * `resolveAppRolePassword` in packages/db: a clean local clone needs no setup,
 * a remote target fails on the missing configuration rather than on a default
 * that replays into every environment it is ever pointed at.
 */
function resolvePassword(ownerUrl: string): string {
  const fromEnv = process.env['SEED_PASSWORD']?.trim();
  if (fromEnv) return fromEnv;
  if (!isLoopback(ownerUrl)) {
    throw new Error(
      'SEED_PASSWORD must be set when seeding a non-local database. The built-in ' +
        'password is published in this repository and is refused off loopback.',
    );
  }
  return DEFAULT_PASSWORD;
}

interface SeededUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ownerUrl = process.env['DATABASE_URL'] ?? DEFAULT_OWNER_URL;
  const password = resolvePassword(ownerUrl);
  // The owner connection, not the api's. This script exists precisely because
  // the write below is one the request-path role must not be able to make.
  const sql = postgres(ownerUrl, {
    max: 1,
    onnotice: () => {},
  });
  const container = buildContainer(config);

  try {
    const users = await sql<SeededUser[]>`
      select id, email, name, role from users order by email`;
    // Zero is never "nothing to do": it means unmigrated, unseeded, the wrong
    // database, or — the one that will bite on Aurora — an owner role without
    // BYPASSRLS, which sees nothing through `force row level security`.
    if (users.length === 0) throw new Error('no users — run `pnpm db:seed` first');

    console.log(`provider: ${config.auth.provider}`);
    for (const user of users) {
      const { sub } = await container.cradle.identityService.provisionCredential({
        // Local only: the local provider's token subject IS users.id. Cognito
        // ignores it and allocates its own, which is what comes back.
        sub: user.id,
        email: user.email,
        password,
      });
      if (config.auth.provider === 'cognito') {
        await sql`update users set external_id = ${sub} where id = ${user.id}::uuid`;
      } else {
        await sql`update users set external_id = null where id = ${user.id}::uuid`;
      }
      console.log(`  ${user.email.padEnd(22)} ${user.role.padEnd(15)} sub=${sub}`);
    }
    // Echoed only when it is the published default. An operator-supplied
    // password would otherwise land in a CI log — which is exactly when this
    // script gets run with one.
    console.log(
      `${users.length} identities provisioned, password: ` +
        (password === DEFAULT_PASSWORD ? password : 'as supplied in SEED_PASSWORD'),
    );
  } finally {
    await sql.end();
    await container.cradle.sql.end();
  }
}

await main();
