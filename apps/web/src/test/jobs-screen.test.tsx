import { JobSchema, ListJobsResponseSchema } from '@talon/contracts';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../components/app-shell';
import { JobsScreen } from '../components/jobs-screen';
import { fetchJobs, jobsUrl } from '../lib/jobs-query';
import { SessionProvider } from '../lib/session';
import { SEEDED_JOBS } from './seeded-jobs';
import { json, route } from './fetch-stub';
import { routerReplace, searchParams } from './setup';

/**
 * What the BFF hands the browser on a restored session: an access token, its
 * lifetime, and the user. Never the refresh token — that stays in the httpOnly
 * cookie the route handler set.
 *
 * The shell is authenticated chrome, so the harness has to be signed in for it to
 * be tested at all. Without this, `session` was null through every case here and
 * the sidebar's avatar, name, role and sign-out all silently rendered as nothing.
 */
const SEEDED_SESSION = {
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

function renderJobs(query = '', queryOptions: Record<string, unknown> = {}) {
  searchParams.current = new URLSearchParams(query);
  route((url) => (url.pathname === '/api/auth/refresh' ? json(SEEDED_SESSION) : undefined));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, ...queryOptions } } });
  // SessionProvider: the live path reads the access token from it, so the screen
  // cannot render without one even when the fixtures answer.
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <AppShell>
          <JobsScreen />
        </AppShell>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

/** Zero violations is the gate; the rule ids make a failure readable. */
async function expectNoAxeViolations(container: HTMLElement) {
  // jsdom has no layout engine, so color-contrast can only guess — it is gated for
  // real in packages/tokens/test/contrast.test.ts, over the token pairs themselves.
  //
  // `resultTypes` is a performance switch, not a coverage one: every rule still runs
  // against every node, axe just stops assembling full node detail for the passing
  // checks. Without it, a shell-plus-rows tree (~220 nodes) never returns under jsdom,
  // where each detail node costs a getComputedStyle. Violations are unaffected.
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
}

describe('fixtures match the contract', () => {
  it('every fixture parses as a Job', () => {
    for (const job of SEEDED_JOBS) expect(() => JobSchema.parse(job)).not.toThrow();
  });

  it('the list response parses', () => {
    expect(() => ListJobsResponseSchema.parse({ data: SEEDED_JOBS, nextCursor: null })).not.toThrow();
  });

  it('keeps ENG-204 at the seeded counts, not the reference screen counts', () => {
    // Spec 001 §11 open question 5 — the board is the truth. If this ever reads 18/38
    // someone has "fixed" the fixture to match a screenshot.
    const eng204 = SEEDED_JOBS.find((job) => job.reqCode === 'ENG-204');
    expect(eng204).toMatchObject({ inProcessCount: 8, activeCount: 9 });
  });

  it('derives in-process counts from the distribution', () => {
    for (const job of SEEDED_JOBS) {
      const { applied, screen: screened, onsite, offer } = job.stageDistribution;
      expect(applied + screened + onsite + offer, job.reqCode).toBe(job.inProcessCount);
    }
  });
});

describe('default state', () => {
  it('groups the six seeded jobs by department, in list order', async () => {
    renderJobs();
    await screen.findByText('Senior Product Engineer');

    const headings = screen.getAllByText(/· \d+ open$/).map((el) => el.textContent);
    expect(headings).toEqual(['Engineering · 3 open', 'Design · 1 open', 'People · 1 open', 'Sales · 1 open']);
    expect(screen.getByText('6 open')).toBeInTheDocument();
  });

  it('opens the job’s board, as one tab stop named by the job', async () => {
    renderJobs();
    const row = (await screen.findByText('Senior Product Engineer')).closest('li') as HTMLElement;
    const eng204 = SEEDED_JOBS.find((job) => job.reqCode === 'ENG-204')!;

    // One link per row, not a clickable <li>: a row with an onClick gives the
    // keyboard nothing to land on and a screen reader nothing to announce.
    const links = within(row).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('Senior Product Engineer');
    expect(links[0]).toHaveAttribute('href', `/jobs/${eng204.id}/pipeline`);
  });

  it('renders the seeded counts and a labelled status pill', async () => {
    renderJobs();
    const row = (await screen.findByText('Senior Product Engineer')).closest('li') as HTMLElement;

    expect(within(row).getByText('8 in process')).toBeInTheDocument();
    expect(within(row).getByText('9 active')).toBeInTheDocument();
    expect(within(row).getByText('ENG-204 · Remote (US)')).toBeInTheDocument();
    // Status is never color alone.
    expect(within(row).getByText('Active')).toBeInTheDocument();
  });

  it('describes the distribution bar for screen readers', async () => {
    renderJobs();
    const row = (await screen.findByText('Senior Product Engineer')).closest('li') as HTMLElement;
    expect(within(row).getByRole('img')).toHaveAccessibleName('8 in process: 4 applied, 2 screen, 1 onsite, 1 offer');
  });

  it('has no axe violations', async () => {
    const { container } = renderJobs();
    await screen.findByText('Senior Product Engineer');
    await expectNoAxeViolations(container);
  });
});

