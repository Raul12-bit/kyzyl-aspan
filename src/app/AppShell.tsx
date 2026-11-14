import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useDataSource } from '@/data/DataSourceContext';
import { queryKeys } from '@/data/queries';
import { loadCountries } from '@/features/geo/countries';
import { LocationPrompt } from '@/features/geo/LocationPrompt';
import { IntroOverlay } from '@/features/intro/IntroOverlay';
import { introSelectors } from '@/features/intro/introMachine';
import { introDispatch, useIntroStore, useIntroTimeline } from '@/features/intro/introStore';
import { Starfield } from '@/features/intro/Starfield';
import { TIMELINE } from '@/features/intro/transition.config';
import { useI18n } from '@/i18n';
import { TopBar } from './TopBar';

const MapStage = lazy(() => import('@/features/map/MapStage'));

export function AppShell() {
  const { m } = useI18n();
  const { pathname } = useLocation();
  const onMap = pathname === '/';
  const phase = useIntroStore((s) => s.phase);
  const mode = useIntroStore((s) => s.mode);
  const instant = useIntroStore((s) => s.instant);
  const uiMounted = useIntroStore(introSelectors.uiMounted);
  // The map is created on the first visit to "/" and then kept alive (hidden) across routes.
  const [mapRequested, setMapRequested] = useState(onMap);
  const qc = useQueryClient();
  const ds = useDataSource();

  useIntroTimeline();

  useEffect(() => {
    if (onMap) setMapRequested(true);
    // Leaving "/" before diving in (e.g. "Method") cancels the intro for this session.
    else if (useIntroStore.getState().phase === 'intro') introDispatch({ type: 'BYPASS' });
  }, [onMap]);

  // Warm the caches while the globe spins, so the map lands with data already in hand.
  useEffect(() => {
    void qc.prefetchQuery({ queryKey: queryKeys.overview, queryFn: ({ signal }) => ds.getOverview({ signal }), staleTime: Infinity });
    void qc.prefetchQuery({ queryKey: queryKeys.detections, queryFn: ({ signal }) => ds.getDetections({ signal }), staleTime: Infinity });
    void qc.prefetchQuery({ queryKey: ['countries'], queryFn: loadCountries, staleTime: Infinity });
  }, [qc, ds]);

  const introRunning = onMap && phase !== 'done';
  // The 3D planet owns the screen until the white flash; the map appears under the white.
  const mapHidden = phase === 'intro' || phase === 'zoom' || phase === 'flash';
  // "Landing": the map settles from a zoomed, blurred frame while the white fades out.
  const landing = onMap && phase === 'reveal' && !instant && mode !== 'reduced';

  return (
    <>
      <a href="#main" className="sr-only-focusable btn btn--primary btn--sm fixed left-4 top-4" style={{ zIndex: 90 }}>
        {m.app.skipToContent}
      </a>
      {onMap ? <Starfield visible={phase === 'intro' || phase === 'zoom'} /> : null}
      {mapRequested ? (
        <div
          className="fixed inset-0"
          style={{
            visibility: onMap && !mapHidden ? 'visible' : 'hidden',
            // MapLibre's controls set their own visibility; opacity hides them too while the globe plays.
            opacity: onMap && !mapHidden ? 1 : 0,
            pointerEvents: onMap && !mapHidden ? undefined : 'none',
            zIndex: 'var(--el-z-map)' as unknown as number,
            animation: landing ? `el-map-land ${TIMELINE[mode].reveal.duration}ms var(--el-ease-emphasized) both` : undefined,
            transformOrigin: '50% 50%',
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
      {introRunning ? <IntroOverlay /> : <LocationPrompt placement="page" />}
    </>
  );
}
