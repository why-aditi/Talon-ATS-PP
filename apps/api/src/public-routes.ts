import type { FastifyPluginAsync } from 'fastify';

export const publicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true }));
};
