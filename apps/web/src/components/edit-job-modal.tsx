'use client';

import { ERROR_TYPES, JobStatusSchema, type Job } from '@talon/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { CURRENCIES, centsToK, kToCents } from '../lib/job-wizard';
import { JobWriteError, updateJob } from '../lib/job-wizard-query';
import { useSession } from '../lib/session';
import { Button, Select, cx } from './ui';

/*
  Spec 005 §7. A modal on the board rather than a route: this is a small
  correction to an object already on screen, and navigating away would throw
  the board's state away to change a title.

  It edits what the wizard's step 1 and step 3 collect, plus status. Not here:
  the stages (changing a pipeline moves live applications and is its own spec)
  and the req code, which is on offer letters and in people's inboxes.
*/

const FIELD =
  'h-[var(--control-height-md)] w-full rounded-md border bg-bg-surface px-3 text-body text-text-primary placeholder:text-text-placeholder focus:border-border-focus';

const fieldClass = (invalid: boolean) => cx(FIELD, invalid ? 'border-border-danger' : 'border-border-default');

const STATUS_OPTIONS = JobStatusSchema.options.map((value) => ({
  value,
  label: value === 'on_hold' ? 'On hold' : value.charAt(0).toUpperCase() + value.slice(1),
}));

/** Every failure this endpoint can answer with, as the editor should read it. */
const FAILURES: Record<string, string> = {
  [ERROR_TYPES.FORBIDDEN]: 'You don’t have permission to change the compensation band.',
  [ERROR_TYPES.NOT_FOUND]: 'This job no longer exists.',
  [ERROR_TYPES.VALIDATION_FAILED]: 'Something here isn’t valid — check the fields above.',
  'urn:talon:client:network': 'We couldn’t reach the server. Your changes are still here.',
};
const FALLBACK = 'The job couldn’t be saved. Your changes are still here — try again.';

