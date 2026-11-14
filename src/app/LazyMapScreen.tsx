import { lazy, Suspense } from 'react';

const MapScreen = lazy(() => import('@/features/map/MapScreen').then((m) => ({ default: m.MapScreen })));

/**
 * The map UI (and h3-js) is its own chunk. Loading it with React.lazy instead of a lazy route keeps
 * the router from holding back the whole app — the intro globe paints immediately while it loads.
 */
export function LazyMapScreen() {
  return (
    <Suspense fallback={null}>
      <MapScreen />
    </Suspense>
  );
}
