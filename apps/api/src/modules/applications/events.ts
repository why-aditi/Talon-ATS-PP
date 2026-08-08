/**
 * Events this module publishes and subscribes to. Written to the outbox in the same
 * transaction as the state change (ARCHITECTURE §6.1), never published inline.
 *
 * Delivery is at-least-once, so every consumer must be idempotent keyed on `outbox.id`
 * — a consumer that cannot handle a duplicate is a bug, not a tuning problem
 * (non-negotiable #19).
 */
export const publishes = [
  /** Payload is ids and versions only: { applicationId, jobId, toStageId, version }.
   *  A consumer refetches what it needs, so a stale broadcast cannot write bad data
   *  into a cache. */
  'application.stage_changed',
] as const satisfies readonly string[];

export const subscribes: readonly string[] = [];
