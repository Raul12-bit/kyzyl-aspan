import { createBrowserRouter } from 'react-router-dom';
import { MapScreen } from '@/features/map/MapScreen';
import { AppShell } from './AppShell';
import { NotFound, RouteError } from './RouteStates';

export const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <AppShell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <MapScreen /> },
        {
          path: 'analysis',
          lazy: async () => ({ Component: (await import('@/features/analysis/AnalysisPage')).AnalysisPage }),
        },
        {
          path: 'how-it-works',
          lazy: async () => ({ Component: (await import('@/features/how-it-works/HowItWorksPage')).HowItWorksPage }),
        },
        { path: '*', element: <NotFound /> },
      ],
    },
  ],
  {
    future: {
      v7_relativeSplatPath: true,
      v7_fetcherPersist: true,
      v7_normalizeFormMethod: true,
      v7_partialHydration: true,
      v7_skipActionErrorRevalidation: true,
    },
  },
);
