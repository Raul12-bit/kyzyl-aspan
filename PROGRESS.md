# Kyzyl Aspan — progress & handoff

NASA Space Apps Challenge 2026 · *Harmonization of MODIS and VIIRS Hot Spots*.
“Kyzyl Aspan” is Kazakh for “red sky”. Formerly “Emberline” (package renamed to `kyzyl-aspan`).

This file is the single place to see **what is done, what is mocked and what the backend has to build**.
Update the status table whenever a stage moves.

Last update: 2026-11-14.

---

## 1. Status at a glance

| # | Stage / idea | Frontend | Backend | Notes |
|---|---|---|---|---|
| 0 | Scaffold, design tokens, DataSource abstraction | ✅ | — | Stage 1 commit `ec37470` |
| 1 | **Noise filter** (low confidence + persistent heat sources, “Flare-Chronos” style) | ✅ | 🟡 runs in browser / mock | `src/domain/noise.ts`; toggles + counters in the map's *Sensors* panel |
| 2 | **H3 hexagon grid** (count burning hexagon-days, not pixels) | ✅ | 🟡 runs in browser / mock | `src/domain/hexgrid.ts`, `hexStats.ts`, `hexCalendar.ts`; map view “H3 hexagons” |
| 3 | **AI risk analysis** (region click → stats → Gemini, “Kiln-Watch” style) | ✅ | ✅ minimal (`server/`) | Without `GEMINI_API_KEY` the API returns rule-based findings |
| 4 | **Onboard AI** (tiny model trained on the 26-year archive) | ✅ concept | 🟡 trained offline by script | `src/domain/onboard.ts`, `scripts/mock/train-model.ts`, page `/mission` |
| 5 | **Link prediction** (orbits + stations + weather → Ka/X/other station) | ✅ concept | ⛔ not started | `src/domain/orbit.ts`, `downlink.ts`; synthetic weather |
| 6 | **Satellite-to-satellite cueing** | ✅ concept | ⛔ not applicable to MODIS/VIIRS | `src/domain/crosscue.ts`; clearly labelled as a concept |
| 7 | 3D Earth intro with MODIS + VIIRS satellites, dive → white flash → map | ✅ | — | three.js, lazy chunk, `src/features/globe/`; real NASA models (Terra, Aqua, Suomi NPP) since the redesign |
| 7a | **Landing page** (header + centred Earth, story on scroll) and minimal-luxury redesign, light/dark | ✅ | — | `src/features/landing/`; see §5 “Design” |
| 8 | Geolocation → language + landing country | ✅ | — | offline point-in-polygon, nothing sent to a server |
| 9 | i18n: en, ru, kk, es, fr, de, pt, zh | ✅ | — | every dictionary type-checked + tested |
| 10 | Real data (FIRMS MCD14ML / VNP14IMGML / VJ114IMGML) | — | ⛔ **main backend task** | see §4 |

✅ done · 🟡 works on synthetic data / in the browser, needs a real backend · ⛔ not started

---

## 2. How to run

```bash
pnpm install
pnpm data:mock        # synthetic archive → public/data/*.json (+ trains the onboard model)
pnpm dev              # http://localhost:5173 (proxies /api → :8787)
pnpm server           # minimal API on http://127.0.0.1:8787
```

Production, one process: `pnpm build && pnpm start` (the API also serves `dist/`).

Checks: `pnpm typecheck` · `pnpm test` (94 tests) · `pnpm lint` · `pnpm build`.

Environment variables: see `.env.example`. **Secrets only in `.env`, never in `VITE_*` variables** —
`VITE_*` values are compiled into the browser bundle.

---

## 3. Architecture

