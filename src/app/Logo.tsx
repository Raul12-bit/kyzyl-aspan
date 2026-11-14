import { useId } from 'react';

/**
 * Kyzyl Aspan mark, redrawn from the brand logo for dark backgrounds: a flame rising from the limb of
 * the planet, an orbit that burns from red into ink, and a satellite riding it. Built from a handful
 * of paths so it stays crisp at 24 px and costs nothing to ship.
 */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size * 1.5} height={size} viewBox="0 0 48 32" aria-hidden className={className} style={{ flex: 'none' }}>
      <defs>
        <linearGradient id={`${id}-orbit`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ff5236" />
          <stop offset=".45" stopColor="#ff8a3d" />
          <stop offset="1" stopColor="#e8ecf4" stopOpacity=".9" />
        </linearGradient>
        <linearGradient id={`${id}-flame`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#ec3b29" />
          <stop offset=".6" stopColor="#ff7333" />
          <stop offset="1" stopColor="#ffb24a" />
        </linearGradient>
        <radialGradient id={`${id}-globe`} cx=".35" cy=".3" r=".8">
          <stop offset="0" stopColor="#24304d" />
          <stop offset="1" stopColor="#0d1424" />
        </radialGradient>
        <clipPath id={`${id}-clip`}>
          <circle cx="27" cy="20" r="10.5" />
        </clipPath>
      </defs>
      {/* planet */}
      <circle cx="27" cy="20" r="10.5" fill={`url(#${id}-globe)`} stroke="#e8ecf4" strokeOpacity=".7" strokeWidth="1" />
      <g clipPath={`url(#${id}-clip)`} fill="#e8ecf4" fillOpacity=".55">
        {/* abstract continents: Eurasia & Africa, as on the logo */}
        <path d="M24.5 12.2c2.3-.9 5-.6 7.4.4 1.3.6 2.2 1.6 3.4 2.2l-1 1.7-2.2-.4-1.4 1.3-2.4-.6-.9 1.6-2.3.3.4 2.4-1.8.9-.8 3.3-1.6-.3-.6-2.6-1.5-1.1.5-2.3 1.7-.8-.6-1.6 1.1-1.5Z" />
        <path d="M30.4 22.2l2.6.3 1.4 2-1.1 3.4-2.1 1.6-1-2.1.4-2.4Z" />
      </g>
      {/* orbit */}
      <path
        d="M3.5 21.5c2.6 6.1 17.4 8 30.2 3.7 9-3 13.8-8.9 11.3-12.8-1.2-1.9-4-2.8-7.4-2.9"
        fill="none"
        stroke={`url(#${id}-orbit)`}
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      {/* flame on the limb */}
      <path
        d="M14.3 23.6c-3.4-.6-5.5-3.2-5.1-6.3.3-2.6 2.4-3.9 3.2-6.4 1.4 1.3 2 2.9 1.7 4.6 1-.6 1.6-1.6 1.8-2.8 1.9 1.9 2.4 4.4 1.6 6.6-.5 1.4-1.6 2.4-3.2 4.3Z"
        fill={`url(#${id}-flame)`}
      />
      {/* satellite */}
      <g transform="rotate(-32 39.5 6)">
        <rect x="37.6" y="4.4" width="3.8" height="3.2" rx=".6" fill="#e8ecf4" />
        <rect x="31.6" y="4.9" width="5.2" height="2.2" rx=".4" fill="#e8ecf4" fillOpacity=".75" />
        <rect x="42.2" y="4.9" width="5.2" height="2.2" rx=".4" fill="#e8ecf4" fillOpacity=".75" />
      </g>
    </svg>
  );
}

/** Two-colour wordmark, as on the logo: KYZYL in ink, ASPAN in signal red. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark ${className}`}>
      <span className="text-ink">Kyzyl</span> <span className="text-kyzyl">Aspan</span>
    </span>
  );
}

export function Logo({ compact = false, size = 26 }: { compact?: boolean; size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      {!compact ? <Wordmark /> : null}
    </span>
  );
}
