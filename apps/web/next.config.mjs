import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  transpilePackages: ['@talon/tokens', '@talon/contracts'],

  /**
   * The browser calls `/v1/*` on its own origin and Next forwards it to the API.
   *
   * Without this the client fetches a relative `/v1/jobs`, which MSW answered in
   * development and the Next server 404s in reality — the jobs list rendered its
   * error state against a perfectly healthy API. The vertical slice is what caught
   * it, which is the argument for having one.
   *
   * Same-origin also means no CORS on the API and no preflight on every request,
   * and it keeps the access token travelling to our own origin rather than being
   * handed to a second one.
   */
  async rewrites() {
    const api = process.env['TALON_API_URL'] ?? 'http://localhost:3001';
    return [{ source: '/v1/:path*', destination: `${api}/v1/:path*` }];
  },
};
