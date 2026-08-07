import { fastify, type FastifyInstance } from 'fastify';
import { authenticate, openTenantTransaction, resolveTenant } from './hooks/auth.js';
import { modules } from './modules/index.js';
import { publicRoutes } from './public-routes.js';

export interface RouteRecord {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** every route registered anywhere on the app */
    allRoutes: RouteRecord[];
    /** routes registered inside the authenticated scope — provably carry the hook chain */
    protectedRoutes: RouteRecord[];
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  // exposeHeadRoutes off: auto-generated HEAD twins would show up in the route
  // manifest as unlisted public routes.
  const app = fastify({ exposeHeadRoutes: false });

  const allRoutes: RouteRecord[] = [];
  const protectedRoutes: RouteRecord[] = [];
  app.decorate('allRoutes', allRoutes);
  app.decorate('protectedRoutes', protectedRoutes);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) allRoutes.push({ method, url: r.url });
  });

  await app.register(publicRoutes, { prefix: '/v1' }); // /healthz, /readyz, /auth/* (step 4)

  // VIOLATION FIXTURE 3: route registered outside the authenticated scope and
  // not in PUBLIC_ROUTES — the manifest test must name it.
  app.get('/v1/rogue', async () => ({ leaked: true }));

  await app.register(
    async (scoped) => {
      scoped.addHook('onRequest', authenticate);
      scoped.addHook('onRequest', resolveTenant);
      scoped.addHook('preHandler', openTenantTransaction);
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
