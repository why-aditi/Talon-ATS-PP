// Events this module publishes and subscribes to. Written to the outbox in the
// same transaction as the state change (spec 001 §8).
//
// None yet: sign-in is not a domain state change, and the audit trail for
// authentication needs a writer that works without tenant context — see the
// step-4 report.
export const publishes: readonly string[] = [];
export const subscribes: readonly string[] = [];
