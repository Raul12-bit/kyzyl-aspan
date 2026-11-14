/**
 * Deterministic mock data generator: `pnpm data:mock`.
 * Writes public/data/{manifest,regions,zones,fires,intro}.json from a fixed seed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SEED, generateAll } from './mock/generate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public', 'data');
mkdirSync(outDir, { recursive: true });

const seedArg = process.argv.find((a) => a.startsWith('--seed='));
const seed = seedArg ? Number(seedArg.slice('--seed='.length)) : DEFAULT_SEED;
if (!Number.isInteger(seed)) {
  console.error(`Invalid --seed: ${seedArg}`);
  process.exit(1);
}

const started = performance.now();
const data = generateAll(seed);

function write(name: string, value: unknown, pretty = false) {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  writeFileSync(resolve(outDir, name), `${text}\n`, 'utf8');
  return `${name} (${(Buffer.byteLength(text) / 1024).toFixed(0)} kB)`;
}

const written = [
  write('manifest.json', data.manifest, true),
  write('regions.json', data.regions, true),
  write('zones.json', data.zones),
  write('fires.json', data.fires),
  write('intro.json', data.intro),
];

const { counts, demo } = data.manifest;
console.log(`Emberline mock data · seed ${seed} · ${(performance.now() - started).toFixed(0)} ms`);
console.log(`  wrote ${written.join(', ')}`);
console.log(`  ${counts.zones} zones, ${counts.regions} regions, ${counts.introPoints} intro aggregates`);
console.log(`  ${counts.fires} fire points (MODIS ${counts.firesModis}, VIIRS ${counts.firesViirs})`);
console.log(`  demo box (Kazakhstan): VIIRS/MODIS ratio ${demo.ratio}, anomalies z≥2: ${demo.anomalies.join(', ')}`);
