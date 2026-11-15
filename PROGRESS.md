# Kyzyl Aspan — progress & handoff

NASA Space Apps Challenge 2026 · *Harmonization of MODIS and VIIRS Hot Spots*.
“Kyzyl Aspan” is Kazakh for “red sky”. Formerly “Emberline” (package renamed to `kyzyl-aspan`).

This file is the single place to see **what is done, what is mocked and what the backend has to build**.
Update the status table whenever a stage moves.

Last update: 2026-11-15 (review fixes: data provenance, demo briefing, period-exact AI brief, AI #3 frost bug, proof suite).

---

## 1. Status at a glance

| # | Stage / idea | Frontend | Backend | Notes |
|---|---|---|---|---|
| 0 | Scaffold, design tokens, DataSource abstraction | ✅ | — | Stage 1 commit `ec37470` |
| 1 | **Noise filter** (low confidence + persistent heat sources, “Flare-Chronos” style) | ✅ | ✅ HELIOS (world) | `src/domain/noise.ts` for the demo; on real data the server filters every detection with the global registry of persistent heat sources |
| 2 | **H3 hexagon grid** (count burning hexagon-days, not pixels) | ✅ | ✅ HELIOS (world) | demo: `src/domain/hexgrid.ts`; real data: `/v1/hex` from EVERY detection, H3 res 2–7 chosen by zoom |
| 3 | **AI risk analysis** (region click → stats → Gemini, “Kiln-Watch” style) | ✅ | ✅ `server/` + HELIOS | The brief describes the selected area AND period (“What is sent” = the time bar). Synthetic data (or a server without the real archive) → **Demo briefing**: the model explains the numbers, never a risk level or forecast. Without `GEMINI_API_KEY` the API returns rule-based findings; real-data briefs get the HELIOS forecast as context |
| 3a | **Proof that the AIs compute** | ✅ | ✅ | `src/domain/ai/proof.test.ts` (metamorphic tests) + `pnpm verify:ai <url>` (black-box HTTP checks of a deployed site, report with `--write` → `docs/verification/`) |
| 4 | **AI #1 · onboard detection + triage** (contextual 4/11 µm fire test → triage model → 16-byte alert) | ✅ | ✅ HELIOS | `src/domain/ai/{thermal,scene,contextual,triage}.ts`; lab tab `/ai#ai1` runs it on MODIS and VIIRS views of synthetic thermal scenes. HELIOS: AI #1 trained on the world archive, compiled to integer-only C99 |
| 5 | **AI #2 · onboard link manager** (orbits, loss-of-signal prediction, laser ↔ Ka/X ↔ backup radio) | ✅ | ✅ HELIOS | `src/domain/ai/link.ts` (+ `orbit.ts`, `downlink.ts`); lab tab `/ai#ai2` compares it with a reactive rule. HELIOS: AI #2 on SGP4 orbits, real stations and weather, constellation on the globe |
| 6 | **Satellite-to-satellite cueing** | ✅ concept | 🟡 HELIOS replay | in `/ai#ai2`; HELIOS: alert-delivery replay on real orbits, cross-satellite confirmation |
| 6c | **AI #3 · ground segment** (noise filter, weather overlay, spread forecast 6/12/24 h, signal-delay tracking) | ✅ | ✅ `server/` | `src/domain/ai/ground.ts`; `POST /api/ai/ground/forecast`, `GET /api/ai/ground/delays` (browser fallback with the same code); weather is SYNTHETIC; floods are not modelled |
| 6d | **MODIS × VIIRS fusion** (event-level confirmation + series-level harmonization) | ✅ | ✅ HELIOS (series) | `src/domain/ai/fusion.ts` + `harmonize.ts`; lab tab `/ai#fusion` with live numbers; landing section explains the four steps |
| 6e | **AI lab `/ai`** (replaces `/mission`, which redirects) + landing section “How our AI works” | ✅ | — | `src/features/ai-lab/`, `src/features/landing/AiSystem.tsx`; registry of the three AIs in `src/domain/ai/registry.ts` (also `GET /api/ai/status`) |
| 6a | **All countries + regions** (admin-1) and precise map | ✅ | ✅ HELIOS (world) | `src/features/world/`: view “Regions” (countries → regions choropleth), server hexagons, every pixel at its real size from zoom 7 |
| 6b | **HELIOS AI layers** (forecast 1–4 weeks + Time Machine, alerts, flares, blind spots, spread, satellites) | ✅ | ✅ HELIOS | `src/features/helios/`; forecast covers every country |
| 7 | 3D Earth intro, dive → soft veil → map | ✅ | — | three.js, lazy chunk, `src/features/globe/`; idle globe shows Terra only; with HELIOS the real constellation (Terra, Aqua, Suomi NPP + laser/radio links) plays. Even frame pacing, smooth trails, soft sun glint |
| 7a | **Landing page** (header + centred Earth, story on scroll) and minimal-luxury redesign, dark only | ✅ | — | `src/features/landing/`; see §5 “Design” |
| 8 | Geolocation → language + landing country | ✅ | — | offline point-in-polygon, nothing sent to a server |
| 9 | i18n: en, ru, kk, es, fr, de, pt, zh | ✅ | — | every dictionary type-checked + tested |
| 10 | Real data (FIRMS MODIS C6.1 2000–2025 + VIIRS S-NPP 2012–2025, all countries) | ✅ | ✅ HELIOS | world archive + 7-day NRT for the current forecast; see §4 |

✅ done · 🟡 works on synthetic data / in the browser, needs a real backend · ⛔ not started

**Real vs demo data.** With `VITE_DATA_SOURCE=auto` (default) the app probes `/v1/helios/status` once at start-up.
If the HELIOS API answers, every number is real (“Real NASA FIRMS data”); otherwise the whole session runs on the
synthetic demo and the HELIOS / world panels stay hidden. The two are never mixed.

---

## 2. How to run

```bash
pnpm install
pnpm data:mock        # synthetic archive → public/data/*.json (+ trains the onboard model)
pnpm dev              # http://localhost:5173 (proxies /api → :8787)
pnpm server           # minimal API on http://127.0.0.1:8787
```

Real data: start the HELIOS-SHIELD API first (separate Python project; locally the parent folder of this
repo); `pnpm dev` and `pnpm server` proxy `/v1/*` to it:

```bash
# in the HELIOS project folder
.venv/Scripts/python -m uvicorn api.server:app --host 127.0.0.1 --port 8000
```

Without it the app falls back to the demo data. Add `?mock` to the URL to force the demo.

Production, one process: `pnpm build && pnpm start` (the API also serves `dist/` and proxies `/v1`).

Checks: `pnpm typecheck` · `pnpm test` (149 tests) · `pnpm lint` · `pnpm build` ·
`pnpm verify:ai [base-url] [--write]` (27 black-box checks of a running site: pages and 404s, robots/sitemap,
`/v1/helios/status`, AI #3 metamorphic physics over HTTP, the Gemini brief's mode and period, AI #1/#2 modules).

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
    ai/             the three AIs as pure modules (also run by server/):
      thermal.ts      Planck, brightness temperatures, FRP          ─┐
      scene.ts        synthetic 4/11 µm scenes, MODIS/VIIRS views    │ AI #1 (onboard)
      contextual.ts   contextual fire test (after MOD14 / VNP14)     │
      triage.ts       priority + 16-byte alert packet with CRC-8    ─┘
      link.ts         AI #2: visibility, loss-of-signal prediction, laser / Ka / X / backup-radio policy
      ground.ts       AI #3: synthetic weather, McArthur FFDI/GFDI, elliptical spread, noise report, delays
      fusion.ts       MODIS × VIIRS event fusion (H3 cell × day)
      registry.ts     who runs where (UI + /api/ai/status)
  data/           DataSource interface, MockDataSource (static JSON), HttpDataSource (real API),
                  AutoDataSource (real API if it answers, else the demo — decided once)
  features/
    world/          real data, all countries: server hexagons by zoom, every pixel at real size, regions view
                    (countries → admin-1 choropleth), region clicks, server area totals (api.ts, WorldSync.tsx)
    helios/         HELIOS-SHIELD layers (forecast + Time Machine, alerts, flares, blind spots, spread, satellites),
                    area card, tooltips
    intro/          intro state machine, overlay, timings
    globe/          three.js Earth scene (EarthScene.ts) + React wrapper
    geo/            geolocation consent, country store, country outlines loader
    map/            MapLibre stage, layers, panels, stats, H3 view
    ai/             AI panel + API client (safe markdown-lite renderer)
    ai-lab/         /ai — the AI lab: system diagram, AI #1 / AI #2 / AI #3 tabs, MODIS × VIIRS fusion; ground client
                    with browser fallback (groundClient.ts)
    mission/        sections reused by the AI lab (triage model, Ka/X planner, cueing, HELIOS results); /mission → /ai
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

### 4.1 Data API — `VITE_API_URL` (built: HELIOS-SHIELD `api/world.py` + `api/kyzyl.py`, prefix `/v1`)

| Method | Path | Returns | Status |
|---|---|---|---|
| GET | `/detections` | `DetectionArchive` — `{ version, synthetic, rows: [lng, lat, sensor 0/1, day since 2000-01-01, frp MW, confidence 0/1/2, truth?][] }` | ✅ uniform 60k sample of the world archive (browser demos only) |
| GET | `/calendar?bbox=w,s,e,n[&region=WORLD\|ISO2\|adm1]` | `CalendarSeries` | ✅ every detection, H3 res 6, local solar days, per-country calibration of every stream to Aqua MODIS |
| GET | `/fires?bbox=…&start=YYYY-MM-DD&end=…` | `FireCollection` (GeoJSON) + `satellite`, `time`, `scan`, `track` | ✅ every detection in the box (reservoir sample above 60k) |
| GET | `/regions?q=text` | `Region[]` | ✅ 240 countries + 4 589 admin-1 regions, names in 7 languages |
| GET | `/overview` | `{ points: [lng, lat, weight][] }` for the globe | ✅ most active H3 cells of the last archive year |
| GET | `/onboard-model` | `OnboardModel` (weights, standardisation, metrics) | ✅ trained on real data |

World extensions (`src/features/world/api.ts`):

| Path | What |
|---|---|
| `/hex?bbox&res=2..7&start&end&noise&sensors` | burning hexagons from every detection, any zoom |
| `/regions/geo?country=ISO2`, `/regions/stats?country=ISO2\|WORLD&start&end` | admin-1 borders; activity per region or per country (choropleth) |
| `/area/stats?bbox[&region]&start&end&lowconf&static&sensors` | the area panel's totals, server-side |

HELIOS extensions — `/v1/helios/*` (`src/features/helios/api.ts`): `status`, `scenarios`, `risk` (world, `?bbox` optional),
`alerts`, `static` (world registry), `blind`, `spread`, `satellites`, `area`, `context`, `mission`, `link`.

Backend tasks (original list — done in HELIOS for every country):
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
| POST | `/api/ai/analyze` | body `{ summary: AreaSummary, locale }` → `{ source: 'gemini', mode, period, model, text }` or `{ source: 'rules', mode, period, findings, reason }`; `mode` = `demo` \| `risk` |

- `AreaSummary` (`src/domain/summary.ts`) holds **aggregates only** — no detections, no visitor location — for the
  **selected period** (`period`, plus `record` for context). Fields a short period cannot support are empty/null
  (season < 12 months, trend < 5 complete years, recent-vs-typical < 24 months); `seasonAhead` only on real data
  that ends with the latest month. The server rebuilds the summary from known fields (extra keys never reach the model)
  and picks `demo` for synthetic data or when it has no real archive (`/helios/status` `data_ready`).
- Strict validation (`server/validate.ts`), 32 kB body limit, 10 req/min/IP, 20 s model timeout.
- Gemini failure → degrades to rule-based findings (HTTP 200), never leaks upstream errors.
- `GEMINI_MODEL` default `gemini-2.5-flash` — **not verified against a live key in this session**;
  set the model id your key supports.
- Oversized bodies get a clean `413` (the socket is closed after the answer, no reset connection).

| Method | Path | Body / returns |
|---|---|---|
| GET | `/api/ai/status` | `{ ok, systems, flows, gemini: { configured, model }, helios: { reachable } }` (HELIOS probe cached 60 s) |
| POST | `/api/ai/ground/forecast` | body `{ lat, lng, fuel?: 'grass'\|'forest', weather?: { windKmh, windFromDeg, tempC, rh, drought, rain24h }, hours?: int[1..72] (≤6), localHour? }` → `{ source: 'ground-server', computedMs, weather, forecast }`. Strict validation (unknown keys rejected, physical ranges), 60 req/min/IP (`AI_GROUND_RATE_LIMIT_PER_MIN`) |
| GET | `/api/ai/ground/delays?storm=<station>&kp=0..9` | `{ source, computedMs, streams: [{ satellite, sensor, meanMin, medianMin, p90Min, maxMin, status }] }` |

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
- **Design** (2026-11-14 redesign, v2; dark-only since 2026-11-15): one theme — fire orange `#f37021` on
  warm obsidian `#0a0a0b`. Heat ramp embers → orange → amber (no cream). There is no light theme and no
  theme switch; `index.html` clears the old `kyzylaspan.theme` key.
  Instruments: MODIS = steel, outline hexagons; VIIRS = amber, filled hexagons; harmonized = ink.
  **One shape everywhere: the pointy-top hexagon** — H3 cells on the map (default view, with real seams
  between cells), detection marks (SDF icon), fires on the 3D globe, legends, landing illustrations,
  markers. Display type is Onest at weight 340; accents are colour, not a second typeface; monospace
  only for numbers. Landing:
  `/` shows only the header and the Earth; sections reveal on scroll (one shared IntersectionObserver,
  transforms/opacity only). Map: same header as the site, one toolbar opens one panel at a time (area or
  layers), min zoom = one world width.
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
- **Three AIs, one architecture** (`src/domain/ai/registry.ts`): AI #1 and AI #2 run on board (in the lab: in the
  browser, as the flight-computer stand-in), AI #3 on the ground (the Node server; the lab falls back to the same
  code in the browser and says so). HELIOS-SHIELD holds the versions trained on real data.
