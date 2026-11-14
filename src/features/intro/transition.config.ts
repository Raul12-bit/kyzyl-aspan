/**
 * Intro → map transition: every timing and curve lives here.
 *
 *   intro ──Start──▶ A zoom ──▶ B flash ──▶ B swap (under white) ──▶ C reveal ──▶ done
 *     │                 └──────────────── Skip (Esc) ─────────────────────────────▶ done
 *     └─ deep link with an area: bypass straight to done
 *
 * Modes: `full` (globe), `fallback` (no WebGL/globe: static sphere, same white flash),
 * `reduced` (prefers-reduced-motion: no rotation, zoom or flash — a plain cross-fade).
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
  /** A — camera dive; the intro copy disappears instantly at its start. */
  zoom: { duration: number; easing: Bezier };
  /** B (part 1) — overlay rises to opacity 1. */
  flash: { rise: number; easing: Bezier; color: string };
  /** B (part 2) — overlay held; projection swap + layers mount. Leaves after `minHold` once the map is idle (or `maxWait`). */
  swap: { minHold: number; maxWait: number };
  /** C — overlay fades out; panels rise with a stagger. */
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
    zoom: { duration: 820, easing: EASE_DIVE },
    flash: { rise: 90, easing: EASE_FLASH, color: '#ffffff' },
    swap: { minHold: 200, maxWait: 1100 },
    reveal: { duration: 1400, easing: EASE_REVEAL, panelsDelay: 220, panelsStagger: 110, panelsDuration: 760, panelsShift: 14 },
  },
  fallback: {
    zoom: { duration: 780, easing: EASE_DIVE },
    flash: { rise: 90, easing: EASE_FLASH, color: '#ffffff' },
    swap: { minHold: 200, maxWait: 600 },
    reveal: { duration: 1400, easing: EASE_REVEAL, panelsDelay: 220, panelsStagger: 110, panelsDuration: 760, panelsShift: 14 },
  },
  reduced: {
    // A = fade the copy out, B = cross-fade to the page colour (no white flash), C = fade the map in.
    zoom: { duration: 240, easing: [0.4, 0, 1, 1] },
    flash: { rise: 220, easing: [0.4, 0, 0.2, 1], color: '#05070d' },
    swap: { minHold: 80, maxWait: 900 },
    reveal: { duration: 480, easing: [0.4, 0, 0.2, 1], panelsDelay: 120, panelsStagger: 0, panelsDuration: 320, panelsShift: 0 },
  },
};

/** Globe behaviour during the intro. */
export const GLOBE = {
  /** Longitude degrees per second; 0 in reduced motion. */
  rotationSpeed: 3.2,
  center: [58, 28] as [number, number],
  zoomDesktop: 1.55,
  zoomMobile: 0.75,
  /** The dive ends this many zoom levels above the start, aimed at the target view. */
  diveZoom: 4.2,
};

/** Where the map lands (Kazakhstan & Central Asia). */
export const TARGET_BOUNDS: [number, number, number, number] = [46, 37, 88, 56];

export const cssEase = css;

/** Sum of A + B(min) + C — used by tests and for docs. */
export function nominalDuration(mode: keyof typeof TIMELINE): number {
  const t = TIMELINE[mode];
  return t.zoom.duration + t.flash.rise + t.swap.minHold + t.reveal.duration;
}
