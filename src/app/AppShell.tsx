import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet, ScrollRestoration, useLocation, useNavigate } from 'react-router-dom';
import { useDataSource } from '@/data/DataSourceContext';
import { queryKeys } from '@/data/queries';
import { useAssistant } from '@/features/assistant/assistantStore';
import { loadCountries } from '@/features/geo/countries';
import { LocationPrompt } from '@/features/geo/LocationPrompt';
import { DiveFlash } from '@/features/intro/DiveFlash';
import { introSelectors } from '@/features/intro/introMachine';
import { introDispatch, useIntroStore, useIntroTimeline } from '@/features/intro/introStore';
import { TIMELINE } from '@/features/intro/transition.config';
import { useI18n } from '@/i18n';
import { TopBar } from './TopBar';

const MapStage = lazy(() => import('@/features/map/MapStage'));
const AssistantPanel = lazy(() => import('@/features/assistant/AssistantPanel'));

/** Warm the map's code while the planet dives, so it is parsed by the time the white lifts. */
export function preloadMap() {
  void import('@/features/map/MapStage');
  void import('@/features/map/MapScreen');
}

export function AppShell() {
  const { m } = useI18n();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const onMap = pathname === '/map';
  const onLanding = pathname === '/';
  const phase = useIntroStore((s) => s.phase);
  const mode = useIntroStore((s) => s.mode);
  const instant = useIntroStore((s) => s.instant);
  const uiMounted = useIntroStore(introSelectors.uiMounted);
  // The map is created on the first visit to /map (or when a dive starts) and then kept alive, hidden, across routes.
  const [mapRequested, setMapRequested] = useState(onMap);
  const qc = useQueryClient();
  const ds = useDataSource();
  const chatOpen = useAssistant((st) => st.open);

  useIntroTimeline();

  useEffect(() => {
    const p = useIntroStore.getState().phase;
    // Reaching the map any other way than the dive (a link, the header) skips the dive.
    if (onMap) {
      setMapRequested(true);
      if (p === 'intro') introDispatch({ type: 'BYPASS' });
    }
    // Back on the landing page: the planet can be dived into again.
    if (onLanding && p === 'done') introDispatch({ type: 'RESET' });
  }, [onMap, onLanding]);

  // The dive started: build the hidden map now so its tiles load during the plunge.
  useEffect(() => {
    if (phase === 'zoom') {
      preloadMap();
      setMapRequested(true);
    }
    // Under the white: switch the route. The map is already there, landing on the target.
    if (phase === 'swap' && !onMap) navigate({ pathname: '/map', search }, { replace: false });
  }, [phase, onMap, navigate, search]);

  // Warm the caches while the globe spins, so the map lands with data already in hand.
  useEffect(() => {
    void qc.prefetchQuery({ queryKey: queryKeys.overview, queryFn: ({ signal }) => ds.getOverview({ signal }), staleTime: Infinity });
    void qc.prefetchQuery({ queryKey: ['countries'], queryFn: loadCountries, staleTime: Infinity });
    if (onMap || phase === 'zoom') {
      void qc.prefetchQuery({ queryKey: queryKeys.detections, queryFn: ({ signal }) => ds.getDetections({ signal }), staleTime: Infinity });
    }
  }, [qc, ds, onMap, phase]);

  // During the dive the map stays hidden until the white flash covers the screen.
  const mapHidden = phase === 'intro' || phase === 'zoom' || phase === 'flash';
  const showMap = onMap && !mapHidden;
  // "Landing": the map settles from a zoomed, blurred frame while the white fades out.
  const landing = onMap && phase === 'reveal' && !instant && mode !== 'reduced';

  return (
    <>
      <a href="#main" className="sr-only-focusable btn btn--primary btn--sm fixed left-4 top-4" style={{ zIndex: 90 }}>
        {m.app.skipToContent}
      </a>
      {mapRequested ? (
        <div
          className="fixed inset-0"
          style={{
            visibility: showMap ? 'visible' : 'hidden',
            opacity: showMap ? 1 : 0,
            pointerEvents: showMap ? undefined : 'none',
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
      {!onMap || uiMounted ? <TopBar variant={onMap ? 'map' : onLanding ? 'landing' : 'page'} /> : null}
      <Outlet />
      <ScrollRestoration />
      <DiveFlash />
      {chatOpen ? (
        <Suspense fallback={null}>
          <AssistantPanel />
        </Suspense>
      ) : null}
      {phase === 'intro' || phase === 'done' ? <LocationPrompt placement={onLanding ? 'intro' : 'page'} /> : null}
    </>
  );
}
