/**
 * Composition root. Owns the connection pool's lifecycle and names every module
 * registration exactly once.
 *
 * The pool is created here rather than in a module because it is process
 * infrastructure, not a repository: two modules sharing one pool is a
 * requirement (a single reserved connection per request), and a pool born inside
 * one module would have to be exported across a boundary to reach the other.
 * Nothing here issues a query.
 */
import { asValue, createContainer, InjectionMode, type AwilixContainer } from 'awilix';
import postgres from 'postgres';
import type { ApiConfig } from './config.js';
import type { Cradle } from './context.js';
import { registerIdentity } from './modules/identity/index.public.js';
import { registerApplications } from './modules/applications/index.public.js';
import { registerJobs } from './modules/jobs/index.public.js';

export function buildContainer(config: ApiConfig): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY });
  container.register({
    config: asValue(config),
    authConfig: asValue(config.auth),
    sql: asValue(postgres(config.databaseUrl, { max: config.poolMax, onnotice: () => {} })),
  });
  registerIdentity(container);
  registerJobs(container);
  registerApplications(container);
  return container;
}
