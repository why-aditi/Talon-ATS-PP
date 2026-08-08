/**
 * Route definitions. Schemas come from @talon/contracts — request and response
 * both, so a handler cannot invent a shape and a comp field cannot appear in a
 * payload just because a service put it there.
 *
 * No auth hook is attached here, ever. Protection comes from being registered
 * inside the authenticated scope (app.ts); a per-route hook would make its
 * absence invisible on the next route someone adds (CLAUDE.md §4).
 */
import {
  CreateJobRequestSchema,
  GetJobParamsSchema,
  JobSchema,
  ListJobsQuerySchema,
  ListJobsResponseSchema,
  ListStageTemplatesResponseSchema,
} from '@talon/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { requireTx, requireUser, services } from '../../context.js';
import { parseOrThrow } from '../../errors.js';

export const jobsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/jobs', async (request, reply) => {
    const query = parseOrThrow(ListJobsQuerySchema, request.query, 'query');
    const page = await services(request).jobsService.listJobs(
      requireTx(request),
      requireUser(request),
      query,
    );
    return reply.send(ListJobsResponseSchema.parse(page));
  });

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

  /* ── spec 005 ──────────────────────────────────────────────────────────── */

  app.get('/stage-templates', async (request, reply) => {
    const list = await services(request).jobsService.listStageTemplates(requireTx(request));
    return reply.send(ListStageTemplatesResponseSchema.parse(list));
  });

  app.post('/jobs', async (request, reply) => {
    const body = parseOrThrow(CreateJobRequestSchema, request.body, 'body');
    const job = await services(request).jobsService.createJob(
      requireTx(request),
      requireUser(request),
      body,
    );
    // 201 with a Location header (CLAUDE.md §9): writes return the full
    // resource, and the header is what makes it addressable without parsing it.
    return reply.code(201).header('location', `/v1/jobs/${job.id}`).send(JobSchema.parse(job));
  });
};
