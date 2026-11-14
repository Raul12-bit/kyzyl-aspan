/**
 * Intro → map transition: every timing and curve lives here.
 *
 *   intro ──click Earth / CTA──▶ A dive ──▶ B flash ──▶ B swap (under white) ──▶ C reveal ──▶ done
 *     │                             └──────────────── Skip (Esc) ─────────────────────────────▶ done
 *     └─ deep link with an area: bypass straight to done
 *
 * Modes: `full` (three.js globe), `fallback` (no WebGL: static CSS sphere, same white flash),
 * `reduced` (prefers-reduced-motion: no rotation, dive or flash — a plain cross-fade).
 */

export type Bezier = readonly [number, number, number, number];

const css = (b: Bezier) => `cubic-bezier(${b.join(', ')})`;

/** Strong acceleration for the dive (≈ easeInQuart). */
export const EASE_DIVE: Bezier = [0.5, 0, 0.75, 0];
/** "Almost a jump": the flash reaches full white within the first frames. */
export const EASE_FLASH: Bezier = [0.05, 0.9, 0.1, 1];
/** Soft settle for the reveal. */
export const EASE_REVEAL: Bezier = [0.22, 1, 0.36, 1];
/** Panels: same family as --el-ease-emphasized. */
export const EASE_PANELS: Bezier = [0.16, 1, 0.3, 1];

export interface PhaseTimeline {
  /** A — camera dive; the intro copy leaves at its start. */
  zoom: { duration: number; easing: Bezier };
  /** B (part 1) — overlay rises to opacity 1. */
  flash: { rise: number; easing: Bezier; color: string };
  /** B (part 2) — overlay held; the map lands on its target. Leaves after `minHold` once the map is idle (or `maxWait`). */
  swap: { minHold: number; maxWait: number };
  /** C — overlay fades out while the map settles from a zoomed, blurred "landing"; panels rise with a stagger. */
  reveal: {
    duration: number;
    easing: Bezier;
    panelsDelay: number;
    panelsStagger: number;
    panelsDuration: number;
    panelsShift: number;
  };
}

export const TIMELINE: Record<'full' | 'fallback' | 'reduced', PhaseTimeline> = {
  full: {
    // ~0.9 s: the planet turns the target to the camera while the camera plunges, then a hard white cut.
    zoom: { duration: 900, easing: EASE_DIVE },
    flash: { rise: 70, easing: EASE_FLASH, color: '#ffffff' },
    swap: { minHold: 180, maxWait: 650 },
    reveal: { duration: 1200, easing: EASE_REVEAL, panelsDelay: 260, panelsStagger: 90, panelsDuration: 700, panelsShift: 16 },
  },
  fallback: {
    zoom: { duration: 780, easing: EASE_DIVE },
    flash: { rise: 90, easing: EASE_FLASH, color: '#ffffff' },
    swap: { minHold: 200, maxWait: 650 },
    reveal: { duration: 1200, easing: EASE_REVEAL, panelsDelay: 220, panelsStagger: 110, panelsDuration: 760, panelsShift: 14 },
  },
  reduced: {
    // A = fade the copy out, B = cross-fade to the page colour (no white flash), C = fade the map in.
    zoom: { duration: 240, easing: [0.4, 0, 1, 1] },
    flash: { rise: 220, easing: [0.4, 0, 0.2, 1], color: '#05070d' },
    swap: { minHold: 80, maxWait: 900 },
    reveal: { duration: 480, easing: [0.4, 0, 0.2, 1], panelsDelay: 120, panelsStagger: 0, panelsDuration: 320, panelsShift: 0 },
  },
};

/** Default area for the map's reset button when nothing is selected (Kazakhstan & Central Asia). */
export const TARGET_BOUNDS: [number, number, number, number] = [46, 37, 88, 56];

export const cssEase = css;

/** Sum of A + B(min) + C — used by tests and for docs. */
export function nominalDuration(mode: keyof typeof TIMELINE): number {
  const t = TIMELINE[mode];
  return t.zoom.duration + t.flash.rise + t.swap.minHold + t.reveal.duration;
}
