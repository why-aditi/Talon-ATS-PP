/**
 * Wizard state, validation, and the payload it produces. Spec 005 §6.
 *
 * Separate from the component because the interesting parts — which step you may
 * leave, what "invalid" means per field, and the k→cents conversion — are the
 * parts worth testing without a DOM.
 */

export const DEPARTMENTS = ['Engineering', 'Design', 'People', 'Sales'] as const;
export const LOCATIONS = ['Remote (US)', 'Remote (EU)', 'SF / Hybrid', 'New York', 'London'] as const;

/**
 * The chip sets are the seeded values exactly, but `jobs.department` and
 * `jobs.location` are free text — so these are suggestions, not an enum. "Other…"
 * reveals a text input, because a hard enum in the UI over a text column will be
 * wrong for the first customer with a Customer Success department (spec 005 §6.2).
 */
export const OTHER = 'other' as const;

/**
 * ISO 4217, and deliberately no default (#9). A currency that defaults is an
 * assumption wearing a constraint; the list is short because the alternative is a
 * 180-entry combobox for a field three of the four values will ever take.
 */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD'] as const;

export const STEPS = ['Role basics', 'Pipeline', 'Hiring team', 'Review'] as const;
export type StepIndex = 0 | 1 | 2 | 3;

export interface WizardState {
  title: string;
  department: string;
  departmentOther: string;
  location: string;
  locationOther: string;
  /** As typed, in thousands. Empty string is "not entered", which is not zero. */
  bandMinK: string;
  bandMaxK: string;
  currency: string;
  stageTemplateId: string;
  /** Keyed by stage position, because job_stages rows do not exist yet (§6.3). */
  slaOverrides: Record<number, string>;
  recruiterId: string;
  hiringManagerId: string;
  openings: string;
}

export const initialState: WizardState = {
  title: '',
  department: '',
  departmentOther: '',
  location: '',
  locationOther: '',
  bandMinK: '',
  bandMaxK: '',
  currency: '',
  stageTemplateId: '',
  slaOverrides: {},
  recruiterId: '',
  hiringManagerId: '',
  openings: '1',
};

export type WizardAction =
  | { type: 'set'; field: keyof WizardState; value: string }
  | { type: 'setSla'; position: number; value: string }
  | { type: 'reset' };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'set':
      return { ...state, [action.field]: action.value };
    case 'setSla':
      return { ...state, slaOverrides: { ...state.slaOverrides, [action.position]: action.value } };
    case 'reset':
      return initialState;
  }
}

/** The value that reaches the API: the chip, or what was typed under "Other…". */
export const resolveChoice = (choice: string, other: string): string =>
  choice === OTHER ? other.trim() : choice;

/**
 * Thousands-of-major-units (what the wizard shows) → minor units (what we store).
 *
 * Spec 005 §4.1 puts this in `packages/domain` so the client and the service
 * cannot disagree. That package is not this stream's to edit and the endpoint does
 * not exist yet, so it lives here **temporarily** and this file loses it in the
 * same commit that adds the domain version. Two copies of a ×100_000 conversion
 * is precisely the bug §4.1 exists to prevent — do not let this one settle.
 *
 * `Math.round` before `BigInt`, because `BigInt(180.5 * 100_000)` on a
 * non-integer throws rather than rounding, and 180.5k is a thing a recruiter
 * types.
 */
export const kToCents = (k: number): bigint => BigInt(Math.round(k * 100_000));

/** Empty is "not entered", which is different from zero and must stay different. */
const parseK = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
};

export type Errors = Partial<Record<keyof WizardState, string>>;

/**
 * Per-step validation. Returns the fields that block Continue, keyed by field so
 * the message renders under the control it belongs to and focus can move there.
 */
