/**
 * Country outlines for the browser: `pnpm data:geo`.
 *
 * Reads Natural Earth 1:110m countries (via the `world-atlas` package) plus country metadata
 * (`world-countries`) and writes one compact file, public/data/countries.json. That single file feeds
 * the intro globe texture, the offline "which country am I in" lookup, click-to-select on the map and
 * the country → interface-language mapping. Nothing here is fetched at runtime from third parties.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { feature } from 'topojson-client';
import worldCountries from 'world-countries';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const GEO_VERSION = 'ne110m-2026.11-1';

/** ISO 639-3 → interface locale. Extend together with src/i18n/locales.ts. */
const LANGUAGE_TO_LOCALE: Record<string, string> = {
  eng: 'en',
  rus: 'ru',
  kaz: 'kk',
  spa: 'es',
  por: 'pt',
  fra: 'fr',
  deu: 'de',
  gsw: 'de',
  bar: 'de',
  zho: 'zh',
  cmn: 'zh',
};

/** Where the alphabetical order of official languages would pick the less common one. */
const LOCALE_OVERRIDES: Record<string, string[]> = {
  KZ: ['kk', 'ru'],
  BE: ['fr', 'de'],
  CH: ['de', 'fr'],
  LU: ['fr', 'de'],
  CA: ['en', 'fr'],
  CM: ['fr', 'en'],
  GQ: ['es', 'fr', 'pt'],
  MO: ['zh', 'pt'],
  PR: ['es', 'en'],
  NA: ['en'],
  // Listed as spoken, but not the language a visitor should be greeted in by default.
  AZ: [],
  UZ: [],
  TM: [],
  LB: [],
};

/** Natural Earth features without an ISO numeric code. */
const UNCODED: Record<string, string> = { 'N. Cyprus': 'CY', Somaliland: 'SO', Kosovo: 'XK' };

interface CountryOut {
  id: string;
  name: string;
  /** [west, south, east, north]; west > east when the main territory crosses the antimeridian. */
  bbox: [number, number, number, number];
  /** Interface locales spoken there, most likely first. Empty → fall back to the browser language. */
  langs: string[];
  /** polygons → rings → flat [lng, lat, lng, lat, …] at 0.01° precision; longitudes are unwrapped (−180…540). */
  polys: number[][][];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * world-atlas polygons are stitched across the antimeridian: a ring may jump from +180° to −180°.
 * Rings are stored "unwrapped" (continuous longitudes, possibly beyond 180°) so that planar code —
 * canvas drawing and point-in-polygon — works by testing lng and lng + 360. A ring that circles a
 * pole (Antarctica) is closed through that pole.
 */
function flattenRing(ring: Position[]): number[] | null {
  const out: number[] = [];
  let shift = 0;
  let prev: number | null = null;
  for (const p of ring) {
    const raw = p[0]!;
    if (prev !== null) {
      if (raw - prev > 180) shift -= 360;
      else if (raw - prev < -180) shift += 360;
    }
    prev = raw;
    const x = r2(raw + shift);
    const y = r2(p[1]!);
    const n = out.length;
    if (n >= 2 && out[n - 2] === x && out[n - 1] === y) continue;
    out.push(x, y);
  }
  // A ring needs three distinct vertices plus the closing one.
  if (out.length < 8) return null;
  const firstX = out[0]!;
  const lastX = out[out.length - 2]!;
  if (Math.abs(lastX - firstX) > 180) {
    let meanLat = 0;
    for (let i = 1; i < out.length; i += 2) meanLat += out[i]!;
    const pole = meanLat < 0 ? -90 : 90;
    out.push(lastX, pole, firstX, pole, firstX, out[1]!);
  }
  let min = Infinity;
  for (let i = 0; i < out.length; i += 2) min = Math.min(min, out[i]!);
  const turns = Math.floor((min + 180) / 360);
  if (turns !== 0) for (let i = 0; i < out.length; i += 2) out[i] = r2(out[i]! - turns * 360);
  return out;
}

interface PolyInfo {
  rings: number[][];
  area: number;
  box: [number, number, number, number];
}

function polyInfo(rings: number[][]): PolyInfo {
  const outer = rings[0]!;
  let w = Infinity;
  let e = -Infinity;
  let s = 90;
  let n = -90;
  for (let i = 0; i < outer.length; i += 2) {
    const x = outer[i]!;
    const y = outer[i + 1]!;
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  // Shoelace on a locally scaled plane: good enough to rank a country's own pieces by size.
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  let twice = 0;
  for (let i = 0; i + 3 < outer.length; i += 2) {
    twice += outer[i]! * k * outer[i + 3]! - outer[i + 2]! * k * outer[i + 1]!;
  }
  return { rings, area: Math.abs(twice) / 2, box: [w, s, e, n] };
}

function angularDistance(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / rad;
}

/**
 * Box of the "main territory": the largest piece, everything near it and everything big.
 * Keeps French Guiana from stretching France across the Atlantic, but keeps Alaska with the USA.
 */
function mainBBox(polys: PolyInfo[]): [number, number, number, number] {
  const largest = polys.reduce((a, b) => (b.area > a.area ? b : a));
  const centre = (p: PolyInfo): [number, number] => [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2];
  const main = polys.filter(
    (p) => p === largest || p.area >= 0.2 * largest.area || angularDistance(centre(p), centre(largest)) <= 10,
  );
  const south = Math.min(...main.map((p) => p.box[1]));
  const north = Math.max(...main.map((p) => p.box[3]));
  // Smallest arc of longitude covering every piece = the complement of the widest gap on the circle.
  if (main.some((p) => p.box[2] - p.box[0] >= 359)) return [-180, r2(south), 180, r2(north)];
  const spans = main
    .flatMap((p): [number, number][] =>
      p.box[2] > 180 ? [[p.box[0], 180], [-180, p.box[2] - 360]] : [[p.box[0], p.box[2]]],
    )
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  let west = merged[0]![0];
  let east = merged[merged.length - 1]![1];
  let widest = west + 360 - east; // the gap that wraps through ±180°
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i]![0] - merged[i - 1]![1];
    if (gap > widest) {
      widest = gap;
      west = merged[i]![0];
      east = merged[i - 1]![1];
    }
  }
  return [r2(west), r2(south), r2(east), r2(north)];
}

