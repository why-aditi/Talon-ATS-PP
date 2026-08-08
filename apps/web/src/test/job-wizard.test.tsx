import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { JobWizard } from '../components/job-wizard';
import { initialState, kToCents, toCreateJobPayload, validateStep, type WizardState } from '../lib/job-wizard';
import { routerPush } from './setup';

const state = (over: Partial<WizardState> = {}): WizardState => ({ ...initialState, ...over });

/** Step 1 filled in with nothing that should fail. */
const validStep1 = (over: Partial<WizardState> = {}): WizardState =>
  state({ title: 'Senior Backend Engineer', department: 'Engineering', location: 'Remote (US)', ...over });

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`)).toEqual([]);
}

describe('k to cents', () => {
  /*
    Spec 005 §4.1 calls this the one piece of arithmetic in the feature, and it is
    off by five orders of magnitude if wrong. The wizard shows 180 meaning
    $180,000; the column is bigint cents.
  */
  it('converts thousands of major units to minor units', () => {
    expect(kToCents(180)).toBe(18_000_000n);
    expect(kToCents(220)).toBe(22_000_000n);
    expect(kToCents(1)).toBe(100_000n);
  });

  it('rounds a fractional k rather than throwing', () => {
    // BigInt(180.5 * 100_000) throws on a non-integer, and 180.5k is ordinary.
    expect(() => kToCents(180.5)).not.toThrow();
    expect(kToCents(180.5)).toBe(18_050_000n);
  });
});

describe('step 1 validation', () => {
  it('requires a title, a department and a location', () => {
    expect(validateStep(0, state())).toMatchObject({
      title: expect.any(String),
      department: expect.any(String),
      location: expect.any(String),
    });
    expect(validateStep(0, validStep1())).toEqual({});
  });

  it('takes the band as a pair or not at all', () => {
    expect(validateStep(0, validStep1({ bandMinK: '180' }))).toMatchObject({ bandMaxK: expect.any(String) });
    expect(validateStep(0, validStep1({ bandMaxK: '220' }))).toMatchObject({ bandMinK: expect.any(String) });
    // Neither is fine — a job need not have a band at all.
    expect(validateStep(0, validStep1())).toEqual({});
  });

  it('refuses a maximum below the minimum', () => {
    const errors = validateStep(0, validStep1({ bandMinK: '220', bandMaxK: '180', currency: 'USD' }));
    expect(errors.bandMaxK).toMatch(/at least the minimum/);
  });

  it('demands a currency once there is a band, and not before', () => {
    // #9: the currency is never guessed. But a currency with no band means
    // nothing, so it is not demanded until there is an amount for it to apply to.
    expect(validateStep(0, validStep1()).currency).toBeUndefined();
    expect(validateStep(0, validStep1({ bandMinK: '180', bandMaxK: '220' })).currency).toMatch(/currency/i);
    expect(validateStep(0, validStep1({ bandMinK: '180', bandMaxK: '220', currency: 'USD' }))).toEqual({});
  });

  it('rejects text in a band field', () => {
    expect(validateStep(0, validStep1({ bandMinK: 'lots' })).bandMinK).toMatch(/number/i);
  });

  it('accepts a department typed under Other', () => {
    const typed = state({ title: 'T', department: 'other', departmentOther: 'Customer Success', location: 'London' });
    expect(validateStep(0, typed)).toEqual({});
    expect(toCreateJobPayload(typed).department).toBe('Customer Success');
  });
});

describe('the payload', () => {
  it('sends cents as strings and never a bare number', () => {
    const payload = toCreateJobPayload(validStep1({ bandMinK: '180', bandMaxK: '220', currency: 'USD' }));
    // bigint has no JSON representation, and a number would reinstate the 2^53
    // class that #9 abolishes.
    expect(payload.bandMinCents).toBe('18000000');
    expect(payload.bandMaxCents).toBe('22000000');
    expect(payload.currency).toBe('USD');
    expect(JSON.parse(JSON.stringify(payload)).bandMinCents).toBe('18000000');
  });

  it('omits all three band keys when no band was entered', () => {
    const payload = toCreateJobPayload(validStep1());
    expect(payload).not.toHaveProperty('bandMinCents');
    expect(payload).not.toHaveProperty('currency');
  });

  it('always creates a draft', () => {
    expect(toCreateJobPayload(validStep1()).status).toBe('draft');
  });

  it('sends null rather than omitting an unassigned recruiter', () => {
    // The columns are nullable and the jobs list renders "Unassigned". Omitting
    // would read as "leave it alone", which is meaningless on a create.
    expect(toCreateJobPayload(validStep1()).recruiterId).toBeNull();
  });
});

describe('the wizard on screen', () => {
  it('opens on step 1 with Back unavailable', () => {
    render(<JobWizard />);
    expect(screen.getByRole('heading', { name: 'New job' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '← Back' })).toBeDisabled();
  });

  it('keeps the band and currency on one row, with currency unset', () => {
    render(<JobWizard />);
    expect(screen.getByLabelText('Band min (k)')).toBeInTheDocument();
    expect(screen.getByLabelText('Band max (k)')).toBeInTheDocument();
    // No default — #9. The placeholder is what "not chosen" looks like.
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveTextContent('Currency');
  });

  it('refuses to advance and moves focus to the first problem', async () => {
    const user = userEvent.setup();
    render(<JobWizard />);

    await user.click(screen.getByRole('button', { name: 'Continue →' }));

    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    expect(screen.getByText('Give the role a title.')).toBeInTheDocument();
    // Focus lands on what is wrong: otherwise the message is announced nowhere
    // and a keyboard user is left standing on the button.
    expect(document.activeElement).toBe(screen.getByLabelText('Job title'));
  });

  it('advances once step 1 is satisfied', async () => {
    const user = userEvent.setup();
    render(<JobWizard />);

    await user.type(screen.getByLabelText('Job title'), 'Senior Backend Engineer');
    await user.click(screen.getByRole('radio', { name: 'Engineering' }));
    await user.click(screen.getByRole('radio', { name: 'Remote (US)' }));
    await user.click(screen.getByRole('button', { name: 'Continue →' }));

    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
  });

  it('moves between chips with the arrow keys, as one tab stop', async () => {
    const user = userEvent.setup();
    render(<JobWizard />);
    const group = screen.getByRole('radiogroup', { name: 'Department' });

    await user.click(within(group).getByRole('radio', { name: 'Engineering' }));
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: 'Design' })).toHaveAttribute('aria-checked', 'true');

    // Wraps, so the last chip is one key from the first rather than four.
    await user.keyboard('{ArrowLeft}');
    expect(within(group).getByRole('radio', { name: 'Engineering' })).toHaveAttribute('aria-checked', 'true');
  });

  it('says the pipeline step has no data rather than inventing templates', async () => {
    const user = userEvent.setup();
    render(<JobWizard />);
    await user.type(screen.getByLabelText('Job title'), 'T');
    await user.click(screen.getByRole('radio', { name: 'Design' }));
    await user.click(screen.getByRole('radio', { name: 'London' }));
    await user.click(screen.getByRole('button', { name: 'Continue →' }));

    // A hardcoded list here would be data that looks like data and answers to
    // nothing — the mistake the sidebar counts made.
    expect(screen.getByText('No stage templates yet.')).toBeInTheDocument();
  });

  it('confirms before discarding typed answers', async () => {
    const user = userEvent.setup();
    render(<JobWizard />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(routerPush).toHaveBeenCalledWith('/jobs');

    await user.type(screen.getByLabelText('Job title'), 'Half a job');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Discard this job?');
  });

  it('has no axe violations', async () => {
    const { container } = render(<JobWizard />);
    await expectNoAxeViolations(container);
  });
});
