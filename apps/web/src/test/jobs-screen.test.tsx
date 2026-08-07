import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../components/app-shell';
import { JobsScreen } from '../components/jobs-screen';
import { jobListResponseSchema, jobSchema } from '../lib/jobs-contract';
import { JOBS } from '../mocks/fixtures';
import { routerReplace, searchParams } from './setup';

function renderJobs(query = '') {
  searchParams.current = new URLSearchParams(query);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AppShell>
        <JobsScreen />
      </AppShell>
    </QueryClientProvider>,
  );
}

/** Zero violations is the gate; the rule ids make a failure readable. */
async function expectNoAxeViolations(container: HTMLElement) {
  // jsdom has no layout engine, so color-contrast can only guess — it is gated for
  // real in packages/tokens/test/contrast.test.ts, over the token pairs themselves.
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
}

describe('fixtures match the contract', () => {
  it('every fixture parses as a Job', () => {
    for (const job of JOBS) expect(() => jobSchema.parse(job)).not.toThrow();
  });

  it('the list response parses', () => {
    expect(() => jobListResponseSchema.parse({ data: JOBS, nextCursor: null })).not.toThrow();
  });

  it('keeps ENG-204 at the seeded counts, not the reference screen counts', () => {
    // Spec 001 §11 open question 5 — the board is the truth. If this ever reads 18/38
    // someone has "fixed" the fixture to match a screenshot.
    const eng204 = JOBS.find((job) => job.reqCode === 'ENG-204');
    expect(eng204).toMatchObject({ inProcessCount: 8, activeCount: 9 });
  });

  it('derives in-process counts from the distribution', () => {
    for (const job of JOBS) {
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
    const { container } = renderJobs('state=loading');
    const skeleton = await screen.findByLabelText('Loading jobs');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.h-\\[var\\(--layout-row-height\\)\\]')).toHaveLength(6);
    await expectNoAxeViolations(container);
  });
});

describe('empty states', () => {
  it('invites a first job when the tenant has none', async () => {
    const { container } = renderJobs('state=empty');
    expect(await screen.findByText('No open roles yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '+ New job' }).length).toBeGreaterThan(0);
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
    const { container } = renderJobs('status=active&state=error');
    expect(await screen.findByText("Jobs didn't load.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // The filter survives the failure — the select is still on Active.
    expect(screen.getByRole('combobox', { name: 'Filter jobs by status' })).toHaveValue('active');
    await expectNoAxeViolations(container);
  });
});

describe('permission-denied', () => {
  it('renders every row without band data, with no error and no empty state', async () => {
    renderJobs('state=forbidden');
    await screen.findByText('Senior Product Engineer');
    expect(screen.getByText('6 open')).toBeInTheDocument();
    expect(screen.queryByText("Jobs didn't load.")).not.toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('writes the status filter to the URL from the keyboard', async () => {
    const user = userEvent.setup();
    renderJobs();
    await screen.findByText('Senior Product Engineer');

    const select = screen.getByRole('combobox', { name: 'Filter jobs by status' });
    await user.selectOptions(select, 'on_hold');
    expect(routerReplace).toHaveBeenCalledWith('/jobs?status=on_hold', { scroll: false });
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
    expect(reached).toContain('Sign out');
    expect(reached).toContain('+ New job');
    // The status filter is a native select, so it is in the tab order for free.
    expect(reached).toContain('Filter jobs by status');
  });
});