- **AI #1 numbers** (lab scenes, synthetic): forest fire → both sensors, CRITICAL; 100 m² stubble burn → VIIRS
  only (diluted below MOD14-style thresholds in a 1.1 km pixel); gas flare → detected, then DROP by the triage
  model (21 hot years); sun-baked rock → every candidate rejected by context. Detector + triage ≈ 0.02–0.1 ms
  per scene in a laptop browser. VIIRS I4 saturates at 367 K, so its FRP on big fires is a lower bound.
- **AI #2 numbers** (3 h, circular orbits, synthetic rain): predictive policy 2–3 unexpected link losses vs 5–7
  for the reactive rule; with a downpour over Fairbanks 3 vs 14–18. Alert latency is dominated by coverage gaps
  (no relay, station or neighbour in view) — more relays (e.g. over Asia) help more than smarter switching.
- **AI #3 spread** = McArthur Mk5 FFDI / GFDI (Noble et al. 1980) + Alexander (1985) L/B ellipse, integrated hourly
  through the daily cycle; constant wind, no terrain, no suppression → an upper-bound “potential” spread.
  Domain guards (found by the metamorphic tests, 2026-11-15): the grass moisture equation has a pole at −6 °C — at
  −10 °C the live site forecast a 2 239 km run in 24 h — so GFDI is 0 at ≤ −5 °C (continuous: the formula itself
  gives 0 there); both indices are capped at 200 (twice the top of “catastrophic”), so the grass head fire tops out at
  26 km/h instead of 618 km/h at 150 km/h of wind. The lab shows “≥ 200” at the cap.
