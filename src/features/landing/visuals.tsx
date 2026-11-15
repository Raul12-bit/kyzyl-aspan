import { useMemo } from 'react';

/**
 * Section illustrations for the landing page. Plain SVG drawn from tokens, so they match the site,
 * weigh nothing over the network and stay sharp at any size. One visual language with the map: a
 * pointy-top hexagon grid and the heat ramp. They illustrate the method — they do not pretend to be data.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const RAMP = ['--el-ramp-2', '--el-ramp-3', '--el-ramp-4', '--el-ramp-5', '--el-ramp-6'];
const rampVar = (heat: number) => `var(${RAMP[Math.min(RAMP.length - 1, Math.floor(heat * RAMP.length))]})`;

/** Pointy-top hexagon polygon points around (cx, cy) with circumradius r. */
function hexPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
}

interface Cell {
  key: string;
  cx: number;
  cy: number;
  /** Column/row in the offset grid. */
  col: number;
  row: number;
}

/** The shared 500×400 offset grid (pointy-top cells of circumradius r, a margin row/column on every side). */
function grid(r: number): Cell[] {
  const w = Math.sqrt(3) * r;
  const rows = Math.ceil(400 / (r * 1.5)) + 1;
  const cols = Math.ceil(500 / w) + 1;
  const out: Cell[] = [];
  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      out.push({ key: `${row}:${col}`, cx: col * w + (row % 2 ? w / 2 : 0), cy: row * r * 1.5, col, row });
    }
  }
  return out;
}

function heatAt(
  cx: number,
  cy: number,
  blobs: readonly (readonly [number, number, number, number])[],
): number {
  let heat = 0;
  for (const [bx, by, s, a] of blobs)
    heat += a * Math.exp(-((cx / 500 - bx) ** 2 + (cy / 400 - by) ** 2) / (2 * s * s));
  return Math.min(1, heat);
}

// Fine cells, like the map's: many small hexagons read as a heat field, a few big ones as a quilt.
const CELL_R = 13;
const DRAW_R = CELL_R * 0.86; // the rest is the dark seam between cells, as on the map

/** A fire season on a hexagon grid: a heat field sampled into H3-like cells. */
export function HexVisual() {
  const cells = useMemo(() => {
    const blobs = [
      [0.6, 0.42, 0.16, 1],
      [0.36, 0.64, 0.11, 0.75],
      [0.78, 0.72, 0.07, 0.55],
    ] as const;
    return grid(CELL_R).map((c) => ({ ...c, heat: heatAt(c.cx, c.cy, blobs) }));
  }, []);

  return (
    <svg viewBox="0 0 500 400" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {cells.map((c) =>
        c.heat < 0.1 ? (
          <polygon
            key={c.key}
            points={hexPoints(c.cx, c.cy, DRAW_R)}
            fill="none"
            stroke="var(--el-line)"
            strokeWidth="0.8"
          />
        ) : (
          <polygon
            key={c.key}
            points={hexPoints(c.cx, c.cy, DRAW_R)}
            fill={rampVar(c.heat)}
            fillOpacity={0.55 + c.heat * 0.45}
          />
        ),
      )}
    </svg>
  );
}

/**
 * Noise filter on the same grid: a real fire front stays; two gas flares (hot every night, every year)
 * and a few low-confidence glints are flagged and fade to an outline once the card scrolls into view.
 */
export function NoiseVisual() {
  const cells = useMemo(() => {
    const rnd = rng(42);
    const front = [[0.5, 0.55, 0.13, 0.95]] as const;
    // Two gas flares (a few cells each) in opposite corners, wherever the grid puts its cells.
    const flareAt = [
      [78, 66],
      [432, 318],
    ] as const;
    const isFlare = (c: Cell) => flareAt.some(([x, y]) => Math.hypot(c.cx - x, c.cy - y) <= CELL_R * 1.9);
    return grid(CELL_R).map((c) => {
      const heat = heatAt(c.cx, c.cy, front);
      const flare = isFlare(c);
      const glint = !flare && heat < 0.1 && rnd() < 0.03;
      return {
        ...c,
        heat,
        kind: flare ? 'flare' : glint ? 'glint' : heat >= 0.12 ? 'fire' : 'empty',
        delay: Math.round(rnd() * 500),
      };
    });
  }, []);

  return (
    <svg viewBox="0 0 500 400" preserveAspectRatio="xMidYMid slice" aria-hidden>
      {cells.map((c) => {
        const pts = hexPoints(c.cx, c.cy, DRAW_R);
        if (c.kind === 'empty')
          return <polygon key={c.key} points={pts} fill="none" stroke="var(--el-line)" strokeWidth="0.8" />;
        if (c.kind === 'fire')
          return (
            <polygon key={c.key} points={pts} fill={rampVar(c.heat)} fillOpacity={0.55 + c.heat * 0.45} />
          );
        const delay = { transitionDelay: `${700 + c.delay}ms` };
        return (
          <g key={c.key}>
            <polygon
              className="lp-noise"
              style={delay}
              points={pts}
              fill={c.kind === 'flare' ? 'var(--el-ramp-6)' : 'var(--el-ramp-4)'}
            />
            <polygon
              className="lp-noise__ring"
              style={delay}
              points={hexPoints(c.cx, c.cy, DRAW_R - 0.8)}
              fill="none"
              stroke="var(--el-ink-dim)"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
          </g>
        );
      })}
    </svg>
  );
}

/** AI brief: a statistics card turned into a few lines of text, with one month flagged. */
export function BriefVisual() {
  const bars = useMemo(() => {
    const rnd = rng(7);
    return Array.from({ length: 24 }, (_, i) => {
      const season = Math.max(0, Math.sin((((i % 12) - 2) / 12) * Math.PI * 2));
      return 0.12 + season * 0.62 + rnd() * 0.12 + (i === 19 ? 0.28 : 0);
    });
  }, []);
  const lines = [292, 262, 306, 188];
  const flaggedX = 92 + 19 * 13.3 + 4;
  return (
    <svg viewBox="0 0 500 400" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <rect
        x="64"
        y="52"
        width="372"
        height="296"
        rx="18"
        fill="var(--el-surface-2)"
        stroke="var(--el-line)"
      />
      <polygon points={hexPoints(100, 92, 9)} fill="var(--el-gold)" />
      <rect x="124" y="88" width="120" height="8" rx="4" fill="var(--el-ink)" fillOpacity="0.75" />
      {lines.map((w, i) => (
        <rect key={i} x="92" y={124 + i * 20} width={w} height="7" rx="3.5" fill="var(--el-line-strong)" />
      ))}
      <line x1="92" x2="408" y1="318" y2="318" stroke="var(--el-line-strong)" />
      {bars.map((h, i) => {
        const height = h * 92;
        const flagged = i === 19;
        return (
          <rect
            key={i}
            x={92 + i * 13.3}
            y={316 - height}
            width="8"
            height={height}
            rx="1.5"
            fill={flagged ? 'var(--el-gold)' : 'var(--el-harmonized)'}
            fillOpacity={flagged ? 1 : 0.32}
          />
        );
      })}
      <polygon
        points={hexPoints(flaggedX, 316 - bars[19]! * 92 - 14, 6)}
        fill="none"
        stroke="var(--el-gold)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