export function EditJobModal({
  job,
  canReadComp,
  onClose,
}: {
  job: Job;
  /** Drives whether the band section exists at all — §7, and non-negotiable #2. */
  canReadComp: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const { session } = useSession();
  const uid = useId();

  const [title, setTitle] = useState(job.title);
  const [department, setDepartment] = useState(job.department);
  const [location, setLocation] = useState(job.location);
  const [status, setStatus] = useState(job.status);
  // Shown in thousands, stored in cents. The conversion is the wizard's, not a
  // second copy — spec 005 §4.1 is explicit that two copies disagree by 10^5.
  const [bandMinK, setBandMinK] = useState(job.band ? String(centsToK(BigInt(job.band.minCents))) : '');
  const [bandMaxK, setBandMaxK] = useState(job.band ? String(centsToK(BigInt(job.band.maxCents))) : '');
  const [currency, setCurrency] = useState(job.band?.currency ?? '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the server says somebody else got there first (§7, 409). */
  const [conflict, setConflict] = useState<Job | null>(null);

  // showModal, not the `open` attribute: it is what gives the dialog a top layer,
  // a focus trap and Esc for free rather than reimplementing three of them.
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  /**
   * Only what actually changed.
   *
   * This is what makes the API's absent-means-untouched rule work end to end: a
   * field nobody edited is never sent, so it cannot be overwritten — and the
   * band keys are absent entirely without `comp:read`, so an editor who cannot
   * see a band cannot destroy one (§4.3).
   */
  function buildPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = { version: job.version };
    if (title.trim() !== job.title) patch['title'] = title.trim();
    if (department.trim() !== job.department) patch['department'] = department.trim();
    if (location.trim() !== job.location) patch['location'] = location.trim();
    if (status !== job.status) patch['status'] = status;

    if (!canReadComp) return patch;

    const cleared = bandMinK.trim() === '' && bandMaxK.trim() === '';
    if (cleared) {
      // Explicit nulls, all three: clearing is a deliberate act, and a currency
      // left behind on a job with no amounts is a row that lies about itself.
      if (job.band) {
        patch['bandMinCents'] = null;
        patch['bandMaxCents'] = null;
        patch['currency'] = null;
      }
      return patch;
    }

    const minCents = kToCents(Number(bandMinK)).toString();
    const maxCents = kToCents(Number(bandMaxK)).toString();
    if (minCents !== job.band?.minCents) patch['bandMinCents'] = minCents;
    if (maxCents !== job.band?.maxCents) patch['bandMaxCents'] = maxCents;
    if (currency !== (job.band?.currency ?? '')) patch['currency'] = currency;
    // A band being introduced needs its currency sent even when it matches the
    // empty default, or the API refuses cents with no currency.
    if (!job.band) patch['currency'] = currency;
    return patch;
  }

  const bandTouched = bandMinK.trim() !== '' || bandMaxK.trim() !== '';
  const bandInvalid = canReadComp && bandTouched && (bandMinK.trim() === '' || bandMaxK.trim() === '');
  const currencyInvalid = canReadComp && bandTouched && currency === '';

  async function onSave() {
    if (bandInvalid || currencyInvalid) return;
    setSaving(true);
    setError(null);
    setConflict(null);
    try {
      await updateJob(job.id, buildPatch(), session?.accessToken);
      // The board header, the jobs list and the sidebar badge all read this.
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      await queryClient.invalidateQueries({ queryKey: ['board'] });
      onClose();
    } catch (caught) {
      if (caught instanceof JobWriteError && caught.status === 409 && caught.current) {
        // Never applied silently either way — #14's rule, on a form instead of a
        // drag. The user chooses; the client does not choose for them.
        setConflict(caught.current);
      } else {
        setError(caught instanceof JobWriteError ? (FAILURES[caught.type] ?? FALLBACK) : FALLBACK);
      }
      setSaving(false);
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
      <div className="flex items-baseline gap-3 border-b border-border-subtle p-6">
        <h2 id={`${uid}-title`} className="flex-1 font-display text-section-title">
          Edit job
        </h2>
        <span className="font-mono text-code text-text-tertiary">{job.reqCode}</span>
      </div>

      <div className="max-h-[var(--layout-modal-max-height)] overflow-y-auto p-6">
        <label htmlFor={`${uid}-t`} className="block text-body-strong">
          Job title
        </label>
        <input id={`${uid}-t`} value={title} onChange={(e) => setTitle(e.target.value)} className={cx(fieldClass(false), 'mt-2')} />

        <div className="mt-4 grid grid-cols-2 gap-5">
          <div>
            <label htmlFor={`${uid}-d`} className="block text-body-strong">
              Department
            </label>
            <input id={`${uid}-d`} value={department} onChange={(e) => setDepartment(e.target.value)} className={cx(fieldClass(false), 'mt-2')} />
          </div>
          <div>
            <label htmlFor={`${uid}-l`} className="block text-body-strong">
              Location
            </label>
            <input id={`${uid}-l`} value={location} onChange={(e) => setLocation(e.target.value)} className={cx(fieldClass(false), 'mt-2')} />
          </div>
        </div>

        <div className="mt-4">
          <span className="block text-body-strong">Status</span>
          <div className="mt-2">
            <Select
              ariaLabel="Status"
              value={status}
              onValueChange={(v) => setStatus(v as Job['status'])}
              options={STATUS_OPTIONS}
              className="w-full"
            />
          </div>
        </div>

        {/*
          Absent, not disabled, without comp:read. A disabled band field would
          tell someone a band exists and they may not touch it; absent tells them
          nothing, which is the point of the scope (#2). buildPatch never emits a
          band key in this case either, so the API's own refusal is a backstop
          rather than the only guard.
        */}
        {canReadComp ? (
          <div className="mt-4 grid grid-cols-[1fr_1fr_var(--layout-wizard-currency-width)] gap-5">
            <div>
              <label htmlFor={`${uid}-min`} className="block text-body-strong">
                Band min (k)
              </label>
              <input
                id={`${uid}-min`}
                inputMode="decimal"
                value={bandMinK}
                onChange={(e) => setBandMinK(e.target.value)}
                className={cx(fieldClass(bandInvalid), 'mt-2 tabular-nums')}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-max`} className="block text-body-strong">
                Band max (k)
              </label>
              <input
                id={`${uid}-max`}
                inputMode="decimal"
                value={bandMaxK}
                onChange={(e) => setBandMaxK(e.target.value)}
                className={cx(fieldClass(bandInvalid), 'mt-2 tabular-nums')}
              />
            </div>
            <div>
              <span className="block text-body-strong">Currency</span>
              <div className="mt-2">
                <Select
                  ariaLabel="Currency"
                  placeholder="Currency"
                  value={currency}
                  onValueChange={setCurrency}
                  options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                  invalid={currencyInvalid}
                  className="w-full"
                />
              </div>
            </div>
          </div>
        ) : null}

        {bandInvalid || currencyInvalid ? (
          <p className="mt-2 text-meta text-feedback-danger-fg">
            {bandInvalid ? 'A band needs both a minimum and a maximum — or clear both.' : 'Choose a currency.'}
          </p>
        ) : null}

        {/* Empty both fields to remove a band; said out loud because deleting by
            clearing is not discoverable. */}
        {canReadComp && job.band ? (
          <p className="mt-2 text-meta text-text-tertiary">Clear both amounts to remove the band.</p>
        ) : null}
      </div>

      <div className="border-t border-border-subtle p-6">
        {conflict ? (
          <div role="alert" className="mb-3 rounded-md border border-border-default bg-feedback-warning-bg p-3">
            <p className="text-body-strong text-feedback-warning-fg">Someone else changed this job.</p>
            <p className="mt-1 text-body text-text-secondary">
              It now reads “{conflict.title}”. Your edits are still here — reload theirs to start from it, or overwrite
              to keep yours.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                onClick={() => {
                  // Take theirs wholesale, and close: re-seeding the fields would
                  // silently mix two people's edits into one save.
                  void queryClient.invalidateQueries({ queryKey: ['jobs'] });
                  void queryClient.invalidateQueries({ queryKey: ['board'] });
                  onClose();
                }}
              >
                Reload theirs
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  // Re-send against THEIR version, which is what makes the second
                  // attempt succeed rather than 409 again.
                  job = { ...job, version: conflict.version };
                  void onSave();
                }}
              >
                Overwrite
              </Button>
            </div>
          </div>
        ) : null}

        {/*
          Rendered only when there is something to say, unlike the sign-in form's
          always-present region. A conflict and an error are mutually exclusive
          here, and two live regions in one dialog means assistive tech has two
          things claiming to be the urgent one. Inserting a role="alert" node is
          announced just as well as filling a standing one.
        */}
        {error ? (
          <p role="alert" className="mb-3 text-body text-feedback-danger-fg">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-3">
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
