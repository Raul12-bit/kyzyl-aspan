/**
 * Pure finite-state machine for the intro → map transition.
 * Side effects (camera, projection swap, timers) are executed by subscribers reacting to `phase`.
 */

export type IntroPhase = 'intro' | 'zoom' | 'flash' | 'swap' | 'reveal' | 'done';
export type IntroMode = 'full' | 'fallback' | 'reduced';

export type IntroEvent =
  | { type: 'START' }
  /** The current phase's timer elapsed. */
  | { type: 'TICK'; phase: IntroPhase }
  /** The map finished swapping projection/layers (or gave up waiting). */
  | { type: 'SWAP_DONE' }
  | { type: 'SKIP' }
  /** Deep link or returning visitor: no intro at all. */
  | { type: 'BYPASS' }
  | { type: 'SET_MODE'; mode: IntroMode };

export interface IntroState {
  phase: IntroPhase;
  mode: IntroMode;
  /** B: projection swapped and layers mounted. */
  swapped: boolean;
  /** B: minimum hold under the overlay elapsed. */
  held: boolean;
  /** Finished by Skip/bypass rather than by the timeline (UI appears without animation). */
  instant: boolean;
}

export const initialIntroState = (mode: IntroMode = 'full'): IntroState => ({
  phase: 'intro',
  mode,
  swapped: false,
  held: false,
  instant: false,
});

export function introReducer(state: IntroState, event: IntroEvent): IntroState {
  switch (event.type) {
    case 'SET_MODE':
      return state.phase === 'intro' ? { ...state, mode: event.mode } : state;
    case 'BYPASS':
      return state.phase === 'intro' ? { ...state, phase: 'done', instant: true } : state;
    case 'SKIP':
      return state.phase === 'done' ? state : { ...state, phase: 'done', instant: true };
    case 'START':
      return state.phase === 'intro' ? { ...state, phase: 'zoom' } : state;
    case 'SWAP_DONE': {
      if (state.phase !== 'swap') return state.phase === 'done' ? state : { ...state, swapped: true };
      return state.held ? { ...state, swapped: true, phase: 'reveal' } : { ...state, swapped: true };
    }
    case 'TICK': {
      // Ignore stale timers from a phase we already left.
      if (event.phase !== state.phase) return state;
      switch (state.phase) {
        case 'zoom':
          return { ...state, phase: 'flash' };
        case 'flash':
          return { ...state, phase: 'swap' };
        case 'swap':
          return state.swapped ? { ...state, held: true, phase: 'reveal' } : { ...state, held: true };
        case 'reveal':
          return { ...state, phase: 'done' };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

/** UI helpers derived from the phase. */
export const introSelectors = {
  /** The intro copy (title, Start) is visible. */
  copyVisible: (s: IntroState) => s.phase === 'intro',
  /** Overlay opacity target. */
  overlayOpaque: (s: IntroState) => s.phase === 'flash' || s.phase === 'swap',
  /** Map UI is mounted (it is mounted under the overlay during the swap). */
  uiMounted: (s: IntroState) => s.phase === 'swap' || s.phase === 'reveal' || s.phase === 'done',
  /** Map UI should be visible / animating in. */
  uiRevealed: (s: IntroState) => s.phase === 'reveal' || s.phase === 'done',
  /** Skip button is offered while the transition runs. */
  canSkip: (s: IntroState) => s.phase === 'zoom' || s.phase === 'flash' || s.phase === 'swap' || s.phase === 'reveal',
  /** The map should be in its working (mercator) state. */
  mapMode: (s: IntroState) => s.swapped || s.phase === 'done' || s.phase === 'reveal',
};
