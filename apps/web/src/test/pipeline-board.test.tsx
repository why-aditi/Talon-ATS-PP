/**
 * Board rendering and the five states — spec 003 §11 tests 1–9.
 * The keyboard path has its own file; it needs different plumbing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { PipelineBoard } from '../components/pipeline-board';
import { SessionProvider } from '../lib/session';
import { ENG204_JOB_ID } from './pipeline-fixtures';
import { resetPipelineState } from './pipeline-handlers';
import { pathname, searchParams } from './setup';

function renderBoard(state?: string) {
  pathname.current = `/jobs/${ENG204_JOB_ID}/pipeline`;
  if (state) searchParams.current = new URLSearchParams({ state });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <PipelineBoard jobId={ENG204_JOB_ID} />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

const column = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name},`) });

beforeEach(() => resetPipelineState());

describe('the board', () => {
  it('renders the nine named candidates in 4 / 2 / 1 / 1 / 1', async () => {
    renderBoard();
    expect(await screen.findByText('Tess Bianchi')).toBeInTheDocument();

    // Every card, by column, with the order asserted. The previous version named one
    // card per column and then asserted that a helper FUNCTION was truthy — Applied
    // could have rendered forty cards and it would still have passed.
    const names = (stage: string) =>
      within(column(stage))
        .queryAllByTestId('card-name')
        .map((el) => el.textContent);

    expect(names('Applied')).toEqual(['Tess Bianchi', 'Omar Haddad', 'Jordan Cole', 'Priya Nair']);
    expect(names('Screen')).toEqual(['Elena Ruiz', 'Marcus Webb']);
    expect(names('Onsite')).toEqual(['Ana Petrova']);
    expect(names('Offer')).toEqual(['Sofia Lindqvist']);
    expect(names('Hired')).toEqual(['David Kim']);
  });

  it('carries count, pass rate and median in every column header', async () => {
    renderBoard();
    expect(await screen.findByText('median 2d')).toBeInTheDocument();

    expect(within(column('Applied')).getByText('100% pass')).toBeInTheDocument();
    expect(within(column('Screen')).getByText('56% pass')).toBeInTheDocument();
    expect(within(column('Screen')).getByText('median 4d')).toBeInTheDocument();
    expect(within(column('Onsite')).getByText('33% pass')).toBeInTheDocument();
    expect(within(column('Offer')).getByText('22% pass')).toBeInTheDocument();
  });

  /**
   * The value a derivation from the visible cards would NOT produce. Applied's four
   * cards read 4d/3d/2d/1d and reduce to a 2.5d median; the real figure is 2d, over the
   * five candidates who have LEFT Applied. If this ever reads 2.5, someone has started
   * computing column stats from the column.
   */
  it('takes medians from completed dwells, not from the cards on screen', async () => {
    renderBoard();
    expect(await screen.findByText('median 2d')).toBeInTheDocument();
    expect(screen.queryByText(/median 2\.5d/)).not.toBeInTheDocument();
  });

  it('reads "closed" rather than a median on the terminal column', async () => {
    renderBoard();
    expect(await screen.findByText('closed')).toBeInTheDocument();
    expect(within(column('Hired')).getByText('closed')).toBeInTheDocument();
    expect(within(column('Hired')).queryByText(/^median/)).not.toBeInTheDocument();
  });
});

describe('the stalled treatment', () => {
  it('gives Elena Ruiz colour, weight and a left edge — three signals', async () => {
    renderBoard();
    const stalled = await screen.findByText('Stalled 8d in stage');

    // Colour and weight.
    expect(stalled).toHaveClass('text-text-danger');
    expect(stalled).toHaveClass('text-body-strong');
    // Position: the third signal, and the one that survives greyscale.
    expect(stalled.closest('.border-l-2')).not.toBeNull();
  });

  it('leaves the next action unstyled — only the dwell clause is the problem', async () => {
    renderBoard();
    const stalled = await screen.findByText('Stalled 8d in stage');
    const footer = stalled.parentElement;
    expect(footer).toHaveTextContent('Stalled 8d in stage · Call Tue');
    expect(footer).toHaveClass('text-text-tertiary');
  });

  /** The whole evidence for `> slaDays` rather than `>=`. Marcus sits exactly on the
   *  5-day Screen SLA and the reference renders him normally. */
  it('does not stall Marcus Webb at exactly the SLA', async () => {
    renderBoard();
    const dwell = await screen.findByText('5d in stage');
    expect(dwell.parentElement).toHaveTextContent('5d in stage · Call Mon');
    expect(dwell).not.toHaveClass('text-text-danger');
    expect(screen.queryByText(/Stalled 5d/)).not.toBeInTheDocument();
  });

  it('never stalls a stage with no SLA', async () => {
    renderBoard();
    // Tess is 4d into Applied, which has slaDays: null.
    const dwell = await screen.findByText('4d in stage');
    expect(dwell).not.toHaveClass('text-text-danger');
    expect(screen.queryByText(/Stalled 4d/)).not.toBeInTheDocument();
  });
});

