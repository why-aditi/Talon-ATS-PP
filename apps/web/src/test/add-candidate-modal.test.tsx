import { type Board } from '@talon/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { AddCandidateModal } from '../components/add-candidate-modal';
import { SessionProvider } from '../lib/session';
import { json, route } from './fetch-stub';
import { eng204Board } from './pipeline-fixtures';

/* Spec 005 §8. What matters is the body it sends and the states it refuses. */

const session = (role: string) => ({
  accessToken: 'test-access-token',
  expiresIn: 3600,
  user: {
    id: '0198f3a1-0007-7000-8000-000000000001',
    tenantId: '0198f3a1-0000-7000-8000-000000000001',
    email: 'maya@taloninc.com',
    name: 'Maya Reyes',
    role,
    timezone: 'America/Los_Angeles',
  },
});

const COLUMNS = eng204Board().columns as Board['columns'];

/** Captures the POST body so assertions can be about what was actually sent. */
function stubPost(response: () => Response) {
  const sent: Record<string, unknown>[] = [];
  route((url, init) => {
    if (url.pathname !== '/v1/applications' || (init?.method ?? 'GET') !== 'POST') return undefined;
    sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    return response();
  });
  return sent;
}

const created = () => {
  const card = COLUMNS[0]!.cards[0]!;
  return json({ application: card, stageId: COLUMNS[0]!.stageId }, 201);
};

function renderModal(role = 'recruiter', onClose = vi.fn()) {
  route((url) => (url.pathname === '/api/auth/refresh' ? json(session(role)) : undefined));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <AddCandidateModal jobId="019fde7d-af70-7810-93af-b10e6d8f1a3b" columns={COLUMNS} onClose={onClose} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { ...result, onClose };
}

const add = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Add candidate' }));

describe('the body it sends', () => {
  it('sends a name, a source and a stage, and omits what was left blank', async () => {
    const user = userEvent.setup();
    const sent = stubPost(created);
    renderModal();

    await user.type(screen.getByLabelText('Name'), 'Priya Raman');
    await add(user);

    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0]!;
    expect(body['candidate']).toEqual({ name: 'Priya Raman' });
    // Empty strings are not addresses. `candidates.email` is nullable, so an
    // untouched field is omitted rather than sent as ''.
    expect(body['source']).toBe('outbound');
    expect(body['stageId']).toBe(COLUMNS[0]!.stageId);
  });

  it('carries the optional fields that were filled in', async () => {
    const user = userEvent.setup();
    const sent = stubPost(created);
    renderModal();

    await user.type(screen.getByLabelText('Name'), 'Priya Raman');
    await user.type(screen.getByLabelText('Email'), 'priya@example.test');
    await user.type(screen.getByLabelText('Current title'), 'Staff Engineer');
    await add(user);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!['candidate']).toEqual({
      name: 'Priya Raman',
      email: 'priya@example.test',
      currentTitle: 'Staff Engineer',
    });
  });

  it('converts a comp expectation from k to cents', async () => {
    const user = userEvent.setup();
    const sent = stubPost(created);
    renderModal();

    await user.type(screen.getByLabelText('Name'), 'Priya Raman');
    await user.type(screen.getByLabelText('Expects min (k)'), '150');
    await user.type(screen.getByLabelText('Expects max (k)'), '180');
    await user.click(screen.getByRole('combobox', { name: 'Expectation currency' }));
    await user.click(await screen.findByRole('option', { name: 'USD' }));
    await add(user);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!['compExpectationMinCents']).toBe('15000000');
    expect(sent[0]!['compExpectationCurrency']).toBe('USD');
  });
});

describe('the comp gate', () => {
  it('hides the expectation fields entirely from a member', () => {
    renderModal('member');
    // Absent, not disabled: a disabled field tells someone the data exists and
    // they may not have it, which is what the scope withholds (#2).
    expect(screen.queryByLabelText('Expects min (k)')).not.toBeInTheDocument();
  });

  it('never sends an expectation key without comp:read', async () => {
    const user = userEvent.setup();
    const sent = stubPost(created);
    renderModal('member');

    await user.type(screen.getByLabelText('Name'), 'Priya Raman');
    await add(user);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(Object.keys(sent[0]!).some((k) => k.startsWith('compExpectation'))).toBe(false);
  });
});

describe('refusals', () => {
  it('will not submit without a name, and says so', async () => {
    const user = userEvent.setup();
    const sent = stubPost(created);
    renderModal();

    await add(user);

    expect(screen.getByText('A name is the one thing this needs.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('reports an already-applied candidate as itself, not as a generic failure', async () => {
    const user = userEvent.setup();
    stubPost(() =>
      json({ type: 'urn:talon:error:already-applied', title: 'Already applied', status: 409 }, 409),
    );
    const { onClose } = renderModal();

    await user.type(screen.getByLabelText('Name'), 'Priya Raman');
    await add(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('already has an application on this job');
    // The form survives: a failed add must not cost someone what they typed.
    expect(screen.getByLabelText('Name')).toHaveValue('Priya Raman');
    expect(onClose).not.toHaveBeenCalled();
  });
});

it('says resumes are not attachable rather than leaving the control missing', () => {
  renderModal();
  // Someone looking for the upload should learn it is not built, not conclude
  // they missed it.
  expect(screen.getByText(/Resumes can’t be attached yet/)).toBeInTheDocument();
});

it('offers only non-terminal stages — rejected is an outcome, not a start', () => {
  renderModal();
  const terminal = COLUMNS.filter((c) => c.isTerminal).map((c) => c.name);
  for (const name of terminal) expect(screen.queryByText(name)).not.toBeInTheDocument();
});

it('has no axe violations', async () => {
  const { container } = renderModal();
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
