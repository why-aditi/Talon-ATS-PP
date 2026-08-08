'use client';

import { ERROR_TYPES, SourceSchema, type Board } from '@talon/contracts';
import { hasScope } from '@talon/domain';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { CURRENCIES, kToCents } from '../lib/job-wizard';
import { createApplication, JobWriteError } from '../lib/job-wizard-query';
import { SOURCE_LABELS } from '../lib/labels';
import { useSession } from '../lib/session';
import { Button, Select, cx } from './ui';

/*
  Spec 005 §8. The board's "+ Add candidate".

  Resumes are NOT here, and their absence is the point rather than an omission:
  §5 needs a quarantine bucket, a virus scanner and a separate download
  subdomain (#17), none of which exist. An upload control that stored an
  unscanned, attacker-controlled file next to every candidate in the tenant is
  the one shortcut this screen must not take.
*/

const FIELD =
  'h-[var(--control-height-md)] w-full rounded-md border bg-bg-surface px-3 text-body text-text-primary placeholder:text-text-placeholder focus:border-border-focus';

const fieldClass = (invalid: boolean) => cx(FIELD, invalid ? 'border-border-danger' : 'border-border-default');

const SOURCE_OPTIONS = SourceSchema.options.map((value) => ({ value, label: SOURCE_LABELS[value] }));

/** Every failure the endpoint can answer with, as the person adding should read it. */
const FAILURES: Record<string, string> = {
  [ERROR_TYPES.ALREADY_APPLIED]: 'This candidate already has an application on this job.',
  [ERROR_TYPES.FORBIDDEN]: 'You don’t have permission to record a compensation expectation.',
  [ERROR_TYPES.NOT_FOUND]: 'That stage is no longer on this job. Close and reopen the board.',
  [ERROR_TYPES.VALIDATION_FAILED]: 'Something here isn’t valid — check the fields above.',
  'urn:talon:client:network': 'We couldn’t reach the server. Your answers are still here.',
};
const FALLBACK = 'The candidate couldn’t be added. Your answers are still here — try again.';

