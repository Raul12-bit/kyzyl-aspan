import { useEffect, useMemo, useRef, useState } from 'react';
import { useOverview } from '@/data/queries';
import { useCountries } from '@/features/geo/countries';
import { useConstellation, useHeliosLive, type ConstellationResponse, type ConstellationScenario } from '@/features/helios/api';
import { prefersReducedMotion, useIntroStore } from '@/features/intro/introStore';
import { TIMELINE } from '@/features/intro/transition.config';
import { useI18n } from '@/i18n';
import { ConstellationCaption, type Scenario } from './ConstellationCaption';
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

/** Start of the next pass over the project region after step `from` (wrapping around): [step, satellite], or null. */
function nextRegionPass(d: ConstellationResponse, from: number): [number, number] | null {
  const passes = d.region.passes;
  const p = passes.find((x) => x.t_start > from) ?? passes[0];
  return p ? [p.t_start, p.sat] : null;
}

/** First step where a scenario changed some satellite's link or reception (-1: nowhere in the window). */
function firstChange(base: ConstellationResponse, other: ConstellationResponse): number {
  const steps = other.states[0]?.length ?? 0;
  for (let t = 0; t < steps; t++) {
    for (let i = 0; i < other.states.length; i++) {
      const a = base.states[i]?.[t];
      const b = other.states[i]?.[t];
      if (a && b && (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2])) return t;
    }
  }
  return -1;
}

/** McMurdo: NOAA's November 2026 notice (maintenance, delays for NOAA-20 and NOAA-21). */
const OUTAGE_STATION = 'MCMURDO';
const ASTANA = { lat: 51.169, lon: 71.449 };
const KZ_CENTRE = { lat: 48.0, lon: 67.0 };

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
 * React shell around the imperative three.js scene: creates it once, feeds it data,
 * runs the dive when the intro machine enters `zoom`, stops rendering when scrolled out of view, and
 * tears everything down (GPU memory included) on unmount. With the HELIOS server it also plays the five
 * satellites on their real orbits with their real ground stations — when each link ends, when data reach the
 * ground, which pass brings news of a fire in Kazakhstan first — and captions it.
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
  const phase = useIntroStore((s) => s.phase);
  const reduced = useMemo(() => prefersReducedMotion(), []);

  // The live satellites need only a reachable HELIOS server, not its fire archive.
  const helios = useHeliosLive();
  const [on, setOn] = useState<Record<Scenario, boolean>>({ storm: false, outage: false, db: false });
  const [lastOn, setLastOn] = useState<Scenario | null>(null);
  const anyOn = on.storm || on.outage || on.db;
  // `storm=auto`: the server tries every station in use and storms the one where it changes the most.
  const scenario: ConstellationScenario = { storm: on.storm ? 'auto' : null, outage: on.outage ? OUTAGE_STATION : null, db: on.db };
  const base = useConstellation(helios, { storm: null, outage: null, db: false });
  const alt = useConstellation(helios && anyOn, scenario);
  // While a new scenario loads, the query still holds the previous one: show it only once it matches.
  const altData =
    anyOn && alt.data && (on.storm ? alt.data.storm !== null : alt.data.storm === null) &&
    (alt.data.outage ?? null) === scenario.outage && alt.data.db === on.db
      ? alt.data
      : null;
  const live = altData ?? base.data ?? null;
  const loading: Scenario | null = anyOn && !altData ? (lastOn ?? (on.storm ? 'storm' : on.outage ? 'outage' : 'db')) : null;
  const [tick, setTick] = useState({ index: 0, slow: false });
  const stormStation = altData?.storm ? shortStation(altData.stations.find((s) => s.id === altData.storm)?.name) : null;
  const toggle = (s: Scenario) => {
    const turningOn = !on[s];
    setOn({ ...on, [s]: turningOn });
    setLastOn(turningOn ? s : null);
  };
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

  // A scenario switched on: jump to the first moment it changes a link and turn the planet to where it
  // happens (once per switch-on, not on every 10-minute refetch).
  const seekedFor = useRef<string | null>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!altData || !lastOn) {
      if (!altData) seekedFor.current = null;
      return;
    }
    const key = `${lastOn}|${altData.storm}|${altData.outage}|${altData.db}`;
    if (!scene || !base.data || seekedFor.current === key) return;
    seekedFor.current = key;
    const t = firstChange(base.data, altData);
    if (t >= 0) scene.seekConstellation(Math.max(0, t - 2));
    const focusId = lastOn === 'storm' ? altData.storm : lastOn === 'outage' ? OUTAGE_STATION : null;
    const st = focusId ? altData.stations.find((s) => s.id === focusId) : undefined;
    if (st) scene.focusOn(st.lat, st.lon);
    else if (lastOn === 'db') scene.focusOn(ASTANA.lat, ASTANA.lon);
  }, [altData, base.data, lastOn]);

  const detections = overview.data && !overview.data.synthetic ? overview.data.detections : undefined;
  const hasPass = useMemo(() => !!live && nextRegionPass(live, 0) !== null, [live]);

  // Judges' button: jump a few steps before the next pass over Kazakhstan and turn the planet to it.
  const showNextPass = () => {
    const scene = sceneRef.current;
    if (!scene || !live) return;
    const hit = nextRegionPass(live, tickRef.current.index + 2);
    if (!hit) return;
    scene.seekConstellation(Math.max(0, hit[0] - 3));
    scene.focusOn(KZ_CENTRE.lat, KZ_CENTRE.lon);
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
          on={on}
          loading={loading}
          onToggle={toggle}
          onNextPass={hasPass ? showNextPass : undefined}
        />
      ) : null}
    </>
  );
}
