import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useDataSource } from '@/data/DataSourceContext';
import { queryKeys } from '@/data/queries';
import { IntroOverlay } from '@/features/intro/IntroOverlay';
import { introSelectors } from '@/features/intro/introMachine';
import { introDispatch, useIntroStore, useIntroTimeline } from '@/features/intro/introStore';
import { Starfield } from '@/features/intro/Starfield';
import { FULL_DATES, WORLD } from '@/features/map/map.config';
import { useI18n } from '@/i18n';
import { TopBar } from './TopBar';

const MapStage = lazy(() => import('@/features/map/MapStage'));

export function AppShell() {
  const { m } = useI18n();
  const { pathname } = useLocation();
  const onMap = pathname === '/';
  const phase = useIntroStore((s) => s.phase);
  const mode = useIntroStore((s) => s.mode);
  const uiMounted = useIntroStore(introSelectors.uiMounted);
  // The map is created on the first visit to "/" and then kept alive (hidden) across routes.
  const [mapRequested, setMapRequested] = useState(onMap);
  const qc = useQueryClient();
  const ds = useDataSource();

  useIntroTimeline();

  useEffect(() => {
    if (onMap) setMapRequested(true);
    // Leaving "/" before pressing Start (e.g. "How it works") cancels the intro for this session.
    else if (useIntroStore.getState().phase === 'intro') introDispatch({ type: 'BYPASS' });
  }, [onMap]);

  // Warm the caches while the intro plays, so the map lands with data already in hand.
  useEffect(() => {
    void qc.prefetchQuery({ queryKey: queryKeys.overview, queryFn: ({ signal }) => ds.getOverview({ signal }), staleTime: Infinity });
    void qc.prefetchQuery({
      queryKey: queryKeys.fires(WORLD, FULL_DATES),
      queryFn: ({ signal }) => ds.getFirePoints(WORLD, FULL_DATES, { signal }),
      staleTime: Infinity,
    });
  }, [qc, ds]);

  const introRunning = onMap && phase !== 'done';
  // In fallback mode the static sphere stands in for the globe until the flash hides the swap.
  const hideMapForFallback = mode === 'fallback' && (phase === 'intro' || phase === 'zoom' || phase === 'flash');

  return (
    <>
      <a
        href="#main"
        className="sr-only-focusable btn btn--primary btn--sm fixed left-4 top-4"
        style={{ zIndex: 90 }}
      >
        {m.app.skipToContent}
      </a>
      {onMap ? <Starfield visible={phase === 'intro' || phase === 'zoom'} /> : null}
      {mapRequested ? (
        <div
          className="fixed inset-0"
          style={{
            visibility: onMap && !hideMapForFallback ? 'visible' : 'hidden',
            zIndex: 'var(--el-z-map)' as unknown as number,
          }}
          aria-hidden={!onMap}
        >
          <Suspense fallback={null}>
            <MapStage />
          </Suspense>
        </div>
      ) : null}
      {!onMap || uiMounted ? <TopBar overMap={onMap} /> : null}
      <Outlet />
      {introRunning ? <IntroOverlay /> : null}
    </>
  );
}
