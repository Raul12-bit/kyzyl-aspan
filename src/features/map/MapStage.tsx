import type { Map as MLMap } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { parseAppParams } from '@/app/urlState';
import { introDispatch, useIntroStore, WORLD_BOUNDS } from '@/features/intro/introStore';
import { TIMELINE } from '@/features/intro/transition.config';
import { useI18n } from '@/i18n';
import { useThemeStore } from '@/app/theme';
import { loadBasemapStyle, retintBasemap } from './basemap';
import { addFireLayers, addHexLayers, addSelectionLayers, retintDataLayers } from './layers';
import { BASEMAP_ERROR_BUDGET, BASEMAP_STYLE_URL, uiPadding } from './map.config';
import { hasWebGL, useMapStore } from './mapStore';

type Bounds = [number, number, number, number];

/** Antimeridian boxes: express the eastern side past 180° so the camera does not span the globe. */
function unwrap(b: readonly number[]): Bounds {
  return b[0]! <= b[2]! ? [b[0]!, b[1]!, b[2]!, b[3]!] : [b[0]!, b[1]!, b[2]! + 360, b[3]!];
}

/** Where the map should be: the intro's landing target, else the shared area, else the whole world. */
function landingBounds(): Bounds {
  const target = useIntroStore.getState().target;
  if (target) return unwrap(target.bounds);
  const { bbox } = parseAppParams(new URLSearchParams(window.location.search));
  return unwrap(bbox ?? WORLD_BOUNDS);
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
 * The one and only MapLibre instance (mercator). It is created hidden while the 3D intro plays,
 * lands on the dive target under the white flash, then hosts the data layers for the map screen.
 */
export default function MapStage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { m } = useI18n();
  const label = m.map.label;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let map: MLMap | null = null;
    let styleReady = false;
    let pending: 'wait' | 'instant' | null = null;
    let tileErrors = 0;
    let unsubscribe: (() => void) | undefined;

    if (!hasWebGL()) {
      useMapStore.setState({ status: 'unsupported' });
      return;
    }
    useMapStore.setState({ status: 'loading' });

    /** B — under the white: final camera, interaction on; report back once tiles are idle. */
    const enterMapMode = (wait: boolean) => {
      if (!map) return;
      if (!styleReady) {
        pending = wait ? 'wait' : 'instant';
        return;
      }
      if (useMapStore.getState().mapMode) {
        // A second dive from the landing page: the map is already live, just move it to the new target.
        if (wait) {
          const b = landingBounds();
          const cam = map.cameraForBounds(
            [
              [b[0], b[1]],
              [b[2], b[3]],
            ],
            { padding: uiPadding(), maxZoom: 8 },
          );
          if (cam) map.jumpTo(cam);
          introDispatch({ type: 'SWAP_DONE' });
        }
        return;
      }
      map.stop();
      const b = landingBounds();
      const cam = map.cameraForBounds(
        [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        { padding: uiPadding(), maxZoom: 8 },
      );
      if (cam) map.jumpTo(cam);
      setInteractive(map, true);
      useMapStore.setState({ mapMode: true });
      if (!wait) return;
      const maxWait = TIMELINE[useIntroStore.getState().mode].swap.maxWait;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
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
      const b = landingBounds();
      map = new maplibregl.Map({
        container,
        style: basemap.style,
        bounds: [
          [b[0], b[1]],
          [b[2], b[3]],
        ],
        fitBoundsOptions: { padding: uiPadding(), maxZoom: 8 },
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
      // Never zoom out past one world width: no repeated continents on wide screens.
      const clampWorld = () => map?.setMinZoom(Math.max(0, Math.log2(container.clientWidth / 512)));
      clampWorld();
      map.on('resize', clampWorld);
      map.getCanvas().setAttribute('aria-label', label);
      setInteractive(map, false);
      useMapStore.setState({ map, basemapOk: basemap.ok });
      if (import.meta.env.DEV) (window as unknown as { __kyzylMap?: MLMap }).__kyzylMap = map;

      map.on('error', (e: { error?: Error; sourceId?: string }) => {
        const basemapTile = e.sourceId !== undefined && !e.sourceId.startsWith('el-');
        if (basemapTile) {
          tileErrors += 1;
          if (tileErrors === BASEMAP_ERROR_BUDGET) useMapStore.setState({ basemapOk: false });
          return;
        }
        console.warn('[kyzyl-aspan] map error:', e.error?.message ?? e);
      });

      map.once('style.load', () => {
        if (disposed || !map) return;
        styleReady = true;
        addSelectionLayers(map);
        addHexLayers(map);
        addFireLayers(map);
        const phase = useIntroStore.getState().phase;
        if (phase === 'done' || pending === 'instant') enterMapMode(false);
        else if (pending === 'wait' || phase === 'swap') enterMapMode(true);
        pending = null;
        useMapStore.setState({ status: 'ready' });
      });

      unsubscribe = useIntroStore.subscribe((s, prev) => {
        if (!map) return;
        // The target is chosen on Start: pre-position the hidden map so its tiles load during the dive.
        if (s.target && s.target !== prev.target && !useMapStore.getState().mapMode) {
          const t = unwrap(s.target.bounds);
          const cam = map.cameraForBounds(
            [
              [t[0], t[1]],
              [t[2], t[3]],
            ],
            { padding: uiPadding(), maxZoom: 8 },
          );
          if (cam) map.jumpTo(cam);
        }
        if (s.phase === prev.phase) return;
        if (s.phase === 'swap') enterMapMode(true);
        if (s.phase === 'done' && !useMapStore.getState().mapMode) enterMapMode(false);
      });
    })().catch((err: unknown) => {
      console.error('[kyzyl-aspan] map failed to start', err);
      useMapStore.setState({ status: 'error' });
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      map?.remove();
      useMapStore.setState({ map: null, status: 'idle', mapMode: false });
    };
    // The map is created exactly once; label updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch: repaint the live map from the new tokens (basemap and our own layers).
  const theme = useThemeStore((s) => s.theme);
  useEffect(() => {
    const map = useMapStore.getState().map;
    if (!map || !map.isStyleLoaded()) return;
    retintBasemap(map);
    retintDataLayers(map);
  }, [theme]);

  useEffect(() => {
    useMapStore.getState().map?.getCanvas().setAttribute('aria-label', label);
  }, [label]);

  // maplibre-gl.css forces `position: relative` on the container, so size it explicitly.
  return <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'transparent' }} />;
}
