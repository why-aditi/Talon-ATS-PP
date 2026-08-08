/**
 * Candidates list and profile — spec 007 §12.
 *
 * Driven through the real mock handler, so the comp gate is exercised end to end
 * rather than simulated: the role in the token decides what the endpoint sends, and
 * the screen renders what it is given. That is the arrangement §4.2 requires, and a
 * stub returning fixtures directly would not test it at all.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GET } from '../app/api/mock/[...path]/route';
import { CandidateProfileScreen } from '../components/candidate-profile';
import { CandidatesScreen } from '../components/candidates-screen';
import { CANDIDATE_IDS } from '../lib/mock-fixtures';
import { SessionProvider } from '../lib/session';
import { json, route } from './fetch-stub';

const sessionFor = (role: string, timezone = 'America/Los_Angeles') => ({
  accessToken: `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`,
  expiresIn: 3600,
  user: {
    id: '0198f3a1-0007-7000-8000-000000000001',
    tenantId: '0198f3a1-0000-7000-8000-000000000001',
    email: 'maya@taloninc.com',
    name: 'Maya Reyes',
    role,
    timezone,
  },
});

function serve(role: string, timezone?: string) {
  route(async (url, init) => {
    if (url.pathname === '/api/auth/refresh') return json(sessionFor(role, timezone));
    if (!url.pathname.startsWith('/api/mock/')) return undefined;
    const path = url.pathname.replace('/api/mock/', '').split('/');
    return GET(new Request(url.href, { headers: (init?.headers ?? {}) as HeadersInit }), {
      params: Promise.resolve({ path }),
    });
  });
}

function renderWith(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider>{ui}</SessionProvider>
    </QueryClientProvider>,
  );
}

describe('candidates list', () => {
  it('renders a row per candidate, linking to the profile', async () => {
    serve('recruiter');
    renderWith(<CandidatesScreen />);

    const ana = await screen.findByRole('link', { name: /Ana Petrova/ });
    expect(ana).toHaveAttribute('href', `/candidates/${CANDIDATE_IDS.ana}`);
    expect(screen.getAllByRole('link')).toHaveLength(9);
  });

  it('names every stage rather than relying on the dot colour', async () => {
    serve('recruiter');
    renderWith(<CandidatesScreen />);

    // §4.15 — colour is never the only carrier. The label rides alongside the dot.
    await screen.findByRole('link', { name: /Ana Petrova/ });
    for (const stage of ['Applied', 'Screen', 'Onsite', 'Offer', 'Hired']) {
      expect(screen.getAllByText(stage).length).toBeGreaterThan(0);
    }
  });
});

describe('candidate profile', () => {
  it('renders the header, stage rail and activity timeline', async () => {
    serve('recruiter');
    renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);

    expect(await screen.findByRole('heading', { name: 'Ana Petrova' })).toBeInTheDocument();
    expect(screen.getByText('3d in Onsite')).toBeInTheDocument();
    expect(screen.getByText('Onsite loop scheduled')).toBeInTheDocument();
    expect(screen.getByText('Values round with Maya Reyes is still unconfirmed')).toBeInTheDocument();
  });

  it('leaves every action inert', async () => {
    serve('recruiter');
    renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);

    for (const name of ['Reject', 'Schedule', 'Advance →', 'Add note']) {
      expect(await screen.findByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('renders the unbuilt tabs with their counts, disabled', async () => {
    serve('recruiter');
    renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);

    const scorecards = await screen.findByRole('tab', { name: 'Scorecards 2' });
    expect(scorecards).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  });

  describe('comp expectation has three states, not two', () => {
    it('shows the figure when it exists and the role may see it', async () => {
      serve('recruiter');
      renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);

      expect(await screen.findByText('Comp expectation')).toBeInTheDocument();
      expect(screen.getByText('$205k to $220k')).toBeInTheDocument();
    });

    it('shows "Not stated" when the candidate never gave one', async () => {
      serve('recruiter');
      renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.marcus} />);

      expect(await screen.findByText('Comp expectation')).toBeInTheDocument();
      expect(screen.getByText('Not stated')).toBeInTheDocument();
    });

    it('omits the row entirely when the role may not see it', async () => {
      serve('member');
      renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);

      // The label is itself the information being withheld, so the row is absent
      // rather than reading "Not stated" — which would be a different claim about
      // the world, and a false one (§10 cases 7 and 8).
      expect(await screen.findByRole('heading', { name: 'Ana Petrova' })).toBeInTheDocument();
      expect(screen.queryByText('Comp expectation')).not.toBeInTheDocument();
      expect(screen.queryByText('Not stated')).not.toBeInTheDocument();
      expect(screen.queryByText('$205k to $220k')).not.toBeInTheDocument();
    });
  });

  it('omits the next-action banner and the timeline when there is nothing to show', async () => {
    serve('recruiter');
    renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.marcus} />);

    expect(await screen.findByRole('heading', { name: 'Marcus Webb' })).toBeInTheDocument();
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
    expect(screen.queryByText('Next action')).not.toBeInTheDocument();
  });

  describe('activity times are the viewer’s, not the server’s', () => {
    it('renders the same instant differently in two zones', async () => {
      serve('recruiter', 'America/Los_Angeles');
      const { unmount } = renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);
      // 2026-08-08T06:30Z is 23:30 on Aug 7 in Los Angeles.
      expect(await screen.findByText('Aug 7, 11:30 PM')).toBeInTheDocument();
      unmount();

      serve('recruiter', 'Asia/Kolkata');
      renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);
      // ...and 12:00 on Aug 8 in Kolkata. Same row, same payload, different reading.
      expect(await screen.findByText('Aug 8, 12:00 PM')).toBeInTheDocument();
    });

    it('renders a DST-boundary instant in the offset that instant actually had', async () => {
      // 2026-07-24T15:40Z falls inside US daylight time (UTC-7 in Los Angeles). The
      // same wall-clock arithmetic against a fixed -8 would print 07:40 and be wrong
      // for half the year — §4.7 is why this is asserted rather than assumed.
      serve('recruiter', 'America/Los_Angeles');
      renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);
      expect(await screen.findByText('Jul 24, 8:40 AM')).toBeInTheDocument();
    });
  });

  it('offers a retry when the profile fails to load', async () => {
    route((url) => (url.pathname === '/api/auth/refresh' ? json(sessionFor('recruiter')) : json({}, 500)));
    renderWith(<CandidateProfileScreen candidateId={CANDIDATE_IDS.ana} />);

    await waitFor(() => expect(screen.getByText('This candidate could not be loaded.')).toBeInTheDocument());
  });
});
