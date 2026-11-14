import type { CSSProperties } from 'react';
import { introSelectors } from './introMachine';
import { useIntroStore } from './introStore';
import { TIMELINE } from './transition.config';

/**
 * Props for a map-UI element that should rise in during phase C of the intro transition.
 * `index` is its place in the stagger. After a Skip or a bypass the element appears instantly.
 */
export function useReveal(index: number): { className: string; 'data-revealed': 'true' | 'instant' | 'false'; style: CSSProperties } {
  const revealed = useIntroStore(introSelectors.uiRevealed);
  const instant = useIntroStore((s) => s.instant);
  const mode = useIntroStore((s) => s.mode);
  const t = TIMELINE[mode].reveal;
  return {
    className: 'reveal',
    'data-revealed': !revealed ? 'false' : instant ? 'instant' : 'true',
    style: {
      transitionDelay: `${t.panelsDelay + index * t.panelsStagger}ms`,
      transitionDuration: `${t.panelsDuration}ms`,
      ['--el-reveal-shift' as string]: `${t.panelsShift}px`,
    },
  };
}
