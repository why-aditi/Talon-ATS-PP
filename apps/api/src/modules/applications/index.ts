import type { FastifyPluginAsync } from 'fastify';
import { applicationsRoutes } from './routes.js';

// Plain plugin, not fastify-plugin: the module keeps its own encapsulation scope.
export const applicationsModule: FastifyPluginAsync = async (app) => {
  await app.register(applicationsRoutes);
};
