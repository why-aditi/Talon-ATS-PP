import type { FastifyPluginAsync } from 'fastify';
import { applicationsModule } from './applications/index.js';
import { jobsModule } from './jobs/index.js';

// Every module plugin registers here. `pnpm gen:module <name>` scaffolds a module;
// adding it to this list is the one manual step (and puts it inside the
// authenticated scope automatically — see app.ts).
export const modules: FastifyPluginAsync[] = [applicationsModule, jobsModule];
