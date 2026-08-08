/**
 * The module's published interface — the only legal import target from other modules.
 * Everything not exported here is private.
 *
 * `ApplicationsService` is exported as a TYPE because the review inbox advances
 * candidates through the SAME `moveStage` method the board uses (non-negotiable #5).
 * Two code paths for one user intent will diverge; this is what makes the shared one
 * reachable without importing `service.ts` directly.
 */
export type { ApplicationsService } from './service.js';
export { registerApplications } from './container.js';
