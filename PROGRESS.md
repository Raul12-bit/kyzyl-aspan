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
| 7 | 3D Earth intro with MODIS + VIIRS satellites, dive → white flash → map | ✅ | — | three.js, lazy chunk, `src/features/globe/` |
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
- **Bundle**: first-screen JS 105 kB gzip (was 192 kB): `h3-js` (64 kB) loads with the map,
  dictionaries per language.
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

## 7. Change log

- **2026-11-14 · Stage 4** — rebrand to Kyzyl Aspan; three.js globe with MODIS/VIIRS; dive transition;
  geolocation + 8 languages; noise filter + H3 view on the map; country click → stats → AI panel;
  `/mission` (ideas 4–6) and `/method`; minimal Node API with Gemini proxy; synthetic generator now
  plants flares/factories/volcanoes/false alarms and models fire-days; 94 tests.
- 2026-11-14 · Stage 3 (WIP) — map screen, layers, time filter, area selection.
- 2026-11-14 · Stage 2 — intro globe and white-flash transition (MapLibre).
- 2026-11-14 · Stage 1 — scaffold, design tokens, i18n, DataSource, mock data.
