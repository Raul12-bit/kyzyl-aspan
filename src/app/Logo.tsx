import { useId, type CSSProperties } from 'react';

/** Brand orange, taken from the logo artwork (ASPAN, the hexagon, the planet's midtone). */
export const BRAND_ORANGE = '#fc5b1c';

/*
 * Geometry measured on the brand artwork (1200 × 500 px) and scaled to a hexagon of circumradius R = 29:
 * planet r = 0.436 R, ring 0.718 R × 0.236 R tilted 28° up to the right, satellite r = 0.08 R at the ring's
 * right end. The ring's back half is drawn before the planet and its front half after, so the planet sits
 * inside the ring.
 */
const CX = 28;
const CY = 32;
const R = 29;
const HEX = Array.from({ length: 6 }, (_, k) => {
  const a = ((-90 + 60 * k) * Math.PI) / 180;
  return `${(CX + R * Math.cos(a)).toFixed(2)},${(CY + R * Math.sin(a)).toFixed(2)}`;
}).join(' ');
const RX = 20.8;
const RY = 6.85;
const TILT = -28;

/**
 * Kyzyl Aspan mark: an orange planet with a white ring and its satellite, inside the pointy-top hexagon that
 * runs through the whole site (H3 cells, markers, legends). Pure SVG: crisp from a 16 px favicon to a poster.
 * `size` is the height in px; the width follows the hexagon (√3 / 2 · height, plus the stroke).
 */
export function LogoMark({ size = 34, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={(size * 56) / 64} height={size} viewBox="0 0 56 64" aria-hidden className={className} style={{ flex: 'none' }}>
      <defs>
        <radialGradient id={`${id}-planet`} cx=".34" cy=".28" r=".85">
          <stop offset="0" stopColor="#ff8f4a" />
          <stop offset=".5" stopColor="#f4632a" />
          <stop offset="1" stopColor="#d6441a" />
        </radialGradient>
        <linearGradient id={`${id}-ring`} x1={CX - RX} y1="0" x2={CX + RX} y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".6" stopColor="#f4f2f0" />
          <stop offset="1" stopColor="#c9c8cc" />
        </linearGradient>
      </defs>
      <polygon points={HEX} fill="none" stroke={BRAND_ORANGE} strokeWidth="1.8" strokeLinejoin="round" />
      <g transform={`rotate(${TILT} ${CX} ${CY})`} fill="none" strokeLinecap="round">
        {/* back half of the ring, behind the planet */}
        <path d={`M${CX - RX} ${CY} A${RX} ${RY} 0 0 1 ${CX + RX} ${CY}`} stroke="#9c9ba1" strokeWidth="1.5" />
      </g>
      <circle cx={CX} cy={CY} r="12.6" fill={`url(#${id}-planet)`} />
      <g transform={`rotate(${TILT} ${CX} ${CY})`}>
        {/* front half of the ring, over the planet */}
        <path d={`M${CX + RX} ${CY} A${RX} ${RY} 0 0 1 ${CX - RX} ${CY}`} fill="none" stroke={`url(#${id}-ring)`} strokeWidth="1.7" strokeLinecap="round" />
        <circle cx={CX + 19.5} cy={CY - 2.4} r="2.3" fill="#ffffff" />
      </g>
    </svg>
  );
}

/** Two-colour wordmark, as on the logo: KYZYL in white, ASPAN in brand orange. */
export function Wordmark({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return (
    <span className={`wordmark ${className}`} style={style}>
      <span className="text-ink">Kyzyl</span> <span className="wordmark__accent">Aspan</span>
    </span>
  );
}

/**
 * Mark + wordmark + "Red sky" (what the name means in Kazakh), laid out like the brand artwork. The text
 * scales with `size` (the mark's height), so the same lockup serves the header and larger placements.
 */
export function Logo({ compact = false, size = 34, tagline = true }: { compact?: boolean; size?: number; tagline?: boolean }) {
  return (
    <span className="flex items-center" style={{ gap: size * 0.4 }}>
      <LogoMark size={size} />
      {!compact ? (
        <span className="grid" style={{ gap: size * 0.12 }}>
          <Wordmark style={{ fontSize: size * 0.4 }} />
          {tagline ? (
            <span className="wordmark__tagline" style={{ fontSize: Math.max(8, size * 0.15) }}>
              Red sky
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