describe('loading state', () => {
  it('shows skeleton rows at the real row height and never resolves', async () => {
    route(() => new Promise<Response>(() => {}));
    const { container } = renderJobs();
    const skeleton = await screen.findByLabelText('Loading jobs');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.h-\\[var\\(--layout-row-height\\)\\]')).toHaveLength(6);
    await expectNoAxeViolations(container);
  });
});

describe('empty states', () => {
  it('invites a first job when the tenant has none, without an inert button', async () => {
    route((url) => (url.pathname === '/v1/jobs' ? json({ data: [], nextCursor: null }) : undefined));
    const { container } = renderJobs();
    const placeholder = (await screen.findByText('No open roles yet.')).closest('div') as HTMLElement;

    // The empty state carries no action of its own. "+ New job" lives in the shell
    // and the jobs header, and both open one modal (spec 003, one path per action) —
    // a third trigger here would be a second path to the same intent.
    expect(within(placeholder).queryByRole('link', { name: '+ New job' })).not.toBeInTheDocument();
    expect(screen.getByText(/Jobs will appear here/)).toBeInTheDocument();
    // And it does not send the reader somewhere dead: every "+ New job" on
    // screen goes to the wizard, which exists and can submit.
    for (const trigger of screen.getAllByRole('link', { name: '+ New job' })) {
      expect(trigger).toHaveAttribute('href', '/jobs/new');
    }
    await expectNoAxeViolations(container);
  });

  it('offers to clear the filter when a filter matches nothing', async () => {
    const { container } = renderJobs('status=draft');
    expect(await screen.findByText('No jobs match this filter.')).toBeInTheDocument();
    // A different cause gets a different fix — never "create a job" here.
    expect(screen.getByRole('link', { name: 'Clear filter' })).toHaveAttribute('href', '/jobs');
    expect(screen.queryByText('No open roles yet.')).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('error state', () => {
  it('names the next move and keeps the filter', async () => {
    route(() => json({ type: 'x', title: 'boom', status: 500 }, 500));
    const { container } = renderJobs('status=active');
    expect(await screen.findByText("Jobs didn't load.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // The filter survives the failure — the trigger still reads Active.
    expect(screen.getByRole('combobox', { name: 'Filter jobs by status' })).toHaveTextContent('Active');
    await expectNoAxeViolations(container);
  });
});

/** What the API sends a caller without `comp:read`: `band` omitted entirely. */
const withoutBand = () =>
  route((url) =>
    url.pathname === '/v1/jobs'
      ? json({ data: SEEDED_JOBS.map(({ band: _band, ...job }) => job), nextCursor: null })
      : undefined,
  );

describe('permission-denied', () => {
  it('omits band at the wire, and still renders every row', async () => {
    // The screen renders no comp field, so this state is visually identical to the
    // default — the assertion that matters is at the fetch layer, not in the DOM.
    // A test named for a check it does not perform is worse than no test.
    withoutBand();
    const response = await fetchJobs({});
    expect(response.data).not.toHaveLength(0);
    for (const job of response.data) expect(job).not.toHaveProperty('band');

    renderJobs();
    await screen.findByText('Senior Product Engineer');
    expect(screen.getByText('6 open')).toBeInTheDocument();
    expect(screen.queryByText("Jobs didn't load.")).not.toBeInTheDocument();
  });

  it('cannot tell "may not see comp" apart from "has no band" — and that is the contract', async () => {
    // Step 4 replaced the comp tagged union with `band?`, reversing the rationale
    // the union carried: an optional field cannot express the difference. This test
    // pins the resulting ambiguity so it stays visible instead of being forgotten.
    const permitted = await fetchJobs({});
    const eng204 = permitted.data.find((job) => job.reqCode === 'ENG-204');
    const eng209 = permitted.data.find((job) => job.reqCode === 'ENG-209');
    expect(eng204?.band).toEqual({ minCents: '19000000', maxCents: '22500000', currency: 'USD' });
    // ENG-209 simply has no band set.
    expect(eng209).not.toHaveProperty('band');

    withoutBand();
    const denied = await fetchJobs({});
    // ENG-204 withheld looks exactly like ENG-209 unset. Owner: api (§7.4).
    const withheld = denied.data.find((job) => job.reqCode === 'ENG-204');
    expect(Object.keys(withheld ?? {}).sort()).toEqual(Object.keys(eng209 ?? {}).sort());
  });
});

describe('a failed refetch keeps the rows it already has', () => {
  it('shows a stale banner over the data instead of replacing it with an error', async () => {
    const { container } = renderJobs('', { refetchOnWindowFocus: 'always', staleTime: 0 });
    await screen.findByText('Senior Product Engineer');

    // Same query key, so React Query retains the data it already has; the next fetch
    // over that key fails. This is the focus-refetch path from providers.tsx.
    route(() => json({ type: 'about:blank', title: 'boom', status: 500 }, 500));
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument());
    // The rows are still there — the banner says "may be out of date", not "gone".
    expect(screen.getByText('Senior Product Engineer')).toBeInTheDocument();
    expect(screen.queryByText("Jobs didn't load.")).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('shows the full error state when there is no data to keep', async () => {
    route(() => json({ type: 'x', title: 'boom', status: 500 }, 500));
    renderJobs();
    expect(await screen.findByText("Jobs didn't load.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('writes the status filter to the URL from the keyboard', async () => {
    const user = userEvent.setup();
    renderJobs();
    await screen.findByText('Senior Product Engineer');

    // Opened from the keyboard, which is the path that has to keep working now the
    // listbox is Radix's rather than the platform's. The option is then clicked:
    // arrow-key counting from an implicit starting highlight would assert Radix's
    // internals rather than ours.
    const trigger = screen.getByRole('combobox', { name: 'Filter jobs by status' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'On hold' }));
    expect(routerReplace).toHaveBeenCalledWith('/jobs?status=on_hold', { scroll: false });
  });

  it('drops an unparseable status rather than putting it on the wire', async () => {
    // ListJobsQuery is .strict() with a status enum, so forwarding `bogus` 400s the
    // real endpoint while the mock only filters to nothing. Dropping it keeps dev and
    // production on the same path, and the select honestly reads "All".
    renderJobs('status=bogus');
    await screen.findByText('Senior Product Engineer');
    // The trigger is a button, not a form control, so the assertion is on what it
    // displays rather than on a `value` — same guarantee, different mechanism.
    expect(screen.getByRole('combobox', { name: 'Filter jobs by status' })).toHaveTextContent('All');
    expect(screen.queryByText('No jobs match this filter.')).not.toBeInTheDocument();
    expect(jobsUrl({ status: undefined })).not.toContain('status=');
  });

  it('narrows the list to the matching department', async () => {
    renderJobs('department=Design');
    expect(await screen.findByText('Product Designer, Growth')).toBeInTheDocument();
    expect(screen.queryByText('Senior Product Engineer')).not.toBeInTheDocument();
    expect(screen.getByText('Design · 1 open')).toBeInTheDocument();
  });
});

describe('keyboard path', () => {
  it('reaches the nav, the filter and the primary action with Tab alone', async () => {
    const user = userEvent.setup();
    renderJobs();
    await screen.findByText('Senior Product Engineer');

    const reached: string[] = [];
    for (let i = 0; i < 16; i += 1) {
      await user.tab();
      const active = document.activeElement;
      // aria-label first: an icon-only control with no accessible name would land here
      // as an empty string, which is exactly the failure worth catching.
      if (active && active !== document.body) reached.push(active.getAttribute('aria-label') ?? active.textContent?.trim() ?? '');
    }

    expect(reached).toContain('Jobs6');
    expect(reached).toContain('+ New job');
    // The Radix trigger is a real <button>, so it stays in the tab order — this is
    // the assertion that catches the swap away from a native select regressing it.
    expect(reached).toContain('Filter jobs by status');

    // Sign-out is a real control now that there is a session to end, so it is
    // reachable — and reachable by its accessible name, since it is icon-only.
    expect(reached).toContain('Sign out');

    // Nothing that does nothing takes focus: the topbar search and the
    // notification bell are still deferred features, so the keyboard path must
    // not stop on either.
    expect(reached).not.toContain('Search candidates, jobs');
    // And every element it does reach has an accessible name.
    expect(reached.filter((label) => label === '')).toEqual([]);
  });
});
