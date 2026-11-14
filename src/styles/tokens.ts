/**
 * Runtime bridge from CSS tokens to libraries that cannot read CSS variables (MapLibre, ECharts).
 * tokens.css stays the single source of truth; fallbacks only matter in non-DOM environments.
 */
const FALLBACK = {
  '--el-bg': '#0a0a0b',
  '--el-land': '#141416',
  '--el-water': '#0a0a0b',
  '--el-panel-solid': '#151517',
  '--el-line': 'rgba(255,245,230,0.09)',
  '--el-line-strong': 'rgba(255,245,230,0.17)',
  '--el-ink': '#eee9e0',
  '--el-ink-muted': '#aaa398',
  '--el-ink-dim': '#878075',
  '--el-amber': '#ffad4a',
  '--el-amber-soft': '#ff9b5e',
  '--el-orange': '#f37021',
  '--el-red': '#e2401f',
  '--el-kyzyl': '#f0532c',
  '--el-modis': '#93afcc',
  '--el-viirs': '#ffad4a',
  '--el-harmonized': '#eee9e0',
  '--el-band': 'rgba(238,233,224,0.12)',
  '--el-anomaly': '#f37021',
  '--el-ramp-0': '#1a1716',
  '--el-ramp-1': '#3b150b',
  '--el-ramp-2': '#7c220d',
  '--el-ramp-3': '#c23a14',
  '--el-ramp-4': '#ec6420',
  '--el-ramp-5': '#ff9133',
  '--el-ramp-6': '#ffbf5a',
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
