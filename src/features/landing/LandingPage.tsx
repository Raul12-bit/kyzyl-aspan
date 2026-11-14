import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Wordmark } from '@/app/Logo';
import { findCountry, useCountries } from '@/features/geo/countries';
import { useGeoStore } from '@/features/geo/geoStore';
import { FallbackGlobe } from '@/features/intro/FallbackGlobe';
import {
  introDispatch,
  prefersReducedMotion,
  setIntroMode,
  useIntroStore,
  WORLD_BOUNDS,
  type IntroTarget,
} from '@/features/intro/introStore';
import { hasWebGL } from '@/features/map/mapStore';
import { useI18n } from '@/i18n';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { ButtonLink, Icon } from '@/ui';
import { diveBridge } from './diveBridge';
import { BriefVisual, HexVisual, NoiseVisual, OrbitArt } from './visuals';
import './landing.css';

const GlobeCanvas = lazy(() => import('@/features/globe/GlobeCanvas'));

/* ------------------------------------------------------------------ helpers */

/** Centre of a [w, s, e, n] box, antimeridian-aware. */
function boxCentre(b: readonly [number, number, number, number]): { lat: number; lng: number } {
  const east = b[0] <= b[2] ? b[2] : b[2] + 360;
  let lng = (b[0] + east) / 2;
  if (lng > 180) lng -= 360;
  return { lat: (b[1] + b[3]) / 2, lng };
}

/** Reveals every `[data-rv]` element inside `root` once it scrolls into view (one shared observer). */
function useRevealAll(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const items = Array.from(host.querySelectorAll<HTMLElement>('[data-rv]'));
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => (el.dataset.rv = 'in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.rv = 'in';
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [root]);
}

/**
 * Writes a 0…1 scroll progress into a CSS variable on `el`, at most once per frame, and only while
 * the page scrolls. `measure` maps the element's rect to progress.
 */
function useScrollVar(
  ref: React.RefObject<HTMLElement>,
  name: string,
  measure: (rect: DOMRect, vh: number) => number,
) {
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let last = -1;
    const update = () => {
      raf = 0;
      const p = Math.max(0, Math.min(1, measureRef.current(el.getBoundingClientRect(), window.innerHeight)));
      const rounded = Math.round(p * 1000) / 1000;
      if (rounded !== last) {
        last = rounded;
        el.style.setProperty(name, String(rounded));
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ref, name]);
}

/** Splits a sentence into words (Intl.Segmenter handles Chinese), marking the ones inside `accent`. */
function splitWords(text: string, accent: string, locale: string): { text: string; accent: boolean }[] {
  const start = accent ? text.indexOf(accent) : -1;
  const end = start >= 0 ? start + accent.length : -1;
  const Seg = (
    Intl as unknown as {
      Segmenter?: new (
        l: string,
        o: { granularity: 'word' },
      ) => { segment: (s: string) => Iterable<{ segment: string; index: number }> };
    }
  ).Segmenter;
  const parts: { text: string; index: number }[] = [];
  if (Seg) {
    for (const s of new Seg(locale, { granularity: 'word' }).segment(text))
      parts.push({ text: s.segment, index: s.index });
  } else {
    let i = 0;
    for (const w of text.split(/(\s+)/)) {
      parts.push({ text: w, index: i });
      i += w.length;
    }
  }
  // Glue punctuation and spaces to the preceding word so they fade together.
  const words: { text: string; accent: boolean }[] = [];
  for (const p of parts) {
    const inAccent = start >= 0 && p.index >= start && p.index < end;
    const isWord = /[\p{L}\p{N}]/u.test(p.text);
    const prev = words[words.length - 1];
    if (!isWord && prev) prev.text += p.text;
    else words.push({ text: p.text, accent: inAccent });
  }
  return words;
}

function Accent({ text, accent }: { text: string; accent: string }) {
  const i = accent ? text.indexOf(accent) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="lp-accent">{accent}</span>
      {text.slice(i + accent.length)}
    </>
  );
}

