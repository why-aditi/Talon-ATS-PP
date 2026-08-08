'use client';

import {
  ImportFieldSchema,
  ImportMappingSchema,
  type AsyncJob,
  type DryRunReport,
  type ImportAnalysis,
  type ImportField,
} from '@talon/contracts';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { commitImport, dryRunImport, uploadAndAnalyze } from '../lib/import-query';
import { useJobs } from '../lib/jobs-query';
import { useSession } from '../lib/session';
import { Button, cx } from './ui';

const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Candidate name',
  email: 'Email',
  phone: 'Phone',
  location: 'Location',
  current_title: 'Current title',
  current_company: 'Current company',
  source: 'Source',
  job_ref: 'Job reference',
};

type Step = 'upload' | 'mapping' | 'review' | 'complete';

export function ImportScreen() {
  const { session } = useSession();
  const jobs = useJobs({});
  const [step, setStep] = useState<Step>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [columns, setColumns] = useState<Record<string, ImportField>>({});
  const [defaultJobId, setDefaultJobId] = useState<string | null>(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState<'skip' | 'update' | 'create'>('skip');
  const [report, setReport] = useState<DryRunReport | null>(null);
  const [job, setJob] = useState<AsyncJob | null>(null);

  const mapping = useMemo(
    () => ImportMappingSchema.safeParse({ columns, defaultJobId, duplicateStrategy }),
    [columns, defaultJobId, duplicateStrategy],
  );

  async function start(file: File) {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadAndAnalyze(file, session.accessToken);
      setImportId(result.importId);
      setAnalysis(result.analysis);
      const suggested: Record<string, ImportField> = {};
      for (const [header, field] of Object.entries(result.analysis.suggested)) {
        const parsed = ImportFieldSchema.safeParse(field);
        if (parsed.success) suggested[header] = parsed.data;
      }
      setColumns(suggested);
      setStep('mapping');
    } catch {
      setError('The file could not be uploaded or analyzed. Check that it is a CSV and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    if (!session || !importId || !mapping.success) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await dryRunImport(importId, mapping.data, session.accessToken));
      setStep('review');
    } catch {
      setError('The dry run failed. Review the mapping and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!session || !importId || !mapping.success) return;
    setBusy(true);
    setError(null);
    try {
      setJob(await commitImport(importId, mapping.data, session.accessToken));
      setStep('complete');
    } catch {
      setError(
        'The import did not complete. You can safely retry; completed rows will not be duplicated.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <p className="text-meta text-text-tertiary">Candidates / Import</p>
        <h1 className="text-page-title text-text-primary">Import candidates</h1>
        <p className="mt-1 text-body text-text-secondary">
          Upload a CSV, confirm its columns, and review every row before anything is created.
        </p>
      </div>

      <ol aria-label="Import progress" className="grid grid-cols-4 gap-2 text-caption">
        {(['Upload', 'Map columns', 'Dry run', 'Complete'] as const).map((label, index) => {
          const active = ['upload', 'mapping', 'review', 'complete'].indexOf(step) >= index;
          return (
            <li
              key={label}
              className={cx(
                'rounded-md border px-3 py-2',
                active
                  ? 'border-border-strong bg-bg-selected text-text-link'
                  : 'border-border-subtle text-text-tertiary',
              )}
            >
              {index + 1}. {label}
            </li>
          );
        })}
      </ol>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-border-danger bg-feedback-danger-bg p-4 text-body text-text-danger"
        >
          {error}
        </div>
      ) : null}

      {step === 'upload' ? (
        <section className="rounded-lg border border-dashed border-border-strong bg-bg-surface p-10 text-center">
          <h2 className="text-section-title text-text-primary">Choose a CSV file</h2>
          <p className="mt-2 text-body text-text-secondary">
            UTF-8, UTF-8 with BOM, or Latin-1. Maximum 50 MB.
          </p>
          <label className="mt-5 inline-flex cursor-pointer">
            <span className="inline-flex h-[var(--control-height-lg)] items-center rounded-md bg-action-primary-bg px-4 text-body-strong text-text-on-primary">
              {busy ? 'Uploading…' : 'Select CSV'}
            </span>
            <input
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void start(file);
              }}
            />
          </label>
        </section>
      ) : null}

      {step === 'mapping' && analysis ? (
        <section className="rounded-lg border border-border-subtle bg-bg-surface p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-section-title text-text-primary">Map columns</h2>
              <p className="text-body text-text-secondary">
                {analysis.rowCount} rows · {analysis.encoding} ·{' '}
                {analysis.delimiter === '\t' ? 'tab' : analysis.delimiter} separated
              </p>
            </div>
          </div>
          <div className="mt-5 grid gap-3">
            {analysis.headers.map((header) => (
              <label
                key={header}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-4"
              >
                <span className="truncate text-body-strong text-text-primary">{header}</span>
                <select
                  aria-label={`Map ${header}`}
                  value={columns[header] ?? ''}
                  onChange={(event) =>
                    setColumns((current) => {
                      const next = { ...current };
                      const parsed = ImportFieldSchema.safeParse(event.target.value);
                      if (parsed.success) next[header] = parsed.data;
                      else delete next[header];
                      return next;
                    })
                  }
                  className="h-[var(--control-height-md)] rounded-md border border-border-default bg-bg-surface px-3 text-body text-text-primary"
                >
                  <option value="">Ignore this column</option>
                  {ImportFieldSchema.options.map((field) => (
                    <option key={field} value={field}>
                      {FIELD_LABELS[field]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4 border-t border-border-subtle pt-5">
            <label className="text-body-strong text-text-primary">
              Default job
              <select
                value={defaultJobId ?? ''}
                onChange={(event) => setDefaultJobId(event.target.value || null)}
                className="mt-2 block h-[var(--control-height-md)] w-full rounded-md border border-border-default bg-bg-surface px-3 text-body font-normal"
              >
                <option value="">Use the job reference column</option>
                {jobs.data?.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {item.reqCode}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-body-strong text-text-primary">
              Duplicates
              <select
                value={duplicateStrategy}
                onChange={(event) =>
                  setDuplicateStrategy(event.target.value as 'skip' | 'update' | 'create')
                }
                className="mt-2 block h-[var(--control-height-md)] w-full rounded-md border border-border-default bg-bg-surface px-3 text-body font-normal"
              >
                <option value="skip">Skip existing candidates</option>
                <option value="update">Use existing candidate</option>
                <option value="create">Create another candidate</option>
              </select>
            </label>
          </div>
          {!mapping.success ? (
            <p className="mt-3 text-body text-text-danger">
              Map at least one column to Candidate name.
            </p>
          ) : null}
          <div className="mt-6 flex justify-end">
            <Button
              variant="primary"
              disabled={busy || !mapping.success}
              onClick={() => void validate()}
            >
              {busy ? 'Checking…' : 'Run dry run'}
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'review' && report ? (
        <section className="rounded-lg border border-border-subtle bg-bg-surface p-6">
          <h2 className="text-section-title text-text-primary">Dry-run results</h2>
          <dl className="mt-4 grid grid-cols-4 gap-3">
            <Result label="Total" value={report.total} />
            <Result label="Ready" value={report.valid} />
            <Result label="Invalid" value={report.invalid} />
            <Result label="Possible duplicates" value={report.duplicates.length} />
          </dl>
          {report.issues.length ? (
            <ul className="mt-5 max-h-[var(--layout-modal-max-height)] overflow-y-auto rounded-md bg-feedback-warning-bg p-4 text-body text-text-primary">
              {report.issues.slice(0, 100).map((issue) => (
                <li key={`${issue.rowIndex}-${issue.message}`}>
                  Row {issue.rowIndex + 2}: {issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-5 text-body text-text-secondary">Every row passed validation.</p>
          )}
          {report.errorCsvUrl ? (
            <a
              className="mt-4 inline-block text-body-strong text-text-link underline"
              href={report.errorCsvUrl}
            >
              Download rows that need fixing
            </a>
          ) : null}
          <div className="mt-6 flex justify-between">
            <Button onClick={() => setStep('mapping')}>Back to mapping</Button>
            <Button
              variant="primary"
              disabled={busy || report.valid === 0}
              onClick={() => void commit()}
            >
              {busy
                ? 'Importing…'
                : `Import ${report.valid} candidate${report.valid === 1 ? '' : 's'}`}
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'complete' && job ? (
        <section className="rounded-lg border border-border-subtle bg-bg-surface p-8 text-center">
          <h2 className="text-section-title text-text-primary">
            Import {job.status === 'succeeded' ? 'complete' : 'finished with issues'}
          </h2>
          <p className="mt-2 text-body text-text-secondary">
            {job.processed} created · {job.failed} failed
          </p>
          <Link
            href="/candidates"
            className="mt-5 inline-flex h-[var(--control-height-md)] items-center rounded-md bg-action-primary-bg px-4 text-body-strong text-text-on-primary"
          >
            View candidates
          </Link>
        </section>
      ) : null}
    </div>
  );
}

function Result({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-bg-surface-sunken p-4">
      <dt className="text-caption text-text-tertiary">{label}</dt>
      <dd className="mt-1 text-section-title text-text-primary tabular-nums">{value}</dd>
    </div>
  );
}
