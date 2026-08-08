/**
 * Route definitions — spec 008 §6.1.
 *
 * No auth hook is attached here, ever. Protection comes from being registered inside
 * the authenticated scope (app.ts); a per-route hook would make its absence invisible
 * on the next route someone adds (CLAUDE.md §4.1).
 */
import {
  CommitImportResponseSchema,
  CreateImportRequestSchema,
  CreateImportResponseSchema,
  DryRunReportSchema,
  ImportAnalysisSchema,
  ImportMappingSchema,
  ImportParamsSchema,
} from '@talon/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { requireTx, requireUser, services } from '../../context.js';
import { parseOrThrow } from '../../errors.js';

export const importsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/imports', async (request, reply) => {
    const body = parseOrThrow(CreateImportRequestSchema, request.body, 'body');
    const result = await services(request).importsService.create(
      requireTx(request),
      requireUser(request),
      body,
    );
    return reply.code(201).send(CreateImportResponseSchema.parse(result));
  });

  app.post('/imports/:id/analyze', async (request, reply) => {
    const params = parseOrThrow(ImportParamsSchema, request.params, 'path');
    const analysis = await services(request).importsService.analyze(requireTx(request), params.id);
    return reply.send(ImportAnalysisSchema.parse(analysis));
  });

  app.post('/imports/:id/dry-run', async (request, reply) => {
    const params = parseOrThrow(ImportParamsSchema, request.params, 'path');
    const mapping = parseOrThrow(ImportMappingSchema, request.body, 'body');
    const report = await services(request).importsService.dryRun(requireTx(request), params.id, mapping);
    return reply.send(DryRunReportSchema.parse(report));
  });

  app.post('/imports/:id/commit', async (request, reply) => {
    const params = parseOrThrow(ImportParamsSchema, request.params, 'path');
    const mapping = parseOrThrow(ImportMappingSchema, request.body, 'body');
    const svc = services(request);
    await svc.importsService.commit(requireTx(request), requireUser(request), params.id, mapping);
    // Always returns the job, whether it ran inline or was deferred — the client
    // polls or streams the same way either way, so a 49-row and a 51-row import
    // present identically.
    const job = await svc.importsService.status(requireTx(request), params.id);
    return reply.code(202).send(CommitImportResponseSchema.parse({ job }));
  });

  app.get('/imports/:id', async (request, reply) => {
    const params = parseOrThrow(ImportParamsSchema, request.params, 'path');
    const job = await services(request).importsService.status(requireTx(request), params.id);
    return reply.send(CommitImportResponseSchema.parse({ job }));
  });
};
