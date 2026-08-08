import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
    // undici rejects relative URLs, so the mock endpoint needs an origin under node.
    env: { NEXT_PUBLIC_API_URL: 'http://localhost:3000' },

    /*
      A bounded worker pool, because this suite ran the machine out of memory.

      Every file gets its own jsdom plus an axe run over a full component tree,
      which is tens of megabytes each — and `pnpm test` starts the other packages
      at the same time. Unbounded, vitest opened one worker per core and the
      whole thing died with "Zone Allocation failed - process out of memory"
      rather than a test failure, which reads as a broken suite instead of a
      resource limit.

      Four is enough to keep the suite quick and low enough to survive a loaded
      machine and a CI runner. Raise it when the runner has the headroom, not
      because it feels slow locally.
    */
    pool: 'threads',
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
  },
});
