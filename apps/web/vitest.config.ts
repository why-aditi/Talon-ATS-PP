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
  },
});
