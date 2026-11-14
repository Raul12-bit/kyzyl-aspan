"""Оркестрация: история (фильтры + H3 + гармонизация), погода, аналитика, NRT.

Все результаты кладутся в data/processed (parquet) и artifacts/reports (json) —
оттуда их берут обучение ИИ, API-сервер и выгрузка в Supabase.
"""

from __future__ import annotations

from datetime import date

import h3
import numpy as np
import pandas as pd

from .config import PROCESSED, REPORTS_DIR, settings
from .utils import get_logger, save_json

log = get_logger("helios.pipeline")

SLIM_COLS = [
    "lat", "lon", "acq_dt", "sensor", "stream", "bright_mir", "bright_tir", "frp", "scan", "track",
    "conf_pct", "conf_cat", "type", "sza", "daynight_sza", "scan_deg", "pixel_km2", "glint_deg",
    "h3_r8", "h3_r7", "h3_r5", "p_fire_raw", "p_fire", "neighbors", "cross_confirmed",
    "is_low_conf", "is_glint_risk", "is_isolated", "is_saa", "is_static", "noise_reason", "keep_veg",
]


def p(name: str):
    return PROCESSED / name


# ----------------------------------------------------------------------------- история
def build_history() -> dict:
    from .apis.firms import load_country_archive
    from .processing import harmonize
    from .processing.filters import add_geometry, apply_filters, filter_report
    from .processing.persistence import build_static_registry, static_cell_set

    raw = load_country_archive()
    log.info("geometry for %d detections", len(raw))
    geo = add_geometry(raw)
    registry = build_static_registry(geo)
    registry.to_parquet(p("static_registry.parquet"), index=False)
    cells = static_cell_set(registry, buffer_k=1)
    filtered = apply_filters(geo, cells)
    filtered[SLIM_COLS].to_parquet(p("detections_filtered.parquet"), index=False)
    frep = filter_report(filtered)
    save_json(frep, REPORTS_DIR / "filter_report.json")

    res = harmonize.run(filtered)
    res["celldays"].to_parquet(p("celldays.parquet"), index=False)
    res["coverage"].assign(month=res["coverage"]["month"].astype(str)).to_parquet(p("stream_coverage.parquet"), index=False)
    res["calibration"].to_parquet(p("calibration.parquet"), index=False)
    cal = res["calendar"].copy()
    cal["month"] = cal["month"].astype(str)
    cal.to_parquet(p("calendar_monthly.parquet"), index=False)
    save_json(res["validation"], REPORTS_DIR / "harmonization_validation.json")
    save_json(res["to_ref"], REPORTS_DIR / "calibration_to_aqua.json")

    weekly = harmonize.harmonized_cell_weekly(res["celldays"], res["to_ref"])
    weekly.to_parquet(p("cell_weekly_r5.parquet"), index=False)
    log.info("history ready: %d detections kept of %d", int(filtered["keep_veg"].sum()), len(filtered))
    return {"filter_report": frep, "validation": res["validation"]}


# ----------------------------------------------------------------------------- погода
def weather_points() -> dict[str, tuple[float, float]]:
    """Центры H3 res-3 ячеек страны (≈ 0.5–1° сетка, как у MERRA-2 в NASA POWER)."""
    from .apis.boundaries import region_cells

    res = settings()["h3"]["res_weather"]
    return {c: h3.cell_to_latlng(c) for c in sorted(region_cells(res))}


def fetch_weather(start: date | None = None, end: date | None = None) -> pd.DataFrame:
    from .apis.nasa_power import fetch_grid

    cfg = settings()["history"]
    start = start or date(cfg["start_year"] if cfg["start_year"] > 2000 else 2001, 1, 1)
    end = end or date(cfg["end_year"], 12, 31)
    pts = weather_points()
    log.info("NASA POWER: %d points, %s..%s", len(pts), start, end)
    df = fetch_grid(pts, start, end, workers=4)
    if not df.empty:
        df.to_parquet(p("weather_daily_r3.parquet"), index=False)
    return df


