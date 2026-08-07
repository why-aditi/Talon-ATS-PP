import type { FastifyPluginAsync } from 'fastify';
import { jobsRoutes } from './routes.js';

// Plain plugin, not fastify-plugin: the module keeps its own encapsulation scope.
export const jobsModule: FastifyPluginAsync = async (app) => {
  await app.register(jobsRoutes);
};
