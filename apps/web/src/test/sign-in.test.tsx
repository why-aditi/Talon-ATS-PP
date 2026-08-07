import { ERROR_TYPES } from '@talon/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { SignInForm, SignInHero } from '../components/sign-in';
import { SessionProvider } from '../lib/session';
import { server } from '../mocks/node';
import { routerPush } from './setup';

function renderSignIn() {
  return render(
    <SessionProvider>
      <SignInHero />
      <SignInForm />
    </SessionProvider>,
  );
}

/** The BFF route handler is server-side, so the browser-facing contract is what we drive. */
function bff(status: number, body: Record<string, unknown>) {
  server.use(http.post('/api/auth/sign-in', () => HttpResponse.json(body, { status })));
}

const problem = (type: string) => ({ type, title: 'nope', status: 401 });

async function submit(email = 'maya@taloninc.com', password = 'correct-horse-battery') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Work email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
}

describe('default state', () => {
  it('renders the reference copy and both panes', async () => {
    const { container } = renderSignIn();
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText('Sign in to your Talon workspace.')).toBeInTheDocument();
    expect(screen.getByText('Hiring, coordinated.')).toBeInTheDocument();
    expect(screen.getByText('SOC 2 Type II · SSO enforced for admin roles')).toBeInTheDocument();
    // The hero stats, from the reference.
    for (const stat of ['24d', '86%', '1,240']) expect(screen.getByText(stat)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('renders SSO as disabled with a reason, not absent and not inert-but-focusable', async () => {
    renderSignIn();
    const google = screen.getByRole('button', { name: /Continue with Google/ });
    const saml = screen.getByRole('button', { name: /Continue with SAML SSO/ });
    const forgot = screen.getByRole('button', { name: 'Forgot?' });

    for (const control of [google, saml, forgot]) expect(control).toBeDisabled();
    // The disabled state needs a reason that is true. "Available once configured"
    // would send someone looking for a setting that does not exist.
    expect(screen.getByText('Single sign-on isn’t available yet. Use your email and password.')).toBeInTheDocument();
    expect(screen.queryByText(/once configured/)).not.toBeInTheDocument();

    // Disabled is what keeps them out of the tab order — the point of choosing it
    // over an enabled control that does nothing.
    const user = userEvent.setup();
    const reached: (HTMLElement | null)[] = [];
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      reached.push(document.activeElement as HTMLElement);
    }
    expect(reached).not.toContain(google);
    expect(reached).not.toContain(saml);
    expect(reached).not.toContain(forgot);
  });

  it('reaches email, password and Sign in with Tab alone', async () => {
    renderSignIn();
    const user = userEvent.setup();
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      const active = document.activeElement;
      if (active && active !== document.body) {
        order.push(active.getAttribute('aria-label') ?? (active.textContent || (active as HTMLInputElement).name));
      }
    }
    expect(order).toEqual(['email', 'password', 'Sign in']);
  });
});

describe('submitting', () => {
  it('disables the button and says what it is doing', async () => {
    server.use(
      http.post('/api/auth/sign-in', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json({ accessToken: 'a', expiresIn: 3600, user: {} });
      }),
    );
    renderSignIn();
    await submit();
    const button = screen.getByRole('button', { name: 'Signing in…' });
    expect(button).toBeDisabled();
  });
});

describe('failure states', () => {
  it.each([
    [ERROR_TYPES.INVALID_CREDENTIALS, /don’t match/],
    [ERROR_TYPES.USER_NOT_PROVISIONED, /no account for you yet/],
    [ERROR_TYPES.MFA_REQUIRED, /verification code/],
    [ERROR_TYPES.MFA_NOT_ENROLLED, /no authenticator is enrolled/],
  ])('renders a distinct message for %s', async (type, copy) => {
    bff(401, problem(type));
    renderSignIn();
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
  });

  it('never reports a wrong password as a provisioning problem, or the reverse', async () => {
    // The two failures look identical to the user unless the client switches on
    // `type` — one is "try again", the other is "ask an admin".
    bff(401, problem(ERROR_TYPES.INVALID_CREDENTIALS));
    const { unmount } = renderSignIn();
    await submit();
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/admin/);
    unmount();

    bff(401, problem(ERROR_TYPES.USER_NOT_PROVISIONED));
    renderSignIn();
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/admin/);
  });

  it('distinguishes an unreachable server from a rejected credential', async () => {
    server.use(http.post('/api/auth/sign-in', () => HttpResponse.error()));
    const { container } = renderSignIn();
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t reach the server/);
    await expectNoAxeViolations(container);
  });

  it('re-enables the form so a corrected password can be submitted', async () => {
    bff(401, problem(ERROR_TYPES.INVALID_CREDENTIALS));
    renderSignIn();
    await submit();
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
  });
});

describe('success', () => {
  it('routes to /jobs and keeps no token in storage', async () => {
    server.use(
      http.post('/api/auth/sign-in', () =>
        HttpResponse.json({
          accessToken: 'access-token-value',
          expiresIn: 3600,
          user: {
            id: '0198f3a1-0007-7000-8000-000000000001',
            tenantId: '0198f3a1-0000-7000-8000-000000000001',
            email: 'maya@taloninc.com',
            name: 'Maya Reyes',
            role: 'recruiter',
            timezone: 'America/Los_Angeles',
          },
        }),
      ),
    );
    renderSignIn();
    await submit();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/jobs'));

    // Nothing durable and JS-readable holds a token. The refresh token never
    // reaches the browser at all — it is set as an httpOnly cookie by the route
    // handler — and the access token lives only in React state.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain('access-token-value');
  });
});

describe('the hero is decoration', () => {
  it('is hidden from assistive tech so the form is the first thing reached', () => {
    const { container } = render(<SignInHero />);
    expect(container.querySelector('section')).toHaveAttribute('aria-hidden', 'true');
    expect(vi.isMockFunction(routerPush)).toBe(true);
  });
});