# ----------------------------------------------------------------------------- аналитика
def run_analytics() -> dict:
    from .models import time_machine
    from .processing import blind_spots, fire_dna, season_shift

    det = pd.read_parquet(p("detections_filtered.parquet"))
    registry = pd.read_parquet(p("static_registry.parquet"))
    cd = pd.read_parquet(p("celldays.parquet"))

    dna = fire_dna.classify_cells(det, registry)
    dna.to_parquet(p("fire_dna_r7.parquet"), index=False)

    shift_region = season_shift.region_season_shift(cd)
    shift_cells = season_shift.cell_season_shift(cd)
    shift_cells.to_parquet(p("season_shift_r4.parquet"), index=False)
    save_json(shift_region, REPORTS_DIR / "season_shift_region.json")

    blind = blind_spots.historical_blind_spots()
    blind_validation = None
    if blind is not None and len(blind):
        blind_validation = blind.attrs.get("validation")
        blind.to_parquet(p("blind_spots_hist.parquet"), index=False)

    tm = time_machine.run_default_scenarios()
    summary = {
        "fire_dna_counts": dna["dna_class"].value_counts().to_dict(),
        "season_shift_verdict": shift_region.get("verdict"),
        "season_shift_cells_significant": int(shift_cells["significant"].sum()) if "significant" in shift_cells else 0,
        "blind_spot_rows": 0 if blind is None else int(len(blind)),
        "blind_spot_validation": blind_validation,
        "time_machine": tm,
    }
    save_json(summary, REPORTS_DIR / "analytics_summary.json")
    return summary


# ----------------------------------------------------------------------------- текущий год
def update_current_year() -> dict:
    """Догрузить текущий год: погода NASA POWER + пожары (Area API с MAP_KEY, иначе NRT 7 дней)."""
    from .apis.firms import fetch_area_range, fetch_open_nrt, map_key
    from .apis.nasa_power import fetch_grid
    from .processing import harmonize
    from .processing.filters import add_geometry, apply_filters
    from .processing.persistence import static_cell_set

    today = pd.Timestamp.now(tz="UTC").date()
    year_start = date(today.year, 1, 1)
    info = {"year": today.year}
    try:
        w = fetch_grid(weather_points(), year_start, today - pd.Timedelta(days=3), workers=4)
        if len(w):
            w.to_parquet(p("weather_daily_r3_current.parquet"), index=False)
            info["weather_days"] = int(w["date"].nunique())
    except Exception as exc:
        log.warning("POWER current year: %s", exc)
    if map_key():
        fires = fetch_area_range(year_start, today, quality="nrt")
        info["fires_source"] = "FIRMS Area API (MAP_KEY)"
        info["history_gap"] = None
    else:
        fires = fetch_open_nrt("7d")
        info["fires_source"] = "FIRMS open NRT 7d (без MAP_KEY)"
        info["history_gap"] = f"{year_start}..{today - pd.Timedelta(days=8)}: добавьте FIRMS_MAP_KEY для полной истории"
    if len(fires):
        from .apis.boundaries import in_region

        fires = fires[in_region(fires["lat"].to_numpy(), fires["lon"].to_numpy())].reset_index(drop=True)
        registry = pd.read_parquet(p("static_registry.parquet"))
        filt = apply_filters(add_geometry(fires), static_cell_set(registry, buffer_k=1))
        cd = harmonize.celldays(filt)
        to_ref = __import__("json").loads((REPORTS_DIR / "calibration_to_aqua.json").read_text(encoding="utf-8"))
        weekly = harmonize.harmonized_cell_weekly(cd, to_ref)
        weekly.to_parquet(p("cell_weekly_r5_current.parquet"), index=False)
        info["fires_kept"] = int(filt["keep_veg"].sum())
    save_json(info, REPORTS_DIR / "current_year_update.json")
    return info


def forecast_now() -> pd.DataFrame:
    """Текущий прогноз риска ИИ №3 (последняя неделя с данными) на 1–4 недели вперёд."""
    from .models import ground_forecast
    from .models.features import Panel

    cw = pd.read_parquet(p("cell_weekly_r5.parquet"))
    wx = pd.read_parquet(p("weather_daily_r3.parquet"))
    if p("cell_weekly_r5_current.parquet").exists():
        cw = pd.concat([cw, pd.read_parquet(p("cell_weekly_r5_current.parquet"))], ignore_index=True)
    if p("weather_daily_r3_current.parquet").exists():
        wx = pd.concat([wx, pd.read_parquet(p("weather_daily_r3_current.parquet"))], ignore_index=True)
    ground_forecast._PANEL = Panel(cw, wx)
    last_week = pd.to_datetime(cw["week"]).max()
    frames = [ground_forecast.predict_week(last_week, h) for h in ground_forecast.HORIZONS]
    risk = pd.concat(frames, ignore_index=True).drop(columns=["actual"])
    risk = risk.rename(columns={"horizon_weeks": "horizon_weeks"})
    risk.to_parquet(p("risk_latest.parquet"), index=False)
    ground_forecast._PANEL = None
    log.info("forecast_now: as of %s, %d cells", last_week.date(), risk["h3_r5"].nunique())
    return risk


# ----------------------------------------------------------------------------- NRT (оперативный контур)
NRT_EXTRAS = ("spread", "satellite_delays", "comm_plan", "space_weather", "blind_spots_now")


