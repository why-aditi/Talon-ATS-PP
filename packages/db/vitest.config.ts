import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/setup.global.ts',
    // Tests share one local database and some rely on session state — run serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
