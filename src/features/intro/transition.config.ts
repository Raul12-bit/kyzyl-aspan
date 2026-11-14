/**
 * Intro → map transition: every timing and curve lives here.
 *
 *   intro ──click Earth / CTA──▶ A dive ──▶ B veil ──▶ B swap (under the veil) ──▶ C reveal ──▶ done
 *     │                             └──────────────── Skip (Esc) ─────────────────────────────▶ done
 *     └─ deep link with an area: bypass straight to done
 *
 * Modes: `full` (three.js globe), `fallback` (no WebGL: static CSS sphere, same veil),
 * `reduced` (prefers-reduced-motion: no rotation or dive — a plain cross-fade).
 *
 * The veil is the page colour, never white: it starts rising during the last ~45% of the dive, so the
 * planet melts into the background instead of cutting to a flash (a hard white cut hurts the eyes).
 * The map then surfaces from a slightly zoomed, softly blurred frame.
 */

export type Bezier = readonly [number, number, number, number];

const css = (b: Bezier) => `cubic-bezier(${b.join(', ')})`;

/** Smooth acceleration for the dive (gentler than a quartic plunge). */
export const EASE_DIVE: Bezier = [0.45, 0, 0.55, 1];
/** The veil rises softly and settles. */
export const EASE_FLASH: Bezier = [0.4, 0, 0.2, 1];
/** Soft settle for the reveal. */
export const EASE_REVEAL: Bezier = [0.22, 1, 0.36, 1];
/** Panels: same family as --el-ease-emphasized. */
export const EASE_PANELS: Bezier = [0.16, 1, 0.3, 1];

export interface PhaseTimeline {
  /** A — camera dive; the intro copy leaves at its start. */
  zoom: { duration: number; easing: Bezier };
  /**
   * B (part 1) — the veil (page colour) reaches opacity 1. It starts `lead` ms before the dive ends,
   * so the fade overlaps the last part of the plunge.
   */
  flash: { rise: number; lead: number; easing: Bezier; color: string };
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
    // ~1.2 s plunge; the veil starts 0.55 s before the surface and is opaque 0.3 s after it.
    zoom: { duration: 1200, easing: EASE_DIVE },
    flash: { rise: 300, lead: 550, easing: EASE_FLASH, color: 'var(--el-bg)' },
    swap: { minHold: 120, maxWait: 700 },
    reveal: { duration: 1100, easing: EASE_REVEAL, panelsDelay: 300, panelsStagger: 80, panelsDuration: 700, panelsShift: 14 },
  },
  fallback: {
    zoom: { duration: 1000, easing: EASE_DIVE },
    flash: { rise: 300, lead: 450, easing: EASE_FLASH, color: 'var(--el-bg)' },
    swap: { minHold: 120, maxWait: 700 },
    reveal: { duration: 1100, easing: EASE_REVEAL, panelsDelay: 260, panelsStagger: 90, panelsDuration: 700, panelsShift: 14 },
  },
  reduced: {
    // A = fade the copy out, B = cross-fade to the page colour (no white flash), C = fade the map in.
    zoom: { duration: 240, easing: [0.4, 0, 1, 1] },
    flash: { rise: 220, lead: 0, easing: [0.4, 0, 0.2, 1], color: 'var(--el-bg)' },
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
