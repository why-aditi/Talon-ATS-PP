/**
 * Public auth routes. Registered by `public-routes.ts`, i.e. OUTSIDE the
 * authenticated scope — you cannot present a token to the endpoint that issues
 * one. Both are listed in PUBLIC_ROUTES, which is the deliberate, visible act of
 * opting out (ARCHITECTURE §4.1).
 */
import type { FastifyPluginAsync } from 'fastify';
import { RefreshRequestSchema, SignInRequestSchema, SsoRequestSchema } from '@talon/contracts';
import { services } from '../../context.js';
import { parseOrThrow } from '../../errors.js';

export const identityRoutes: FastifyPluginAsync = async (app) => {
  app.post('/auth/sign-in', async (request, reply) => {
    const body = parseOrThrow(SignInRequestSchema, request.body, 'body');
    // `request.ip` is the socket peer: Fastify only trusts a forwarded header
    // when `trustProxy` is configured, and it is not. An attacker-settable
    // X-Forwarded-For in an audit trail is worse than no address at all.
    const audit = { ip: request.ip, requestId: request.id };
    return reply.send(await services(request).identityService.signIn(body, audit));
  });

  /**
   * Federated sign-in (spec 004 §11.3). Public for the same reason the other two are:
   * you cannot present a bearer token to the endpoint that issues one. Listed in
   * PUBLIC_ROUTES, and the route-manifest test fails CI if it is not — which is the
   * correct outcome if this step is ever forgotten.
   *
   * The audit context is NOT for a sign-in row — Cognito minted the id token and has
   * already recorded that authentication, and this endpoint exchanges an
   * already-proven identity rather than checking a credential of our own. It is here
   * for the one row this path can write: a `users` row created just in time
   * (`user.provisioned.jit`), which is a mutation and so must carry an actor, an ip
   * and a request id like every other (CLAUDE.md §4). With `TALON_JIT_PROVISION`
   * unset nothing is written and the context is unused.
   */
  app.post('/auth/sso', async (request, reply) => {
    const body = parseOrThrow(SsoRequestSchema, request.body, 'body');
    const audit = { ip: request.ip, requestId: request.id };
    return reply.send(await services(request).identityService.signInWithSso(body, audit));
  });

  app.post('/auth/refresh', async (request, reply) => {
    const body = parseOrThrow(RefreshRequestSchema, request.body, 'body');
    // Same reason as /auth/sso: the refresh itself writes no audit row, but a
    // first refresh for an allow-listed identity can create the `users` row.
    const audit = { ip: request.ip, requestId: request.id };
    return reply.send(await services(request).identityService.refresh(body, audit));
  });
};