- **Data provenance is always on screen**: `src/app/DataBadge.tsx` — “Synthetic demo data” / “Real NASA FIRMS data”
  over the map, next to the statistics and on the charts (map panel, AI-lab fusion chart); nothing while the
  start-up probe runs. The landing AI section shows live status: AI #1/#2 = onboard and comms *simulations* in the
  browser, AI #3 = ground server online/offline, HELIOS real-data mode on/off.
- **H3 resolutions, stated separately**: statistics, harmonization and the AI brief = res 5 (≈253 km²); persistence
  (noise filter) and MODIS × VIIRS event fusion = res 6 (≈36 km²); the map's display grid follows the zoom (res 2–6
  demo, 2–7 HELIOS). A same-cell same-day MODIS + VIIRS hit is called a *joint detection*, not “one fire”.
- **Area label**: a country's statistics are counted inside its outline, so the panel shows the outline area
  (Kazakhstan ≈2.7 M km², `polygonsAreaKm2`), not the box (≈5 M km²); boxes and regions are labelled as boxes.
- **Hosting rules** (`scripts/build-vercel.mjs`, mirrored in `server/index.ts`): app pages → 200; a missing file → 404;
  any other path → the app's “not found” page with status 404; `robots.txt` and `sitemap.xml` are real files.
