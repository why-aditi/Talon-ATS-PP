// Events this module publishes and subscribes to. Written to the outbox in the
// same transaction as the state change (spec 001 §8).
export const publishes: readonly string[] = [];
export const subscribes: readonly string[] = [];
