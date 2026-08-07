#!/usr/bin/env node
// pnpm gen:module <name> — scaffolds a compliant apps/api module (spec 001 §4.1).
// If creating a compliant module is harder than a non-compliant one, agents
// will create non-compliant ones.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error('usage: pnpm gen:module <name>   (lowercase, e.g. "jobs")');
  process.exit(1);
}
const pascal = name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
const camel = pascal[0].toLowerCase() + pascal.slice(1);

const dir = path.join('apps', 'api', 'src', 'modules', name);
if (existsSync(dir)) {
  console.error(`${dir} already exists`);
  process.exit(1);
}

const files = {
  'index.ts': `import type { FastifyPluginAsync } from 'fastify';
import { ${camel}Routes } from './routes.js';

// Plain plugin, not fastify-plugin: the module keeps its own encapsulation scope.
export const ${camel}Module: FastifyPluginAsync = async (app) => {
  await app.register(${camel}Routes);
};
`,
  'routes.ts': `import type { FastifyPluginAsync } from 'fastify';

// Route definitions. Schemas come from @talon/contracts.
export const ${camel}Routes: FastifyPluginAsync = async (_app) => {};
`,
  'service.ts': `// Orchestration; the only place transactions begin. Permission scopes are
// checked here, never in components.
export class ${pascal}Service {}
`,
  'repository.ts': `// The ONLY file in this module allowed to import @talon/db.
export class ${pascal}Repository {}
`,
  'container.ts': `import { asClass, type AwilixContainer } from 'awilix';
import { ${pascal}Repository } from './repository.js';
import { ${pascal}Service } from './service.js';

export function register${pascal}(container: AwilixContainer): void {
  container.register({
    ${camel}Service: asClass(${pascal}Service),
    ${camel}Repository: asClass(${pascal}Repository),
  });
}
`,
  'events.ts': `// Events this module publishes and subscribes to. Written to the outbox in the
// same transaction as the state change (spec 001 §8).
export const publishes: readonly string[] = [];
export const subscribes: readonly string[] = [];
`,
  'index.public.ts': `// The module's published interface — the only legal import target from other
// modules. Everything not exported here is private.
export {};
`,
};

await mkdir(dir, { recursive: true });
for (const [file, content] of Object.entries(files)) {
  await writeFile(path.join(dir, file), content);
}
console.log(`created ${dir}/{${Object.keys(files).join(',')}}`);
console.log(`next: add ${camel}Module to the modules list in apps/api/src/modules/index.ts`);
