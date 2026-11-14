import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { createDataSource } from '@/data';
import { DataSourceProvider } from '@/data/DataSourceProvider';
import { useLocaleStore } from '@/i18n';
import { router } from './router';

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, gcTime: 30 * 60_000 },
        },
      }),
  );
  const [source] = useState(() => createDataSource());
  const locale = useLocaleStore((s) => s.locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <QueryClientProvider client={queryClient}>
      <DataSourceProvider source={source}>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </DataSourceProvider>
    </QueryClientProvider>
  );
}
