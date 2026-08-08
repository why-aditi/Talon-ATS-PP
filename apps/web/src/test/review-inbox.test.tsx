/**
 * Review inbox — spec 007 §12.
 *
 * The mock endpoint is driven through its REAL handler rather than a hand-written
 * stub response, so these tests exercise the comp gate and the schema parse on the way
 * out as well as the component. A stub that returned bare fixtures would let the screen
 * pass against a shape the endpoint cannot actually produce.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { GET } from '../app/api/mock/[...path]/route';
import { ReviewInbox } from '../components/review-inbox';
import { SessionProvider } from '../lib/session';
import { json, route } from './fetch-stub';

const SESSION = {
  accessToken: `header.${Buffer.from(JSON.stringify({ role: 'recruiter' })).toString('base64url')}.sig`,
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

/** Signed in, with `/api/mock/*` answered by the real route handler. */
function serve(override?: (url: URL) => Response | undefined) {
  route(async (url, init) => {
    if (url.pathname === '/api/auth/refresh') return json(SESSION);
    const forced = override?.(url);
    if (forced) return forced;
    if (!url.pathname.startsWith('/api/mock/')) return undefined;
    const path = url.pathname.replace('/api/mock/', '').split('/');
    return GET(new Request(url.href, { headers: (init?.headers ?? {}) as HeadersInit }), {
      params: Promise.resolve({ path }),
    });
  });
}

function renderInbox() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider>
        <ReviewInbox />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('review inbox', () => {
  it('renders the queue and opens the first candidate', async () => {
    serve();
    renderInbox();

    const queue = await screen.findByRole('listbox', { name: 'Review queue' });
    const options = within(queue).getAllByRole('option');
    expect(options).toHaveLength(4);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    // Detail pane follows selection.
    expect(await screen.findByRole('heading', { name: 'Jordan Cole' })).toBeInTheDocument();
    expect(screen.getByText(/Fullstack at Beacon · Chicago, IL · applied 2d ago/)).toBeInTheDocument();
    expect(screen.getByText(/turning a monolith into event driven services/)).toBeInTheDocument();
  });

  it('moves the selection with the arrow keys and absorbs at the ends', async () => {
    serve();
    const user = userEvent.setup();
    renderInbox();

    const queue = await screen.findByRole('listbox', { name: 'Review queue' });
    queue.focus();

    await user.keyboard('{ArrowUp}');
    // Already at the top — no wrap, no flicker (§10 case 2).
    expect(await screen.findByRole('heading', { name: 'Jordan Cole' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('heading', { name: 'Priya Nair' })).toBeInTheDocument();

    await user.keyboard('{End}');
    expect(await screen.findByRole('heading', { name: 'Tess Bianchi' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('heading', { name: 'Tess Bianchi' })).toBeInTheDocument();

    await user.keyboard('{Home}');
    expect(await screen.findByRole('heading', { name: 'Jordan Cole' })).toBeInTheDocument();
  });

  it('is one tab stop, not four', async () => {
    serve();
    const user = userEvent.setup();
    renderInbox();

    await screen.findByRole('listbox', { name: 'Review queue' });
    // Roving tabindex: the container is focusable and its options are not.
    for (const option of screen.getAllByRole('option')) expect(option).not.toHaveAttribute('tabindex');
    await user.tab();
    expect(document.activeElement).toHaveAttribute('role', 'listbox');
  });

  it('omits the cover note card when there is none, rather than rendering it blank', async () => {
    serve();
    const user = userEvent.setup();
    renderInbox();

    const queue = await screen.findByRole('listbox', { name: 'Review queue' });
    queue.focus();
    // Omar has no cover note and Tess has no highlights — §10 cases 3 and 4.
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(await screen.findByRole('heading', { name: 'Omar Haddad' })).toBeInTheDocument();
    expect(screen.queryByText('Cover note')).not.toBeInTheDocument();
    expect(screen.getByText('Resume highlights')).toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('heading', { name: 'Tess Bianchi' })).toBeInTheDocument();
    expect(screen.queryByText('Resume highlights')).not.toBeInTheDocument();
  });

  it('draws the advance and reject actions but leaves them inert', async () => {
    serve();
    renderInbox();

    // Asserting the §6 decision, so removing it fails a test rather than quietly
    // shipping a second advance path alongside the board's.
    expect(await screen.findByRole('button', { name: /Advance to Screen/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /Reject/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the empty state and no progress rule when nothing is waiting', async () => {
    serve((url) =>
      url.pathname === '/api/mock/review-queue'
        ? json({ items: [], waiting: 0, reviewedToday: 0 })
        : undefined,
    );
    renderInbox();

    expect(await screen.findByText('Nothing waiting for review.')).toBeInTheDocument();
    // A full rule reading "0 of 0" is a lie about a queue that does not exist.
    expect(screen.queryByRole('img', { name: /reviewed today/ })).not.toBeInTheDocument();
  });

  it('offers a retry when the queue fails to load', async () => {
    serve((url) =>
      url.pathname === '/api/mock/review-queue' ? json({ title: 'nope' }, 500) : undefined,
    );
    renderInbox();

    await waitFor(() => expect(screen.getByText('The review queue could not be loaded.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