- **No light theme**: the site is dark-only (`theme.ts` removed; the merge kept it that way).

---

## 6. Known limitations / next steps

- [x] Real FIRMS ingestion + data API (§4.1) — HELIOS-SHIELD, every country, MODIS 2000–2025 + VIIRS S-NPP 2012–2025.
- [x] Province outlines — Natural Earth admin-1 (4 589 regions), shown in the “Regions” view and from zoom 4.5.
- [ ] The 2026 part of the record: the FIRMS yearly archive ends in 2025; without a FIRMS MAP_KEY only the last
      7 days (NRT) are available, so the current forecast uses the operational model (last 7 days + climatology).
- [ ] Gemini path tested only with the rule-based fallback (no API key in this environment). The demo-briefing prompt
      (no risk level on synthetic data) is checked by `pnpm verify:ai https://kyzyl-aspan.vercel.app` after a deploy.
- [ ] The hosted site still runs on the synthetic demo archive: the HELIOS Python data API needs its own host before
      the map can show real data (the badge says so on every data view).
- [x] SGP4 propagation from CelesTrak TLEs — HELIOS satellites layer and `/mission` §05–06
      (the older concept sections and the globe still use circular orbits).
- [ ] Onboard image screening (tiny CNN on thermal chips) — described, not implemented.
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
- [ ] AI lab weather is synthetic (moving pressure systems): plug ERA5/GFS into `ground.ts` for real overlays.
- [ ] AI #2 in the lab uses circular orbits; port the HELIOS SGP4 tracks (`/v1/helios/constellation`) into the lab.
- [ ] Flood spread is not modelled (needs rainfall + terrain); only heavy-rain warnings.
- [ ] The HELIOS-SHIELD Python backend is not in this repository; without it every number is synthetic demo data.
- [ ] Map brief: the “typical uncertainty since 2012” line can read ±90–100% on quiet areas (monthly counts are
      small); consider reporting it on annual totals.

