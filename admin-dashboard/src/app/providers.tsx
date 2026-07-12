'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Default staleTime is 0, so every route change or window
            // refocus refetches instantly even for data fetched moments
            // ago. 15s smooths that out; queries that need to poll (e.g.
            // useNotifications, the dashboard's refetchInterval) already
            // set their own interval and keep working the same.
            staleTime: 15_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
