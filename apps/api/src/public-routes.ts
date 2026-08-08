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
  app.get('/readyz', async (_request, reply) => {
    try {
      // A socket-only `select 1` goes green before migrations exist. Touch a
      // required RLS table instead; zero visible rows is healthy for an
      // unauthenticated readiness probe, while a missing schema is not.
      await app.container.cradle.sql`select 1 from tenants limit 0`;
      return { ok: true };
    } catch (error) {
      app.log.warn({ err: error }, 'readiness database check failed');
      return reply.code(503).send({ ok: false });
    }
  });
  await app.register(authRoutes);
};
