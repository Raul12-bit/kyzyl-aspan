import { useEffect, useRef, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '@/app/Logo';
import { LanguageSwitch } from '@/app/LanguageSwitch';
import { useMapStore } from '@/features/map/mapStore';
import { useI18n } from '@/i18n';
import { Button, Icon } from '@/ui';
import { FallbackGlobe } from './FallbackGlobe';
import { introSelectors } from './introMachine';
import { introDispatch, useIntroStore } from './introStore';
import { cssEase, TIMELINE } from './transition.config';

function Tagline({ text, accent }: { text: string; accent: string }) {
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

/**
 * Intro copy + the transition overlay (white flash / reduced-motion cross-fade) + Skip.
 * The globe itself is the shared MapLibre instance rendered underneath by MapStage.
 */
export function IntroOverlay() {
  const { m } = useI18n();
  const phase = useIntroStore((s) => s.phase);
  const mode = useIntroStore((s) => s.mode);
  const mapStatus = useMapStore((s) => s.status);
  const startRef = useRef<HTMLButtonElement>(null);
  const t = TIMELINE[mode];
  const copyVisible = phase === 'intro';
  const canSkip = useIntroStore(introSelectors.canSkip);

  // Without a map (no WebGL or a crash) nobody else will confirm the swap.
  useEffect(() => {
    if (phase === 'swap' && (mapStatus === 'unsupported' || mapStatus === 'error')) introDispatch({ type: 'SWAP_DONE' });
  }, [phase, mapStatus]);

  useEffect(() => {
    if (phase === 'intro') startRef.current?.focus({ preventScroll: true });
  }, [phase]);

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

  // A: the copy vanishes instantly (full / fallback); reduced motion fades it instead.
  const copyStyle: CSSProperties = {
    opacity: copyVisible ? 1 : 0,
    visibility: copyVisible ? 'visible' : 'hidden',
    transition:
      mode === 'reduced' && !copyVisible ? `opacity ${t.zoom.duration}ms ease, visibility 0s linear ${t.zoom.duration}ms` : 'none',
  };

  return (
    <div className="pointer-events-none fixed inset-0" style={{ zIndex: 'var(--el-z-intro)' as unknown as number }}>
      {mode === 'fallback' && (phase === 'intro' || phase === 'zoom') ? <FallbackGlobe diving={phase === 'zoom'} /> : null}

      <div
        className="absolute inset-0 flex flex-col justify-between px-[var(--el-gutter)] pb-6 pt-5 md:px-12 md:pb-10 md:pt-8 lg:px-16"
        style={copyStyle}
      >
        <div className="pointer-events-auto flex items-center justify-between">
          <Logo />
          <LanguageSwitch />
        </div>

        <main
          id="main"
          className="pointer-events-auto max-w-[600px] max-lg:mt-auto"
          aria-labelledby="intro-title"
        >
          <p className="eyebrow m-0 mb-5 !text-ink-muted">{m.intro.eyebrow}</p>
          <h1
            id="intro-title"
            className="m-0 font-semibold text-ink"
            style={{ fontSize: 'clamp(2.5rem, 4.6vw + 0.5rem, 4.75rem)', lineHeight: 1.02, letterSpacing: 'var(--el-tracking-display)' }}
          >
            <Tagline text={m.app.tagline} accent={m.app.taglineAccent} />
          </h1>
          <p className="mb-0 mt-6 max-w-[500px] text-[16px] leading-[1.6] text-ink-muted md:text-lg">{m.intro.lead}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button
              ref={startRef}
              variant="primary"
              size="lg"
              iconRight="arrowRight"
              onClick={() => introDispatch({ type: 'START' })}
              disabled={!copyVisible}
            >
              {m.intro.start}
            </Button>
            <Link
              to="/how-it-works?intro=0"
              className="btn btn--quiet btn--lg"
              tabIndex={copyVisible ? 0 : -1}
            >
              {m.intro.how}
            </Link>
          </div>
        </main>

        <div className="pointer-events-auto mt-8 flex flex-wrap items-center justify-between gap-3">
          <p className="eyebrow m-0 whitespace-pre-wrap">{m.intro.footnote}</p>
          <p className="m-0 flex items-center gap-2 text-[12px] text-ink-dim">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-trust-medium" />
            {m.app.synthetic}
          </p>
        </div>
      </div>

      <div aria-hidden className="absolute inset-0" style={overlayStyle} />

      {canSkip ? (
        <button
          type="button"
          onClick={() => introDispatch({ type: 'SKIP' })}
          aria-label={m.intro.skipHint}
          className="btn btn--sm pointer-events-auto absolute right-[var(--el-gutter)] top-5 border border-[rgb(5_7_13/0.18)] bg-[rgb(5_7_13/0.55)] text-ink backdrop-blur-md hover:bg-[rgb(5_7_13/0.75)] md:right-12 md:top-8"
          style={{ zIndex: 'var(--el-z-skip)' as unknown as number }}
        >
          {m.intro.skip}
          <Icon name="chevronRight" size={16} />
        </button>
      ) : null}
    </div>
  );
}
