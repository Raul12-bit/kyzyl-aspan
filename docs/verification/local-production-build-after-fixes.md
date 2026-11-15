# Verification · local production build (pnpm build && pnpm start), http://127.0.0.1:8787

Run: 2026-11-15T07:20:13.721Z · `pnpm verify:ai http://127.0.0.1:8787` · 27 of 27 checks passed.

Every check calls the live server over HTTP, as the browser does; the AI #1 / AI #2 rows run the same modules the browser runs.

## 1 · Pages, files and routing

| | Check | Measured |
|---|---|---|
| PASS | GET / | HTTP 200 text/html |
| PASS | GET /map | HTTP 200 text/html |
| PASS | GET /ai | HTTP 200 text/html |
| PASS | GET /method | HTTP 200 text/html |
| PASS | GET /robots.txt is a real text file | HTTP 200 text/plain |
| PASS | GET /sitemap.xml is real XML | HTTP 200 application/xml |
| PASS | A missing file answers 404 | HTTP 404 |
| PASS | An unknown page answers 404 (the app shows "not found") | HTTP 404 text/html |

## 2 · Servers behind the site

| | Check | Measured |
|---|---|---|
| PASS | GET /api/health | Gemini configured: false · model gemini-3.6-flash |
| PASS | GET /api/ai/status lists the three AIs | ai1:space, ai2:space, ai3:ground |
| PASS | GET /v1/helios/status answers (live satellites) | HTTP 200 · data_ready=false · engine=typescript |

## 3 · AI #3 on the ground server — metamorphic checks over HTTP

| | Check | Measured |
|---|---|---|
| PASS | Calm air (wind 0): computed on the server, fire spreads as a circle | source=ground-server · 2.58 ms on the server · L/B=1 · head 20.80 km = back 20.80 km in 24 h |
| PASS | More wind → the fire runs further (0→60 km/h) | 0 km/h: 20.8 km · 10 km/h: 31.1 km · 20 km/h: 46.6 km · 40 km/h: 104.3 km · 60 km/h: 233.5 km |
| PASS | More humidity → slower fire | 10%: 55.1 km · 30%: 44.0 km · 60%: 31.5 km · 90%: 22.9 km |
| PASS | The fire runs downwind for every wind direction | from 0° → to 180° · from 90° → to 270° · from 180° → to 0° · from 270° → to 90° |
| PASS | Frost (−10 °C, grass): no fire, finite numbers (regression of the −6 °C pole) | HTTP 200 · index 0 · head 0 km |
| PASS | Harshest allowed weather (150 km/h, 55 °C, 1 %): finite and capped | danger catastrophic · index 200 · head-fire speed 26.0 km/h |
| PASS | Deterministic: the same request gives the same forecast | forest head 24 h: 9.074 km both times |
| PASS | Rejects invalid input (lat 91 → 422, unknown field → 422, wrong content type → 415) | 422 · 422 · 415 |
| PASS | Signal delays: four streams, computed on the server | p90 min: Terra 19, Aqua 20, Suomi NPP 13, NOAA-20 21 |
| PASS | A storm over Fairbanks changes the delays | p90 min with the storm: Terra 22, Aqua 21, Suomi NPP 16, NOAA-20 24 |

## 4 · AI brief (Gemini through the server)

| | Check | Measured |
|---|---|---|
| PASS | Synthetic data → a demo briefing from the model, with no risk level | source=rules · mode=demo · 6 ms · first line: — |
| PASS | The brief covers the selected period (Jan 2000 only), not the whole archive | server answered for 2000-01 → 2000-01 · sent 2000-01 → 2000-01 |
| PASS | A request that hides "synthetic" or injects text still gets the demo brief (server-side guard) | mode=demo · source=rules |

## 5 · AI #1 and AI #2 — onboard simulations (the modules the browser runs)

| | Check | Measured |
|---|---|---|
| PASS | AI #1: a fire planted anywhere is found exactly there | 163 of 163 positions |
| PASS | AI #1: erase the fire → nothing is reported | 0 false detections in 3 erased scenes × 2 sensors |
| PASS | AI #2: predicting beats reacting (downpour over Fairbanks, link losses AI vs rule) | terra 3 vs 14 · aqua 2 vs 12 · snpp 2 vs 18 · noaa20 3 vs 18 |
