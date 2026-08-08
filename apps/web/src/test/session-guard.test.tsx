import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../components/app-shell';
import { RequireSession, SessionProvider } from '../lib/session';
import { json, route } from './fetch-stub';
import { routerReplace } from './setup';

/** What `/api/auth/refresh` hands back for a restored session. No refresh token. */
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

/** Signed in. Without this the stub throws on refresh, which is the signed-out case. */
function signedIn() {
  route((url) => (url.pathname === '/api/auth/refresh' ? json(SESSION) : undefined));
}

function renderGuarded(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <RequireSession>
          <p>Everything behind the shell</p>
        </RequireSession>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('RequireSession', () => {
  it('sends a signed-out visitor to sign-in and renders none of the page', async () => {
    renderGuarded();

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/sign-in'));
    expect(screen.queryByText('Everything behind the shell')).not.toBeInTheDocument();
  });

  it('renders nothing at all before the cookie has been answered', () => {
    // The window between mount and the refresh resolving. Rendering the shell here
    // and pulling it away a moment later is the flash this exists to prevent — and
    // it would show a signed-out visitor the chrome of a tenant they have no
    // session for.
    renderGuarded();

    expect(screen.queryByText('Everything behind the shell')).not.toBeInTheDocument();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('lets a signed-in user through and leaves them where they are', async () => {
    signedIn();
    renderGuarded();

    expect(await screen.findByText('Everything behind the shell')).toBeInTheDocument();
    expect(routerReplace).not.toHaveBeenCalled();
  });
});

describe('sign out', () => {
  it('ends the session, clears the cache, and leaves for sign-in', async () => {
    signedIn();
    const signOutCalls: string[] = [];
    route((url, init) => {
      if (url.pathname !== '/api/auth/sign-out') return undefined;
      signOutCalls.push(init?.method ?? 'GET');
      return json({ ok: true });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <AppShell>
            <p>Jobs</p>
          </AppShell>
        </SessionProvider>
      </QueryClientProvider>,
    );

    // The control only exists once there is a session to end.
    const button = await screen.findByRole('button', { name: 'Sign out' });
    // The shell's own jobs query fills the cache, which is what has to be dropped.
    await waitFor(() => expect(client.getQueryCache().getAll().length).toBeGreaterThan(0));

    await userEvent.setup().click(button);

    // The httpOnly refresh cookie can only be cleared by the server, so the request
    // is not optional — dropping the in-memory token alone would leave a cookie
    // that still redeems for a session on the next reload.
    await waitFor(() => expect(signOutCalls).toEqual(['POST']));
    // The previous tenant's rows must not survive into the next sign-in on this tab.
    // Asserted as "no entry holds data" rather than "the cache is empty": the shell
    // is still mounted here, so its observer re-registers an entry immediately — an
    // empty one. What matters is that nothing in it carries the old tenant's jobs.
    await waitFor(() =>
      expect(client.getQueryCache().getAll().filter((query) => query.state.data !== undefined)).toEqual([]),
    );
    expect(routerReplace).toHaveBeenCalledWith('/sign-in');
  });

  it('leaves anyway when the sign-out request fails', async () => {
    signedIn();
    route((url) => {
      if (url.pathname === '/api/auth/sign-out') throw new TypeError('Failed to fetch');
      return undefined;
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionProvider>
          <AppShell>
            <p>Jobs</p>
          </AppShell>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));

    // A session the server already forgot still has to end here. Stranding someone
    // signed in to a token nothing will honour is the worse failure.
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/sign-in'));
  });
});
