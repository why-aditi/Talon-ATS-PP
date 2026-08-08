import type { FastifyPluginAsync } from 'fastify';
import { usersRoutes } from './routes.js';

// Plain plugin, not fastify-plugin: the module keeps its own encapsulation scope.
export const usersModule: FastifyPluginAsync = async (app) => {
  await app.register(usersRoutes);
};
