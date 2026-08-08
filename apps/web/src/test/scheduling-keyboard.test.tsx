/**
 * The grid without a pointer — spec 004 §11 ("the grid is navigable and a slot
 * selectable without a pointer") and the Day/Week toggle.
 *
 * Kept apart from the state tests because it needs a different shape: every case here
 * drives real keys and asserts on what a screen reader would have been told, not on
 * what a click produced.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SchedulingScreen } from '../components/scheduling-screen';
import { REFERENCE_LOOP_ID } from '../lib/scheduling-fixtures';
import { pathname } from './setup';

/**
 * The clock the hold is measured from — spec §9 step 2 is `now() + 24h`.
 *
 * Injected rather than read off the machine, for the same reason `solveLoop` takes a
 * `now`: the assertion has to be stable, and the way to make it stable is to fix the
 * clock, never to measure the hold from a different quantity.
 */
const FIXED_NOW = () => Date.parse('2026-08-05T18:00:00.000Z'); // 1:00 PM CT, Wed 5 Aug

function renderScreen() {
  pathname.current = `/scheduling/${REFERENCE_LOOP_ID}`;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SchedulingScreen loopId={REFERENCE_LOOP_ID} now={FIXED_NOW} />
    </QueryClientProvider>,
  );
}

const live = () => screen.getByRole('status');

/**
 * On-screen text, excluding the live region.
 *
 * The picked-up hint is deliberately in both places — spoken once when it happens,
 * and standing in the left pane for as long as it is true — so a plain `getByText`
 * matches twice. This asks the question the test actually means: can you *see* it.
 */
const onScreen = (text: RegExp) => screen.queryByText(text, { ignore: '[role="status"]' });

/**
 * Tab until `target` has focus, or fail.
 *
 * Every reach for a control goes through this rather than `.focus()`, because a
 * programmatic focus proves the handler works and proves nothing about whether a
 * keyboard user can ever get there. A control that is unreachable by Tab fails here
 * instead of passing quietly.
 */
async function tabTo(target: HTMLElement, limit = 40) {
  for (let i = 0; i < limit; i += 1) {
    if (document.activeElement === target) return;
    await userEvent.tab();
  }
  throw new Error(`Tab never reached ${target.tagName}: ${target.getAttribute('aria-label') ?? target.textContent}`);
}

/** The grid's single tab stop — the cell the roving tabindex currently sits on. */
const tabbableCell = () =>
  within(screen.getByRole('grid'))
    .getAllByRole('gridcell')
    .find((cell) => cell.tabIndex === 0) as HTMLElement;

