import type { FastifyPluginAsync } from 'fastify';
import { schedulingRoutes } from './routes.js';
export const schedulingModule: FastifyPluginAsync = async (app) => { await app.register(schedulingRoutes); };
