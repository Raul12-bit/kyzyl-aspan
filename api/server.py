"""HELIOS-SHIELD API — бэкенд для будущего фронтенда (сайт подключим позже).

Запуск:  .venv\\Scripts\\python -m uvicorn api.server:app --port 8000 --reload
Документация (Swagger): http://127.0.0.1:8000/docs

Готовые (предрасчитанные) данные фронтенд может читать и напрямую из Supabase
(ключ SUPABASE_PUBLISHABLE_KEY, только чтение). Этот сервер нужен для живых
вычислений и для вызовов с секретами (Gemini, запись в БД).
"""

from __future__ import annotations

import json
import threading
import time
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field

from api.kyzyl import router as kyzyl_router
from api.world import router as world_router
from helios import __version__
from helios.config import MODELS_DIR, PROCESSED, REPORTS_DIR, env, settings

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Прогрев кэшей в фоне: первый запрос календаря по всей стране иначе ждал бы ~10 с (таймаут фронтенда 15 с)."""
    from api import kyzyl, world

    def warm():
        try:  # мировые агрегаты (все страны) — главный путь; KZ-экспорт — запасной
            world.warmup()
        except Exception as exc:
            print(f"[helios-api] world warmup skipped: {exc}")
        try:
            kyzyl.arrays(), kyzyl.hexdays(), kyzyl.static_registry(), kyzyl.region_r5_centers()
            kyzyl.calibration(), kyzyl.coverage(), kyzyl.detections_bytes()
            with kyzyl._LOCK:
                kyzyl._calendar((46.47, 40.66, 87.36, 55.39), "KZ")
                kyzyl._calendar((-180.0, -85.0, 180.0, 85.0), None)
        except Exception as exc:  # без данных экспорта сервер всё равно стартует
            print(f"[helios-api] warmup skipped: {exc}")

    threading.Thread(target=warm, daemon=True).start()
    yield


app = FastAPI(title="HELIOS-SHIELD API", version=__version__, lifespan=lifespan,
              description="Гармонизация пожаров MODIS+VIIRS, три ИИ (борт ×2 + Земля), умная доставка тревог. "
                          "Data API фронтенда Kyzyl Aspan — /v1/*.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.include_router(world_router)  # раньше KZ-роутера: одинаковые пути (/v1/fires, /calendar…) отдаёт мир
app.include_router(kyzyl_router)

_CACHE: dict[str, tuple[float, Any]] = {}


def cached(key: str, ttl: float, fn):
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _CACHE[key] = (time.time(), val)
    return val


def records(df: pd.DataFrame) -> list[dict]:
    return json.loads(df.to_json(orient="records", date_format="iso", default_handler=str))


def parquet(name: str) -> pd.DataFrame:
    path = PROCESSED / name
    if not path.exists():
        raise HTTPException(404, f"{name} ещё не посчитан — запустите пайплайн (python -m helios.cli all)")
    return pd.read_parquet(path)


def report(name: str) -> Any:
    path = REPORTS_DIR / f"{name}.json"
    if not path.exists():
        raise HTTPException(404, f"отчёт {name} не найден")
    return json.loads(path.read_text(encoding="utf-8"))


def geojson_points(df: pd.DataFrame, props: list[str]) -> dict:
    feats = []
    for r in records(df):
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
                      "properties": {k: r.get(k) for k in props}})
    return {"type": "FeatureCollection", "features": feats}


# ----------------------------------------------------------------------------- служебные
@app.get("/api/health")
def health():
    models = {p.name: round(p.stat().st_size / 1024, 1) for p in MODELS_DIR.glob("*") if p.is_file()}
    return {"version": __version__, "region": settings()["region"]["name"], "models_kb": models,
            "keys": {k: bool(env(k)) for k in ("FIRMS_MAP_KEY", "GEMINI_API_KEY", "EARTHDATA_TOKEN", "SUPABASE_URL",
                                               "HELIOS_INGEST_TOKEN", "SUPABASE_SERVICE_ROLE_KEY")}}


@app.get("/api/config")
def config():
    from helios.apis.gibs import layer_catalog

    return {"region": settings()["region"], "h3": settings()["h3"], "gibs_layers": layer_catalog(),
            "supabase": {"url": env("SUPABASE_URL"), "publishable_key": env("SUPABASE_PUBLISHABLE_KEY")}}


@app.get("/api/reports/{key}")
def get_report(key: str):
    return report(key)


@app.get("/api/models")
def models_summary():
    out = {}
    for name in ("ai1_edge_detector_metrics", "ai2_link_metrics", "ai3_ground_forecast_metrics"):
        try:
            out[name] = report(name)
        except HTTPException:
            out[name] = None
    return out


# ----------------------------------------------------------------------------- пожары и тревоги
@app.get("/api/fires/recent")
def fires_recent(period: str = Query("48h", pattern="^(24h|48h|7d)$"), only_veg: bool = False, live: bool = False):
    """Свежие пожары FIRMS NRT после фильтра шума и ИИ №1 (GeoJSON). live=true — заново из FIRMS."""
    if live:
        from helios.pipeline import run_nrt

        cached(f"nrt_{period}", 600, lambda: run_nrt(period))
    df = parquet("nrt_scored.parquet")
    if only_veg:
        df = df[df["keep_veg"]]
    cols = ["acq_dt", "stream", "frp", "conf_cat", "p_fire", "keep_veg", "is_static", "noise_reason",
            "p_real", "p_escalation", "priority", "h3_r7"]
    return geojson_points(df.astype({"stream": str, "conf_cat": str, "noise_reason": str, "priority": str}), cols)


@app.get("/api/alerts")
def alerts(source: str = Query("nrt", pattern="^(nrt|replay)$"), min_priority: str = "ROUTINE", limit: int = 500):
    df = parquet("nrt_alerts.parquet" if source == "nrt" else "delivery_alerts.parquet")
    order = ["SUPPRESS", "ROUTINE", "HIGH", "CRITICAL"]
    df = df[df["priority"].astype(str).map(order.index) >= order.index(min_priority)]
    return records(df.sort_values("acq_dt", ascending=False).head(limit))


@app.get("/api/static-sources")
def static_sources():
    df = parquet("static_registry.parquet")
    return geojson_points(df[df["is_static"]], ["h3_r8", "n", "static_score", "night_share", "first_year", "last_year"])


# ----------------------------------------------------------------------------- история и аналитика
@app.get("/api/calendar")
def calendar():
    return records(parquet("calendar_monthly.parquet"))


@app.get("/api/harmonization")
def harmonization():
    return {"validation": report("harmonization_validation"), "filters": report("filter_report")}


@app.get("/api/fire-dna")
def fire_dna(min_det: int = 5, dna_class: str | None = None, limit: int = 20000):
    df = parquet("fire_dna_r7.parquet")
    df = df[df["n_det"] >= min_det]
    if dna_class:
        df = df[df["dna_class"] == dna_class]
    return records(df.head(limit)[["h3_r7", "lat", "lon", "dna_class", "label_ru", "confidence", "n_det", "n_years", "peak_doy"]])


@app.get("/api/season-shift")
def season_shift():
    return {"region": report("season_shift_region"), "cells": records(parquet("season_shift_r4.parquet"))}


@app.get("/api/risk")
def risk(horizon: int = Query(1, ge=1, le=4), min_p: float = 0.0):
    df = parquet("risk_latest.parquet")
    df = df[(df["horizon_weeks"] == horizon) & (df["p_fire"] >= min_p)]
    return records(df)


@app.get("/api/timemachine")
def timemachine(as_of: str, horizon: int = Query(1, ge=1, le=4), strict: bool = False):
    """Прогноз «как будто сегодня as_of» и что произошло на самом деле."""
    tm = PROCESSED / "time_machine.parquet"
    if tm.exists():
        df = pd.read_parquet(tm)
        sel = df[(pd.to_datetime(df["as_of"]).dt.strftime("%Y-%m-%d") == as_of) & (df["horizon_weeks"] == horizon)]
        if len(sel):
            summary = next((r for r in report("time_machine") if r["as_of"] == as_of), None)
            return {"summary": summary, "cells": records(sel)}
    from helios.models.time_machine import scenario

    summary, df = scenario(as_of, horizons=(horizon,), strict=strict)
    df = df[(df["p_fire"] >= 0.02) | (df["actual"] == 1)]
    return {"summary": summary, "cells": records(df)}


@app.get("/api/blind-spots")
def blind_spots():
    return records(parquet("blind_spots_nrt.parquet"))


@app.get("/api/spread")
def spread():
    return records(parquet("spread_forecasts.parquet"))


# ----------------------------------------------------------------------------- ИИ-аналитик (Gemini)
class AnalyzeRequest(BaseModel):
    h3: str | None = None
    lat: float | None = None
    lon: float | None = None
    question: str | None = Field(None, max_length=500)


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    """Клик по региону → статистическая сводка → Gemini (или офлайн-аналитик) → текст риска."""
    from helios.analysis import cell_stats
    from helios.apis.gemini import analyze_region

    try:
        stats = cell_stats(req.h3, req.lat, req.lon)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    res = analyze_region(stats, req.question)
    try:
        from helios.db.supabase_sync import SupabaseClient

        SupabaseClient().upsert("ai_analyses", [{"h3": stats["h3_r5"], "region_id": settings()["region"]["id"],
                                                 "question": req.question, "stats": stats, "response": res["text"],
                                                 "model": res["model"], "source": res["source"]}])
    except Exception:
        pass  # без БД анализ всё равно возвращаем
    return {"stats": stats, **res}


# ----------------------------------------------------------------------------- ИИ №1 (борт)
class Detection(BaseModel):
    latitude: float
    longitude: float
    acq_date: str
    acq_time: str | int
    satellite: str = "N20"
    instrument: str = "VIIRS"
    confidence: str | int = "n"
    bright_ti4: float | None = None
    bright_ti5: float | None = None
    brightness: float | None = None
    bright_t31: float | None = None
    frp: float = 1.0
    scan: float = 0.4
    track: float = 0.4
    daynight: str = "D"
    version: str = "2.0NRT"


@app.post("/api/edge/score")
def edge_score(detections: list[Detection]):
    """ИИ №1 на произвольных точках в формате FIRMS: p_real, p_escalation, приоритет и 24-байтные пакеты."""
    from helios.apis.firms import normalize
    from helios.models import edge_detector
    from helios.pipeline import p
    from helios.processing.filters import add_geometry, apply_filters
    from helios.processing.persistence import static_cell_set

    raw = pd.DataFrame([d.model_dump() for d in detections])
    frames = []
    for instr, g in raw.groupby(raw["instrument"].str.upper()):
        if instr == "MODIS":
            frames.append(normalize(g.drop(columns=["bright_ti4", "bright_ti5"]), "MODIS", "nrt"))
        else:
            stream = {"N": "VIIRS_SNPP", "N20": "VIIRS_NOAA20", "1": "VIIRS_NOAA20", "N21": "VIIRS_NOAA21"}.get(
                str(g["satellite"].iloc[0]).upper(), "VIIRS_NOAA20")
            frames.append(normalize(g.drop(columns=["brightness", "bright_t31"]), stream, "nrt"))
    df = pd.concat(frames, ignore_index=True)
    registry = pd.read_parquet(p("static_registry.parquet"))
    scored = edge_detector.score_detections(apply_filters(add_geometry(df), static_cell_set(registry, 1)))
    alerts_df = edge_detector.make_alerts(scored, min_priority="ROUTINE")
    cols = ["lat", "lon", "acq_dt", "stream", "p_fire", "keep_veg", "is_static", "noise_reason", "p_real", "p_escalation", "priority"]
    return {"detections": records(scored[cols].astype({"stream": str, "noise_reason": str, "priority": str})),
            "alerts": records(alerts_df) if len(alerts_df) else []}


@app.get("/api/edge/packet/{hex_packet}")
def decode_packet(hex_packet: str):
    from helios.comms.packets import decode

    try:
        return decode(bytes.fromhex(hex_packet))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


# ----------------------------------------------------------------------------- связь (ИИ №2, физика, орбиты)
@app.get("/api/link/simulate")
def link_simulate(xray_flux: float = 1e-6, kp: float = 3.0, rain_mm_h: float = 0.0, cloud_frac: float = 0.2,
                  distance_km: float = 800.0, elevation_deg: float = 30.0, laser_power_w: float = 2.0,
                  receiver_radius_m: float = 0.2):
    """Симулятор «радио vs лазер»: вспышка (рентген), буря (Kp), дождь, облака → запасы каналов."""
    from helios.comms.physics import simulate_space_link

    return simulate_space_link(xray_flux, kp, rain_mm_h, cloud_frac, distance_km, elevation_deg, laser_power_w, receiver_radius_m)


@app.get("/api/mission-design")
def mission_design():
    from helios.comms.physics import mission_design_table

    return mission_design_table()


@app.get("/api/comm/plan")
def comm_plan(hours: int = Query(12, ge=1, le=48)):
    from helios.comms.scheduler import plan

    def _run():
        res = plan(hours=hours)
        return {"start": str(res["start"]), "end": str(res["end"]), "passes": records(res["passes"]),
                "blackouts": json.loads(json.dumps(res["blackouts"], default=str))}

    return cached(f"plan_{hours}", 900, _run)


@app.get("/api/satellites/positions")
def satellite_positions():
    from helios.apis.celestrak import fetch_all
    from helios.comms.orbits import Orbit

    now = pd.Timestamp.now(tz="UTC")
    times = pd.date_range(now, now + pd.Timedelta(minutes=100), freq="60s")
    out = []
    for name, (l1, l2) in fetch_all().items():
        la, lo, alt = Orbit(name, l1, l2).subpoint(times)
        out.append({"name": name, "lat": round(float(la[0]), 3), "lon": round(float(lo[0]), 3), "alt_km": round(float(alt[0]), 1),
                    "track": [[round(float(b), 3), round(float(a), 3)] for a, b in zip(la, lo)]})
    return out


@app.get("/api/space-weather")
def space_weather():
    from helios.apis.space_weather import current_conditions

    return cached("sw", 600, current_conditions)


@app.get("/api/satellites/delays")
def satellite_delays():
    from helios.models.ground_forecast import satellite_delay_report

    return cached("delays", 900, lambda: records(satellite_delay_report(24)))


@app.get("/api/eonet")
def eonet(days: int = 30):
    from helios.apis.eonet import wildfire_events

    return cached(f"eonet_{days}", 3600, lambda: wildfire_events(days=days))