describe('keyboard navigation', () => {
  it('is one tab stop, then moves cell by cell with the arrows', async () => {
    renderScreen();
    await screen.findByText('Thursday, Aug 6');

    const cells = within(screen.getByRole('grid')).getAllByRole('gridcell');
    // A roving tabindex: exactly one cell is tabbable, so tabbing past the grid does
    // not walk twenty-eight cells.
    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);

    // Reached by Tab from the top of the document, with no pointer and no .focus().
    await tabTo(cells[0] as HTMLElement);
    expect(document.activeElement).toHaveAttribute('aria-label', 'Lin Chen is busy at 9:00');

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAttribute('aria-label', 'David Osei is free at 9:00');

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveAttribute('aria-label', 'David Osei is holding the loop slot at 10:00');

    await userEvent.keyboard('{End}');
    expect(document.activeElement).toHaveAttribute('aria-label', 'Sam Altmann is holding the loop slot at 10:00');

    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toHaveAttribute('aria-label', 'Lin Chen is holding the loop slot at 10:00');

    // Clamped at the edges rather than wrapping — a wrap makes "up" ambiguous.
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toHaveAttribute('aria-label', 'Lin Chen is busy at 9:00');
  });

  it('selects a slot with Enter and announces who is free', async () => {
    renderScreen();
    await screen.findByText('Thursday, Aug 6');

    await tabTo(tabbableCell());
    // 9:00 → 11:00, the first row where nobody is busy.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(live()).toHaveTextContent(
      '11:00 selected. Lin Chen, David Osei, Maya Reyes and Sam Altmann are free.',
    );
    expect(screen.getByRole('button', { name: 'Send invites, 11:00 AM Aug 6' })).toBeEnabled();
    // The conflict callout goes with the conflict.
    expect(screen.queryByText(/Maya Reyes is busy at 10:00/)).not.toBeInTheDocument();
  });

  it('announces the blocker when the picked row has a busy panelist', async () => {
    renderScreen();
    await screen.findByText('Thursday, Aug 6');

    await tabTo(tabbableCell());
    // 9:00 → 12:00, where Lin and Sam are both busy. Lin's round is first in position
    // order, so she is the one the blocker names.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ }');

    expect(live()).toHaveTextContent(
      '12:00 selected. Lin Chen is busy at 12:00. Pick a clear row or the loop needs a gap.',
    );
    expect(screen.getByText('Lin Chen is busy at 12:00. Pick a clear row or the loop needs a gap.')).toBeInTheDocument();
    // Still sendable — the row is the loop's start, and the server re-validates before
    // it writes anything (§10). The callout is the warning; it is not a lock.
    expect(screen.getByRole('button', { name: 'Send invites, 12:00 PM Aug 6' })).toBeEnabled();
  });

  /*
    Spec 004 §7a, and the reviewer's S4: the grid's rows are the day's hours, not a
    pre-validated list of loop starts. The reference screen offers a 3:30 row AND states
    the candidate window as 9 to 4, both measured from it — so a 60-minute round at 3:30
    genuinely runs past the window, and the honest answer is the `outside_window` blocker
    rather than a row that quietly reads as placeable. Neither fixture number is
    "corrected" to make the check go away; the check is what tells the recruiter why.
  */
  it('refuses a row where the first round would run past the candidate window', async () => {
    renderScreen();
    await screen.findByText('Thursday, Aug 6');

    await tabTo(tabbableCell());
    // 9:00 → 3:30, the last row. Coding is 60 minutes and the window ends at 4:00.
    await userEvent.keyboard('{PageDown}{ }');

    expect(live()).toHaveTextContent(
      '3:30 selected. Coding at 3:30 falls outside the window the candidate gave. Pick a time inside it.',
    );
    expect(
      screen.getByText('Coding at 3:30 falls outside the window the candidate gave. Pick a time inside it.'),
    ).toBeInTheDocument();
  });

  it('switches to the week and back into a day, by keyboard', async () => {
    renderScreen();
    await screen.findByText('Thursday, Aug 6');

    // A radiogroup is one tab stop and the arrows move inside it, so Week is never
    // tabbed to — it is arrowed to, which is what a screen-reader user will do.
    const day = screen.getByRole('radio', { name: 'Day' });
    await tabTo(day);
    expect(day).toHaveAttribute('aria-checked', 'true');

    await userEvent.keyboard('{ArrowRight}');
    const week = screen.getByRole('radio', { name: 'Week' });
    expect(week).toHaveAttribute('aria-checked', 'true');
    // Selection moved, so focus moved with it — otherwise it strands on a control
    // that has just become untabbable.
    expect(document.activeElement).toBe(week);
    expect(screen.getByRole('grid')).toHaveAccessibleName(/week of Aug 3/);
    // One column per day now, not per panelist.
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Time',
      'Mon 3',
      'Tue 4',
      'Wed 5',
      'Thu 6',
      'Fri 7',
    ]);

    await tabTo(tabbableCell());
    await userEvent.keyboard('{Enter}');

    // Picking a day drops back into that day's panel grid, at the row that was chosen.
    expect(screen.getByRole('radio', { name: 'Day' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('heading', { name: 'Monday, Aug 3' })).toBeInTheDocument();
    expect(live()).toHaveTextContent('Monday, Aug 3 opened at 9:00.');
  });

  it('holds and then sends, with no pointer at all', async () => {
    renderScreen();
    await screen.findByText('Thursday, Aug 6');

    await tabTo(screen.getByRole('button', { name: 'Hold slot for 24h' }));
    await userEvent.keyboard('{Enter}');
    /*
      24h from the clock, not 24h from the slot — and the clock is deliberately a day
      before the slot so the two answers differ: from `now` it is 1:00 PM Aug 6, from the
      selected 10:00 AM Aug 6 slot it would be 10:00 AM Aug 7. §9 step 2 says the former,
      and the callout states it to the recruiter, so it is a commitment rather than a
      detail.
    */
    expect(screen.getByText(/Slot held until 1:00 PM Aug 6/)).toBeInTheDocument();
    // A hold is not a booking, and the copy says so rather than implying safety.
    expect(screen.getByText(/A hold is not a booking/)).toBeInTheDocument();

    await tabTo(screen.getByRole('button', { name: 'Send invites, 10:00 AM Aug 6' }));
    await userEvent.keyboard('{Enter}');
    // The verb on the button reappears in the confirmation (DESIGN_SYSTEM §6).
    expect(screen.getByText(/Invites sent, 10:00 AM Aug 6\./)).toBeInTheDocument();
  });

  /* ── Manual placement, §7a ───────────────────────────────────────────────── */

  it('picks a round up and places it on a clear row, keyboard only', async () => {
    renderScreen();
    await screen.findByText('Thursday, Aug 6');

    // Step one: the round. Its card is the control, so Tab reaches it like anything else.
    await tabTo(screen.getByRole('button', { name: /Maya Reyes/ }));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /Maya Reyes/ })).toHaveAttribute('aria-pressed', 'true');
    expect(live()).toHaveTextContent('Values picked up. Choose a row in the grid to place it');

    // Step two: the row. 9:00 → 11:00, where Maya is free.
    await tabTo(tabbableCell());
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(live()).toHaveTextContent('Values placed at 11:00.');
    expect(screen.getByRole('button', { name: /Maya Reyes/ })).toHaveAttribute('aria-pressed', 'false');
    // Maya's column now carries the slot on the 11:00 row.
    expect(screen.getByLabelText('Maya Reyes is holding the loop slot at 11:00')).toBeInTheDocument();
    expect(screen.getByText('Values, 45 min · moved to 11:00')).toBeInTheDocument();
  });

  it('drops a picked-up round on Escape', async () => {
    renderScreen();
    await screen.findByText('Thursday, Aug 6');

    await tabTo(screen.getByRole('button', { name: /Sam Altmann/ }));
    await userEvent.keyboard('{Enter}');
    expect(onScreen(/Hiring manager picked up/)).toBeInTheDocument();

    await tabTo(tabbableCell());
    await userEvent.keyboard('{Escape}');

    expect(onScreen(/Hiring manager picked up/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sam Altmann/ })).toHaveAttribute('aria-pressed', 'false');
    expect(live()).toHaveTextContent('Nothing picked up.');
  });
});
