import type { FastifyPluginAsync } from 'fastify';
import { identityRoutes } from './routes.js';

// Plain plugin, not fastify-plugin: the module keeps its own encapsulation scope.
//
// Unlike the other modules this one is NOT in `modules/index.ts`: everything it
// serves is pre-authentication, so it is registered by `public-routes.ts`
// instead. Its container registrations are wired by the root container, which is
// what the request chain resolves the provider and service from.
export const identityModule: FastifyPluginAsync = async (app) => {
  await app.register(identityRoutes);
};