## 7. Change log

- **2026-11-15 · Review fixes before the defence** — after an external review of the public site:
  (1) “Synthetic demo data” badge on the map, the statistics and the charts; (2) on synthetic data the AI brief is a
  **Demo briefing** — separate Gemini prompt that forbids risk levels and forecasts, enforced server-side even if a
  request claims real data; (3) the brief is built for the **selected period** (it used to send 2000-01 → 2026-10
  whatever the time bar said), with totals measured for that period and too-short-period fields set to null; the
  answer echoes the period; (4) landing: AI #1/#2 described as onboard and comms simulations, live status chips;
  (5) mobile sheet: the scroll area pads by the off-screen height (the last button was unreachable at half height)
  and an explicit “Expand panel” button (tap and keyboard); (6) area line distinguishes country outline vs box;
  (7) H3 display vs analysis resolution, chart titled “2000–2025 · full years” with the selected period highlighted;
  (8) “joint detection” instead of “one fire”, MODIS/VIIRS described as cross-track scanners; (9) real
  `robots.txt`/`sitemap.xml`, 404 for missing files and unknown pages. Also: AI #3 frost pole and index cap (above),
  `/v1/helios/status` and `/v1/helios/constellation` functions verified in the Vercel build (the live deployment
  predated them → 404). Proof: `proof.test.ts` (16 metamorphic tests), `pnpm verify:ai` (27 HTTP checks). 149 tests.

- **2026-11-15 · New logo, live on Vercel** — logo redrawn as SVG from the brand artwork (`public/brand/kyzyl-aspan-logo.png`,
  geometry and colours measured on it): orange planet with a white ring and its satellite inside the pointy-top
  hexagon, KYZYL white / ASPAN `#fc5b1c`, "RED SKY" under the wordmark (`src/app/Logo.tsx`, `public/favicon.svg`,
  Method page, `og:image`). Hosted at **https://kyzyl-aspan.vercel.app** (Vercel project `kyzyl-aspan`) as a prebuilt
  deployment: `pnpm deploy:vercel` = `pnpm build` + `scripts/build-vercel.mjs` (Build Output API: `dist/` as static
  files, `server/handlers.ts` bundled into the five `/api/*` functions, SPA fallback, 404 for `/v1`) +
  `vercel deploy --prebuilt --prod`. `GEMINI_API_KEY` is a Secret project variable (Production). The HELIOS Python
  API is not on Vercel (too large for functions), so the hosted site runs on the demo data and without the live
  constellation until that API gets its own host and `/v1` is routed to it. `server/index.ts` now only serves
  static files and proxies `/v1`; the `/api/*` router moved to `server/handlers.ts` (shared with the functions).