describe('card content', () => {
  it('orders tags status, then skills, then source', async () => {
    renderBoard();
    await screen.findByText('David Kim');

    const card = screen.getByText('David Kim').closest('div')?.parentElement?.parentElement;
    const tags = within(card as HTMLElement)
      .getAllByText(/^(Hired|Referral)$/)
      .map((t) => t.textContent);
    expect(tags).toEqual(['Hired', 'Referral']);
  });

  it('renders Marcus Webb as Outbound, not the reference’s "LinkedIn"', async () => {
    renderBoard();
    await screen.findByText('Marcus Webb');
    // The designer was loose with the source enum; the enum is not widened for a pixel.
    expect(screen.queryByText('LinkedIn')).not.toBeInTheDocument();
  });

  it('shows a score chip only where a score exists', async () => {
    renderBoard();
    expect(await screen.findByText('4.2')).toBeInTheDocument();
    expect(screen.getByText('4.6')).toBeInTheDocument();
    expect(screen.queryAllByText(/^\d\.\d$/)).toHaveLength(2);
  });
});

describe('states', () => {
  it('renders a skeleton while loading, and not the board beside it', async () => {
    renderBoard('loading');
    expect(await screen.findByRole('status', { name: 'Loading pipeline' })).toBeInTheDocument();
    // The second clause the old name promised and never checked.
    expect(screen.queryByText('Tess Bianchi')).not.toBeInTheDocument();
  });

  it('keeps every column present on an empty board', async () => {
    renderBoard('empty');
    // The board's shape is itself the information — which stages exist is worth more
    // than a single "nothing here" message.
    expect(await screen.findByRole('region', { name: /^Applied,/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /^Hired,/ })).toBeInTheDocument();
    expect(screen.getAllByText(/No candidates in .* yet/).length).toBeGreaterThan(0);
  });

  it('offers a retry, not a stack trace, when the board fails to load', async () => {
    renderBoard('error');
    expect(await screen.findByText("The pipeline didn't load.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('drops the score chip out of scorecard scope rather than masking it', async () => {
    renderBoard('forbidden');
    await screen.findByText('Ana Petrova');
    // Indistinguishable from an unscored card: the board never says "there is a score
    // you may not see" (non-negotiable #3).
    expect(screen.queryByText('4.2')).not.toBeInTheDocument();
    expect(screen.queryByText(/hidden|restricted|—/i)).not.toBeInTheDocument();
  });

  it('offers to clear the filter, not to create a record, when a filter matches nothing', async () => {
    pathname.current = `/jobs/${ENG204_JOB_ID}/pipeline`;
    searchParams.current = new URLSearchParams({ q: 'nobody at all' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <PipelineBoard jobId={ENG204_JOB_ID} />
        </SessionProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('No candidates match those filters.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toBeInTheDocument();
    expect(screen.queryByText(/Add a candidate directly/)).not.toBeInTheDocument();
  });
});

describe('the pictured-but-unbuilt controls', () => {
  it('disables them rather than leaving dead-end tab stops', async () => {
    renderBoard();
    await screen.findByText('Tess Bianchi');

    expect(screen.getByRole('button', { name: 'Edit job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Add candidate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Job details' })).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: /^Add a candidate to/ })) {
      expect(button).toBeDisabled();
    }
  });
});

/**
 * The `region` rule is disabled here and nowhere else: it requires every element to sit
 * inside a landmark, and this harness renders the board without the `<main>` the app
 * layout wraps it in. That is a fixture artifact, not a violation — the E2E run checks
 * the real page, landmarks included.
 */
describe('accessibility', () => {
  it('is axe-clean on the default board', async () => {
    const { container } = renderBoard();
    await screen.findByText('Tess Bianchi');
    const results = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  it('is axe-clean while loading', async () => {
    const { container } = renderBoard('loading');
    await screen.findByRole('status', { name: 'Loading pipeline' });
    const results = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  it('is axe-clean on the empty board', async () => {
    const { container } = renderBoard('empty');
    await screen.findByRole('region', { name: /^Applied,/ });
    const results = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
