/**
 * The sidebar must not link to a page that does not exist.
 *
 * This regressed once: "Pipeline" pointed at `/pipeline`, which is the highlight key for
 * `/jobs/:id/pipeline` and not a route — clicking the app's own menu item answered 404.
 * Asserting against the filesystem rather than a hand-kept list means shipping a screen
 * is the only thing needed to make its nav row live again.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../components/app-shell';
import { SessionProvider } from '../lib/session';
import { json, route } from './fetch-stub';
import { pathname } from './setup';

const SESSION = {
  accessToken: 'test-access-token',
  expiresIn: 3600,
  user: {
    id: '0198f3a1-0007-7000-8000-000000000001',
    tenantId: '0198f3a1-0000-7000-8000-000000000001',
    email: 'maya@taloninc.com',
    name: 'Maya Reyes',
    role: 'recruiter',
    timezone: 'America/Los_Angeles',
  },
};

// Runnable from apps/web or from the repo root; import.meta.url is not a file URL here.
const appDir = ['src/app/(app)', 'apps/web/src/app/(app)']
  .map((p) => resolve(process.cwd(), p))
  .find(existsSync);

/** `/jobs` → `app/(app)/jobs/page.tsx`. Dynamic segments are not linked from the nav. */
const hasPage = (href: string) => existsSync(`${appDir}${href}/page.tsx`);

/*
  The shell renders a breadcrumb on the nested routes only, so a check that runs at one
  pathname never sees it — `onLoop` and `onJobPipeline` are both false at `/jobs`, which is
  how a breadcrumb `Link` to the non-existent `/scheduling` index sat outside this guard.
  The nested pathnames are listed rather than derived: the point is to render the trail.
*/
const PATHNAMES = [
  '/jobs',
  '/jobs/0198f3a5-0001-7000-8000-000000000001/pipeline',
  '/scheduling/0198f3a7-0001-7000-8000-000000000001',
];

describe('sidebar navigation', () => {
  it.each(PATHNAMES)('renders no link to a route that has no page, at %s', async (at) => {
    route((url) => (url.pathname === '/api/auth/refresh' ? json(SESSION) : undefined));
    pathname.current = at;

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionProvider>
          <AppShell>
            <p>page</p>
          </AppShell>
        </SessionProvider>
      </QueryClientProvider>,
    );

    // getAll, not get: on the pipeline route the breadcrumb adds a second "Jobs" link,
    // and this wait is only here to say the shell has rendered past the session fetch.
    await waitFor(() => expect(screen.getAllByRole('link', { name: /jobs/i }).length).toBeGreaterThan(0));

    const dead = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => href.startsWith('/') && !href.startsWith('/api/') && !hasPage(href));

    expect(dead).toEqual([]);
  });

  it('still shows the unbuilt sections, disabled rather than removed', async () => {
    route((url) => (url.pathname === '/api/auth/refresh' ? json(SESSION) : undefined));

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionProvider>
          <AppShell>
            <p>page</p>
          </AppShell>
        </SessionProvider>
      </QueryClientProvider>,
    );

    const pipeline = await screen.findByText('Pipeline');
    expect(pipeline.closest('[aria-disabled="true"]')).not.toBeNull();
  });
});
