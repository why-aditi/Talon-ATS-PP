'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useReducer, useState } from 'react';
import {
  CURRENCIES,
  DEPARTMENTS,
  LOCATIONS,
  OTHER,
  STEPS,
  initialState,
  isDirty,
  toCreateJobPayload,
  validateStep,
  wizardReducer,
  type Errors,
  type StepIndex,
  type WizardState,
} from '../lib/job-wizard';
import {
  JobCreateError,
  createJob,
  useAssignableUsers,
  useStageTemplates,
  type StageTemplate,
  type UserOption,
} from '../lib/job-wizard-query';
import { useSession } from '../lib/session';
import { useJobTemplate } from './app-shell';
import { Button, Select, cx } from './ui';

/**
 * Every failure `POST /v1/jobs` can answer with, as the person who filled in
 * four steps should read it. Switching on `type` rather than status is what
 * keeps "you may not set a band" from being rendered as "something went wrong",
 * which would send them to retry the one thing that cannot work.
 */
const CREATE_FAILURES: Record<string, string> = {
  'urn:talon:error:forbidden': 'You don’t have permission to set a compensation band. Remove it, or ask an admin.',
  'urn:talon:error:not-found': 'That pipeline is no longer available. Go back to step 2 and pick another.',
  'urn:talon:error:validation-failed': 'Something on an earlier step isn’t valid. Check the summary above.',
  'urn:talon:client:network': 'We couldn’t reach the server. Your answers are still here — try again.',
};
const CREATE_FALLBACK = 'The job couldn’t be created. Your answers are still here — try again.';

/*
  Spec 005 §6. Geometry measured off 09-new-job-wizard@2x.png by scanning the
  2880px original for border transitions and halving: card x=517..1155 (638 wide,
  centred — content spans 254..1416 and both centres land on 835/836), 24 padding,
  inputs 34 tall, band fields 286 with a 21 gutter, chips ~25 tall.

  Only step 1 is on the reference. Steps 2-4 are named on the chips there and
  drawn nowhere; §6.3-§6.5 derive them from the data model, and they are the part
  of this screen most likely to be redesigned. Marked so nobody mistakes them for
  measured.
*/

const FIELD =
  'h-[var(--control-height-md)] w-full rounded-md border bg-bg-surface px-3 text-body text-text-primary placeholder:text-text-placeholder focus:border-border-focus';

const fieldClass = (invalid: boolean) => cx(FIELD, invalid ? 'border-border-danger' : 'border-border-default');

function Label({ htmlFor, children }: { htmlFor?: string | undefined; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-body-strong text-text-primary">
      {children}
    </label>
  );
}

/** Errors sit under their control so the message and the fix are the same place. */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-meta text-feedback-danger-fg">
      {message}
    </p>
  );
}

/**
 * Single-select chips.
 *
 * `radiogroup`/`radio`, not buttons: this is one choice, arrow keys must move
 * within it, and a button group announces four independent controls where there
 * is one. Roving tabindex so the group is a single tab stop.
 */
function ChipGroup({
  legend,
  name,
  options,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  legend: string;
  name: string;
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const all = [...options, OTHER];
  const activeIndex = Math.max(0, all.indexOf(value));

  function onKeyDown(event: React.KeyboardEvent) {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;
    event.preventDefault();
    const next = all[(activeIndex + (forward ? 1 : all.length - 1)) % all.length];
    if (next !== undefined) onChange(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label={legend}
      {...(invalid ? { 'aria-invalid': true } : {})}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      onKeyDown={onKeyDown}
      className="mt-2 flex flex-wrap gap-2"
    >
      {all.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: the group is one tab stop, and arrows move inside it.
            tabIndex={selected || (value === '' && option === all[0]) ? 0 : -1}
            name={name}
            onClick={() => onChange(option)}
            className={cx(
              'h-[var(--control-height-sm)] rounded-md border px-3 text-body',
              'transition-colors duration-[var(--duration-instant)] ease-standard',
              selected
                ? 'border-border-focus bg-bg-selected text-text-link'
                : 'border-border-default bg-bg-surface text-text-primary hover:bg-bg-surface-hover',
            )}
          >
            {option === OTHER ? 'Other…' : option}
          </button>
        );
      })}
    </div>
  );
}

