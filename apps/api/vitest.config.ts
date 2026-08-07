import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.resolve(here, '..', '..', 'packages', name, 'src', 'index.ts');

export default defineConfig({
  // Workspace packages resolve to source, not dist: the suite then tests what is
  // in the tree rather than whatever was built last, and `pnpm test:isolation`
  // works without a build step. Types already come from src (package exports).
  resolve: {
    alias: {
      '@talon/contracts': pkg('contracts'),
      '@talon/domain': pkg('domain'),
      '@talon/testing': pkg('testing'),
      '@talon/db/migrate': path.resolve(here, '..', '..', 'packages', 'db', 'src', 'migrate.ts'),
      '@talon/db/seed': path.resolve(here, '..', '..', 'packages', 'db', 'src', 'seed.ts'),
      '@talon/db': pkg('db'),
    },
  },
  test: {
    globalSetup: './test/setup.global.ts',
    // One database, and the leak test deliberately runs a max-1 pool — serial.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