export function AddCandidateModal({
  jobId,
  columns,
  onClose,
}: {
  jobId: string;
  /** The board's own columns, so the stage picker cannot offer one that is not there. */
  columns: Board['columns'];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const { session } = useSession();
  const canReadComp = session ? hasScope(session.user.role, 'comp:read') : false;
  const uid = useId();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currentTitle, setCurrentTitle] = useState('');
  const [currentCompany, setCurrentCompany] = useState('');
  const [source, setSource] = useState<string>('outbound');
  // The first non-terminal column: where an application actually starts.
  const [stageId, setStageId] = useState(columns.find((c) => !c.isTerminal)?.stageId ?? '');
  const [expectMinK, setExpectMinK] = useState('');
  const [expectMaxK, setExpectMaxK] = useState('');
  const [currency, setCurrency] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const nameInvalid = name.trim() === '';
  const expectTouched = expectMinK.trim() !== '' || expectMaxK.trim() !== '';
  const expectInvalid = canReadComp && expectTouched && (expectMinK.trim() === '' || expectMaxK.trim() === '');
  const currencyInvalid = canReadComp && expectTouched && currency === '';
  const invalid = nameInvalid || expectInvalid || currencyInvalid;

  async function onAdd() {
    if (invalid) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createApplication(
        {
          jobId,
          candidate: {
            name: name.trim(),
            // Omitted rather than sent empty: `candidates.email` is nullable and
            // an empty string is not an address.
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(currentTitle.trim() ? { currentTitle: currentTitle.trim() } : {}),
            ...(currentCompany.trim() ? { currentCompany: currentCompany.trim() } : {}),
          },
          source,
          stageId,
          ...(canReadComp && expectTouched
            ? {
                compExpectationMinCents: kToCents(Number(expectMinK)).toString(),
                compExpectationMaxCents: kToCents(Number(expectMaxK)).toString(),
                compExpectationCurrency: currency,
              }
            : {}),
        },
        session?.accessToken,
      );
      // The board recomputes counts, medians and the distribution from its own
      // query — inserting the card by hand here would leave those stale.
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      onClose();
      return created;
    } catch (caught) {
      setError(caught instanceof JobWriteError ? (FAILURES[caught.type] ?? FALLBACK) : FALLBACK);
      // Nothing cleared: a failed add must not cost someone the form they filled.
      setSaving(false);
      return undefined;
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${uid}-title`}
      onCancel={onClose}
      onClose={onClose}
      className="m-auto w-full max-w-2xl rounded-lg border border-border-default bg-bg-surface p-0 text-text-primary shadow-lg backdrop:bg-bg-overlay"
    >
      <div className="border-b border-border-subtle p-6">
        <h2 id={`${uid}-title`} className="font-display text-section-title">
          Add candidate
        </h2>
      </div>

      <div className="max-h-[var(--layout-modal-max-height)] overflow-y-auto p-6">
        <label htmlFor={`${uid}-n`} className="block text-body-strong">
          Name
        </label>
        <input
          id={`${uid}-n`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Priya Raman"
          className={cx(fieldClass(showErrors && nameInvalid), 'mt-2')}
          {...(showErrors && nameInvalid ? { 'aria-invalid': true } : {})}
        />
        {showErrors && nameInvalid ? (
          <p className="mt-1 text-meta text-feedback-danger-fg">A name is the one thing this needs.</p>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-5">
          <div>
            <label htmlFor={`${uid}-e`} className="block text-body-strong">
              Email
            </label>
            <input
              id={`${uid}-e`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={cx(fieldClass(false), 'mt-2')}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-t`} className="block text-body-strong">
              Current title
            </label>
            <input
              id={`${uid}-t`}
              value={currentTitle}
              onChange={(e) => setCurrentTitle(e.target.value)}
              className={cx(fieldClass(false), 'mt-2')}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-5">
          <div>
            <label htmlFor={`${uid}-c`} className="block text-body-strong">
              Current company
            </label>
            <input
              id={`${uid}-c`}
              value={currentCompany}
              onChange={(e) => setCurrentCompany(e.target.value)}
              className={cx(fieldClass(false), 'mt-2')}
            />
          </div>
          <div>
            <span className="block text-body-strong">Source</span>
            <div className="mt-2">
              <Select
                ariaLabel="Source"
                value={source}
                onValueChange={setSource}
                options={SOURCE_OPTIONS}
                className="w-full"
              />
            </div>
          </div>
        </div>

        <div className="mt-4">
          <span className="block text-body-strong">Stage</span>
          <div className="mt-2">
            {/* Only the board's own non-terminal columns. Rejected and withdrawn
                are outcomes reached by rejecting, not places to start. */}
            <Select
              ariaLabel="Stage"
              value={stageId}
              onValueChange={setStageId}
              options={columns
                .filter((c) => !c.isTerminal)
                .map((c) => ({ value: c.stageId, label: c.name }))}
              className="w-full"
            />
          </div>
        </div>

        {canReadComp ? (
          <div className="mt-4 grid grid-cols-[1fr_1fr_var(--layout-wizard-currency-width)] gap-5">
            <div>
              <label htmlFor={`${uid}-emin`} className="block text-body-strong">
                Expects min (k)
              </label>
              <input
                id={`${uid}-emin`}
                inputMode="decimal"
                value={expectMinK}
                onChange={(e) => setExpectMinK(e.target.value)}
                className={cx(fieldClass(showErrors && expectInvalid), 'mt-2 tabular-nums')}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-emax`} className="block text-body-strong">
                Expects max (k)
              </label>
              <input
                id={`${uid}-emax`}
                inputMode="decimal"
                value={expectMaxK}
                onChange={(e) => setExpectMaxK(e.target.value)}
                className={cx(fieldClass(showErrors && expectInvalid), 'mt-2 tabular-nums')}
              />
            </div>
            <div>
              <span className="block text-body-strong">Currency</span>
              <div className="mt-2">
                <Select
                  ariaLabel="Expectation currency"
                  placeholder="Currency"
                  value={currency}
                  onValueChange={setCurrency}
                  options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                  invalid={showErrors && currencyInvalid}
                  className="w-full"
                />
              </div>
            </div>
          </div>
        ) : null}

        {showErrors && (expectInvalid || currencyInvalid) ? (
          <p className="mt-2 text-meta text-feedback-danger-fg">
            {expectInvalid ? 'An expectation needs both a minimum and a maximum.' : 'Choose a currency.'}
          </p>
        ) : null}

        {/* Said out loud rather than left as a missing control: someone looking
            for the upload should learn it is not built, not conclude they missed it. */}
        <p className="mt-4 text-meta text-text-tertiary">
          Resumes can’t be attached yet — file scanning isn’t built (spec 005 §5).
        </p>
      </div>

      <div className="border-t border-border-subtle p-6">
        {error ? (
          <p role="alert" className="mb-3 text-body text-feedback-danger-fg">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onAdd()} disabled={saving}>
            {saving ? 'Adding…' : 'Add candidate'}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
