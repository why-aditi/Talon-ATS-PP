/**
 * Route definitions. Schemas come from @talon/contracts — request and response both,
 * so a handler cannot invent a shape.
 *
 * No auth hook is attached here, ever. Protection comes from being registered inside
 * the authenticated scope (app.ts); a per-route hook would make its absence invisible
 * on the next route someone adds (CLAUDE.md §4).
 */
import {
  ApplicationCardSchema,
  ApplicationParamsSchema,
  BoardSchema,
  CreateApplicationBodySchema,
  CreateApplicationResponseSchema,
  GetBoardParamsSchema,
  MoveStageBodySchema,
  ReorderBodySchema,
} from '@talon/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { requireTx, requireUser, services } from '../../context.js';
import { parseOrThrow } from '../../errors.js';

export const applicationsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/jobs/:jobId/board', async (request, reply) => {
    const params = parseOrThrow(GetBoardParamsSchema, request.params, 'path');
    const board = await services(request).applicationsService.getBoard(requireTx(request), params.jobId);
    // Enforced on the way out, not assumed: zod strips anything the schema does not
    // declare, so a field added to a record later cannot leak through this route.
    return reply.send(BoardSchema.parse(board));
  });

  /**
   * Two routes, not one with an optional field. The separation is what makes
   * non-negotiable #18 structural: there is no path on which a reorder reaches the
   * write that bumps `version`.
   */
  app.patch('/applications/:id/stage', async (request, reply) => {
    const params = parseOrThrow(ApplicationParamsSchema, request.params, 'path');
    const body = parseOrThrow(MoveStageBodySchema, request.body, 'body');
    const card = await services(request).applicationsService.moveStage(
      requireTx(request),
      requireUser(request),
      params.id,
      body,
      { ip: request.ip, requestId: request.id },
    );
    // Writes return the full updated resource including its new version (CLAUDE.md §9).
    return reply.send(ApplicationCardSchema.parse(card));
  });

  app.patch('/applications/:id/rank', async (request, reply) => {
    const params = parseOrThrow(ApplicationParamsSchema, request.params, 'path');
    const body = parseOrThrow(ReorderBodySchema, request.body, 'body');
    const card = await services(request).applicationsService.reorder(
      requireTx(request),
      requireUser(request),
      params.id,
      body,
      { ip: request.ip, requestId: request.id },
    );
    return reply.send(ApplicationCardSchema.parse(card));
  });

  app.post('/applications', async (request, reply) => {
    const body = parseOrThrow(CreateApplicationBodySchema, request.body, 'body');
    const created = await services(request).applicationsService.createApplication(
      requireTx(request),
      requireUser(request),
      body,
      { ip: request.ip, requestId: request.id },
    );
    return reply
      .code(201)
      .header('location', `/v1/applications/${created.application.id}`)
      .send(CreateApplicationResponseSchema.parse(created));
  });
};
