import { useEffect, useRef, useState } from 'react';
import { useThemeStore } from '@/app/theme';
import { useOverview } from '@/data/queries';
import { useCountries } from '@/features/geo/countries';
import { prefersReducedMotion, useIntroStore } from '@/features/intro/introStore';
import { TIMELINE } from '@/features/intro/transition.config';
import { useI18n } from '@/i18n';
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
  /** Planet radius as a share of half the viewport's short side. */
  size: number;
}

/**
 * React shell around the imperative three.js scene: creates it once, feeds it data and the theme,
 * runs the dive when the intro machine enters `zoom`, stops rendering when scrolled out of view, and
 * tears everything down (GPU memory included) on unmount.
 */
export default function GlobeCanvas({ onPick, onHover, facingRef, onReady, onError, size }: GlobeCanvasProps) {
  const { m } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<EarthScene | null>(null);
  const handlers = useRef({ onPick, onHover, onReady });
  handlers.current = { onPick, onHover, onReady };
  const [ready, setReady] = useState(false);
  const countries = useCountries();
  const overview = useOverview();
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let scene: EarthScene;
    try {
      scene = new EarthScene(host, {
        quality: pickQuality(),
        reducedMotion: prefersReducedMotion(),
        theme: useThemeStore.getState().theme,
        onPick: (lat, lng, screen) => handlers.current.onPick(lat, lng, screen),
        onHoverEarth: (over) => handlers.current.onHover?.(over),
        onReady: () => {
          setReady(true);
          handlers.current.onReady?.();
        },
      });
    } catch (err) {
      console.warn('[kyzyl-aspan] 3D globe unavailable', err);
      onError?.();
      return;
    }
    sceneRef.current = scene;
    // Dev only: lets the console (and automated checks in a background tab) step the scene by hand.
    const devHandle = window as unknown as { __earth?: EarthScene };
    if (import.meta.env.DEV) devHandle.__earth = scene;
    if (facingRef) facingRef.current = () => scene.facing();
    scene.start();

    // Only render while the planet is on screen.
    const io = new IntersectionObserver(([entry]) => scene.setVisible(entry?.isIntersecting ?? true), { threshold: 0 });
    io.observe(host);

    const unsubscribe = useIntroStore.subscribe((s, prev) => {
      if (s.phase === 'zoom' && prev.phase !== 'zoom' && s.target) {
        void scene.diveTo(s.target.focus, TIMELINE[s.mode].zoom.duration);
      }
    });
    return () => {
      io.disconnect();
      unsubscribe();
      if (facingRef) facingRef.current = null;
      if (devHandle.__earth === scene) delete devHandle.__earth;
      sceneRef.current = null;
      scene.dispose();
    };
    // The scene is created once; callbacks go through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sceneRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (countries.data) sceneRef.current?.setCountries(countries.data.countries);
  }, [countries.data]);

  useEffect(() => {
    if (overview.data) sceneRef.current?.setFires(overview.data.points);
  }, [overview.data]);

  useEffect(() => {
    sceneRef.current?.setFrame({ x: 0, y: 0, size });
  }, [size]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={m.intro.globeLabel}
      className="absolute inset-0"
      style={{
        opacity: ready ? 1 : 0,
        transform: ready ? 'none' : 'scale(0.96)',
        transition: 'opacity 1100ms var(--el-ease-standard), transform 1400ms var(--el-ease-emphasized)',
      }}
    />
  );
}
