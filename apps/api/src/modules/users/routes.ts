/**
 * Route definitions. Schemas come from @talon/contracts — request and response
 * both, so a handler cannot invent a shape.
 *
 * No auth hook is attached here, ever. Protection comes from being registered
 * inside the authenticated scope (app.ts); a per-route hook would make its
 * absence invisible on the next route someone adds (CLAUDE.md §4).
 */
import { ListUsersQuerySchema, ListUsersResponseSchema } from '@talon/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { requireTx, requireUser, services } from '../../context.js';
import { parseOrThrow } from '../../errors.js';

export const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get('/users', async (request, reply) => {
    const query = parseOrThrow(ListUsersQuerySchema, request.query, 'query');
    const page = await services(request).usersService.listUsers(
      requireTx(request),
      requireUser(request),
      query,
    );
    return reply.send(ListUsersResponseSchema.parse(page));
  });
};
