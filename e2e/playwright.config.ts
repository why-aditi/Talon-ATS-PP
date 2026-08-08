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
      env: { PORT: String(API_PORT) },
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
