import { type Job } from '@talon/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';
import { EditJobModal } from '../components/edit-job-modal';
import { SessionProvider } from '../lib/session';
import { json, route } from './fetch-stub';
import { SEEDED_JOBS } from './seeded-jobs';

/*
  Spec 005 §7. What matters here is not that a field edits — it is that the
  patch carries ONLY what changed, because that is what makes the API's
  absent-means-untouched rule true end to end.
*/

const SESSION = {
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

/** ENG-204 — the seeded job that has a band. */
const BANDED = SEEDED_JOBS.find((j) => j.reqCode === 'ENG-204') as Job;

/** Captures the PATCH body so the assertions can be about what was sent. */
function stubPatch(response: () => Response) {
  const sent: Record<string, unknown>[] = [];
  route((url, init) => {
    if (!url.pathname.startsWith('/v1/jobs/') || (init?.method ?? 'GET') !== 'PATCH') return undefined;
    sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    return response();
  });
  return sent;
}

function renderModal(job: Job = BANDED, canReadComp = true, onClose = vi.fn()) {
  route((url) => (url.pathname === '/api/auth/refresh' ? json(SESSION) : undefined));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <EditJobModal job={job} canReadComp={canReadComp} onClose={onClose} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { ...result, onClose };
}

const save = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Save changes' }));

describe('the patch it sends', () => {
  it('carries only the field that changed, plus the version', async () => {
    const user = userEvent.setup();
    const sent = stubPatch(() => json({ ...BANDED, title: 'Staff Engineer', version: BANDED.version + 1 }));
    renderModal();

    await user.clear(screen.getByLabelText('Job title'));
    await user.type(screen.getByLabelText('Job title'), 'Staff Engineer');
    await save(user);

    await waitFor(() => expect(sent).toHaveLength(1));
    // Department, location, status and the band are all absent — untouched
    // fields are never sent, so they cannot be overwritten.
    expect(sent[0]).toEqual({ title: 'Staff Engineer', version: BANDED.version });
  });

  it('never sends a band key without comp:read, even when the job has one', async () => {
    const user = userEvent.setup();
    const sent = stubPatch(() => json({ ...BANDED, version: BANDED.version + 1 }));
    renderModal(BANDED, false);

    // The fields are absent entirely, not disabled: a disabled band field would
    // tell someone a band exists and they may not touch it (#2).
    expect(screen.queryByLabelText('Band min (k)')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Job title'));
    await user.type(screen.getByLabelText('Job title'), 'Renamed');
    await save(user);

    await waitFor(() => expect(sent).toHaveLength(1));
    // This is the silent-wipe guard on the client side. The API refuses a band
    // from this caller too, but the request should never make it try.
    expect(Object.keys(sent[0]!)).toEqual(['version', 'title']);
  });

  it('clears a band as three explicit nulls', async () => {
    const user = userEvent.setup();
    const sent = stubPatch(() => json({ ...BANDED, band: undefined, version: BANDED.version + 1 }));
    renderModal();

    await user.clear(screen.getByLabelText('Band min (k)'));
    await user.clear(screen.getByLabelText('Band max (k)'));
    await save(user);

    await waitFor(() => expect(sent).toHaveLength(1));
    // All three: a currency left behind on a job with no amounts is a row that
    // lies about itself.
    expect(sent[0]).toMatchObject({ bandMinCents: null, bandMaxCents: null, currency: null });
  });

  it('converts k back to cents on the way out', async () => {
    const user = userEvent.setup();
    const sent = stubPatch(() => json({ ...BANDED, version: BANDED.version + 1 }));
    renderModal();

    await user.clear(screen.getByLabelText('Band min (k)'));
    await user.type(screen.getByLabelText('Band min (k)'), '200');
    await save(user);

    await waitFor(() => expect(sent).toHaveLength(1));
    // 200k is 20,000,000 cents. The ×100_000 is the one piece of arithmetic in
    // this feature and it is off by five orders of magnitude if wrong.
    expect(sent[0]!['bandMinCents']).toBe('20000000');
  });
});

describe('validation before it asks the server', () => {
  it('refuses half a band and does not send anything', async () => {
    const user = userEvent.setup();
    const sent = stubPatch(() => json({}));
    renderModal();

    await user.clear(screen.getByLabelText('Band max (k)'));
    await save(user);

    expect(screen.getByText(/needs both a minimum and a maximum/)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });
});

describe('when somebody else got there first', () => {
  it('offers reload or overwrite rather than choosing for the user', async () => {
    const user = userEvent.setup();
    const theirs = { ...BANDED, title: 'Renamed by a colleague', version: BANDED.version + 1 };
    stubPatch(() =>
      json(
        {
          type: 'urn:talon:error:job-version-conflict',
          title: 'changed',
          status: 409,
          detail: 'Someone else edited this job.',
          current: theirs,
        },
        409,
      ),
    );
    const { onClose } = renderModal();

    await user.clear(screen.getByLabelText('Job title'));
    await user.type(screen.getByLabelText('Job title'), 'Mine');
    await save(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Someone else changed this job.');
    // Names what changed: "somebody edited this" with no indication of WHAT
    // forces the user to discard their edit blind.
    expect(alert).toHaveTextContent('Renamed by a colleague');
    expect(screen.getByRole('button', { name: 'Reload theirs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeInTheDocument();
    // Nothing applied silently, either way — #14's rule on a form.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Job title')).toHaveValue('Mine');
  });

  it('retries against their version when told to overwrite', async () => {
    const user = userEvent.setup();
    const theirs = { ...BANDED, title: 'Theirs', version: BANDED.version + 5 };
    let call = 0;
    const sent: Record<string, unknown>[] = [];
    route((url, init) => {
      if (!url.pathname.startsWith('/v1/jobs/') || (init?.method ?? 'GET') !== 'PATCH') return undefined;
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      call += 1;
      return call === 1
        ? json({ type: 'urn:talon:error:job-version-conflict', title: 'c', status: 409, detail: 'd', current: theirs }, 409)
        : json({ ...theirs, title: 'Mine', version: theirs.version + 1 });
    });
    renderModal();

    await user.clear(screen.getByLabelText('Job title'));
    await user.type(screen.getByLabelText('Job title'), 'Mine');
    await save(user);
    await screen.findByRole('button', { name: 'Overwrite' });
    await user.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    // Against THEIR version, or the second attempt 409s exactly as the first did.
    expect(sent[1]!['version']).toBe(theirs.version);
  });
});

it('has no axe violations', async () => {
  const { container } = renderModal();
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
