/**
 * Interview vocabulary — spec 004 §5.
 *
 * Here for the same reason `CANONICAL_STAGES` is (see stages.ts): `packages/contracts`
 * derives its enums from this list and the API's own logic switches on it. One array,
 * no drift.
 *
 * Must match the check constraints in `packages/db/migrations/0009_scheduling.up.sql`.
 */

/** `interview_rounds.kind` / `interviews.kind`. */
export const ROUND_KINDS = ['coding', 'system_design', 'values', 'hiring_manager'] as const;
export type RoundKind = (typeof ROUND_KINDS)[number];

/** `interviews.status`. `unscheduled` is the round that exists but has no time yet. */
export const INTERVIEW_STATUSES = [
  'unscheduled',
  'pending',
  'confirmed',
  'declined',
  'completed',
  'cancelled',
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/** `interview_loops.status`. */
export const LOOP_STATUSES = [
  'draft',
  'proposed',
  'held',
  'confirmed',
  'completed',
  'cancelled',
] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

/** `interview_panelists.response`. Never read back from the calendar server — Radicale
 *  has no iTIP, so a panelist marks this in Talon (spec 004 §10). */
export const PANELIST_RESPONSES = ['pending', 'accepted', 'declined'] as const;
export type PanelistResponse = (typeof PANELIST_RESPONSES)[number];
