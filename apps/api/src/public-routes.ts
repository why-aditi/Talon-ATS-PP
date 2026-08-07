import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from './modules/identity/index.public.js';

/**
 * Everything reachable without a token. This plugin carries NO auth hooks, which
 * is exactly why it is separate and named: opting out of authentication is a
 * visible act, and every route registered here must also appear in
 * PUBLIC_ROUTES (route-manifest.ts) or the manifest test fails.
 */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true }));
  await app.register(authRoutes);
};