```
src/
  app/            shell, router, top bar, logo, language menu
  domain/         PURE logic, no React — the part a backend can reuse 1:1
    detections.ts   compact detection table (typed arrays)
    hexgrid.ts      H3 indexing (res 6 fine grid, res 5 harmonization grid)
    noise.ts        low-confidence + persistence filter, filter scoring
    noiseSettings.ts filter flags (no h3 import → keeps h3-js off the first screen)
    archive.ts      table + grids + persistence + flags, built once
    hexStats.ts     burning hexagon-days per sensor
    harmonize.ts    ratio calibration, inverse-variance blend, 90% interval, anomalies
    hexCalendar.ts  full pipeline → CalendarSeries
    summary.ts      statistical brief for the LLM + rule-based findings
    onboard.ts      logistic-regression triage model (features, train, predict)
    orbit.ts        circular-orbit propagation, passes, coverage
    downlink.ts     weather-aware Ka/X downlink planner
    crosscue.ts     tip-and-cue planner
    countries.ts    offline reverse geocoding
  data/           DataSource interface, MockDataSource (static JSON), HttpDataSource (real API)
  features/
    intro/          intro state machine, overlay, timings
    globe/          three.js Earth scene (EarthScene.ts) + React wrapper
    geo/            geolocation consent, country store, country outlines loader
    map/            MapLibre stage, layers, panels, stats, H3 view
    ai/             AI panel + API client (safe markdown-lite renderer)
    mission/        /mission — ideas 4, 5, 6
    method/         /method — how it works
  i18n/locales/   en (reference) + 7 lazy-loaded dictionaries
server/           minimal Node API (no dependencies): Gemini proxy, validation, rate limit, static files
scripts/          data generators (mock archive, country outlines, onboard model training)
```

The UI talks to data **only** through `src/data/DataSource.ts`. Switch to a real API with
`VITE_DATA_SOURCE=http` + `VITE_API_URL=…` — no UI change needed.

---

## 4. API contract for the backend

**Machine-readable contract: [`docs/openapi.yaml`](docs/openapi.yaml)** (OpenAPI 3.1 — every endpoint, schema,
error code and limit below). Generate server stubs / types from it. The frontend is complete against this
contract: switching from mock data is `VITE_DATA_SOURCE=http` + `VITE_API_URL=…`, no UI change.

All JSON, UTF-8, CORS for the frontend origin. Types live in `src/data/types.ts` and
`src/domain/*.ts`; runtime shape guards in `src/data/HttpDataSource.ts`.

### 4.1 Data API (to build) — `VITE_API_URL`

| Method | Path | Returns | Status |
|---|---|---|---|
| GET | `/detections` | `DetectionArchive` — `{ version, synthetic, rows: [lng, lat, sensor 0/1, day since 2000-01-01, frp MW, confidence 0/1/2, truth?][] }` | mocked by `public/data/fires.json` |
| GET | `/calendar?bbox=w,s,e,n[&region=KZ]` | `CalendarSeries` (harmonized monthly series + meta: grid, ratios, noise totals) | mocked; logic = `src/domain/hexCalendar.ts` |
| GET | `/fires?bbox=…&start=YYYY-MM-DD&end=…` | `FireCollection` (GeoJSON) | mocked |
| GET | `/regions?q=text` | `Region[]` | mocked (`regions.json`) |
| GET | `/overview` | `{ points: [lng, lat, weight][] }` for the globe | mocked (`intro.json`) |
| GET | `/onboard-model` | `OnboardModel` (weights, standardisation, metrics) | mocked (`model.json`) |

Backend tasks, in order:
1. **Ingest FIRMS archives** (MODIS C6.1 MCD14ML 2000–, VIIRS S-NPP VNP14IMGML 2012–, NOAA-20
   VJ114IMGML 2018–). Map MODIS confidence 0–100 to low/nominal/high (`<30 / 30–79 / ≥80`),
   VIIRS `l/n/h` directly. Keep the FIRMS `type` field — combine it with the persistence rule.
2. **Precompute the `FireArchive`** (`src/domain/archive.ts`) server-side: H3 res 6 + res 5 indices,
   persistence, noise flags. Store per-cell daily aggregates (PostGIS or DuckDB/Parquet).
3. **Serve aggregates, not raw rows**, once the archive is real (hundreds of millions of rows):
   `/detections` must become tiled (by H3 res-3 parent and month), or the map must switch to vector
   tiles. The browser pipeline only works for the ~21k-row demo sample.
4. Re-train the onboard model on real labels (e.g. FIRMS `type` = static/volcano/offshore + manual).
5. Replace synthetic weather in the downlink planner with a forecast API near each station.

### 4.2 Minimal backend (built) — `server/`

