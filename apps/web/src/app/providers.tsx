'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/**
 * ponytail: the mock worker is started unconditionally — there is no API to talk to
 * until the API stream lands, so a `NEXT_PUBLIC_MOCKS` flag would only ever hold one
 * value. Delete this hook, the `mocks/browser` module and the gate below together.
 */
function useMockServiceWorker(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void import('../mocks/browser')
      .then(({ worker }) => worker.start({ onUnhandledRequest: 'bypass', quiet: true }))
      .then(() => {
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

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