def run_nrt(period: str = "48h", extras: tuple[str, ...] | set[str] | None = None) -> dict:
    """Свежие пожары: FIRMS NRT -> фильтр (реестр факелов) -> ИИ №1 -> тревоги,
    + распространение по ветру, задержки спутников, план связи, космическая погода, слепые зоны.
    extras — какие дополнительные продукты считать (по умолчанию все)."""
    from .apis.boundaries import in_region
    from .apis.firms import fetch_open_nrt
    from .models import edge_detector
    from .processing.filters import add_geometry, apply_filters
    from .processing.persistence import static_cell_set

    extras = set(NRT_EXTRAS if extras is None else extras)
    out: dict = {}
    nrt = fetch_open_nrt(period)
    if len(nrt):
        nrt = nrt[in_region(nrt["lat"].to_numpy(), nrt["lon"].to_numpy())].reset_index(drop=True)
    if len(nrt):
        registry = pd.read_parquet(p("static_registry.parquet"))
        filt = apply_filters(add_geometry(nrt), static_cell_set(registry, buffer_k=1))
        scored = edge_detector.score_detections(filt)
        scored.to_parquet(p("nrt_scored.parquet"), index=False)
        alerts = edge_detector.make_alerts(scored)
        alerts.to_parquet(p("nrt_alerts.parquet"), index=False)
        out.update({
            "detections": int(len(filt)), "kept_veg": int(filt["keep_veg"].sum()), "static": int(filt["is_static"].sum()),
            "by_stream": filt["stream"].astype(str).value_counts().to_dict(),
            "alerts": alerts["priority"].astype(str).value_counts().to_dict() if len(alerts) else {},
            "latest_acq": str(filt["acq_dt"].max()),
        })
        if "spread" in extras:
            _safe(out, "spread", lambda: _spread_for(scored))
    else:
        log.warning("NRT: нет свежих точек в регионе")
        out["detections"] = 0
    for key, fn in (("satellite_delays", _satellite_delays), ("comm_plan", _comm_plan),
                    ("space_weather", _space_weather), ("blind_spots_now", _blind_now)):
        if key in extras:
            _safe(out, key, fn)
    out["computed_at"] = pd.Timestamp.now(tz="UTC").isoformat()
    save_json(out, REPORTS_DIR / "nrt_summary.json")
    log.info("NRT: %s", {k: v for k, v in out.items() if k != "comm_plan"})
    return out


# ----------------------------------------------------------------------------- автообновление (каждый час)
NRT_SYNC_TABLES = ["fire_detections_nrt", "alerts_nrt", "spread_forecasts", "satellite_delays", "space_weather",
                   "comm_passes", "comm_blackouts", "blind_spots_nrt", "reports"]


def _age_hours(path) -> float:
    import time

    return (time.time() - path.stat().st_mtime) / 3600 if path.exists() else 1e9


def refresh(period: str = "48h", forecast_every_h: float = 24.0, comm_every_h: float = 3.0) -> dict:
    """Ежечасное автообновление: свежие пожары -> фильтр -> ИИ №1 -> тревоги -> Supabase.
    Тяжёлые продукты пересчитываются реже: план связи и слепые зоны — раз в 3 ч,
    погода/пожары текущего года и прогноз риска ИИ №3 — раз в сутки."""
    import os
    import time

    from .db.supabase_sync import sync_all

    lock = PROCESSED / ".refresh.lock"
    if lock.exists() and _age_hours(lock) < 2:
        log.warning("refresh: предыдущий запуск ещё идёт (lock %s) — пропускаю", lock)
        return {"skipped": "locked"}
    lock.write_text(f"{os.getpid()} {time.time():.0f}", encoding="utf-8")
    t0 = time.time()
    out: dict = {"started_at": pd.Timestamp.now(tz="UTC").isoformat()}
    try:
        extras = {"spread", "satellite_delays", "space_weather"}
        if _age_hours(p("comm_passes.parquet")) >= comm_every_h:
            extras.add("comm_plan")
        if _age_hours(p("blind_spots_nrt.parquet")) >= comm_every_h:
            extras.add("blind_spots_now")
        tables = list(NRT_SYNC_TABLES)
        if _age_hours(p("risk_latest.parquet")) >= forecast_every_h:
            _safe(out, "current_year", update_current_year)
            _safe(out, "forecast_cells", lambda: int(forecast_now()["h3_r5"].nunique()))
            tables.append("risk_forecast")
            extras.add("blind_spots_now")  # слепые зоны зависят от свежего прогноза риска
            from .frontend_export import global_overview

            _safe(out, "globe_overview", lambda: bool(global_overview()))  # глобус фронтенда: пожары мира за сутки
            from .config import MODELS_DIR

            if (MODELS_DIR / "world_forecast_oper_h1.txt").exists():  # прогноз ИИ №3 для всего мира (лента NRT 7 дней)
                from .world.forecast import forecast_now as world_forecast_now

                _safe(out, "world_forecast", lambda: world_forecast_now()["rows"])
                tables.append("world_risk_latest")
        _safe(out, "nrt", lambda: run_nrt(period, extras))
        out["extras"] = sorted(extras)
        _safe(out, "sync", lambda: sync_all(only=tables))
    finally:
        lock.unlink(missing_ok=True)
    out["seconds"] = round(time.time() - t0, 1)
    save_json(out, REPORTS_DIR / "refresh_last.json")
    log.info("refresh done in %.0f s", out["seconds"])
    return out


