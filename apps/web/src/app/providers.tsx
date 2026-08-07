'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { SessionProvider } from '../lib/session';

/**
 * The client itself is already real — `fetchJobs` is a plain `fetch` whose response is
 * parsed by the contract schema. MSW only intercepts the request, so pointing the app
 * at a live API is configuration, not a code change:
 *
 *     NEXT_PUBLIC_MOCKS=off NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm dev
 *
 * Mocks stay on by default because `GET /v1/jobs` has no handler yet — the jobs module
 * registers an empty plugin, and `authenticate` is a fail-closed stub that 401s every
 * protected route. Flip the default to `off` when step 4 lands; delete this hook and
 * `mocks/browser` when the endpoint is real.
 */
const MOCKS_ENABLED = process.env['NEXT_PUBLIC_MOCKS'] !== 'off';

function useMockServiceWorker(): boolean {
  const [ready, setReady] = useState(!MOCKS_ENABLED);
  useEffect(() => {
    if (!MOCKS_ENABLED) return;
    let cancelled = false;
    void import('../mocks/browser')
      .then(({ worker }) => worker.start({ onUnhandledRequest: 'bypass', quiet: true }))
      .then(() => {
        if (!cancelled) setReady(true);
      })
      // Without this the app renders nothing forever when the worker fails to
      // register — a stale mockServiceWorker.js after an msw bump does exactly that.
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Open question 3 (spec 001 §11): no realtime counts in M0a — the list
          // refetches on focus, and SSE arrives with the pipeline board.
          queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: true },
        },
      }),
  );

  // Rendering before the worker is listening would fire a real request at an API that
  // does not exist, and flash the error state on every cold load.
  const mocksReady = useMockServiceWorker();
  if (!mocksReady) return null;

  return (
    <QueryClientProvider client={client}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}
