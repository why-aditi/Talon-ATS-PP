import type { FastifyPluginAsync } from 'fastify';
import { importsRoutes } from './routes.js';

// Plain plugin, not fastify-plugin: the module keeps its own encapsulation scope.
export const importsModule: FastifyPluginAsync = async (app) => {
  await app.register(importsRoutes);
};
