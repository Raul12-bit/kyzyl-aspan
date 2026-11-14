import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { LanguageSwitch } from '@/app/LanguageSwitch';
import { Logo } from '@/app/Logo';
import { useCountries, findCountry } from '@/features/geo/countries';
import { useGeoStore } from '@/features/geo/geoStore';
import { LocationPrompt } from '@/features/geo/LocationPrompt';
import { hasWebGL, useMapStore } from '@/features/map/mapStore';
import { useI18n } from '@/i18n';
import { Button, Icon } from '@/ui';
import { FallbackGlobe } from './FallbackGlobe';
import { introSelectors } from './introMachine';
import { introDispatch, setIntroMode, useIntroStore, WORLD_BOUNDS, type IntroTarget } from './introStore';
import { cssEase, TIMELINE } from './transition.config';

const GlobeCanvas = lazy(() => import('@/features/globe/GlobeCanvas'));

function Accent({ text, accent }: { text: string; accent: string }) {
  const i = text.indexOf(accent);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="text-fire">{accent}</span>
      {text.slice(i + accent.length)}
    </>
  );
}

/** Centre of a [w, s, e, n] box, antimeridian-aware. */
function boxCentre(b: readonly [number, number, number, number]): { lat: number; lng: number } {
  const east = b[0] <= b[2] ? b[2] : b[2] + 360;
  let lng = (b[0] + east) / 2;
  if (lng > 180) lng -= 360;
  return { lat: (b[1] + b[3]) / 2, lng };
}

/**
 * The landing screen: the 3D planet, the pitch and the way in. A click on the planet (or the CTA)
 * dives into the visitor's country when it is known, otherwise into the whole world.
 */
