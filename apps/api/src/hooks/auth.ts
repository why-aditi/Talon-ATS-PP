/**
 * The request chain (spec 001 §6.3). Registered ONCE, at plugin scope, in
 * app.ts — never on an individual route. A route is protected by where it is
 * registered, so adding one cannot silently opt out, and the route-manifest test
 * fails CI if one does (CLAUDE.md §4, ARCHITECTURE §4.1).
 *
 *   authenticate           onRequest    signature, audience, issuer, expiry
 *   resolveTenant          onRequest    users row by sub → request.user/tenantId
 *   openTenantTransaction  preHandler   BEGIN + SET LOCAL app.tenant_id/user_id
 *   finishTenantTransaction  onSend     COMMIT on 2xx/3xx, ROLLBACK otherwise
 */
import { ERROR_TYPES } from '@talon/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireIdentity, requireUser, services } from '../context.js';
import { HttpProblem } from '../errors.js';

export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (header === undefined || header.trim() === '') {
    throw new HttpProblem(
      401,
      ERROR_TYPES.UNAUTHENTICATED,
      'Unauthorized',
      'No bearer token was presented.',
    );
  }
  const [scheme, ...rest] = header.trim().split(/\s+/);
  const token = rest.join('');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length !== 1 || token === '') {
    throw new HttpProblem(
      401,
      ERROR_TYPES.UNAUTHENTICATED,
      'Unauthorized',
      'Authorization must be a single Bearer token.',
    );
  }
  request.identity = await services(request).identityService.verifyAccessToken(token);
}

export async function resolveTenant(request: FastifyRequest): Promise<void> {
  const identity = requireIdentity(request);
  // Also where `tokens_valid_after` is enforced: it needs the users row, which
  // is this hook's job to load. Rejection is a 401 either way, before any
  // handler runs, so the split changes nothing a caller can observe.
  const user = await services(request).identityService.resolveAuthenticatedUser(identity);
  request.user = user;
  request.tenantId = user.tenantId;
}

export async function openTenantTransaction(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const user = requireUser(request);
  const tx = await services(request).identityService.openTenantTransaction(user.tenantId, user.id);
  request.tx = tx;

  // Safety net for a client that disappears mid-handler: Fastify may never run
  // onSend for a socket that is already gone, and a reserved connection nobody
  // releases is a pool leak that ends with the service refusing to answer
  // (§9 edge case 10). Idempotent, so the normal path's commit still wins.
  reply.raw.on('close', () => {
    void tx.rollback().catch((err: unknown) => {
      request.log.error({ err }, 'failed to roll back an abandoned tenant transaction');
    });
  });
}

/**
 * Commit on 2xx/3xx, roll back on anything else — including the 500 produced by
 * a handler that threw, because the error handler has already turned it into a
 * response by the time this runs.
 */
export async function finishTenantTransaction(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  const tx = request.tx;
  if (!tx) return payload;
  if (reply.statusCode < 400) await tx.commit();
  else await tx.rollback();
  return payload;
}
