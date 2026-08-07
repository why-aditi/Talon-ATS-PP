/**
 * Public auth routes. Registered by `public-routes.ts`, i.e. OUTSIDE the
 * authenticated scope — you cannot present a token to the endpoint that issues
 * one. Both are listed in PUBLIC_ROUTES, which is the deliberate, visible act of
 * opting out (ARCHITECTURE §4.1).
 */
import type { FastifyPluginAsync } from 'fastify';
import { RefreshRequestSchema, SignInRequestSchema } from '@talon/contracts';
import { services } from '../../context.js';
import { parseOrThrow } from '../../errors.js';

export const identityRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/sign-in', async (request, reply) => {
    const body = parseOrThrow(SignInRequestSchema, request.body, 'body');
    return reply.send(await services(request).identityService.signIn(body));
  });

  app.post('/auth/refresh', async (request, reply) => {
    const body = parseOrThrow(RefreshRequestSchema, request.body, 'body');
    return reply.send(await services(request).identityService.refresh(body));
  });
};