export function IntroOverlay() {
  const { m, fmt } = useI18n();
  const phase = useIntroStore((s) => s.phase);
  const mode = useIntroStore((s) => s.mode);
  const canSkip = useIntroStore(introSelectors.canSkip);
  const mapStatus = useMapStore((s) => s.status);
  const geoCountry = useGeoStore((s) => s.country);
  const countries = useCountries();
  const [webgl] = useState(() => hasWebGL());
  const [hovering, setHovering] = useState(false);
  const [burst, setBurst] = useState<{ x: number; y: number; key: number } | null>(null);
  const facingRef = useRef<(() => { lat: number; lng: number }) | null>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const t = TIMELINE[mode];
  const copyVisible = phase === 'intro';
  const country = findCountry(countries.data, geoCountry);

  useEffect(() => {
    if (!webgl) setIntroMode('fallback');
  }, [webgl]);

  // Without a map (no WebGL or a crash) nobody else will confirm the swap.
  useEffect(() => {
    if (phase === 'swap' && (mapStatus === 'unsupported' || mapStatus === 'error')) introDispatch({ type: 'SWAP_DONE' });
  }, [phase, mapStatus]);

  useEffect(() => {
    if (phase === 'intro') ctaRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const start = useCallback(
    (picked?: { lat: number; lng: number }) => {
      if (useIntroStore.getState().phase !== 'intro') return;
      const target: IntroTarget = country
        ? { country: country.id, bounds: [...country.bbox] as IntroTarget['bounds'], focus: boxCentre(country.bbox) }
        : { country: null, bounds: WORLD_BOUNDS, focus: picked ?? facingRef.current?.() ?? { lat: 30, lng: 60 } };
      useIntroStore.getState().setTarget(target);
      introDispatch({ type: 'START' });
    },
    [country],
  );

  const overlayStyle: CSSProperties = {
    background: t.flash.color,
    zIndex: 'var(--el-z-flash)' as unknown as number,
    opacity: phase === 'flash' || phase === 'swap' ? 1 : 0,
    transition:
      phase === 'flash'
        ? `opacity ${t.flash.rise}ms ${cssEase(t.flash.easing)}`
        : phase === 'reveal'
          ? `opacity ${t.reveal.duration}ms ${cssEase(t.reveal.easing)}`
          : 'none',
    pointerEvents: phase === 'flash' || phase === 'swap' ? 'auto' : 'none',
  };

  // The copy steps aside fast as the dive begins (reduced motion: a plain fade).
  const copyStyle: CSSProperties = {
    opacity: copyVisible ? 1 : 0,
    transform: copyVisible || mode === 'reduced' ? 'none' : 'translate3d(-24px, 0, 0)',
    visibility: copyVisible ? 'visible' : 'hidden',
    transition: copyVisible
      ? 'none'
      : `opacity 200ms ease, transform 260ms var(--el-ease-in), visibility 0s linear 260ms`,
  };

  const showGlobe = phase === 'intro' || phase === 'zoom' || phase === 'flash';
  const targetText = country ? m.intro.targetCountry(fmt.country(country.id, country.name)) : m.intro.targetWorld;

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ zIndex: 'var(--el-z-intro)' as unknown as number }}>
      {/* Deep-space backdrop with the brand's red horizon glow. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(70% 60% at 72% 55%, rgb(255 82 54 / 0.10), transparent 70%), radial-gradient(50% 40% at 15% 100%, rgb(61 90 200 / 0.10), transparent 70%)',
          opacity: showGlobe ? 1 : 0,
          transition: 'opacity 300ms ease',
        }}
      />

      {showGlobe ? (
        webgl && mode !== 'fallback' ? (
          <Suspense fallback={null}>
            <GlobeCanvas
              facingRef={facingRef}
              onHover={setHovering}
              onError={() => setIntroMode('fallback')}
              onPick={(lat, lng, screen) => {
                setBurst({ ...screen, key: Date.now() });
                start({ lat, lng });
              }}
            />
          </Suspense>
        ) : (
          <button
            type="button"
            className="absolute inset-0 cursor-pointer border-0 bg-transparent p-0"
            aria-label={m.intro.cta}
            onClick={() => start()}
            tabIndex={-1}
          >
            <FallbackGlobe diving={phase === 'zoom'} />
          </button>
        )
      ) : null}

      {burst ? (
        <span
          key={burst.key}
          aria-hidden
          className="pointer-events-none absolute h-24 w-24 rounded-full"
          style={{
            left: burst.x,
            top: burst.y,
            border: '2px solid rgb(255 140 80 / 0.9)',
            boxShadow: '0 0 40px rgb(255 82 54 / 0.7), inset 0 0 30px rgb(255 178 74 / 0.5)',
            animation: 'el-flash-ring 700ms var(--el-ease-emphasized) forwards',
            zIndex: 2,
          }}
        />
      ) : null}

      <div
        className="pointer-events-none absolute inset-0 flex flex-col px-[var(--el-gutter)] pb-[calc(env(safe-area-inset-bottom)+20px)] pt-4 md:px-12 md:pb-10 md:pt-7 lg:px-16"
        style={copyStyle}
      >
        <div className="pointer-events-auto flex items-center justify-between gap-3">
          <Logo size={28} />
          <LanguageSwitch />
        </div>

        <main
          id="main"
          className="pointer-events-none mt-auto max-w-[620px] lg:mb-auto lg:mt-auto"
          aria-labelledby="intro-title"
        >
          <p className="eyebrow m-0 mb-4 hidden !text-ink-muted sm:block md:mb-5">{m.intro.eyebrow}</p>
          <h1
            id="intro-title"
            className="display m-0 text-ink"
            style={{ fontSize: 'clamp(1.6rem, 3.6vw + 0.75rem, 4.1rem)' }}
          >
            <Accent text={m.intro.title} accent={m.intro.titleAccent} />
          </h1>
          <div className="orbit-rule mt-4 w-20 md:mt-7 md:w-24" aria-hidden />
          <p className="mb-0 mt-3 line-clamp-3 max-w-[520px] text-[14px] leading-[1.55] text-ink-muted sm:line-clamp-none md:mt-5 md:text-[17px] md:leading-[1.6]">{m.intro.lead}</p>
          <div className="pointer-events-auto mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 md:mt-8">
            <Button ref={ctaRef} variant="primary" size="lg" iconRight="arrowRight" onClick={() => start()} disabled={!copyVisible}>
              {m.intro.cta}
            </Button>
            <Link to="/method?intro=0" className="btn btn--quiet btn--lg " tabIndex={copyVisible ? 0 : -1}>
              {m.intro.method}
            </Link>
          </div>
          <p className="m-0 mt-4 flex items-center gap-2 text-[12.5px] text-ink-dim">
            <Icon name={country ? 'pin' : 'globe'} size={14} className="text-kyzyl" />
            {targetText}
          </p>
        </main>

        <div className="pointer-events-auto mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 md:mt-8">
          <ul className="m-0 hidden list-none flex-wrap gap-x-6 gap-y-2 p-0 text-[12px] md:flex">
            <li className="flex items-center gap-2">
              <span aria-hidden className="h-2 w-2 rounded-[2px] bg-modis" />
              <span className="num font-medium tracking-[0.08em] text-ink">{m.intro.satModis}</span>
              <span className="text-ink-dim">{m.intro.satModisDesc}</span>
            </li>
            <li className="flex items-center gap-2">
              <span aria-hidden className="h-2 w-2 rounded-full bg-viirs" />
              <span className="num font-medium tracking-[0.08em] text-ink">{m.intro.satViirs}</span>
              <span className="text-ink-dim">{m.intro.satViirsDesc}</span>
            </li>
          </ul>
          <p className="m-0 flex items-center gap-2 text-[12px] text-ink-dim">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-trust-medium" />
            {m.app.synthetic}
          </p>
        </div>
      </div>

      {/* Interaction hint, pinned near the planet; lights up while the pointer is over it. */}
      {copyVisible && webgl && mode !== 'fallback' ? (
        <p
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[calc(50%-36vh)] m-0 hidden -translate-x-1/2 items-center gap-2 rounded-pill border border-line bg-[rgb(5_7_13/0.5)] px-3 py-1.5 text-[12px] text-ink-muted backdrop-blur-md lg:left-[71%] lg:top-auto lg:bottom-[9vh] lg:flex"
          style={{
            borderColor: hovering ? 'rgb(255 82 54 / 0.55)' : undefined,
            color: hovering ? 'var(--el-ink)' : undefined,
            transition: 'border-color 200ms ease, color 200ms ease',
          }}
        >
          <Icon name="crosshair" size={14} className="text-kyzyl" />
          {m.intro.clickHint}
        </p>
      ) : null}

      {copyVisible ? <LocationPrompt placement="intro" /> : null}

      <div aria-hidden className="absolute inset-0" style={overlayStyle} />

      {canSkip ? (
        <button
          type="button"
          onClick={() => introDispatch({ type: 'SKIP' })}
          aria-label={m.intro.skipHint}
          className="btn btn--sm absolute right-[var(--el-gutter)] top-5 border border-[rgb(5_7_13/0.18)] bg-[rgb(5_7_13/0.55)] text-ink backdrop-blur-md hover:bg-[rgb(5_7_13/0.75)] md:right-12 md:top-8"
          style={{ zIndex: 'var(--el-z-skip)' as unknown as number }}
        >
          {m.intro.skip}
          <Icon name="chevronRight" size={16} />
        </button>
      ) : null}
    </div>
  );
}