function localesFor(iso2: string, languages: Record<string, string> | undefined): string[] {
  const override = LOCALE_OVERRIDES[iso2];
  if (override) return override;
  const out: string[] = [];
  for (const code of Object.keys(languages ?? {})) {
    const locale = LANGUAGE_TO_LOCALE[code];
    if (locale && !out.includes(locale)) out.push(locale);
  }
  return out;
}

export function buildCountries(): CountryOut[] {
  const topology = JSON.parse(
    readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'),
  ) as Parameters<typeof feature>[0];
  const collection = feature(topology, topology.objects.countries!) as unknown as FeatureCollection<
    Polygon | MultiPolygon,
    { name: string }
  >;
  const byNumeric = new Map(worldCountries.filter((c) => c.ccn3).map((c) => [c.ccn3, c]));
  const byAlpha2 = new Map(worldCountries.map((c) => [c.cca2, c]));

  const grouped = new Map<string, { name: string; polys: PolyInfo[] }>();
  for (const f of collection.features as Feature<Polygon | MultiPolygon, { name: string }>[]) {
    const meta = f.id !== undefined ? byNumeric.get(String(f.id)) : byAlpha2.get(UNCODED[f.properties.name] ?? '');
    const iso2 = meta?.cca2 ?? UNCODED[f.properties.name];
    if (!iso2) {
      console.warn(`  skipped "${f.properties.name}" (no ISO code)`);
      continue;
    }
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const entry = grouped.get(iso2) ?? { name: meta?.name.common ?? f.properties.name, polys: [] };
    for (const polygon of polygons) {
      // The first ring is the outline; without it the holes mean nothing.
      const outline = polygon[0] ? flattenRing(polygon[0]) : null;
      if (!outline) continue;
      const holes = polygon.slice(1).map(flattenRing).filter((ring): ring is number[] => ring !== null);
      entry.polys.push(polyInfo([outline, ...holes]));
    }
    grouped.set(iso2, entry);
  }

  return [...grouped.entries()]
    .filter(([, v]) => v.polys.length > 0)
    .map(([id, v]) => ({
      id,
      name: v.name,
      bbox: mainBBox(v.polys),
      langs: localesFor(id, byAlpha2.get(id)?.languages),
      polys: v.polys.sort((a, b) => b.area - a.area).map((p) => p.rings),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function main() {
  const started = performance.now();
  const countries = buildCountries();
  const outDir = resolve(root, 'public', 'data');
  mkdirSync(outDir, { recursive: true });
  const file = {
    version: GEO_VERSION,
    attribution:
      'Made with Natural Earth (1:110m, public domain) via world-atlas. Country metadata: mledoze/countries (ODbL).',
    countries,
  };
  const text = JSON.stringify(file);
  writeFileSync(resolve(outDir, 'countries.json'), `${text}\n`, 'utf8');
  const vertices = countries.reduce((a, c) => a + c.polys.reduce((b, p) => b + p.reduce((d, ring) => d + ring.length / 2, 0), 0), 0);
  console.log(`Kyzyl Aspan geo data · ${(performance.now() - started).toFixed(0)} ms`);
  console.log(`  wrote countries.json (${(Buffer.byteLength(text) / 1024).toFixed(0)} kB): ${countries.length} countries, ${vertices} vertices`);
  const sample = (id: string) => {
    const c = countries.find((x) => x.id === id);
    return c ? `${id} ${JSON.stringify(c.bbox)} [${c.langs.join(',')}]` : `${id} missing`;
  };
  console.log(`  ${['KZ', 'ES', 'FR', 'RU', 'US', 'FJ', 'BR'].map(sample).join(' · ')}`);
}

// Run only as a script (the builder is also imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
