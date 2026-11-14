import { useEffect, useMemo, useRef, useState } from 'react';
import { useThemeStore } from '@/app/theme';
import { useOverview } from '@/data/queries';
import { useCountries } from '@/features/geo/countries';
import { useConstellation, useHeliosAvailable, type ConstellationResponse } from '@/features/helios/api';
import { prefersReducedMotion, useIntroStore } from '@/features/intro/introStore';
import { TIMELINE } from '@/features/intro/transition.config';
import { useI18n } from '@/i18n';
import { ConstellationCaption } from './ConstellationCaption';
import { shortStation } from './constellationText';
import { EarthScene, type Quality } from './EarthScene';

/** Phones, low-memory devices and data-saver mode get the light profile. */
function pickQuality(): Quality {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  if (nav.connection?.saveData) return 'low';
  if ((nav.deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4) return 'low';
  return coarse && Math.min(window.innerWidth, window.innerHeight) < 600 ? 'low' : 'high';
}

/** Start of the next laser handoff after step `from` (wrapping around): [step, satellite], or null. */
function nextHandoff(d: ConstellationResponse, from: number): [number, number] | null {
  const steps = d.states[0]?.length ?? 0;
  for (let k = 1; k <= steps; k++) {
    const t = (from + k) % steps;
    for (let i = 0; i < d.states.length; i++) {
      const list = d.states[i]!;
      if (list[t]?.[0] === 2 && (t === 0 || list[t - 1]?.[0] !== 2)) return [t, i];
    }
  }
  return null;
}

/** First step where the storm changed some satellite's decision (or its first pass over the station). */
function firstStormStep(base: ConstellationResponse, stormy: ConstellationResponse, stationIdx: number): number {
  const steps = stormy.states[0]?.length ?? 0;
  let pass = -1;
  for (let t = 0; t < steps; t++) {
    for (let i = 0; i < stormy.states.length; i++) {
      const a = base.states[i]?.[t];
      const b = stormy.states[i]?.[t];
      if (!a || !b) continue;
      if (a[0] !== b[0] && (a[2] === stationIdx || b[2] === stationIdx)) return t;
      if (pass < 0 && b[2] === stationIdx && b[0] !== 0) pass = t;
    }
  }
  return Math.max(0, pass);
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
 * tears everything down (GPU memory included) on unmount. With the real backend it also plays the three
 * satellites on their real orbits (AI #2 handing data over before a link drops) and captions it.
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
  const phase = useIntroStore((s) => s.phase);
  const reduced = useMemo(() => prefersReducedMotion(), []);

  const helios = useHeliosAvailable();
  const [storm, setStorm] = useState<string | null>(null);
  const base = useConstellation(helios, null);
  const stormy = useConstellation(helios && storm !== null, storm);
  // `storm=auto`: the server tries every station in use and storms the one where it changes the most.
  const stormData = storm !== null && stormy.data?.storm ? stormy.data : null;
  const live = stormData ?? base.data ?? null;
  const [tick, setTick] = useState({ index: 0, slow: false });
  const stormStation = stormData ? shortStation(stormData.stations.find((s) => s.id === stormData.storm)?.name) : null;
  const tickRef = useRef(tick);
  tickRef.current = tick;

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
        onConstellationTick: (index, slow) => setTick({ index, slow }),
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

  useEffect(() => {
    if (live) sceneRef.current?.setConstellation(live);
  }, [live]);

  // Storm switched on: jump to the first moment it changes a decision and turn the planet to the station
  // (once per switch-on, not on every 10-minute refetch).
  const seekedFor = useRef<string | null>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!stormData) {
      seekedFor.current = null;
      return;
    }
    if (!scene || !base.data || seekedFor.current === stormData.storm) return;
    const idx = stormData.stations.findIndex((s) => s.id === stormData.storm);
    const st = stormData.stations[idx];
    if (!st) return;
    seekedFor.current = stormData.storm;
    scene.seekConstellation(Math.max(0, firstStormStep(base.data, stormData, idx) - 2));
    scene.focusOn(st.lat, st.lon);
  }, [stormData, base.data]);

  const detections = overview.data && !overview.data.synthetic ? overview.data.detections : undefined;
  const hasHandoff = useMemo(() => !!live && nextHandoff(live, 0) !== null, [live]);

  // Judges' button: jump a few steps before the next laser handoff and turn the planet to it.
  const showNextHandoff = () => {
    const scene = sceneRef.current;
    if (!scene || !live) return;
    const hit = nextHandoff(live, tickRef.current.index + 3);
    if (!hit) return;
    const [t, i] = hit;
    scene.seekConstellation(Math.max(0, t - 3));
    const p = live.satellites[i]?.track[t];
    if (p) scene.focusOn(p[1], p[0]);
  };

  return (
    <>
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
      {live && ready && phase === 'intro' ? (
        <ConstellationCaption
          data={live}
          index={tick.index}
          slow={tick.slow}
          reducedMotion={reduced}
          detections={detections}
          stormStation={stormStation}
          stormOn={storm !== null}
          stormLoading={storm !== null && !stormData}
          onStorm={() => setStorm((s) => (s ? null : 'auto'))}
          onNextHandoff={hasHandoff ? showNextHandoff : undefined}
        />
      ) : null}
    </>
  );
}
