import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env['TALON_API_PORT'] ?? 3001);
const WEB_PORT = Number(process.env['TALON_WEB_PORT'] ?? 3000);
const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

/**
 * Spec 001 §10's vertical slice. Both servers are started by Playwright so the
 * suite is one command, and both are reused if already running locally.
 *
 * The database is NOT started here: `docker compose up -d` plus `pnpm db:migrate`
 * and `pnpm db:seed` are prerequisites, because a suite that reseeds on every run
 * would be the thing that eventually drops a developer's data mid-demo
 * (CLAUDE.md §4.12).
 */

/**
 * Cognito configuration, forwarded to the api child process.
 *
 * `LocalIdentityProvider` was deleted with the Cognito-only refactor, and
 * `loadConfig` now refuses to produce a config without a pool id, a client id, a
 * region and a signing key — so the api exits at boot instead of serving
 * unauthenticated traffic. Playwright spawns the api with an env it builds
 * itself, and passing only `PORT` meant those four never arrived: the suite died
 * with a raw stack trace from `dist/config.js` and no indication that the fix was
 * configuration rather than code.
 *
 * Forwarded rather than defaulted. A default pool id here would be a test suite
 * quietly authenticating against whatever pool that string happened to name.
 */
const COGNITO_KEYS = [
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
  'COGNITO_REGION',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'TALON_JWT_SECRET',
  'API_DATABASE_URL',
] as const;

const apiEnv: Record<string, string> = { PORT: String(API_PORT) };
for (const key of COGNITO_KEYS) {
  const value = process.env[key];
  if (value) apiEnv[key] = value;
}

/*
  Fail here, with the list, rather than let the child exit on the first missing
  one. The api checks these in order and reports whichever it reaches first, so a
  run with none of them set takes four attempts to learn what it needs.
*/
const REQUIRED = ['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'TALON_JWT_SECRET'] as const;
const missing = REQUIRED.filter((key) => !apiEnv[key]);
if (!apiEnv['COGNITO_REGION'] && !apiEnv['AWS_REGION']) missing.push('COGNITO_REGION (or AWS_REGION)' as never);
if (missing.length > 0) {
  throw new Error(
    `e2e cannot start the api: ${missing.join(', ')} not set.\n\n` +
      `Cognito is the only identity provider (spec 002 open question 1), so the api ` +
      `refuses to boot without a reachable pool. Set them in your shell, or export ` +
      `them from .env, and make sure \`pnpm --filter api seed:identities\` has run — ` +
      `it creates the pool users AND links users.external_id, and sign-in returns ` +
      `user_not_provisioned until it has.\n\n` +
      `This suite therefore needs AWS credentials today. See TODO in this file.`,
  );
}

/*
  TODO(api stream): make this suite runnable without an AWS account.

  `apps/api/test/cognito-stub.ts` already fakes Cognito at the network layer, but
  it works by mutating `process.env` and `globalThis.fetch` INSIDE the test
  process — and Playwright runs the api as a separate process, so it cannot reach
  it. Extracting the stub into a standalone server the api can be pointed at with
  `AWS_ENDPOINT_URL` would make this suite hermetic and let it become a required
  CI check. Until then `pnpm e2e` needs credentials and cannot gate a PR, which is
  recorded in spec 001 §10 rather than left as a mystery red job.
*/
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    // The reference viewport. Below `lg` the sign-in hero is hidden by design.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // apps/api has no dev or start script, and `tsx` is not a dependency of this
      // repo — so the built output is the entry point. `pnpm build` is a
      // prerequisite, which CI already runs before any test step.
      command: 'node dist/server.js',
      cwd: '../apps/api',
      url: `${API_URL}/v1/healthz`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: apiEnv,
    },
    {
      // Mocks off: this suite is the one that proves the real path.
      command: 'pnpm --filter web exec next dev --port ' + WEB_PORT,
      url: WEB_URL,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: { NEXT_PUBLIC_MOCKS: 'off', TALON_API_URL: API_URL, APP_ORIGIN: WEB_URL },
    },
  ],
});
