import { GetInterviewLoopParamsSchema, HoldLoopRequestSchema, HoldLoopResponseSchema, InterviewLoopSchema, SendLoopRequestSchema, SendLoopResponseSchema } from '@talon/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { requireTx, requireUser, services } from '../../context.js';
import { parseOrThrow } from '../../errors.js';

export const schedulingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/interview-loops/:id', async (request, reply) => {
    const { id } = parseOrThrow(GetInterviewLoopParamsSchema, request.params, 'path');
    const loop = await services(request).schedulingService.getLoop(requireTx(request), id);
    return reply.send(InterviewLoopSchema.parse(loop));
  });
  app.post('/interview-loops/:id/hold', async (request, reply) => {
    const { id } = parseOrThrow(GetInterviewLoopParamsSchema, request.params, 'path');
    const body = parseOrThrow(HoldLoopRequestSchema, request.body, 'body');
    const loop = await services(request).schedulingService.hold(requireTx(request), requireUser(request), id, body.arrangement, body.version);
    return reply.send(HoldLoopResponseSchema.parse({ loop }));
  });
  app.post('/interview-loops/:id/send', async (request, reply) => {
    const { id } = parseOrThrow(GetInterviewLoopParamsSchema, request.params, 'path');
    const body = parseOrThrow(SendLoopRequestSchema, request.body, 'body');
    const result = await services(request).schedulingService.send(requireTx(request), requireUser(request), id, body.arrangement, body.version, body.idempotencyKey);
    return reply.send(SendLoopResponseSchema.parse(result));
  });
};
