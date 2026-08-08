import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ImportScreen } from '../components/import-screen';
import { commitImport, dryRunImport, uploadAndAnalyze } from '../lib/import-query';

vi.mock('../lib/session', () => ({
  useSession: () => ({
    session: { accessToken: 'access-token', user: { id: 'user-1' } },
    ready: true,
  }),
}));

vi.mock('../lib/jobs-query', () => ({
  useJobs: () => ({
    data: {
      data: [{ id: '018f2c31-0000-7000-8000-000000000001', title: 'Engineer', reqCode: 'ENG-1' }],
    },
  }),
}));

vi.mock('../lib/import-query', () => ({
  uploadAndAnalyze: vi.fn(),
  dryRunImport: vi.fn(),
  commitImport: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(uploadAndAnalyze).mockResolvedValue({
    importId: '018f2c31-0000-7000-8000-000000000099',
    analysis: {
      delimiter: ',',
      encoding: 'utf-8',
      headers: ['Name', 'Email'],
      sampleRows: [['Ana', 'ana@example.test']],
      rowCount: 1,
      suggested: { Name: 'name', Email: 'email' },
    },
  });
  vi.mocked(dryRunImport).mockResolvedValue({
    total: 1,
    valid: 1,
    invalid: 0,
    issues: [],
    duplicates: [],
    errorCsvUrl: null,
  });
  vi.mocked(commitImport).mockResolvedValue({
    id: '018f2c31-0000-7000-8000-000000000099',
    kind: 'import',
    status: 'succeeded',
    total: 1,
    processed: 1,
    failed: 0,
    createdAt: '2026-08-08T12:00:00.000Z',
    finishedAt: '2026-08-08T12:00:01.000Z',
  });
});

it('takes a CSV through upload, mapping, dry run, and commit', async () => {
  const user = userEvent.setup();
  render(<ImportScreen />);

  await user.upload(
    screen.getByLabelText('Select CSV'),
    new File(['Name,Email\nAna,ana@example.test\n'], 'people.csv', { type: 'text/csv' }),
  );
  expect(await screen.findByRole('heading', { name: 'Map columns' })).toBeInTheDocument();
  expect(screen.getByLabelText('Map Name')).toHaveValue('name');

  await user.click(screen.getByRole('button', { name: 'Run dry run' }));
  expect(await screen.findByRole('heading', { name: 'Dry-run results' })).toBeInTheDocument();
  expect(screen.getByText('Every row passed validation.')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Import 1 candidate' }));
  expect(await screen.findByRole('heading', { name: 'Import complete' })).toBeInTheDocument();
  expect(screen.getByText('1 created · 0 failed')).toBeInTheDocument();
  expect(uploadAndAnalyze).toHaveBeenCalledOnce();
  expect(dryRunImport).toHaveBeenCalledOnce();
  expect(commitImport).toHaveBeenCalledOnce();
});

it('requires a name mapping before dry run', async () => {
  render(<ImportScreen />);
  fireEvent.change(screen.getByLabelText('Select CSV'), {
    target: { files: [new File(['Name\nAna'], 'people.csv', { type: 'text/csv' })] },
  });
  await screen.findByRole('heading', { name: 'Map columns' });
  fireEvent.change(screen.getByLabelText('Map Name'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Run dry run' })).toBeDisabled();
  await waitFor(() => expect(screen.getByText(/Map at least one column/)).toBeInTheDocument());
});