export function validateStep(step: StepIndex, state: WizardState): Errors {
  const errors: Errors = {};

  if (step === 0) {
    if (state.title.trim() === '') errors.title = 'Give the role a title.';
    if (resolveChoice(state.department, state.departmentOther) === '') {
      errors.department = 'Pick a department.';
    }
    if (resolveChoice(state.location, state.locationOther) === '') {
      errors.location = 'Pick a location.';
    }

    const min = parseK(state.bandMinK);
    const max = parseK(state.bandMaxK);
    for (const [field, value] of [['bandMinK', min], ['bandMaxK', max]] as const) {
      if (Number.isNaN(value)) errors[field] = 'Enter a number, in thousands.';
      else if (value !== null && value <= 0) errors[field] = 'Must be more than zero.';
    }

    // Together or not at all: a band with one bound is not a band.
    if (min !== null && max === null && !errors.bandMaxK) errors.bandMaxK = 'Add a maximum too.';
    if (max !== null && min === null && !errors.bandMinK) errors.bandMinK = 'Add a minimum too.';
    if (min !== null && max !== null && !Number.isNaN(min) && !Number.isNaN(max) && max < min) {
      errors.bandMaxK = 'Maximum must be at least the minimum.';
    }

    // #9, in the UI: the currency is never guessed. Only demanded once there is
    // an amount for it to apply to — a currency with no band means nothing.
    if ((min !== null || max !== null) && state.currency === '') {
      errors.currency = 'Choose a currency.';
    }
  }

  if (step === 1 && state.stageTemplateId === '') {
    errors.stageTemplateId = 'Choose a pipeline.';
  }

  if (step === 2) {
    const openings = Number(state.openings.trim());
    if (!Number.isInteger(openings) || openings < 1 || openings > 999) {
      errors.openings = 'Between 1 and 999.';
    }
  }

  return errors;
}

export const isStepValid = (step: StepIndex, state: WizardState): boolean =>
  Object.keys(validateStep(step, state)).length === 0;

/** Anything typed at all — drives the discard confirmation (§6.7). */
export const isDirty = (state: WizardState): boolean =>
  JSON.stringify({ ...state, openings: '1' }) !== JSON.stringify(initialState);

export interface CreateJobPayload {
  title: string;
  department: string;
  location: string;
  bandMinCents?: string;
  bandMaxCents?: string;
  currency?: string;
  recruiterId: string | null;
  hiringManagerId: string | null;
  openings: number;
  stageTemplateId: string;
  stageOverrides: { position: number; slaDays: number | null }[];
  status: 'draft';
}

/**
 * The request body for `POST /v1/jobs` (spec 005 §4.2).
 *
 * Cents are serialised as strings: `bigint` has no JSON representation, and
 * sending them as numbers would reintroduce the 2^53 class that #9 exists to
 * abolish. `z.coerce.bigint()` on the API accepts the string.
 *
 * `status` is always `draft` — §6.5. A wizard that publishes a req the moment
 * somebody mistypes is a wizard nobody trusts.
 */
export function toCreateJobPayload(state: WizardState): CreateJobPayload {
  const min = parseK(state.bandMinK);
  const max = parseK(state.bandMaxK);
  const hasBand = min !== null && max !== null;

  return {
    title: state.title.trim(),
    department: resolveChoice(state.department, state.departmentOther),
    location: resolveChoice(state.location, state.locationOther),
    ...(hasBand
      ? {
          bandMinCents: kToCents(min).toString(),
          bandMaxCents: kToCents(max).toString(),
          currency: state.currency,
        }
      : {}),
    // Null, not omitted: the columns are nullable and "unassigned" is a value the
    // jobs list already renders. Omitting would read as "leave it alone", which is
    // meaningless on a create.
    recruiterId: state.recruiterId || null,
    hiringManagerId: state.hiringManagerId || null,
    openings: Number(state.openings.trim()),
    stageTemplateId: state.stageTemplateId,
    stageOverrides: Object.entries(state.slaOverrides)
      .map(([position, value]) => ({
        position: Number(position),
        slaDays: value.trim() === '' ? null : Number(value),
      }))
      .filter((o) => o.slaDays === null || Number.isInteger(o.slaDays)),
    status: 'draft',
  };
}
