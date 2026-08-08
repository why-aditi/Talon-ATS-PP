/**
 * The scheduling screen — spec 004 §11 (every state) and §12 (the edge cases that
 * reach the UI).
 *
 * Each state gets its own case, because a screen with six specced states and a test for
 * the happy one is a screen with five untested states.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { SchedulingScreen } from '../components/scheduling-screen';
import { REFERENCE_LOOP_ID, type Scenario } from '../lib/scheduling-fixtures';
import { pathname, searchParams } from './setup';

function renderScreen(state?: Scenario) {
  pathname.current = `/scheduling/${REFERENCE_LOOP_ID}`;
  if (state) searchParams.current = new URLSearchParams({ state });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SchedulingScreen loopId={REFERENCE_LOOP_ID} />
    </QueryClientProvider>,
  );
}

const grid = () => screen.getByRole('grid');
const rowFor = (label: string) =>
  screen.getAllByRole('row').find((row) => within(row).queryByText(label) !== null) as HTMLElement;

/* ── Default: the reference screen ─────────────────────────────────────────── */

describe('the reference loop', () => {
  it('lists four rounds with two confirmed and two pending', async () => {
    renderScreen();
    expect(await screen.findByText('Lin Chen')).toBeInTheDocument();

    const rounds = screen.getAllByRole('listitem');
    expect(rounds).toHaveLength(4);
    expect(rounds.map((item) => within(item).getByText(/min$/).textContent)).toEqual([
      'Coding, 60 min',
      'System design, 60 min',
      'Values, 45 min',
      'Hiring manager, 45 min',
    ]);
    expect(screen.getAllByText('Confirmed')).toHaveLength(2);
    expect(screen.getAllByText('Pending')).toHaveLength(2);
  });

  it('names the person and the time in the conflict callout', async () => {
    renderScreen();
    expect(
      await screen.findByText('Maya Reyes is busy at 10:00. Pick a clear row or the loop needs a gap.'),
    ).toBeInTheDocument();
    // Never the generic form (DESIGN_SYSTEM §6).
    expect(screen.queryByText(/no availability/i)).not.toBeInTheDocument();
    // Said once. A callout and a disabled-button reason saying the same sentence twice
    // is how a screen starts nagging.
    expect(
      screen.getAllByText('Maya Reyes is busy at 10:00. Pick a clear row or the loop needs a gap.'),
    ).toHaveLength(1);
  });

  it('states the exact commitment on the primary button', async () => {
    renderScreen();
    expect(await screen.findByRole('button', { name: 'Send invites, 10:00 AM Aug 6' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Hold slot for 24h' })).toBeEnabled();
  });

  it('heads the grid with the day, the zone and the candidate window', async () => {
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Thursday, Aug 6' })).toBeInTheDocument();
    expect(screen.getByText('Times in CT, candidate available 9 to 4')).toBeInTheDocument();
  });

  it('reproduces the busy blocks and the all-free rows from the reference', async () => {
    renderScreen();
    expect(await screen.findByText('Thursday, Aug 6')).toBeInTheDocument();

    // 9:00 — Lin and Maya busy. 10:00 — Maya busy, the other three on the loop slot.
    expect(within(rowFor('9:00')).getAllByText('Busy')).toHaveLength(2);
    expect(within(rowFor('10:00')).getAllByText('Busy')).toHaveLength(1);
    expect(within(rowFor('10:00')).getAllByText('Loop slot')).toHaveLength(3);
    // "All free" is derived from the row, not written into the fixture twice.
    expect(within(rowFor('11:00')).getByText('All free')).toBeInTheDocument();
    expect(within(rowFor('2:30')).getByText('All free')).toBeInTheDocument();
    expect(within(rowFor('12:00')).queryByText('All free')).not.toBeInTheDocument();
  });

  it('carries busy as a label and a 45° hatch, never as colour alone', async () => {
    const { container } = renderScreen();
    expect(await screen.findByText('Thursday, Aug 6')).toBeInTheDocument();

    const cell = within(rowFor('9:00')).getAllByRole('gridcell')[0] as HTMLElement;
    expect(cell).toHaveAttribute('aria-label', 'Lin Chen is busy at 9:00');
    expect(within(cell).getByText('Busy')).toBeInTheDocument();

    /*
      The hatch is required, not decorative: `busyFill` on `surfaceSunken` is a ~3%
      luminance step, so in grayscale the fill alone is invisible and the pattern is
      the whole accessibility carrier. Asserted down to the angle and the token,
      because a hatch that quietly became a flat fill would still satisfy "there is
      an element here".
    */
    const fill = cell.querySelector('rect')?.getAttribute('fill') ?? '';
    const patternId = /^url\(#(.+)\)$/.exec(fill)?.[1];
    expect(patternId).toBeDefined();

    const pattern = container.querySelector(`pattern[id="${patternId}"]`) as SVGPatternElement;
    expect(pattern).not.toBeNull();
    expect(pattern.getAttribute('patternTransform')).toBe('rotate(45)');
    // Two stripes, so it reads as a pattern rather than a tint: the sunken ground and
    // the busy fill, both tokens, never a literal.
    expect([...pattern.querySelectorAll('rect')].map((r) => r.getAttribute('fill'))).toEqual([
      'var(--color-bg-surface-sunken)',
      'var(--color-calendar-busy-fill)',
    ]);
  });
});

/* ── Manual placement (§7a) ────────────────────────────────────────────────── */

describe('placing a round by hand', () => {
  const roundCard = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

  it('is two steps — pick the round, then pick the row', async () => {
    renderScreen();
    expect(await screen.findByText('Thursday, Aug 6')).toBeInTheDocument();

    await userEvent.click(roundCard('Maya Reyes'));
    // The hint is spoken once and also stands in the left pane, so it matches twice;
    // this asks whether it is on screen, not whether it was announced.
    expect(screen.getByText(/Values picked up\. Choose a row in the grid/, { ignore: '[role="status"]' })).toBeInTheDocument();

    // Any cell on the row: the round already knows whose calendar it needs, so the
    // column is not a second thing to get right.
    await userEvent.click(within(rowFor('11:00')).getAllByRole('gridcell')[0] as HTMLElement);

    expect(screen.getByLabelText('Maya Reyes is holding the loop slot at 11:00')).toBeInTheDocument();
    expect(screen.getByText('Values, 45 min · moved to 11:00')).toBeInTheDocument();
    // Values left 10:00, so the conflict that was there goes with it.
    expect(screen.queryByText(/Maya Reyes is busy at 10:00/)).not.toBeInTheDocument();
    // There is no mode to leave: the round is put down and the screen is as it was.
    expect(roundCard('Maya Reyes')).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders a violation as the solver’s own callout, with "Place anyway" beside it', async () => {
    const { container } = renderScreen();
    expect(await screen.findByText('Thursday, Aug 6')).toBeInTheDocument();

    await userEvent.click(roundCard('Maya Reyes'));
    // 9:00 — Maya is busy there.
    await userEvent.click(within(rowFor('9:00')).getAllByRole('gridcell')[0] as HTMLElement);

    // The same sentence the solver produces, not a second conflict UI (§7a).
    expect(
      screen.getByText('Maya Reyes is busy at 9:00. Pick a clear row or the loop needs a gap.'),
    ).toBeInTheDocument();
    // Nothing is placed until it is confirmed, and the send says exactly that.
    expect(screen.getByRole('button', { name: /^Send invites/ })).toBeDisabled();
    expect(screen.getByText('Say where the Values round goes before sending.')).toBeInTheDocument();
    expect(screen.queryByText(/moved to 9:00/)).not.toBeInTheDocument();

    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Place anyway' }));

    // Placed, and the cell carries both facts: the busy hatch and the slot stroke.
    const cell = screen.getByLabelText(
      'Maya Reyes is busy at 9:00, and the loop slot was placed there anyway',
    );
    expect(within(cell).getByText('Loop slot, busy')).toBeInTheDocument();
    expect(cell.querySelector('rect')).not.toBeNull();
    expect(cell).toHaveAttribute('aria-selected', 'true');

    // The override is recorded and said out loud, not swallowed.
    expect(screen.getByText(/Values sits at 9:00 over Maya Reyes/)).toBeInTheDocument();
    // And the advice she already declined is not repeated at her.
    expect(
      screen.queryByText('Maya Reyes is busy at 9:00. Pick a clear row or the loop needs a gap.'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invites, 9:00 AM Aug 6' })).toBeEnabled();
  });
});

/* ── Loading ───────────────────────────────────────────────────────────────── */

describe('loading', () => {
  it('shows a skeleton grid at the real row height', async () => {
    renderScreen('loading');
    expect(await screen.findByRole('status', { name: 'Loading availability' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading the loop' })).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });
});

/* ── The states from §11 ───────────────────────────────────────────────────── */

describe('no arrangement', () => {
  it('returns the blocker rather than an empty list, and refuses the send', async () => {
    renderScreen('no-arrangement');
    expect(
      await screen.findByText('Maya Reyes is busy at 10:00. Pick a clear row or the loop needs a gap.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/No arrangement fits inside 9 to 4/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invites' })).toBeDisabled();
    expect(screen.getByText('Pick a row before sending.')).toBeInTheDocument();
  });
});

describe('a blocker with nobody in it', () => {
  it('still says the specific number and the next move', async () => {
    renderScreen('window-narrow');
    // Not `panelist_busy`, so there is no person to name — and the sentence still has
    // to be a specific one, never "No availability found" (DESIGN_SYSTEM §6).
    expect(
      await screen.findByText(
        "The loop needs 3h 30m and only 2h is free in the candidate's window. Ask for a wider window, or drop a round.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no availability|undefined|NaN/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invites' })).toBeDisabled();
  });
});

describe('a panelist who declined', () => {
  it('reads as declined, never as confirmed', async () => {
    renderScreen('declined');
    expect(await screen.findByText('Declined')).toBeInTheDocument();
    // Two confirmed rounds in the reference; David's decline leaves one.
    expect(screen.getAllByText('Confirmed')).toHaveLength(1);
    expect(screen.getAllByText('Pending')).toHaveLength(2);
  });
});

describe('partial solve', () => {
  it('says the search was time-boxed without naming the machinery', async () => {
    renderScreen('partial');
    expect(await screen.findByText(/The search ran out of time/)).toBeInTheDocument();
    expect(screen.queryByText(/200 ?ms/)).not.toBeInTheDocument();
    // Still sendable: a time-boxed search is a note, not a blocker.
    expect(screen.getByRole('button', { name: 'Send invites, 10:00 AM Aug 6' })).toBeEnabled();
  });
});

describe('a calendar that cannot be read', () => {
  // The fixture gives Maya ONE interval over the whole window, per §4 — so seven busy
  // rows here is the grid deriving them by overlap, not the fixture listing them.
  it('marks the column, says why, reads fully busy, and blocks the send', async () => {
    renderScreen('disconnected');
    expect(await screen.findAllByText('Calendar not connected')).not.toHaveLength(0);
    expect(
      screen.getByText(/Maya Reyes hasn't connected a calendar, so every row reads as busy/),
    ).toBeInTheDocument();
    // Never the machinery (DESIGN_SYSTEM §6).
    expect(screen.queryByText(/OAuth|token|provider/i)).not.toBeInTheDocument();

    // Fully busy: every one of the seven rows, not just the ones she had events in.
    expect(within(grid()).getAllByLabelText(/Maya Reyes reads as busy at .* their calendar is not connected/)).toHaveLength(7);
    expect(screen.getByRole('button', { name: /^Send invites/ })).toBeDisabled();
  });
});

describe('a hold someone else owns', () => {
  it('names the holder and when it lapses, and disables the hold', async () => {
    renderScreen('hold-taken');
    expect(
      await screen.findByText(/Dana Whitfield is holding this slot until 4:30 PM Aug 7/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hold slot for 24h' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Send invites/ })).toBeDisabled();
  });
});

describe('a send blocked by drift', () => {
  it('says what changed, that nothing was sent, and offers another slot', async () => {
    renderScreen('drift');
    expect(
      await screen.findByText(/Maya Reyes booked 10:00 to 10:45 while this was open\. Nothing was sent\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Send invites/ })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Find another slot' }));
    // Re-solved onto the first row with no conflict — 11:00.
    expect(screen.getByRole('button', { name: 'Send invites, 11:00 AM Aug 6' })).toBeEnabled();
  });
});

/* ── Empty, error, permission-denied ───────────────────────────────────────── */

describe('the remaining states', () => {
  it('invites the fix when the loop has no rounds', async () => {
    renderScreen('empty');
    expect(await screen.findByText(/No rounds in this loop yet/)).toBeInTheDocument();
    expect(screen.getByText('No panel to show.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invites' })).toBeDisabled();
  });

  it('offers a retry when the load fails', async () => {
    renderScreen('error');
    expect(await screen.findByText("The schedule didn't load.")).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been sent/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('says who can open the loop when permission is refused', async () => {
    renderScreen('forbidden');
    expect(await screen.findByText("You can't open this loop.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

/* ── axe ───────────────────────────────────────────────────────────────────── */

describe('accessibility', () => {
  it.each<Scenario>([
    'default',
    'loading',
    'no-arrangement',
    'window-narrow',
    'declined',
    'disconnected',
    'hold-taken',
    'drift',
    'empty',
    'error',
    'forbidden',
  ])(
    'has no axe violations in the %s state',
    async (state) => {
      const { container } = renderScreen(state);
      if (state !== 'loading') await screen.findByText(/Thursday, Aug 6|didn't load|can't open/);
      const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    },
  );
});
