/**
 * The module's published interface — the only legal import target from other modules.
 *
 * `ImportsService` is exported as a TYPE because `apps/workers` runs the SAME commit
 * loop this module exposes rather than a second implementation of it (#5). A 49-row
 * import and a 51-row import differ only in who calls the method.
 */
export type { ImportsService } from './service.js';
export { registerImports } from './container.js';
export type { FileStore } from './file-store.js';
