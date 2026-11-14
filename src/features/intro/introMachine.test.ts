import { describe, expect, it } from 'vitest';
import { initialIntroState, introReducer, introSelectors, type IntroEvent, type IntroState } from './introMachine';
import { nominalDuration, TIMELINE } from './transition.config';

const run = (events: IntroEvent[], s: IntroState = initialIntroState()) => events.reduce(introReducer, s);

describe('intro machine', () => {
  it('walks A → B → C in order', () => {
    let s = run([{ type: 'START' }]);
    expect(s.phase).toBe('zoom');
    expect(introSelectors.copyVisible(s)).toBe(false);
    s = introReducer(s, { type: 'TICK', phase: 'zoom' });
    expect(s.phase).toBe('flash');
    expect(introSelectors.overlayOpaque(s)).toBe(true);
    s = introReducer(s, { type: 'TICK', phase: 'flash' });
    expect(s.phase).toBe('swap');
    expect(introSelectors.uiMounted(s)).toBe(true);
    expect(introSelectors.uiRevealed(s)).toBe(false);
  });

  it('holds the white overlay until both the min hold and the map swap are done', () => {
    const base = run([{ type: 'START' }, { type: 'TICK', phase: 'zoom' }, { type: 'TICK', phase: 'flash' }]);
    // map first, then hold
    let s = introReducer(base, { type: 'SWAP_DONE' });
    expect(s.phase).toBe('swap');
    s = introReducer(s, { type: 'TICK', phase: 'swap' });
    expect(s.phase).toBe('reveal');
    // hold first, then map
    let t = introReducer(base, { type: 'TICK', phase: 'swap' });
    expect(t.phase).toBe('swap');
    t = introReducer(t, { type: 'SWAP_DONE' });
    expect(t.phase).toBe('reveal');
    expect(introReducer(t, { type: 'TICK', phase: 'reveal' }).phase).toBe('done');
  });

  it('ignores stale timers from previous phases', () => {
    const s = run([{ type: 'START' }, { type: 'TICK', phase: 'zoom' }]);
    expect(introReducer(s, { type: 'TICK', phase: 'zoom' })).toBe(s);
  });

  it('Skip finishes instantly from any running phase', () => {
    for (const steps of [
      [{ type: 'START' }],
      [{ type: 'START' }, { type: 'TICK', phase: 'zoom' }],
      [{ type: 'START' }, { type: 'TICK', phase: 'zoom' }, { type: 'TICK', phase: 'flash' }],
    ] as IntroEvent[][]) {
      const s = introReducer(run(steps), { type: 'SKIP' });
      expect(s.phase).toBe('done');
      expect(s.instant).toBe(true);
      expect(introSelectors.mapMode(s)).toBe(true);
    }
  });

  it('bypasses only from the idle intro and ignores Start afterwards', () => {
    const s = run([{ type: 'BYPASS' }, { type: 'START' }]);
    expect(s.phase).toBe('done');
    expect(run([{ type: 'START' }, { type: 'BYPASS' }]).phase).toBe('zoom');
  });

  it('RESET re-arms the dive only after it finished', () => {
    const done = run([{ type: 'START' }, { type: 'SKIP' }]);
    expect(done.phase).toBe('done');
    const again = introReducer(done, { type: 'RESET' });
    expect(again).toMatchObject({ phase: 'intro', instant: false, swapped: false, held: false });
    expect(run([{ type: 'START' }, { type: 'RESET' }]).phase).toBe('zoom');
  });

  it('locks the mode once the transition started', () => {
    const s = run([{ type: 'START' }, { type: 'SET_MODE', mode: 'reduced' }]);
    expect(s.mode).toBe('full');
  });

  it('keeps the timings inside the brief (soft dive, no white flash)', () => {
    const t = TIMELINE.full;
    expect(t.zoom.duration).toBeGreaterThanOrEqual(1000);
    expect(t.zoom.duration).toBeLessThanOrEqual(1400);
    // The veil overlaps the end of the dive and never pops: at least 0.6 s from first tint to opaque.
    expect(t.flash.lead).toBeLessThan(t.zoom.duration);
    expect(t.flash.lead + t.flash.rise).toBeGreaterThanOrEqual(600);
    expect(t.swap.minHold).toBeLessThanOrEqual(200);
    expect(t.reveal.duration).toBeGreaterThanOrEqual(900);
    expect(t.reveal.duration).toBeLessThanOrEqual(1400);
    expect(nominalDuration('reduced')).toBeLessThan(nominalDuration('full'));
  });

  it('never flashes white: every mode veils with the page colour', () => {
    for (const mode of ['full', 'fallback', 'reduced'] as const) {
      expect(TIMELINE[mode].flash.color).toBe('var(--el-bg)');
    }
  });
});
