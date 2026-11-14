import { useEffect, useRef, useState } from 'react';
import { useOverview } from '@/data/queries';
import { useCountries } from '@/features/geo/countries';
import { prefersReducedMotion, useIntroStore } from '@/features/intro/introStore';
import { TIMELINE } from '@/features/intro/transition.config';
import { useI18n } from '@/i18n';
import { BREAKPOINTS, useMediaQuery } from '@/lib/useMediaQuery';
import { EarthScene, type Quality } from './EarthScene';

/** Phones, low-memory devices and data-saver mode get the light profile. */
function pickQuality(): Quality {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  if (nav.connection?.saveData) return 'low';
  if ((nav.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4) return 'low';
  return coarse && Math.min(window.innerWidth, window.innerHeight) < 600 ? 'low' : 'high';
}

export interface GlobeCanvasProps {
  onPick: (lat: number, lng: number, screen: { x: number; y: number }) => void;
  onHover?: (over: boolean) => void;
  /** Lets the parent ask which point faces the viewer (CTA without a click on the planet). */
  facingRef?: React.MutableRefObject<(() => { lat: number; lng: number }) | null>;
  onReady?: () => void;
  onError?: () => void;
}

/**
 * React shell around the imperative three.js scene: creates it once, feeds it data, runs the dive
 * when the intro machine enters `zoom`, and tears everything down (GPU memory included) on unmount.
 */
export default function GlobeCanvas({ onPick, onHover, facingRef, onReady, onError }: GlobeCanvasProps) {
  const { m } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const modisRef = useRef<HTMLDivElement>(null);
  const viirsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<EarthScene | null>(null);
  const handlers = useRef({ onPick, onHover });
  handlers.current = { onPick, onHover };
  const [ready, setReady] = useState(false);
  const countries = useCountries();
  const overview = useOverview();
  const desktop = useMediaQuery(BREAKPOINTS.lg);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let scene: EarthScene;
    try {
      scene = new EarthScene(host, {
        quality: pickQuality(),
        reducedMotion: prefersReducedMotion(),
        labels: { MODIS: modisRef.current ?? undefined, VIIRS: viirsRef.current ?? undefined },
        onPick: (lat, lng, screen) => handlers.current.onPick(lat, lng, screen),
        onHoverEarth: (over) => handlers.current.onHover?.(over),
      });
    } catch (err) {
      console.warn('[kyzyl-aspan] 3D globe unavailable', err);
      onError?.();
      return;
    }
    sceneRef.current = scene;
    if (facingRef) facingRef.current = () => scene.facing();
    scene.start();
    // Two frames later the first image is on screen: fade the canvas in.
    const id = requestAnimationFrame(() => requestAnimationFrame(() => {
      setReady(true);
      onReady?.();
    }));

    // The dive is driven by the intro machine.
    const unsubscribe = useIntroStore.subscribe((s, prev) => {
      if (s.phase === 'zoom' && prev.phase !== 'zoom' && s.target) {
        void scene.diveTo(s.target.focus, TIMELINE[s.mode].zoom.duration);
      }
    });
    return () => {
      cancelAnimationFrame(id);
      unsubscribe();
      if (facingRef) facingRef.current = null;
      sceneRef.current = null;
      scene.dispose();
    };
    // The scene is created once; callbacks go through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (countries.data) sceneRef.current?.setCountries(countries.data.countries);
  }, [countries.data]);

  useEffect(() => {
    if (overview.data) sceneRef.current?.setFires(overview.data.points);
  }, [overview.data]);

  // Frame the planet beside the copy (desktop) or above it (phones and tablets).
  useEffect(() => {
    const apply = () => {
      const scene = sceneRef.current;
      if (!scene) return;
      if (desktop) scene.setFrame({ x: 0.23, y: 0.03, size: 0.64 });
      else {
        const tall = window.innerHeight / Math.max(1, window.innerWidth);
        scene.setFrame({ x: 0, y: tall > 1.5 ? -0.24 : -0.17, size: tall > 1.5 ? 0.82 : 0.5 });
      }
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [desktop]);

  const label = (ref: React.RefObject<HTMLDivElement>, sensor: 'MODIS' | 'VIIRS') => (
    <div
      ref={ref}
      aria-hidden
      className="sat-label pointer-events-none absolute left-0 top-0"
      data-hidden="true"
    >
      <span className="sat-label__dot" style={{ background: sensor === 'MODIS' ? 'var(--el-modis)' : 'var(--el-viirs)' }} />
      <span className="sat-label__name">{sensor === 'MODIS' ? m.intro.satModis : m.intro.satViirs}</span>
      <span className="sat-label__desc">{sensor === 'MODIS' ? '1 km' : '375 m'}</span>
    </div>
  );

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={m.intro.globeLabel}
      className="absolute inset-0"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 900ms var(--el-ease-standard)' }}
    >
      {label(modisRef, 'MODIS')}
      {label(viirsRef, 'VIIRS')}
    </div>
  );
}