| Method | Path | Body / returns |
|---|---|---|
| GET | `/api/health` | `{ ok, gemini: { configured, model } }` |
| POST | `/api/ai/analyze` | body `{ summary: AreaSummary, locale }` → `{ source: 'gemini', model, text }` or `{ source: 'rules', findings, reason }` |

- `AreaSummary` (`src/domain/summary.ts`) holds **aggregates only** — no detections, no visitor location.
- Strict validation (`server/validate.ts`), 32 kB body limit, 10 req/min/IP, 20 s model timeout.
- Gemini failure → degrades to rule-based findings (HTTP 200), never leaks upstream errors.
- `GEMINI_MODEL` default `gemini-2.5-flash` — **not verified against a live key in this session**;
  set the model id your key supports.

---

## 5. Decisions worth knowing

- **Geolocation**: an in-app consent card appears on entry; the native browser prompt fires only
  on the visitor's click (browsers suppress load-time prompts, and a refused native prompt cannot be
  asked again). Country is found offline from `public/data/countries.json`; only the ISO code and the
  consent are stored. Denied/unavailable → the dive lands on the whole world.
- **Language**: manual choice > country languages (geolocation) > browser language > English.
- **3D performance**: three.js chunk ~137 kB gzip, loaded with the intro only and disposed after the
  dive (GPU memory freed). Phones / ≤4 GB RAM / data-saver get the low profile (1024 px texture,
  fewer segments, DPR ≤ 1.5, no MSAA). Rendering pauses in background tabs.
- **Bundle**: first-screen JS ~110 kB gzip: `h3-js` (64 kB) loads with the map, dictionaries per
  language. Globe chunk 156 kB gzip; the glTF loader is a separate 15 kB chunk loaded after the planet shows.
- **Satellite model**: one satellite on its orbit — Terra (MODIS), where the 26-year record starts —
  from NASA 3D Resources (public domain). Original 2.1 MB
  (117k-triangle CAD meshes, Draco, PNG duplicates). `pnpm models:build <dir>` (script
  `scripts/build-satellite-models.mjs`, uses only libraries bundled with three) decodes, welds, simplifies
  to ~9k triangles and drops normals → **131 kB** in `public/models/terra.glb`, no Draco decoder at runtime.
  Normals are rebuilt in the browser with a 35° crease. Phones / low profile keep procedural models (0 bytes).
- **Design** (2026-11-14 redesign, v2): one accent per theme — fire orange `#f37021` on warm obsidian
  `#0a0a0b`, burnt orange `#b84a12` on porcelain `#f6f4ef`. Heat ramp embers → orange → amber (no cream).
  Instruments: MODIS = steel, outline hexagons; VIIRS = amber, filled hexagons; harmonized = ink.
  **One shape everywhere: the pointy-top hexagon** — H3 cells on the map (default view, with real seams
  between cells), detection marks (SDF icon), fires on the 3D globe, legends, landing illustrations,
  markers. Display type is Onest at weight 340; accents are colour, not a second typeface; monospace
  only for numbers. Landing:
  `/` shows only the header and the Earth; sections reveal on scroll (one shared IntersectionObserver,
  transforms/opacity only). Map: same header as the site, one toolbar opens one panel at a time (area or
  layers), min zoom = one world width. The map re-tints live on theme change (basemap + data layers).
  Theme switch cross-fades via the View Transitions API.
- **Globe smoothness**: rendering capped at ~72 fps (120–165 Hz screens no longer redraw 2–3× more than
  needed); render resolution steps down 1.75 → 1.4 → 1.05 → 1 when the machine cannot hold ~40 fps;
  satellite trails rebuilt every 4th frame without per-vertex allocations; night texture 2048 px everywhere
  (smaller GPU upload hitch). The cloud layer drifts in longitude, so its texture repeats (`RepeatWrapping`):
  the default clamp smeared the edge column into a striped band over the Pacific.
- **Dive transition**: no white flash. A veil in the page colour starts rising 0.55 s before the camera
  reaches the surface (1.2 s cubic plunge), holds while the map lands, then lifts over 1.1 s while the
  map settles from a 6% zoom with a 4 px blur. Pinned by `introMachine.test.ts`.