- **2026-11-15 · Five real satellites, no satellite changes** — the landing globe now plays Terra, Aqua, Suomi NPP,
  NOAA-20 and NOAA-21 with their REAL ground segments (Terra via TDRS 11/12/13 → White Sands, direct broadcast off
  since 2024-05-11; Aqua → Svalbard + Poker Flat, broadcast paused while dumping; NOAA-20/21 → Svalbard + McMurdo,
  Troll backup; Suomi NPP flagged as stopped on 2026-11-02). The inter-satellite laser is gone: the existing
  satellites cannot be upgraded. Everything is computed on the ground (`helios/comms/constellation.py`): when each
  link ends (SGP4 horizon + Open-Meteo rain/cloud over the antenna + AI #2 with a monotonic physics correction —
  the network alone lowered the risk in heavy rain), when data taken now reach the ground (store-and-forward to
  the satellite's own station, or real-time direct broadcast), and which pass over Kazakhstan brings the news first.
  Scenarios: storm over a station, McMurdo under maintenance (NOAA notice, Nov 2026), an own direct-broadcast
  antenna in Astana (ground equipment only). 24 h study for Kyzylorda: time from ignition to data on the ground —
  median 4.2 h with NOAA-20 alone, 1.3 h with all four active satellites (another satellite's next pass delivers),
  1.1 h with the Astana antenna. Gemini: `gemini-2.5-flash` answers 404 to new keys → default `gemini-3.6-flash`
  with `gemini-3.5-flash-lite` fallback, low thinking, 4096-token limit, cut answers rejected (verified with a live
  key). Fixes: desktop map panel ignored the mouse (pointer-events); `/v1/helios/status` now sends `data_ready`, so
  a HELIOS server without the archive keeps the map on the demo while the live satellites stay on.

- **2026-11-15 · AI lab** — the three AIs as one architecture: `src/domain/ai/` (AI #1 contextual detector +
  triage + 16-byte alert packet; AI #2 link manager with loss-of-signal prediction and laser ↔ backup-radio
  switching; AI #3 weather overlay, McArthur spread forecast, noise report, signal delays; MODIS × VIIRS event
  fusion; registry), 27 tests. Server: `/api/ai/status`, `/api/ai/ground/forecast`, `/api/ai/ground/delays`
  (validated, rate-limited) + clean `413` for oversized bodies. New `/ai` lab (five tabs, works on phones) replacing
  `/mission` (redirect); landing section “How our AI works” replaces the mission band; 8 dictionaries extended.
  Globe: even frame pacing on 90–240 Hz screens, smooth satellite trails, soft sun glint; constellation satellites
  created on demand (idle globe still shows Terra only). Merge of origin/main (HELIOS world) resolved dark-only.

- **2026-11-15 · Dark only** — light theme removed: no theme toggle, single token set, globe and map tinted
  once; theme store, live map re-tint, View Transitions cross-fade and the toggle labels (8 locales) deleted.

- **2026-11-15 · Globe fixes** — one satellite only (Terra; Aqua and Suomi NPP removed, screen-reader label
  updated in 8 locales); fixed the striped cloud band at
  the date line (cloud texture now repeats); quieter sun glint; ~72 fps cap and adaptive resolution;
  cheaper trail updates; night texture 2048 px.

- **2026-11-15 · World** — real data for every country through the HELIOS-SHIELD API: NASA FIRMS MODIS 2000–2025 +
  VIIRS S-NPP 2012–2025 (all countries), global persistent-source registry, burning hexagon-days H3 res 2–7.
  Map: “Regions” view (countries → admin-1 choropleth with labels, click a region to analyse it), server
  hexagons by zoom instead of the browser sample, every pixel at its real size from zoom 7, server area totals,
  region search (240 countries, 4 589 regions, 7 languages). HELIOS forecast and static sources cover the world;
  `/mission` shows the world AI #1 and the onboard C code (int8, any flight computer). Ported onto the redesign.
- **2026-11-14 · Stage 5** — real data through the HELIOS-SHIELD API (Kazakhstan): `auto` data source with a
  once-only probe; HELIOS map layers with tooltips; area card; AI brief with the forecast as context;
  `/mission` §04–06; `/v1` proxy in Vite and `server/`; all 8 dictionaries extended.
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
