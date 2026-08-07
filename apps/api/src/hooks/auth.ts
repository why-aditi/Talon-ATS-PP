import type { FastifyReply, FastifyRequest } from 'fastify';

// Stubs until step 4 (spec 001 §6). authenticate fails closed: every protected
// route 401s rather than silently passing until the real chain lands.
export async function authenticate(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await reply.code(401).send({
    type: 'urn:talon:error:auth-not-implemented',
    title: 'Unauthorized',
    status: 401,
  });
}

export async function resolveTenant(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // step 4: load user row by sub, attach request.user and request.tenantId
}

export async function openTenantTransaction(
  _req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // step 4: BEGIN; SET LOCAL app.tenant_id / app.user_id
}
