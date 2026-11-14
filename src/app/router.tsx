import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './AppShell';
import { LazyMapScreen } from './LazyMapScreen';
import { NotFound, Redirect, RouteError } from './RouteStates';

export const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <AppShell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <LazyMapScreen /> },
        {
          path: 'mission',
          lazy: async () => ({ Component: (await import('@/features/mission/MissionPage')).MissionPage }),
        },
        {
          path: 'method',
          lazy: async () => ({ Component: (await import('@/features/method/MethodPage')).MethodPage }),
        },
        { path: 'how-it-works', element: <Redirect to="/method" /> },
        { path: 'analysis', element: <Redirect to="/" /> },
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