/** Deterministic star dust behind the planet (dark theme only; hidden by a token in light). */
function HeroStars() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      let seed = 1337;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      const count = Math.round((w * h) / 3200);
      for (let i = 0; i < count; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const r = rnd() ** 3 * 1.1 + 0.25;
        ctx.fillStyle = `rgba(238, 233, 224, ${0.12 + rnd() * 0.5})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);
  return (
    <canvas ref={ref} aria-hidden className="lp-hero__stars" style={{ width: '100%', height: '100%' }} />
  );
}

/* ------------------------------------------------------------------ hero */

function Hero() {
  const { m } = useI18n();
  const phase = useIntroStore((s) => s.phase);
  const mode = useIntroStore((s) => s.mode);
  const geoCountry = useGeoStore((s) => s.country);
  const countries = useCountries();
  const [webgl] = useState(() => hasWebGL());
  const [hover, setHover] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);
  const facingRef = useRef<(() => { lat: number; lng: number }) | null>(null);
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)');
  const phone = useMediaQuery('(max-width: 640px)');
  const country = findCountry(countries.data, geoCountry);

  useEffect(() => {
    if (!webgl) setIntroMode('fallback');
  }, [webgl]);

  useScrollVar(heroRef, '--hero-p', (rect, vh) => -rect.top / vh);

  const start = useCallback(
    (picked?: { lat: number; lng: number }) => {
      if (useIntroStore.getState().phase !== 'intro') return;
      const target: IntroTarget = country
        ? {
            country: country.id,
            bounds: [...country.bbox] as IntroTarget['bounds'],
            focus: boxCentre(country.bbox),
          }
        : {
            country: null,
            bounds: WORLD_BOUNDS,
            focus: picked ?? facingRef.current?.() ?? { lat: 30, lng: 60 },
          };
      useIntroStore.getState().setTarget(target);
      // The dive is filmed from the top of the page.
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      introDispatch({ type: 'START' });
    },
    [country],
  );

  // The header's "Open map" dives too while the planet is on screen.
  useEffect(() => {
    diveBridge.start = () => start();
    return () => {
      diveBridge.start = null;
    };
  }, [start]);

  // The cursor hint follows the pointer with transforms only (no re-render per move).
  useEffect(() => {
    if (!finePointer) return;
    const onMove = (e: PointerEvent) => {
      const el = hintRef.current;
      if (el) el.style.transform = `translate3d(${e.clientX + 18}px, ${e.clientY + 18}px, 0)`;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [finePointer]);

  const showGlobe = phase === 'intro' || phase === 'zoom' || phase === 'flash';
  const fallback = !webgl || mode === 'fallback';

  return (
    <section ref={heroRef} className="lp-hero" aria-label={m.intro.globeLabel}>
      <div className="lp-hero__stage">
        <HeroStars />
        <div className="lp-hero__halo" aria-hidden />
        <div className="lp-hero__shadow" aria-hidden />
        {showGlobe ? (
          fallback ? (
            <button
              type="button"
              className="absolute inset-0 cursor-pointer border-0 bg-transparent p-0"
              aria-label={m.landing.heroHint}
              onClick={() => start()}
            >
              <FallbackGlobe diving={phase === 'zoom'} />
            </button>
          ) : (
            <Suspense fallback={null}>
              <GlobeCanvas
                size={phone ? 0.84 : 0.7}
                facingRef={facingRef}
                onHover={setHover}
                onError={() => setIntroMode('fallback')}
                onPick={(lat, lng) => start({ lat, lng })}
              />
            </Suspense>
          )
        ) : null}
      </div>

      {/* Keyboard and screen-reader way in: the planet itself is a pointer target. */}
      <button
        type="button"
        className="sr-only-focusable btn btn--primary btn--sm absolute left-1/2 top-[calc(var(--el-header-h)+16px)] -translate-x-1/2"
        onClick={() => start()}
      >
        {m.intro.cta}
      </button>

      {finePointer && !fallback ? (
        <span
          ref={hintRef}
          className="lp-hint"
          data-on={hover && phase === 'intro' ? 'true' : 'false'}
          aria-hidden
        >
          <span className="lp-hint__dot" />
          {m.landing.heroHint}
        </span>
      ) : null}

      <a href="#lp-start" className="lp-scroll">
        {m.landing.scroll}
        <span className="lp-scroll__line" aria-hidden />
      </a>
    </section>
  );
}

/* ------------------------------------------------------------------ sections */

function Statement() {
  const { m, locale } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const s = m.landing.statement;
  const words = useMemo(() => splitWords(s.title, s.accent, locale), [s.title, s.accent, locale]);
  // Words light up while the paragraph travels from the bottom of the screen to its upper third.
  useScrollVar(ref, '--p', (rect, vh) => (vh * 0.92 - rect.top) / (vh * 0.62));
  return (
    <section
      ref={ref}
      id="lp-start"
      className="lp-statement"
      style={{ ['--n' as string]: words.length } as CSSProperties}
    >
      <div className="lp-wrap">
        <p className="lp-eyebrow" data-rv>
          {s.eyebrow}
        </p>
        <h1 className="lp-statement__text" aria-label={s.title}>
          {words.map((w, i) => (
            <span
              key={i}
              aria-hidden
              className={w.accent ? 'lp-word lp-accent' : 'lp-word'}
              style={{ ['--i' as string]: i } as CSSProperties}
            >
              {w.text}
            </span>
          ))}
        </h1>
      </div>
    </section>
  );
}

const VISUALS = [HexVisual, NoiseVisual, BriefVisual];
/** Language-neutral captions (instrument and product names only). */
const TAGS = ['H3 · res 6', 'MODIS × VIIRS', 'Gemini · rules'];

function What() {
  const { m } = useI18n();
  const w = m.landing.what;
  return (
    <section className="lp-section" aria-labelledby="lp-what">
      <div className="lp-wrap">
        <header className="lp-head">
          <p className="lp-eyebrow" data-rv>
            {w.eyebrow}
          </p>
          <h2 id="lp-what" className="lp-h2" data-rv style={{ ['--d' as string]: 1 } as CSSProperties}>
            <Accent text={w.title} accent={w.accent} />
          </h2>
        </header>
        {w.items.map((item, i) => {
          const Visual = VISUALS[i] ?? HexVisual;
          return (
            <article key={item.title} className="lp-feature" data-flip={i % 2 === 1 ? 'true' : 'false'}>
              <div className="lp-feature__copy" data-rv>
                <span className="lp-feature__index">
                  <b>{String(i + 1).padStart(2, '0')}</b>
                  {item.kicker}
                </span>
                <h3 className="lp-h3">{item.title}</h3>
                <p className="lp-lead">{item.body}</p>
                <div className="mt-2">
                  <Link to="/map" className="lp-link">
                    {w.cta}
                    <Icon name="arrowRight" size={16} />
                  </Link>
                </div>
              </div>
              <div className="lp-frame" data-rv style={{ ['--d' as string]: 1 } as CSSProperties}>
                <Visual />
                <span className="lp-frame__tag">{TAGS[i]}</span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Numbers() {
  const { m } = useI18n();
  const n = m.landing.numbers;
  return (
    <section className="lp-section" aria-labelledby="lp-numbers">
      <div className="lp-wrap">
        <header className="lp-head !mb-10">
          <p id="lp-numbers" className="lp-eyebrow" data-rv>
            {n.eyebrow}
          </p>
        </header>
        <div className="lp-numbers">
          {n.items.map((item, i) => (
            <div
              key={item.label}
              className="lp-number"
              data-rv
              style={{ ['--d' as string]: i } as CSSProperties}
            >
              <span className="lp-number__value">
                {item.value}
                {item.unit ? <span className="lp-number__unit">{item.unit}</span> : null}
              </span>
              <p className="lp-number__label">{item.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function How() {
  const { m } = useI18n();
  const h = m.landing.how;
  return (
    <section className="lp-section" aria-labelledby="lp-how">
      <div className="lp-wrap">
        <header className="lp-head">
          <p className="lp-eyebrow" data-rv>
            {h.eyebrow}
          </p>
          <h2 id="lp-how" className="lp-h2" data-rv style={{ ['--d' as string]: 1 } as CSSProperties}>
            {h.title}
          </h2>
        </header>
        <ol className="lp-steps">
          {m.method.steps.map((step, i) => (
            <li
              key={step.title}
              className="lp-step"
              data-rv
              style={{ ['--d' as string]: i } as CSSProperties}
            >
              <span className="lp-step__n">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="lp-step__title">{step.title}</h3>
              <p className="lp-step__body">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-12" data-rv>
          <Link to="/method" className="lp-link">
            {h.cta}
            <Icon name="arrowRight" size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

function Mission() {
  const { m } = useI18n();
  const x = m.landing.mission;
  const [animate] = useState(() => !prefersReducedMotion());
  return (
    <section className="lp-section" aria-labelledby="lp-mission">
      <div className="lp-wrap">
        <div className="lp-night" data-rv>
          <div className="lp-night__copy">
            <p className="lp-eyebrow">{x.eyebrow}</p>
            <h2 id="lp-mission" className="lp-h2">
              {x.title}
            </h2>
            <p className="lp-lead">{x.body}</p>
            <div className="mt-2">
              <ButtonLink to="/mission" variant="primary" iconRight="arrowRight">
                {x.cta}
              </ButtonLink>
            </div>
          </div>
          <div className="lp-night__art">
            <OrbitArt animate={animate} />
          </div>
        </div>
      </div>
    </section>
  );
}

function About() {
  const { m } = useI18n();
  const a = m.landing.about;
  return (
    <section className="lp-section" aria-labelledby="lp-about">
      <div className="lp-wrap lp-about">
        <div className="grid content-start gap-6" data-rv>
          <p className="lp-eyebrow">{a.eyebrow}</p>
          <h2 id="lp-about" className="lp-h2">
            {a.title}
          </h2>
          <p className="lp-lead">{a.body}</p>
        </div>
        <dl className="lp-facts" data-rv style={{ ['--d' as string]: 1 } as CSSProperties}>
          {a.facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Final() {
  const { m } = useI18n();
  const f = m.landing.final;
  return (
    <section aria-labelledby="lp-final">
      <div className="lp-wrap lp-final">
        <h2 id="lp-final" className="lp-display lp-final__title" data-rv>
          <Accent text={f.title} accent={f.accent} />
        </h2>
        <div data-rv style={{ ['--d' as string]: 1 } as CSSProperties}>
          <ButtonLink to="/map" variant="primary" size="lg" iconRight="arrowRight">
            {f.cta}
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const { m } = useI18n();
  const f = m.landing.footer;
  const nav: { to: string; label: string }[] = [
    { to: '/map', label: m.app.nav.map },
    { to: '/mission', label: m.app.nav.mission },
    { to: '/method', label: m.app.nav.method },
  ];
  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <div className="lp-footer__grid">
          <div className="grid content-start gap-4">
            <Wordmark />
            <p>{f.disclaimer}</p>
          </div>
          <div className="grid content-start gap-4">
            <p>{f.data}</p>
            <p className="text-ink-dim">{m.app.synthetic}</p>
          </div>
          <ul className="lp-footer__nav">
            {nav.map((n) => (
              <li key={n.to}>
                <Link to={n.to}>{n.label}</Link>
              </li>
            ))}
            <li className="mt-2 text-ink-dim">{f.rights}</li>
          </ul>
        </div>
      </div>
      <p className="lp-footer__mark" aria-hidden>
        Kyzyl Aspan
      </p>
    </footer>
  );
}

/* ------------------------------------------------------------------ page */

/**
 * `/` — the planet first (header + Earth, nothing else), then the story on scroll.
 * A click on the Earth (or the header's "Open map" while it is on screen) dives into the map.
 */
export function LandingPage() {
  const { m } = useI18n();
  const rootRef = useRef<HTMLElement>(null);
  const phase = useIntroStore((s) => s.phase);
  useRevealAll(rootRef);

  useEffect(() => {
    document.title = m.landing.title;
  }, [m]);

  // No page scroll while the camera dives.
  useEffect(() => {
    if (phase === 'intro' || phase === 'done') return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prev;
    };
  }, [phase]);

  return (
    <main id="main" ref={rootRef} className="lp">
      <Hero />
      <Statement />
      <What />
      <Numbers />
      <How />
      <Mission />
      <About />
      <Final />
      <Footer />
    </main>
  );
}