- **Dev hook**: in `pnpm dev`, `window.__earth.debugStep()` draws a globe frame by hand — background tabs
  never tick `requestAnimationFrame`, so automated checks use it. Not present in production builds.
- **Honest numbers** (synthetic data, spatial hold-out):
  - onboard model F1 **0.951** vs simple rule **0.921** — small gain; the value is size (80 bytes) and autonomy;
  - KZ box, overlap period: raw VIIRS/MODIS **3.94×** → burning hexagon-days **2.04×** after the H3 step;
  - noise filter on synthetic truth: ~58% of removed points are true noise, ~86% of real fires kept
    (the low-confidence rule also drops real small fires).
- **Ideas 5 and 6 are concepts**: circular orbits (no SGP4/TLE), assumed station capabilities and link
  margins, synthetic weather. MODIS/VIIRS cannot be re-tasked; idea 6 needs new satellites and relays.

---

## 6. Known limitations / next steps

- [ ] Real FIRMS ingestion + tiled data API (§4.1) — the main backend work.
- [ ] Gemini path tested only with the rule-based fallback (no API key in this environment).
- [ ] SGP4 propagation from Celestrak TLEs for the mission page and the globe.
- [ ] Onboard image screening (tiny CNN on thermal chips) — described, not implemented.
- [ ] Province outlines (only country outlines; provinces are boxes).
- [ ] E2E tests (Playwright) for the intro → map flow; currently verified manually in a browser.
- [ ] Old Figma file and `figma-plugin/` still carry the Emberline name.
- [ ] Redesign verified in a desktop browser pane and at 375 px emulation only — not on a real phone,
      and frame rate / GPU cost on low-end devices was not measured.
- [ ] Map screen inner panels (area statistics, AI brief) keep their previous content; restyled, not
      re-architected. Mission page demos are unchanged apart from type, colours and surfaces.
- [ ] `@fontsource-variable/cormorant-garamond` is no longer imported; remove it with
      `pnpm remove @fontsource-variable/cormorant-garamond` (needs registry access).
- [ ] Higgsfield: the connected MCP is read-only (no media generation) and the account has no generations;
      all visuals are code (SVG, three.js) and NASA imagery/models.

## 7. Change log

- **2026-11-15 · Globe fixes** — one satellite only (Terra; Aqua and Suomi NPP removed, screen-reader label
  updated in 8 locales); fixed the striped cloud band at
  the date line (cloud texture now repeats); quieter sun glint; ~72 fps cap and adaptive resolution;
  cheaper trail updates; night texture 2048 px.

- **2026-11-14 · Redesign v2** — hexagons everywhere (map H3 view by default with seams, SDF hexagon
  detections, hexagonal fires on the globe, legends, illustrations); orange accent and amber heat ramp
  instead of champagne/cream; soft page-colour veil instead of the white flash; map header and panels in
  the landing's style; live map re-tint on theme change; no serif italics or shouted mono labels;
  `docs/openapi.yaml` for the backend; camera padding fixed for the removed right panel.
- **2026-11-14 · Redesign** — minimal-luxury design system (palette, type, surfaces, light/dark with
  cross-fade); new landing page `/` (header + centred Earth, statement, features with SVG visuals, numbers,
  method steps, mission band, about, footer); Earth shader fixes (no terminator band, tight glint, soft
  halo without a gap), orbit rings removed, NASA satellite models; map declutter (toolbar + one panel,
  centred time bar); header solid on scroll; fixed empty `unit` strings that failed the i18n test.

- **2026-11-14 · Stage 4** — rebrand to Kyzyl Aspan; three.js globe with MODIS/VIIRS; dive transition;
  geolocation + 8 languages; noise filter + H3 view on the map; country click → stats → AI panel;
  `/mission` (ideas 4–6) and `/method`; minimal Node API with Gemini proxy; synthetic generator now
  plants flares/factories/volcanoes/false alarms and models fire-days; 94 tests.
- 2026-11-14 · Stage 3 (WIP) — map screen, layers, time filter, area selection.
- 2026-11-14 · Stage 2 — intro globe and white-flash transition (MapLibre).
- 2026-11-14 · Stage 1 — scaffold, design tokens, i18n, DataSource, mock data.
