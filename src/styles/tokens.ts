/**
 * Runtime bridge from CSS tokens to libraries that cannot read CSS variables (MapLibre, ECharts).
 * tokens.css stays the single source of truth; fallbacks only matter in non-DOM environments.
 */
const FALLBACK = {
  '--el-bg': '#05070d',
  '--el-land': '#0c1220',
  '--el-water': '#04060b',
  '--el-panel-solid': '#0b101d',
  '--el-line': 'rgba(148,170,210,0.14)',
  '--el-line-strong': 'rgba(160,180,220,0.28)',
  '--el-ink': '#e8ecf4',
  '--el-ink-muted': '#a9b3c6',
  '--el-ink-dim': '#7d889c',
  '--el-amber': '#ffb547',
  '--el-amber-soft': '#ffd08a',
  '--el-orange': '#ff7a2f',
  '--el-red': '#e8412c',
  '--el-kyzyl': '#ff5236',
  '--el-modis': '#3ddbd9',
  '--el-viirs': '#9aa6ff',
  '--el-harmonized': '#ffb547',
  '--el-band': 'rgba(255,181,71,0.18)',
  '--el-anomaly': '#fff0c8',
  '--el-ramp-0': '#111829',
  '--el-ramp-1': '#3a1410',
  '--el-ramp-2': '#8e2318',
  '--el-ramp-3': '#e8412c',
  '--el-ramp-4': '#ff8a3d',
  '--el-ramp-5': '#ffc061',
  '--el-ramp-6': '#fff0c8',
  '--el-font-sans': "'Onest Variable', system-ui, sans-serif",
  '--el-font-mono': "'Geist Mono Variable', ui-monospace, monospace",
} as const;

export type TokenName = keyof typeof FALLBACK;

let cache: Partial<Record<TokenName, string>> = {};

export function token(name: TokenName): string {
  const hit = cache[name];
  if (hit) return hit;
  let value: string = FALLBACK[name];
  if (typeof document !== 'undefined') {
    const css = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (css) value = css;
  }
  cache[name] = value;
  return value;
}

/** For hot reload of tokens.css during development. */
export function resetTokenCache(): void {
  cache = {};
}

export function rampColors(): string[] {
  return (['--el-ramp-0', '--el-ramp-1', '--el-ramp-2', '--el-ramp-3', '--el-ramp-4', '--el-ramp-5', '--el-ramp-6'] as const).map(
    token,
  );
}

/** '#rrggbb' + alpha → 'rgba(r,g,b,a)'. Leaves non-hex colours untouched. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
