/**
 * Prepares a prebuilt Vercel deployment (Build Output API v3) in .vercel/output:
 *
 *   static/                       ← dist/ from `pnpm build` (the site)
 *   functions/api/<path>.func/    ← server/handlers.ts bundled for Node: the Gemini brief, the AI #3 endpoints and
 *                                   the real-time feeds /api/live/{fires,tle,weather} (FIRMS, CelesTrak, Open-Meteo)
 *   functions/v1/helios/{status,constellation}.func/
 *                                 ← server/heliosLite.ts: the five real satellites computed in TypeScript
 *                                   (SGP4, ITU-R link margins, Open-Meteo, AI #2) — the landing globe's live part
 *   config.json                   ← routing: cached assets, files and functions first, 404 for other /api and /v1,
 *                                   the app's pages → index.html (200), missing files → 404, any other path →
 *                                   index.html with status 404 (the app shows its "not found" page)
 *
 * Why prebuilt: the repository also holds the HELIOS Python backend in api/ (Vercel would try to deploy those
 * files as Python functions) and the browser app needs nothing but static files. The Python data API (fire
 * archive, forecasts) is too large for serverless functions; without it the map runs on the built-in demo data,
 * while the satellites stay live through the TypeScript port.
 *
 * Usage:  pnpm build:vercel   then   vercel deploy --prebuilt --prod
 * The Gemini key is a project variable on Vercel (GEMINI_API_KEY), never part of the build.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, '.vercel', 'output');
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ is missing: run "pnpm build" first');

// esbuild ships with Vite; resolve it through Vite so no extra dependency is needed.
const require = createRequire(import.meta.url);
const esbuild = require(createRequire(require.resolve('vite')).resolve('esbuild'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, join(out, 'static'), { recursive: true });

// Fresh orbital elements for the snapshot the constellation falls back to when CelesTrak does not answer.
const NORAD = { TERRA: 25994, AQUA: 27424, 'SUOMI NPP': 37849, 'NOAA 20': 43013, 'NOAA 21': 54234, 'TDRS 11': 39070, 'TDRS 12': 39504, 'TDRS 13': 42915 };
const snapFile = join(root, 'server', 'constellation', 'tle-fallback.json');
try {
  const tle = {};
  for (const [name, id] of Object.entries(NORAD)) {
    const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=TLE`, { signal: AbortSignal.timeout(10_000) });
    const lines = (await res.text()).split(/\r?\n/).map((l) => l.trim());
    const l1 = lines.find((l) => l.startsWith('1 '));
    const l2 = lines.find((l) => l.startsWith('2 '));
    if (!res.ok || !l1 || !l2) throw new Error(`${name}: no elements`);
    tle[name] = [l1, l2];
  }
  writeFileSync(snapFile, JSON.stringify({ source: 'CelesTrak GP (fallback snapshot)', fetched: new Date().toISOString(), tle }, null, 1));
  console.log('Orbital elements snapshot refreshed from CelesTrak');
} catch (err) {
  console.warn(`Keeping the previous orbital elements snapshot (${err.message})`);
}

async function bundle(entry, name) {
  const file = join(out, '.tmp', `${name}.mjs`);
  await esbuild.build({
    entryPoints: [join(root, 'server', entry)],
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@': join(root, 'src') },
    // CommonJS dependencies inside an ES module still need `require`.
    banner: { js: "import { createRequire as __kaRequire } from 'node:module'; const require = __kaRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });
  return file;
}

function addFunction(path, file) {
  const dir = join(out, 'functions', `${path}.func`);
  mkdirSync(dir, { recursive: true });
  cpSync(file, join(dir, 'index.mjs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(dir, '.vc-config.json'),
    JSON.stringify(
      // Gemini answers in 3–10 s and gives up after 26 s; the first constellation of a window takes 2–5 s.
      { runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 30 },
      null,
      2,
    ),
  );
}

const api = await bundle('vercel-entry.ts', 'api');
const helios = await bundle('vercel-helios-entry.ts', 'helios');
const ENDPOINTS = [
  'api/health',
  'api/ai/analyze',
  'api/ai/status',
  'api/ai/ground/forecast',
  'api/ai/ground/delays',
  // The in-app AI guide (Gemini + fact sheet) and the AI #2 network run on demand (server/assistant.ts).
  'api/ai/chat',
  'api/ai/link/predict',
  // A real FIRMS fire played through the three AIs; AI #1 reads its 26-year table next to the function.
  'api/ai/replay',
  // Real-time feeds (server/live.ts): NASA FIRMS hot spots, CelesTrak orbits, Open-Meteo wind.
  'api/live/fires',
  'api/live/tle',
  'api/live/weather',
];
for (const endpoint of ENDPOINTS) addFunction(endpoint, api);
// AI #1's onboard history table (2.2 MB): only the replay function reads it, from its own directory.
cpSync(join(root, 'artifacts', 'models', 'onboard_history.bin'), join(out, 'functions', 'api/ai/replay.func', 'onboard_history.bin'));
for (const endpoint of ['v1/helios/status', 'v1/helios/constellation']) addFunction(endpoint, helios);
ENDPOINTS.push('v1/helios/status', 'v1/helios/constellation');
rmSync(join(out, '.tmp'), { recursive: true, force: true });

const security = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
/** Client-side routes of src/app/router.tsx (keep in sync; server/index.ts uses the same list). */
const SPA_ROUTES = ['map', 'ai', 'method', 'mission', 'how-it-works', 'analysis'];
for (const file of ['robots.txt', 'sitemap.xml']) {
  if (!existsSync(join(dist, file))) throw new Error(`dist/${file} is missing (public/${file})`);
}
writeFileSync(
  join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '^/(.*)$', headers: security, continue: true },
        { handle: 'filesystem' },
        // No HELIOS data API here: /v1 must answer 404 (not the app's HTML), so the site picks its demo data.
        { src: '^/(?:api|v1)(?:/.*)?$', status: 404 },
        // The app's pages (and the old paths it redirects on the client) → the app, 200.
        { src: `^/(?:${SPA_ROUTES.join('|')})?/?$`, dest: '/index.html' },
        // A missing FILE (robots.txt before it existed, an old asset…) is a plain 404, never the app's HTML.
        { src: '^/.*\\.[A-Za-z0-9]{1,8}$', status: 404 },
        // Any other path: the app renders its "page not found" view, with a real 404 status for crawlers.
        { src: '^/(.*)$', dest: '/index.html', status: 404 },
      ],
    },
    null,
    2,
  ),
);
console.log(`Vercel output ready: ${out} (static + ${ENDPOINTS.length} functions)`);
