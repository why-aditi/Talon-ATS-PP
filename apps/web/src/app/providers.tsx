'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { SessionProvider } from '../lib/session';

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

  return (
    <QueryClientProvider client={client}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}
