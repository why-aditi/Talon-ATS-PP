/**
 * Route definitions. Schemas come from @talon/contracts — request and response
 * both, so a handler cannot invent a shape and a comp field cannot appear in a
 * payload just because a service put it there.
 *
 * No auth hook is attached here, ever. Protection comes from being registered
 * inside the authenticated scope (app.ts); a per-route hook would make its
 * absence invisible on the next route someone adds (CLAUDE.md §4).
 */
import { GetJobParamsSchema, JobSchema } from '@talon/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { requireTx, requireUser, services } from '../../context.js';
import { parseOrThrow } from '../../errors.js';

export const jobsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/jobs/:id', async (request, reply) => {
    const params = parseOrThrow(GetJobParamsSchema, request.params, 'path');
    const job = await services(request).jobsService.getJob(
      requireTx(request),
      requireUser(request),
      params.id,
    );
    // The response contract is enforced on the way out, not assumed: zod strips
    // anything the schema does not declare, so a field added to a record later
    // cannot leak through this route without a contract change.
    return reply.send(JobSchema.parse(job));
  });
};