/* ── Step 1 — Role basics (the measured one) ───────────────────────────────── */

function RoleBasics({
  state,
  set,
  errors,
  ids,
}: {
  state: WizardState;
  set: (field: keyof WizardState, value: string) => void;
  errors: Errors;
  ids: Record<string, string>;
}) {
  return (
    <>
      <Label htmlFor={ids['title']}>Job title</Label>
      <input
        id={ids['title']}
        value={state.title}
        onChange={(e) => set('title', e.target.value)}
        placeholder="e.g. Senior Backend Engineer"
        className={cx(fieldClass(!!errors.title), 'mt-2')}
        {...(errors.title ? { 'aria-invalid': true, 'aria-describedby': `${ids['title']}-error` } : {})}
      />
      <FieldError id={`${ids['title']}-error`} message={errors.title} />

      <div className="mt-4">
        <Label>Department</Label>
        <ChipGroup
          legend="Department"
          name="department"
          options={DEPARTMENTS}
          value={state.department}
          onChange={(v) => set('department', v)}
          invalid={!!errors.department}
          describedBy={errors.department ? `${ids['department']}-error` : undefined}
        />
        {state.department === OTHER ? (
          <input
            aria-label="Department name"
            value={state.departmentOther}
            onChange={(e) => set('departmentOther', e.target.value)}
            placeholder="Department name"
            className={cx(fieldClass(!!errors.department), 'mt-2')}
          />
        ) : null}
        <FieldError id={`${ids['department']}-error`} message={errors.department} />
      </div>

      <div className="mt-4">
        <Label>Location</Label>
        <ChipGroup
          legend="Location"
          name="location"
          options={LOCATIONS}
          value={state.location}
          onChange={(v) => set('location', v)}
          invalid={!!errors.location}
          describedBy={errors.location ? `${ids['location']}-error` : undefined}
        />
        {state.location === OTHER ? (
          <input
            aria-label="Location name"
            value={state.locationOther}
            onChange={(e) => set('locationOther', e.target.value)}
            placeholder="Location name"
            className={cx(fieldClass(!!errors.location), 'mt-2')}
          />
        ) : null}
        <FieldError id={`${ids['location']}-error`} message={errors.location} />
      </div>

      {/*
        §6.2a. The reference row is two 286px fields with a 21px gutter; currency
        joins them as a third control rather than as a prefix inside the minimum,
        because a prefix reads as decoration and #9 wants the currency to be a
        choice somebody made. Tracks resolve from the container, so the numbers in
        the spec are a record of the change, not constants to maintain.
      */}
      <div className="mt-4 grid grid-cols-[1fr_1fr_var(--layout-wizard-currency-width)] gap-5">
        <div>
          <Label htmlFor={ids['bandMin']}>Band min (k)</Label>
          <input
            id={ids['bandMin']}
            inputMode="decimal"
            value={state.bandMinK}
            onChange={(e) => set('bandMinK', e.target.value)}
            className={cx(fieldClass(!!errors.bandMinK), 'mt-2 tabular-nums')}
            {...(errors.bandMinK ? { 'aria-invalid': true } : {})}
          />
        </div>
        <div>
          <Label htmlFor={ids['bandMax']}>Band max (k)</Label>
          <input
            id={ids['bandMax']}
            inputMode="decimal"
            value={state.bandMaxK}
            onChange={(e) => set('bandMaxK', e.target.value)}
            className={cx(fieldClass(!!errors.bandMaxK), 'mt-2 tabular-nums')}
            {...(errors.bandMaxK ? { 'aria-invalid': true } : {})}
          />
        </div>
        <div>
          <Label>Currency</Label>
          <div className="mt-2">
            {/* No default value — #9. The placeholder is what "not chosen" looks
                like, and Continue is blocked until it is, once a band exists. */}
            <Select
              ariaLabel="Currency"
              placeholder="Currency"
              value={state.currency}
              onValueChange={(v) => set('currency', v)}
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
              invalid={!!errors.currency}
              className="w-full"
            />
          </div>
        </div>
      </div>
      <FieldError id={`${ids['band']}-error`} message={errors.bandMinK ?? errors.bandMaxK ?? errors.currency} />
    </>
  );
}

