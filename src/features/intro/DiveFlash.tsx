import type { CSSProperties } from 'react';
import { useI18n } from '@/i18n';
import { Icon } from '@/ui';
import { introSelectors } from './introMachine';
import { introDispatch, useIntroStore } from './introStore';
import { cssEase, TIMELINE } from './transition.config';

/**
 * Phase B/C of the dive: a veil in the page colour (never white) that rises over the last part of
 * the plunge, hides the landing → map swap, then lifts off the map. Lives in the app shell (not on
 * the landing page) because the route changes under it.
 *
 * zoom + flash: one CSS animation (0 → 1) that starts `lead` ms before the dive ends, so the planet
 * melts into the background. swap: held at 1. reveal: a long, soft fade to 0.
 */
export function DiveFlash() {
  const { m } = useI18n();
  const phase = useIntroStore((s) => s.phase);
  const mode = useIntroStore((s) => s.mode);
  const canSkip = useIntroStore(introSelectors.canSkip);
  const t = TIMELINE[mode];
  if (phase === 'intro' || phase === 'done') return null;

  const rising = phase === 'zoom' || phase === 'flash';
  const delay = Math.max(0, t.zoom.duration - t.flash.lead);
  const style: CSSProperties = {
    background: t.flash.color,
    zIndex: 'var(--el-z-flash)' as unknown as number,
    opacity: phase === 'reveal' ? 0 : 1,
    // The same animation string through zoom and flash, so it never restarts between the two phases.
    animation: rising ? `el-veil-in ${t.flash.lead + t.flash.rise}ms ${cssEase(t.flash.easing)} ${delay}ms both` : undefined,
    transition: phase === 'reveal' ? `opacity ${t.reveal.duration}ms ${cssEase(t.reveal.easing)}` : 'none',
    pointerEvents: phase === 'reveal' ? 'none' : 'auto',
  };

  return (
    <>
      <div aria-hidden className="fixed inset-0" style={style} />
      {canSkip ? (
        <button
          type="button"
          onClick={() => introDispatch({ type: 'SKIP' })}
          aria-label={m.intro.skipHint}
          className="btn btn--sm fixed right-[var(--el-gutter)] top-5 border border-line-strong bg-panel text-ink backdrop-blur-md"
          style={{ zIndex: 'var(--el-z-skip)' as unknown as number }}
        >
          {m.intro.skip}
          <Icon name="chevronRight" size={16} />
        </button>
      ) : null}
    </>
  );
}