def _safe(out: dict, key: str, fn) -> None:
    try:
        out[key] = fn()
    except Exception as exc:
        log.warning("%s: %s", key, exc)
        out[key] = f"error: {exc}"


def _spread_for(scored: pd.DataFrame):
    from .processing.spread import forecast_spread

    k = scored[scored["keep_veg"]]
    if k.empty:
        return 0
    k = k.assign(h3_r6=[h3.cell_to_parent(c, 6) for c in k["h3_r7"]])
    cl = k.groupby("h3_r6").agg(lat=("lat", "mean"), lon=("lon", "mean"), frp_sum=("frp", "sum"), n=("frp", "size")).reset_index()
    cl = cl.sort_values("frp_sum", ascending=False).head(40).rename(columns={"h3_r6": "cluster_id"})
    sp = forecast_spread(cl)
    if len(sp):
        sp["computed_at"] = pd.Timestamp.now(tz="UTC").floor("min")
        sp.to_parquet(p("spread_forecasts.parquet"), index=False)
    return int(len(sp))


def _satellite_delays():
    from .models.ground_forecast import satellite_delay_report

    rep = satellite_delay_report(hours=24)
    if len(rep):
        rep["computed_at"] = pd.Timestamp.now(tz="UTC").floor("min")
        rep.to_parquet(p("satellite_delays.parquet"), index=False)
        return rep[["stream", "median_latency_min", "status"]].to_dict("records")
    return []


def _comm_plan():
    from .comms.scheduler import plan

    res = plan(hours=24)
    passes = res["passes"]
    if len(passes):
        cols = {c: c.lower() for c in passes.columns}
        passes = passes.rename(columns=cols)
        keep = ["satellite", "station", "aos", "los", "max_el", "duration_min", "s_availability", "x_availability",
                "ka_availability", "opt_availability", "recommended_channel", "expected_volume_gb"]
        passes.reindex(columns=keep).to_parquet(p("comm_passes.parquet"), index=False)
    bl = pd.DataFrame(res["blackouts"])
    if len(bl):
        bl["computed_at"] = pd.Timestamp.now(tz="UTC").floor("min")
        bl.to_parquet(p("comm_blackouts.parquet"), index=False)
    return {"passes": int(len(passes)),
            "blackouts": [{k: b[k] for k in ("satellite", "minutes_without_any_link", "longest_gap_min",
                                             "minutes_without_link_with_real_relays", "minutes_without_link_with_relay_76E")}
                          for b in res["blackouts"]]}


def _space_weather():
    from .apis.space_weather import current_conditions

    cur = current_conditions()
    df = pd.DataFrame([{"time": pd.Timestamp.now(tz="UTC").floor("min"), "kp": cur.get("kp"), "xray_flux": cur.get("xray_flux"),
                        "flare_class": cur.get("flare_class"), "f107": cur.get("f107")}])
    df.to_parquet(p("space_weather.parquet"), index=False)
    return cur


def _blind_now():
    from .processing.blind_spots import recent_blind_spots

    risk = pd.read_parquet(p("risk_latest.parquet")) if p("risk_latest.parquet").exists() else None
    if risk is not None:
        risk = risk[risk["horizon_weeks"] == 1]
    seen = set()
    if p("nrt_scored.parquet").exists():
        s = pd.read_parquet(p("nrt_scored.parquet"))
        seen = {h3.cell_to_parent(c, settings()["h3"]["res_weather"]) for c in s.loc[s["keep_veg"], "h3_r7"]}
    b = recent_blind_spots(risk, seen)
    if len(b):
        b2 = b.assign(h3=b["h3_r3"], week=pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"), source="nrt",
                      expected_fire_p=b["expected_fire_p"], cloud_frac=b["cloud_at_overpasses"],
                      fire_next_week=None)[["h3", "week", "source", "expected_fire_p", "cloud_frac", "blind_score",
                                            "fire_next_week", "message", "lat", "lon"]]
        b2.to_parquet(p("blind_spots_nrt.parquet"), index=False)
    return {"cells": int(len(b)), "blind": int(b["is_blind"].sum()) if len(b) else 0}