/* ── Steps 2-4 — no reference. Spec 005 §6.3-§6.5. ─────────────────────────── */

/*
  Steps 2 and 3 read from `GET /v1/stage-templates` and `GET /v1/users?role=`,
  neither of which exists yet (spec 005 §12 step 4, §15 OQ7). The queries are
  written against the contract so the steps fill in the moment those ship; until
  then a 404 resolves to an empty list and the step says which endpoint it is
  waiting for. A hardcoded list here would be data that looks like data and
  answers to nothing — the mistake the sidebar counts made.
*/

function Pipeline({
  state,
  set,
  setSla,
  errors,
  templates,
  unavailable,
  isPending,
}: {
  state: WizardState;
  set: (field: keyof WizardState, value: string) => void;
  setSla: (position: number, value: string) => void;
  errors: Errors;
  templates: StageTemplate[];
  unavailable: boolean;
  isPending: boolean;
}) {
  const chosen = templates.find((t) => t.id === state.stageTemplateId);

  if (isPending) {
    return (
      <div aria-busy="true" aria-label="Loading pipelines">
        {[0, 1].map((i) => (
          <div key={i} className="mb-3 h-16 animate-pulse rounded-md bg-bg-canvas" />
        ))}
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div>
        <p className="text-body-strong text-text-primary">No stage templates yet.</p>
        <p className="mt-1 text-body text-text-secondary">
          A job needs a pipeline before it can accept candidates, and none are available.{' '}
          {unavailable ? (
            <>
              This step reads <code className="font-mono text-code">GET /v1/stage-templates</code>, which isn’t built
              yet.
            </>
          ) : (
            <>Ask an admin to add one.</>
          )}
        </p>
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label="Pipeline">
      {templates.map((template) => {
        const selected = state.stageTemplateId === template.id;
        return (
          <div key={template.id} className="mb-3 last:mb-0">
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => set('stageTemplateId', template.id)}
              className={cx(
                'w-full rounded-md border p-3 text-left',
                selected ? 'border-border-focus bg-bg-selected' : 'border-border-default bg-bg-surface',
              )}
            >
              <span className="block text-body-strong text-text-primary">{template.name}</span>
              {/* The stage names read as chips so the choice is legible without
                  opening anything — the whole reason this is a list and not a select. */}
              <span className="mt-2 flex flex-wrap gap-1">
                {template.stages.map((stage) => (
                  <span key={stage.name} className="rounded-xs bg-bg-canvas px-2 py-px text-caption text-text-secondary">
                    {stage.name}
                  </span>
                ))}
              </span>
            </button>

            {selected ? (
              <div className="mt-3 pl-3">
                <p className="text-meta text-text-tertiary">
                  SLA per stage, in days. Blank means no SLA, which is not the same as zero.
                </p>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {template.stages.map((stage, position) => (
                    <label key={stage.name} className="flex items-center gap-2 text-body text-text-secondary">
                      <span className="flex-1 truncate">{stage.name}</span>
                      <input
                        inputMode="numeric"
                        aria-label={`${stage.name} SLA in days`}
                        value={state.slaOverrides[position] ?? (stage.slaDays?.toString() ?? '')}
                        onChange={(e) => setSla(position, e.target.value)}
                        className={cx(FIELD, 'border-border-default w-16 tabular-nums')}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      <FieldError id="pipeline-error" message={errors.stageTemplateId} />
      {chosen ? null : <span className="sr-only">No pipeline selected</span>}
    </div>
  );
}

function HiringTeam({
  state,
  set,
  errors,
  ids,
  recruiters,
  managers,
  unavailable,
}: {
  state: WizardState;
  set: (field: keyof WizardState, value: string) => void;
  errors: Errors;
  ids: Record<string, string>;
  recruiters: UserOption[];
  managers: UserOption[];
  unavailable: boolean;
}) {
  // Both columns are nullable and the jobs list already renders "Unassigned", so
  // an empty option is a real choice rather than a placeholder.
  const withUnassigned = (users: UserOption[]) => [
    { value: '', label: 'Unassigned' },
    ...users.map((u) => ({ value: u.id, label: u.name })),
  ];

  return (
    <>
      <Label>Recruiter</Label>
      <div className="mt-2">
        <Select
          ariaLabel="Recruiter"
          placeholder="Unassigned"
          value={state.recruiterId}
          onValueChange={(v) => set('recruiterId', v)}
          options={withUnassigned(recruiters)}
          className="w-full"
        />
      </div>

      <div className="mt-4">
        <Label>Hiring manager</Label>
        <div className="mt-2">
          <Select
            ariaLabel="Hiring manager"
            placeholder="Unassigned"
            value={state.hiringManagerId}
            onValueChange={(v) => set('hiringManagerId', v)}
            options={withUnassigned(managers)}
            className="w-full"
          />
        </div>
      </div>

      <div className="mt-4">
        <Label htmlFor={ids['openings']}>Openings</Label>
        <input
          id={ids['openings']}
          inputMode="numeric"
          value={state.openings}
          onChange={(e) => set('openings', e.target.value)}
          className={cx(fieldClass(!!errors.openings), 'mt-2 w-20 tabular-nums')}
          {...(errors.openings ? { 'aria-invalid': true, 'aria-describedby': `${ids['openings']}-error` } : {})}
        />
        <FieldError id={`${ids['openings']}-error`} message={errors.openings} />
      </div>

      {recruiters.length === 0 && managers.length === 0 && unavailable ? (
        <p className="mt-4 text-meta text-text-tertiary">
          Nobody to assign yet — this reads <code className="font-mono text-code">GET /v1/users?role=</code>, which
          isn’t built. Both columns are nullable, so the job can be created unassigned and assigned later.
        </p>
      ) : null}
    </>
  );
}

function Review({
  state,
  canReadComp,
  onEdit,
  templates,
  recruiters,
  managers,
}: {
  state: WizardState;
  canReadComp: boolean;
  onEdit: (step: StepIndex) => void;
  templates: StageTemplate[];
  recruiters: UserOption[];
  managers: UserOption[];
}) {
  const payload = toCreateJobPayload(state);
  const template = templates.find((t) => t.id === state.stageTemplateId);
  const named = (users: UserOption[], id: string) => users.find((u) => u.id === id)?.name ?? 'Unassigned';

  // Only the overrides that differ from the template. Listing every stage would
  // bury the two the user actually changed in a list of the ones they did not.
  const changedSlas = template
    ? template.stages
        .map((stage, position) => ({ stage, position, override: state.slaOverrides[position] }))
        .filter(({ stage, override }) => override !== undefined && override !== (stage.slaDays?.toString() ?? ''))
        .map(({ stage, override }) => `${stage.name} ${override === '' ? 'no SLA' : `${override}d`}`)
    : [];

  const rows: { label: string; value: string; step: StepIndex }[] = [
    { label: 'Title', value: payload.title, step: 0 },
    { label: 'Department', value: payload.department, step: 0 },
    { label: 'Location', value: payload.location, step: 0 },
    { label: 'Pipeline', value: template?.name ?? '—', step: 1 },
    ...(changedSlas.length > 0
      ? [{ label: 'SLA changes', value: changedSlas.join(', '), step: 1 as StepIndex }]
      : []),
    { label: 'Recruiter', value: named(recruiters, state.recruiterId), step: 2 },
    { label: 'Hiring manager', value: named(managers, state.hiringManagerId), step: 2 },
    { label: 'Openings', value: String(payload.openings), step: 2 },
  ];

  // Band is scope-gated (#2). Someone without comp:read cannot have entered one,
  // so the row is absent rather than empty — an empty "Band —" would suggest the
  // job has no band, which is a different fact.
  if (canReadComp && payload.bandMinCents) {
    rows.splice(3, 0, {
      label: 'Band',
      value: `${state.bandMinK}k – ${state.bandMaxK}k ${state.currency}`,
      step: 0,
    });
  }

  return (
    <>
      <dl>
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-3 border-b border-border-subtle py-2 last:border-0">
            <dt className="w-20 shrink-0 text-meta text-text-tertiary">{row.label}</dt>
            {/* The Edit control lives inside the <dd>, not beside it: a <div> in a
                <dl> may contain dt and dd and nothing else, and a sibling button
                is an axe `definition-list` violation. */}
            <dd className="flex flex-1 items-baseline gap-3 text-body text-text-primary">
              <span className="flex-1">{row.value || '—'}</span>
              <button
                type="button"
                onClick={() => onEdit(row.step)}
                className="text-body text-text-link hover:underline"
              >
                Edit<span className="sr-only"> {row.label}</span>
              </button>
            </dd>
          </div>
        ))}
      </dl>
      {/* Outside the <dl>: a definition list may only contain dt/dd/div, and a
          stray <p> is an axe `definition-list` violation. Caught by the gate. */}
      <p className="mt-4 text-meta text-text-tertiary">
        Creates a <strong className="text-text-secondary">draft</strong>. Publish it from the job once the description
        is written — §6.5.
      </p>
    </>
  );
}

/* ── The wizard ────────────────────────────────────────────────────────────── */

export function JobWizard({
  canReadComp = true,
  templates: templatesProp,
  recruiters: recruitersProp,
  managers: managersProp,
}: {
  canReadComp?: boolean;
  /* Overrides exist so a test can drive a populated step without standing up the
     endpoints. Nothing in the app passes them — the wizard fetches its own data. */
  templates?: StageTemplate[];
  recruiters?: UserOption[];
  managers?: UserOption[];
} = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // The JD template modal, which used to be what "+ New job" opened. It is a
  // copy-the-text tool rather than a creation path (spec 005 §2), and this is
  // where someone writing a new req actually wants it.
  const openJobTemplate = useJobTemplate();
  const { session } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const templateQuery = useStageTemplates();
  const recruiterQuery = useAssignableUsers('recruiter');
  const managerQuery = useAssignableUsers('hiring_manager');

  const templates = templatesProp ?? templateQuery.data;
  const recruiters = recruitersProp ?? recruiterQuery.data;
  const managers = managersProp ?? managerQuery.data;
  const [state, dispatch] = useReducer(wizardReducer, initialState);
  const [step, setStep] = useState<StepIndex>(0);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const uid = useId();
  const ids = useMemo(
    () =>
      Object.fromEntries(
        ['title', 'department', 'location', 'bandMin', 'bandMax', 'band', 'openings'].map((k) => [k, `${uid}-${k}`]),
      ),
    [uid],
  );

  const set = (field: keyof WizardState, value: string) => {
    dispatch({ type: 'set', field, value });
    // Errors clear as you fix them rather than on the next Continue: a message
    // that outlives its cause reads as a control that will not accept anything.
    setShowErrors(false);
  };

  const stepErrors = validateStep(step, state);
  const errors: Errors = showErrors ? stepErrors : {};

  /*
    Focus the first thing that is wrong, in an effect rather than in the click
    handler. `setShowErrors(true)` is what puts `aria-invalid` on the controls, and
    React has not re-rendered by the time the handler continues — querying there
    finds nothing and focus stays on the button, which is the silent version of
    this feature not working. The effect runs after the DOM is updated.
  */
  useEffect(() => {
    if (!showErrors) return;
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [showErrors]);

  function onContinue() {
    if (Object.keys(stepErrors).length > 0) {
      // Without this a keyboard user is left standing on Continue with a message
      // announced nowhere.
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (step < 3) setStep((step + 1) as StepIndex);
  }

  async function onCreate() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createJob(toCreateJobPayload(state), session?.accessToken);
      // The list is now stale in two places — the jobs screen and the sidebar
      // badge — and both read the same key.
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
      router.push(`/jobs/${created.id}/pipeline`);
    } catch (caught) {
      setSubmitError(
        caught instanceof JobCreateError ? (CREATE_FAILURES[caught.type] ?? CREATE_FALLBACK) : CREATE_FALLBACK,
      );
      // Re-enabled, and nothing cleared: four steps of typing must survive a
      // failed submit, or the error becomes the more expensive event.
      setSubmitting(false);
    }
  }

  function onCancel() {
    if (isDirty(state)) setConfirmDiscard(true);
    else router.push('/jobs');
  }

  return (
    <div className="mx-auto w-[var(--layout-wizard-card-width)]">
      <div className="flex items-baseline gap-3">
        <h1 className="font-display text-page-title text-text-primary">New job</h1>
        <p className="flex-1 text-body text-text-secondary">Step {step + 1} of {STEPS.length}</p>
        <button type="button" onClick={onCancel} className="text-body text-text-link hover:underline">
          Cancel
        </button>
      </div>

      {/*
        A list, not a tablist: the steps are a progress indicator and are not
        freely selectable — you cannot jump to Review without filling step 1. The
        current one carries aria-current so it is announced as position, not as a
        selected tab that would imply the others are one click away.
      */}
      <ol className="mt-5 flex gap-2">
        {STEPS.map((label, index) => {
          const active = index === step;
          const done = index < step;
          return (
            <li key={label}>
              <button
                type="button"
                // Backwards only. Forwards is Continue's job, because it validates.
                disabled={index > step}
                onClick={() => setStep(index as StepIndex)}
                {...(active ? { 'aria-current': 'step' as const } : {})}
                className={cx(
                  'flex h-8 items-center gap-2 rounded-md border px-3 text-body',
                  active
                    ? 'border-border-focus bg-bg-selected text-text-link'
                    : 'border-border-default bg-bg-surface text-text-secondary',
                  index > step && 'text-action-disabled-text',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'grid size-5 place-items-center rounded-full text-caption tabular-nums',
                    active || done ? 'bg-action-primary-bg text-text-on-primary' : 'bg-bg-canvas text-text-tertiary',
                  )}
                >
                  {index + 1}
                </span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 rounded-lg border border-border-default bg-bg-surface p-6">
        {step === 0 ? <RoleBasics state={state} set={set} errors={errors} ids={ids} /> : null}
        {step === 1 ? (
          <Pipeline
            state={state}
            set={set}
            setSla={(position, value) => dispatch({ type: 'setSla', position, value })}
            errors={errors}
            templates={templates}
            unavailable={templatesProp === undefined && templateQuery.unavailable}
            isPending={templatesProp === undefined && templateQuery.isPending}
          />
        ) : null}
        {step === 2 ? (
          <HiringTeam
            state={state}
            set={set}
            errors={errors}
            ids={ids}
            recruiters={recruiters}
            managers={managers}
            unavailable={recruitersProp === undefined && recruiterQuery.unavailable && managerQuery.unavailable}
          />
        ) : null}
        {step === 3 ? (
          <Review
            state={state}
            canReadComp={canReadComp}
            onEdit={setStep}
            templates={templates}
            recruiters={recruiters}
            managers={managers}
          />
        ) : null}
      </div>

      <div className="mt-5 flex gap-3">
        <Button onClick={() => setStep((step - 1) as StepIndex)} disabled={step === 0}>
          ← Back
        </Button>
        {step < 3 ? (
          // Never disabled on invalid: a disabled button gives no reason, and the
          // second press is how someone asks what is wrong. It validates instead.
          <Button variant="primary" onClick={onContinue}>
            Continue →
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void onCreate()} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create job'}
          </Button>
        )}
      </div>

      {step === 0 ? (
        <p className="mt-3 text-meta text-text-tertiary">
          Writing the description?{' '}
          <button type="button" onClick={openJobTemplate} className="text-text-link hover:underline">
            Copy a job description template
          </button>
          .
        </p>
      ) : null}

      {/* Non-blocking, above the buttons, with the form intact behind it. A
          full-page error would discard four steps of typing to say "try again". */}
      <p role="alert" className={cx('mt-3 text-body text-feedback-danger-fg', !submitError && 'sr-only')}>
        {submitError ?? ''}
      </p>

      {confirmDiscard ? (
        <div role="alertdialog" aria-modal="true" aria-labelledby={`${uid}-discard`} className="mt-4 rounded-md border border-border-default bg-bg-surface p-4">
          <p id={`${uid}-discard`} className="text-body-strong text-text-primary">
            Discard this job?
          </p>
          <p className="mt-1 text-body text-text-secondary">Your answers will be lost.</p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => router.push('/jobs')}>
              Discard
            </Button>
            <Button onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
