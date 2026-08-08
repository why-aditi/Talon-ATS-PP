/**
 * Canonical pipeline stages.
 *
 * Here for the same reason `ROLES` is (see permissions.ts): two consumers need the same
 * list and neither may import the other. `packages/contracts` derives
 * `CanonicalStageSchema` from this, and the domain's own stage logic — stall detection,
 * next actions — switches on it. One array, no drift.
 *
 * Must match the `job_stages.canonical` check constraint in packages/db. Spec 001
 * open question 9 records that nothing yet catches drift between the SQL constraint,
 * the Drizzle column and this list; that test belongs in `apps/api`, where both are
 * reachable.
 */
export const CANONICAL_STAGES = [
  'applied',
  'screen',
  'onsite',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
] as const;

export type CanonicalStage = (typeof CANONICAL_STAGES)[number];

/** Terminal stages are the end of the road: nothing advances out of them, so they have
 *  no time-in-stage median and refuse drops until the reason prompt exists. */
export const TERMINAL_STAGES = ['hired', 'rejected', 'withdrawn'] as const satisfies readonly CanonicalStage[];

export const isTerminalStage = (stage: CanonicalStage): boolean =>
  (TERMINAL_STAGES as readonly CanonicalStage[]).includes(stage);

/**
 * Strictly greater, and null never stalls.
 *
 * Derived from the reference board rather than stated in any doc: Marcus Webb sits at
 * exactly 5 days in Screen against a 5-day SLA and renders normally, while Elena Ruiz
 * at 8 days is stalled. `>=` would stall Marcus and contradict the screen. The UI has
 * its own copy of this rule (spec 003 §6.4) because it renders the treatment; this one
 * is for anything server-side that needs to agree with it.
 */
export const isStalled = (daysInStage: number, slaDays: number | null): boolean =>
  slaDays !== null && daysInStage > slaDays;
