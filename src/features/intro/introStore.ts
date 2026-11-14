import { useEffect } from 'react';
import { create } from 'zustand';
import { initialIntroState, introReducer, type IntroEvent, type IntroMode, type IntroState } from './introMachine';
import { TIMELINE } from './transition.config';

interface IntroStore extends IntroState {
  dispatch: (event: IntroEvent) => void;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * The intro plays only on a fresh visit to `/`. Deep links (another route, a shared `bbox`)
 * and `?intro=0` start in the finished state, so recipients land straight on the content.
 */
function initialState(): IntroState {
  if (typeof window === 'undefined') return initialIntroState('full');
  const params = new URLSearchParams(window.location.search);
  // QA override: ?introMode=reduced|fallback previews the other two transitions on any machine.
  const forced = params.get('introMode');
  const mode: IntroMode = forced === 'reduced' || forced === 'fallback' ? forced : prefersReducedMotion() ? 'reduced' : 'full';
  const base = initialIntroState(mode);
  const bypass = window.location.pathname !== '/' || params.has('bbox') || params.get('intro') === '0';
  return bypass ? introReducer(base, { type: 'BYPASS' }) : base;
}

export const useIntroStore = create<IntroStore>((set, get) => ({
  ...initialState(),
  dispatch: (event) => {
    const { dispatch: _d, ...state } = get();
    const next = introReducer(state, event);
    if (next !== state) set(next);
  },
}));

export const introDispatch = (event: IntroEvent) => useIntroStore.getState().dispatch(event);

export function setIntroMode(mode: IntroMode) {
  // Reduced motion always wins over the globe fallback.
  const reduced = prefersReducedMotion();
  introDispatch({ type: 'SET_MODE', mode: reduced ? 'reduced' : mode });
}

/**
 * Drives phase timers. Mounted once (AppShell). Each phase schedules a TICK tagged with the
 * phase it belongs to, so a Skip or an out-of-order event can never advance the wrong phase.
 */
export function useIntroTimeline() {
  const phase = useIntroStore((s) => s.phase);
  const mode = useIntroStore((s) => s.mode);

  useEffect(() => {
    const t = TIMELINE[mode];
    const durations: Partial<Record<IntroState['phase'], number>> = {
      zoom: t.zoom.duration,
      flash: t.flash.rise,
      swap: t.swap.minHold,
      reveal: Math.max(t.reveal.duration, t.reveal.panelsDelay + t.reveal.panelsDuration + 4 * t.reveal.panelsStagger),
    };
    const ms = durations[phase];
    if (ms === undefined) return;
    const id = window.setTimeout(() => introDispatch({ type: 'TICK', phase }), ms);
    // Safety net: if the map never reports back (still loading, lost context), leave the white anyway.
    const guard = phase === 'swap' ? window.setTimeout(() => introDispatch({ type: 'SWAP_DONE' }), t.swap.minHold + t.swap.maxWait + 400) : undefined;
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(guard);
    };
  }, [phase, mode]);

  // Escape skips the running transition.
  useEffect(() => {
    if (phase === 'intro' || phase === 'done') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') introDispatch({ type: 'SKIP' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);
}
