import { fastify, type FastifyInstance } from 'fastify';
import type { AwilixContainer } from 'awilix';
import { loadConfig, type ApiConfig } from './config.js';
import { buildContainer } from './container.js';
import type { Cradle } from './context.js';
import { problemErrorHandler, sendProblem } from './errors.js';
import {
  authenticate,
  finishTenantTransaction,
  openTenantTransaction,
  resolveTenant,
} from './hooks/auth.js';
import { modules } from './modules/index.js';
import { publicRoutes } from './public-routes.js';
import { ERROR_TYPES } from '@talon/contracts';

export interface RouteRecord {
  method: string;
  url: string;
}

export interface BuildAppOptions {
  config?: ApiConfig;
  /** Tests pass their own to point at a test database or a max-1 pool. */
  container?: AwilixContainer<Cradle>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** every route registered anywhere on the app */
    allRoutes: RouteRecord[];
    /** routes registered inside the authenticated scope — provably carry the hook chain */
    protectedRoutes: RouteRecord[];
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const container = options.container ?? buildContainer(config);

  // exposeHeadRoutes off: auto-generated HEAD twins would show up in the route
  // manifest as unlisted public routes.
  // Logging on by default. `problemErrorHandler` logs every 5xx with the real
  // error, and with the logger off that call was a no-op: failed sign-ins on a
  // dev server returned an opaque 500 and the cause was discarded, so the
  // mechanism still cannot be established after the fact (`branded-error.ts`).
  // This is the line that makes the next one answerable. Silent under test,
  // where a thrown error is already the assertion.
  const app = fastify({
    exposeHeadRoutes: false,
    logger: process.env['NODE_ENV'] === 'test' ? false : { level: process.env['LOG_LEVEL'] ?? 'info' },
  });
  app.decorate('container', container);
  app.setErrorHandler(problemErrorHandler);
  app.setNotFoundHandler((request, reply) => {
    // Unmatched paths answer the same way a wrong-tenant resource does.
    sendProblem(reply, {
      type: ERROR_TYPES.NOT_FOUND,
      title: 'Not found',
      status: 404,
      instance: request.url,
      requestId: request.id,
    });
  });
  // Only the container closes the pool, so a test that builds several apps over
  // one container does not tear the pool out from under the others.
  if (!options.container) {
    app.addHook('onClose', async () => {
      await container.cradle.sql.end();
    });
  }

  // Before a single route is registered: an allow-list that names a tenant which
  // does not exist must stop the process, not surface as a 401 at somebody's
  // first sign-in (the exact failure the feature was turned on to remove). A
  // no-op — no query, no transaction — when TALON_JIT_PROVISION is unset, which
  // is the default.
  for (const entry of await container.cradle.identityService.assertJitPolicy()) {
    app.log.warn(
      { jit: entry },
      `just-in-time provisioning is ON for @${entry.domain}: anyone the identity ` +
        `provider authenticates with an address at that domain becomes a ` +
        `${entry.role} in "${entry.tenantName}"`,
    );
  }

  const allRoutes: RouteRecord[] = [];
  const protectedRoutes: RouteRecord[] = [];
  app.decorate('allRoutes', allRoutes);
  app.decorate('protectedRoutes', protectedRoutes);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) allRoutes.push({ method, url: r.url });
  });

  await app.register(publicRoutes, { prefix: '/v1' }); // /healthz, /readyz, /auth/*

  await app.register(
    async (scoped) => {
      scoped.addHook('onRequest', authenticate);
      scoped.addHook('onRequest', resolveTenant);
      scoped.addHook('preHandler', openTenantTransaction);
      scoped.addHook('onSend', finishTenantTransaction);
      // onRoute fires only for routes registered in this scope and its children,
      // i.e. exactly the routes that inherit the hooks above. The manifest test
      // diffs this set against allRoutes.
      scoped.addHook('onRoute', (r) => {
        for (const method of [r.method].flat()) protectedRoutes.push({ method, url: r.url });
      });
      for (const m of modules) await scoped.register(m);
    },
    { prefix: '/v1' },
  );

  await app.ready();
  return app;
}
