import { useQueryClient } from '@tanstack/react-query';
import type { Map as MLMap } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { parseAppParams } from '@/app/urlState';
import { useDataSource } from '@/data/DataSourceContext';
import { queryKeys } from '@/data/queries';
import { introDispatch, prefersReducedMotion, setIntroMode, useIntroStore } from '@/features/intro/introStore';
import { GLOBE, introPadding, introZoom, TARGET_BOUNDS, TIMELINE } from '@/features/intro/transition.config';
import { useI18n } from '@/i18n';
import { bezier } from '@/lib/easing';
import { token } from '@/styles/tokens';
import { loadBasemapStyle } from './basemap';
import { addFireLayers, addIntroLayers, addSelectionLayers, setBasemapLabelsVisible, setIntroLayersVisible } from './layers';
import { BASEMAP_ERROR_BUDGET, BASEMAP_STYLE_URL, fitZoom, uiPadding } from './map.config';
import { hasWebGL, useMapStore } from './mapStore';

function currentAreaBounds(): [number, number, number, number] {
  const { bbox } = parseAppParams(new URLSearchParams(window.location.search));
  if (!bbox) return TARGET_BOUNDS;
  // Antimeridian boxes: fit the eastern side expressed past 180° so the camera does not span the globe.
  return bbox[0] <= bbox[2] ? [...bbox] : [bbox[0], bbox[1], bbox[2] + 360, bbox[3]];
}

function setInteractive(map: MLMap, on: boolean) {
  const handlers = [map.scrollZoom, map.boxZoom, map.dragPan, map.keyboard, map.doubleClickZoom, map.touchZoomRotate];
  for (const h of handlers) {
    if (on) h.enable();
    else h.disable();
  }
  if (on) {
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
  }
}

/**
 * The one and only MapLibre instance. It plays the intro globe, performs the dive, swaps to the
 * working mercator map under the white flash, and then hosts the data layers for the map screen.
 */
export default function MapStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const ds = useDataSource();
  const { m } = useI18n();
  const label = m.map.label;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let map: MLMap | null = null;
    let styleReady = false;
    let pending: 'wait' | 'instant' | null = null;
    let raf = 0;
    let tileErrors = 0;
    let unsubscribe: (() => void) | undefined;

    if (!hasWebGL()) {
      useMapStore.setState({ status: 'unsupported' });
      setIntroMode('fallback');
      return;
    }
    useMapStore.setState({ status: 'loading' });

    const stopRotation = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const startRotation = () => {
      if (raf || useIntroStore.getState().mode === 'reduced' || prefersReducedMotion()) return;
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (map && !document.hidden && !map.isMoving()) {
          const c = map.getCenter();
          map.jumpTo({ center: [c.lng + GLOBE.rotationSpeed * dt, c.lat] });
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };

    /** A — accelerate into Central Asia. Copy is already gone; the flash follows on the timer. */
    const dive = () => {
      if (!map) return;
      stopRotation();
      const t = TIMELINE.full.zoom;
      const bounds = currentAreaBounds();
      const padding = uiPadding();
      const canvas = map.getCanvas();
      const zoom = fitZoom(bounds, canvas.clientWidth, canvas.clientHeight, padding);
      map.easeTo({
        center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
        zoom: zoom + GLOBE.overshoot,
        // Padding animates from the intro layout (globe beside the copy) to the map layout.
        padding,
        duration: t.duration,
        easing: bezier(...t.easing),
        essential: true,
      });
    };

    /** B — under the white: projection, layers, final camera; report back once tiles are idle. */
    const enterMapMode = (wait: boolean) => {
      if (!map) return;
      if (!styleReady) {
        pending = wait ? 'wait' : 'instant';
        return;
      }
      if (useMapStore.getState().mapMode) {
        if (wait) introDispatch({ type: 'SWAP_DONE' });
        return;
      }
      stopRotation();
      map.stop();
      try {
        map.setProjection({ type: 'mercator' });
      } catch (err) {
        console.warn('[emberline] projection swap failed', err);
      }
      setIntroLayersVisible(map, false);
      setBasemapLabelsVisible(map, true);
      addSelectionLayers(map);
      addFireLayers(map);
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      const cam = map.cameraForBounds(currentAreaBounds(), { padding: uiPadding(), maxZoom: 9 });
      if (cam) map.jumpTo(cam);
      setInteractive(map, true);
      useMapStore.setState({ mapMode: true });
      if (!wait) return;
      const maxWait = TIMELINE[useIntroStore.getState().mode].swap.maxWait;
      const swapStarted = performance.now();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        if (import.meta.env.DEV) {
          console.debug(`[emberline] swap ready in ${Math.round(performance.now() - swapStarted)} ms (cap ${maxWait})`);
        }
        introDispatch({ type: 'SWAP_DONE' });
      };
      const timer = window.setTimeout(finish, maxWait);
      map.once('idle', finish);
    };

    (async () => {
      const [{ default: maplibregl }, basemap] = await Promise.all([
        import('maplibre-gl'),
        loadBasemapStyle(BASEMAP_STYLE_URL),
        import('maplibre-gl/dist/maplibre-gl.css'),
      ]);
      if (disposed) return;
      const intro = useIntroStore.getState();
      const playGlobe = intro.phase === 'intro' && intro.mode !== 'fallback';

      map = new maplibregl.Map({
        container,
        style: basemap.style,
        center: GLOBE.center,
        zoom: playGlobe ? introZoom(window.innerWidth, window.innerHeight) : 2,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxPitch: 0,
        renderWorldCopies: true,
        fadeDuration: 180,
        canvasContextAttributes: { antialias: true },
      });
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      map.getCanvas().setAttribute('aria-label', label);
      if (playGlobe) {
        setInteractive(map, false);
        map.setPadding(introPadding(window.innerWidth, window.innerHeight));
      }
      useMapStore.setState({ map, basemapOk: basemap.ok });
      if (import.meta.env.DEV) (window as unknown as { __emberlineMap?: MLMap }).__emberlineMap = map;

      map.on('error', (e: { error?: Error; sourceId?: string }) => {
        const basemapTile = e.sourceId !== undefined && !e.sourceId.startsWith('el-');
        if (basemapTile) {
          tileErrors += 1;
          if (tileErrors === BASEMAP_ERROR_BUDGET) useMapStore.setState({ basemapOk: false });
          return;
        }
        console.warn('[emberline] map error:', e.error?.message ?? e);
      });

      map.once('style.load', () => {
        if (disposed || !map) return;
        styleReady = true;
        const phase = useIntroStore.getState().phase;
        if (phase === 'intro' && playGlobe) {
          map.setProjection({ type: 'globe' });
          setBasemapLabelsVisible(map, false);
          const bg = token('--el-bg');
          map.setSky({
            'sky-color': bg,
            'horizon-color': '#16233f',
            'fog-color': bg,
            'sky-horizon-blend': 0.5,
            'horizon-fog-blend': 0.6,
            'fog-ground-blend': 0.8,
            'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.85, 7, 0],
          });
          startRotation();
          qc.fetchQuery({ queryKey: queryKeys.overview, queryFn: ({ signal }) => ds.getOverview({ signal }), staleTime: Infinity })
            .then((ov) => {
              if (map && !disposed && !useMapStore.getState().mapMode) addIntroLayers(map, ov.points);
            })
            .catch(() => {
              /* the globe is still worth showing without the glow */
            });
        } else if (phase === 'intro' || phase === 'done' || pending === 'instant') {
          enterMapMode(false);
        } else if (pending === 'wait' || phase === 'swap') {
          enterMapMode(true);
        } else {
          // Start was pressed before the style arrived (zoom/flash): the swap will come on its phase.
        }
        pending = null;
        useMapStore.setState({ status: 'ready' });
      });

      unsubscribe = useIntroStore.subscribe((s, prev) => {
        if (s.phase === prev.phase || !map) return;
        if (s.phase === 'zoom' && s.mode === 'full' && styleReady) dive();
        else if (s.phase === 'zoom') stopRotation();
        if (s.phase === 'swap') enterMapMode(true);
        if (s.phase === 'done' && !useMapStore.getState().mapMode) enterMapMode(false);
      });
    })().catch((err: unknown) => {
      console.error('[emberline] map failed to start', err);
      useMapStore.setState({ status: 'error' });
      setIntroMode('fallback');
    });

    return () => {
      disposed = true;
      stopRotation();
      unsubscribe?.();
      map?.remove();
      useMapStore.setState({ map: null, status: 'idle', mapMode: false });
    };
    // The map is created exactly once; label updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    useMapStore.getState().map?.getCanvas().setAttribute('aria-label', label);
  }, [label]);

  // maplibre-gl.css forces `position: relative` on the container, so size it explicitly.
  return <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'transparent' }} />;
}
