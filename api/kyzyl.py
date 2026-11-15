"""Data API для фронтенда Kyzyl Aspan — ровно контракт из kyzyl-aspan/PROGRESS.md §4.1 + расширения HELIOS.

Контракт (VITE_DATA_SOURCE=http, VITE_API_URL=/v1):
  GET /v1/detections                         → DetectionArchive (выборка реальных строк + метки фильтра HELIOS)
  GET /v1/fires?bbox=w,s,e,n&start=&end=     → FireCollection (GeoJSON, по полному архиву, ≤ 60 000 точек)
  GET /v1/calendar?bbox=…[&region=KZ]        → CalendarSeries (считается сервером по ПОЛНОМУ архиву)
  GET /v1/regions?q=text                     → Region[]
  GET /v1/overview                           → ActivityOverview (глобус)
  GET /v1/onboard-model                      → OnboardModel (их логистическая регрессия на реальных данных)

Расширения HELIOS (новые функции интерфейса):
  GET /v1/helios/status | risk | scenarios | alerts | static | blind | spread | satellites | area | context | mission
"""

from __future__ import annotations

import json
import math
import threading
from functools import lru_cache

import h3
import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query, Response

from helios.config import PROCESSED, REPORTS_DIR

router = APIRouter(prefix="/v1", tags=["kyzyl-aspan"])
K = PROCESSED / "kyzyl"
_LOCK = threading.Lock()

OVERLAP = ("2012-03", "2020-12")
LAST_MONTH = (2025 - 2000) * 12 + 11  # 2025-12 — последний полный месяц научного архива
FIRST_MONTH = 10  # 2000-11 — первые данные Terra MODIS
CONF = ["low", "nominal", "high"]
TRUTH = ["fire", "static", "false-alarm"]
METHOD = ("helios-shield-0.1: server noise filter (4-evidence static registry, sun glint, isolation, cross-sensor "
          "support) → H3 res-5 burning hexagon-days → empirical-Bayes ratio calibration to the Aqua MODIS scale")


def _json(obj) -> Response:
    return Response(content=json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_default),
                    media_type="application/json")


def _default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if np.isnan(o) else float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return str(o)


def _need(path):
    if not path.exists():
        raise HTTPException(503, f"{path.name} не готов — запустите: python -m helios.cli export-frontend")
    return path


def parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    try:
        w, s, e, n = (float(x) for x in bbox.split(","))
    except ValueError as exc:
        raise HTTPException(400, "bbox должен быть w,s,e,n") from exc
    if not (-90 <= s < n <= 90 and -180 <= w <= 180 and -180 <= e <= 180):
        raise HTTPException(400, "bbox вне диапазона")
    return w, s, e, n


def in_bbox(lng: np.ndarray, lat: np.ndarray, b: tuple[float, float, float, float]) -> np.ndarray:
    w, s, e, n = b
    lat_ok = (lat >= s) & (lat <= n)
    lng_ok = (lng >= w) & (lng <= e) if w <= e else (lng >= w) | (lng <= e)  # бокс через антимеридиан
    return lat_ok & lng_ok


# ----------------------------------------------------------------------------- загрузка (лениво, один раз)
@lru_cache(maxsize=1)
def arrays() -> dict[str, np.ndarray]:
    z = np.load(_need(K / "arrays.npz"))
    return {k: z[k] for k in z.files}


@lru_cache(maxsize=1)
def detections_bytes() -> bytes:
    data = json.loads(_need(K / "detections.json").read_text(encoding="utf-8"))
    out = {"version": data["version"], "synthetic": False, "rows": data["rows"],
           "meta": {k: data[k] for k in ("total_rows", "sample_rows", "sample_rate", "truthMeaning") if k in data}}
    return json.dumps(out, separators=(",", ":")).encode("utf-8")


@lru_cache(maxsize=1)
def hexdays() -> dict:
    hd = pd.read_parquet(_need(K / "hexdays_r5.parquet"))
    cat = hd["h3_r5"].astype("category")
    ids = list(cat.cat.categories)
    ll = np.array([h3.cell_to_latlng(c) for c in ids])
    return {"df": hd.assign(code=cat.cat.codes.to_numpy(np.int32)), "ids": ids, "lat": ll[:, 0], "lng": ll[:, 1]}


@lru_cache(maxsize=1)
def calibration() -> dict:
    return json.loads(_need(K / "calibration_r5.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def coverage() -> pd.DataFrame:
    c = pd.read_parquet(_need(PROCESSED / "stream_coverage.parquet"))
    return c.assign(month=pd.PeriodIndex(c["month"].astype(str), freq="M"))


@lru_cache(maxsize=1)
def static_registry() -> pd.DataFrame:
    r = pd.read_parquet(_need(PROCESSED / "static_registry.parquet"),
                        columns=["h3_r8", "lat", "lon", "n", "static_score", "night_share", "first_year", "last_year", "is_static"])
    return r[r["is_static"]].reset_index(drop=True)


@lru_cache(maxsize=1)
def region_r5_centers() -> np.ndarray:
    from helios.apis.boundaries import region_cells

    return np.array([h3.cell_to_latlng(c) for c in region_cells(5)])


@lru_cache(maxsize=1)
def regions() -> list[dict]:
    from helios.config import ROOT

    return json.loads((ROOT / "config" / "regions.json").read_text(encoding="utf-8"))


def _parquet(name: str) -> pd.DataFrame:
    return pd.read_parquet(_need(PROCESSED / name))


def _report(name: str):
    p = REPORTS_DIR / f"{name}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


# ----------------------------------------------------------------------------- контракт приложения
@router.get("/detections")
def get_detections():
    return Response(content=detections_bytes(), media_type="application/json")


@router.get("/fires")
def get_fires(bbox: str, start: str, end: str, limit: int = Query(60_000, le=100_000)):
    b = parse_bbox(bbox)
    a = arrays()
    try:
        d0 = (pd.Timestamp(start) - pd.Timestamp("2000-01-01")).days
        d1 = (pd.Timestamp(end) - pd.Timestamp("2000-01-01")).days
    except ValueError as exc:
        raise HTTPException(400, "start/end — YYYY-MM-DD") from exc
    lo, hi = np.searchsorted(a["day"], d0, "left"), np.searchsorted(a["day"], d1, "right")
    sl = slice(lo, hi)
    idx = np.flatnonzero(in_bbox(a["lng"][sl], a["lat"][sl], b)) + lo
    total = int(len(idx))
    if total > limit:  # равномерное прореживание по времени, а не «первые N»
        idx = idx[np.linspace(0, total - 1, limit).astype(int)]
    base = pd.Timestamp("2000-01-01")
    feats = []
    for i in idx:
        sensor = "MODIS" if a["sensor"][i] == 0 else "VIIRS"
        feats.append({
            "type": "Feature", "id": int(i),
            "geometry": {"type": "Point", "coordinates": [round(float(a["lng"][i]), 4), round(float(a["lat"][i]), 4)]},
            "properties": {"id": f"{sensor[0]}{int(i)}", "sensor": sensor,
                           "date": (base + pd.Timedelta(days=int(a["day"][i]))).strftime("%Y-%m-%d"),
                           "frp": round(float(a["frp"][i]), 1), "confidence": CONF[int(a["conf"][i])],
                           "truth": TRUTH[int(a["truth"][i])]},
        })
    return _json({"type": "FeatureCollection", "features": feats,
                  "meta": {"total": total, "truncated": len(feats) < total, "synthetic": False}})


def _robust_z(values: np.ndarray, months: np.ndarray) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    for m in range(12):
        sel = np.flatnonzero(months == m)
        if len(sel) < 6:
            continue
        v = values[sel]
        med = float(np.median(v))
        mad = float(np.median(np.abs(v - med)))
        if mad <= 0:
            continue
        for j, k in enumerate(sel):
            out[k] = round(float((v[j] - med) / (1.4826 * mad)), 2)
    return out


@lru_cache(maxsize=256)
def _calendar(b: tuple[float, float, float, float], region: str | None) -> dict:
    from helios.frontend_export import monthly_table
    from helios.processing.harmonize import harmonized_monthly

    meta_base = {"scale": "modis-equivalent-hex-days-per-month", "interval": 0.95,
                 "grid": {"system": "h3", "resolution": 5, "cellAreaKm2": round(h3.average_hexagon_area(5, "km^2"), 1)},
                 "synthetic": False, "method": METHOD}
    empty = {"bbox": list(b), "points": [], "meta": {**meta_base, "rawRatio": None,
             "ratio": {"value": 1.0, "lo": 1.0, "hi": 1.0, "overlapStart": OVERLAP[0], "overlapEnd": OVERLAP[1], "calibrated": False},
             "noise": {"considered": 0, "lowConfidence": 0, "staticSources": 0, "staticCells": 0}, "coverage": 0.0}}
    if region and len(region) == 2 and region != "KZ":
        return empty  # архив HELIOS пока покрывает только Казахстан
    H = hexdays()
    cell_in = in_bbox(H["lng"], H["lat"], b)
    df = H["df"]
    sel = df[cell_in[df["code"].to_numpy()]]
    a = arrays()
    box = in_bbox(a["lng"], a["lat"], b)
    if sel.empty and not box.any():
        return empty
    mt = monthly_table(sel, coverage())
    hm = harmonized_monthly(mt, {"to_ref": calibration()}) if len(mt) else pd.DataFrame()
    hm_idx = {((p.year - 2000) * 12 + p.month - 1): r for p, r in zip(hm.get("month", []), hm.to_dict("records"))} if len(hm) else {}

    months = np.arange(FIRST_MONTH, LAST_MONTH + 1)
    n_m = LAST_MONTH + 1
    keep = box & (a["truth"] == 0)
    modis_raw = np.bincount(a["month"][keep & (a["sensor"] == 0)], minlength=n_m)[:n_m]
    viirs_raw = np.bincount(a["month"][keep & (a["sensor"] == 1)], minlength=n_m)[:n_m]
    hexm = sel[sel["sensor"] == "MODIS"].drop_duplicates(["day", "code"]).groupby("month").size()
    hexv = sel[sel["sensor"] == "VIIRS"].drop_duplicates(["day", "code"]).groupby("month").size()
    viirs_start = (2012 - 2000) * 12
    harm = np.array([float(hm_idx.get(m, {}).get("harmonized") or 0.0) for m in months])
    z = _robust_z(harm, months % 12)
    points = []
    for k, m in enumerate(months):
        r = hm_idx.get(m, {})
        v_ok = m >= viirs_start
        points.append({
            "year": int(2000 + m // 12), "month": int(m % 12 + 1),
            "modis": int(modis_raw[m]), "viirsRaw": int(viirs_raw[m]) if v_ok else None,
            "modisHex": int(hexm.get(m, 0)), "viirsHex": int(hexv.get(m, 0)) if v_ok else None,
            "harmonized": round(float(r.get("harmonized") or 0.0), 2),
            "lo": round(float(r.get("lo95") or 0.0), 2), "hi": round(float(r.get("hi95") or 0.0), 2),
            "anomalyZ": z[k],
        })
    o0 = (2012 - 2000) * 12 + 2
    o1 = (2020 - 2000) * 12 + 11
    om = (months >= o0) & (months <= o1)
    raw_m, raw_v = modis_raw[months[om]].sum(), viirs_raw[months[om]].sum()
    hm_m = np.array([hexm.get(m, 0) for m in months[om]], float)
    hm_v = np.array([hexv.get(m, 0) for m in months[om]], float)
    ratio = float(hm_v.sum() / hm_m.sum()) if hm_m.sum() > 0 else 1.0
    years = (months[om] // 12)
    rng = np.random.default_rng(0)
    boots = []
    uy = np.unique(years)
    for _ in range(200):
        pick = rng.choice(uy, size=len(uy), replace=True)
        mm = np.concatenate([hm_m[years == y] for y in pick])
        vv = np.concatenate([hm_v[years == y] for y in pick])
        if mm.sum() > 0:
            boots.append(vv.sum() / mm.sum())
    st = static_registry()
    w, s, e, n = b
    km2 = max(1.0, (n - s) * 111.32 * (abs(e - w) if w <= e else 360 - w + e) * 111.32 * math.cos(math.radians((n + s) / 2)))
    rc = region_r5_centers()
    cov = min(1.0, float(in_bbox(rc[:, 1], rc[:, 0], b).sum()) * h3.average_hexagon_area(5, "km^2") / km2)
    return {"bbox": list(b), "points": points, "meta": {
        **meta_base,
        "rawRatio": round(float(raw_v / raw_m), 3) if raw_m > 0 else None,
        "ratio": {"value": round(ratio, 3), "lo": round(float(np.quantile(boots, 0.025)), 3) if boots else ratio,
                  "hi": round(float(np.quantile(boots, 0.975)), 3) if boots else ratio,
                  "overlapStart": OVERLAP[0], "overlapEnd": OVERLAP[1], "calibrated": bool(hm_m.sum() > 50)},
        "noise": {"considered": int(box.sum()), "lowConfidence": int((box & a["lowconf"]).sum()),
                  "staticSources": int((box & a["static"]).sum()),
                  "staticCells": int(in_bbox(st["lon"].to_numpy(), st["lat"].to_numpy(), b).sum())},
        "coverage": round(cov, 3),
    }}


@router.get("/calendar")
def get_calendar(bbox: str, region: str | None = None):
    b = tuple(round(v, 3) for v in parse_bbox(bbox))
    with _LOCK:  # pandas-группировки не любят параллельный первый прогрев кэшей
        return _json(_calendar(b, region))


def _norm(s: str) -> str:
    import unicodedata

    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower().replace("ё", "е")
    for ch in "'’ʻ`":
        s = s.replace(ch, "")
    return s.strip()


@router.get("/regions")
def get_regions(q: str = ""):
    """Поиск регионов — порт searchRegionList из фронтенда (тот же ранжир)."""
    import re

    items = regions()
    qq = _norm(q)
    if not qq:
        return _json([r for r in items if r.get("featured")][:8])
    scored = []
    for r in items:
        terms = [_norm(t) for t in (r["name"]["en"], r["name"]["ru"], *r.get("aliases", []))]
        best = 0
        for t in terms:
            if t == qq:
                best = max(best, 100)
            elif t.startswith(qq):
                best = max(best, 80)
            elif any(wd.startswith(qq) for wd in re.split(r"[\s\-–(),]+", t)):
                best = max(best, 60)
            elif qq in t:
                best = max(best, 40)
        if _norm(r["id"]) == qq:
            best = max(best, 100)
        if not best:
            continue
        best += 5 if r.get("group") == "central-asia" else 0
        best += 2 if r.get("kind") == "country" else 0
        scored.append((best, r["name"]["en"], r))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return _json([r for _, _, r in scored[:8]])


@router.get("/overview")
def get_overview():
    kz = json.loads(_need(K / "overview_kz.json").read_text(encoding="utf-8"))
    pts = list(kz["points"])
    g = K / "overview_global.json"
    if g.exists():
        glob = json.loads(g.read_text(encoding="utf-8"))
        kz_box = (46.4, 40.5, 87.4, 55.5)
        pts += [p for p in glob["points"] if not (kz_box[0] <= p[0] <= kz_box[2] and kz_box[1] <= p[1] <= kz_box[3])]
    return _json({"points": pts, "synthetic": False})


@router.get("/onboard-model")
def get_onboard_model():
    return Response(content=_need(K / "onboard_model.json").read_bytes(), media_type="application/json")


# ----------------------------------------------------------------------------- расширения HELIOS
def data_ready() -> bool:
    """Есть ли данные для карты: мировые агрегаты или экспорт по Казахстану. Без них сервер отвечает только
    «живыми» эндпоинтами (орбиты, созвездие, физика связи), а карта сайта должна остаться на демо-данных."""
    from api import world

    return bool(world.available()) or (K / "arrays.npz").exists()


@router.get("/helios/status")
def helios_status():
    return _json({
        "data_ready": data_ready(),
        "data": _report("frontend_export"), "refresh": _report("refresh_last"),
        "models": {"ai1_edge": _report("ai1_edge_detector_metrics"), "ai2_link": _report("ai2_link_metrics"),
                   "ai3_ground": (_report("ai3_ground_forecast_metrics") or {}).get("horizons")},
        "harmonization": _report("harmonization_validation"),
    })


@router.get("/helios/scenarios")
def helios_scenarios():
    tm = _report("time_machine") or []
    risk = PROCESSED / "risk_latest.parquet"
    latest = None
    if risk.exists():
        r = pd.read_parquet(risk, columns=["as_of_week"])
        latest = str(pd.Timestamp(r["as_of_week"].max()).date())
    return _json({"latest": latest, "history_gap": (_report("current_year_update") or {}).get("history_gap"),
                  "scenarios": [{"as_of": s["as_of"], "horizons": {h: {"ai": v["ai"], "baseline": v["seasonal_baseline"],
                                                                        "target_week": v.get("target_week")}
                                                                    for h, v in s["horizons"].items()}} for s in tm]})


@router.get("/helios/risk")
def helios_risk(horizon: int = Query(1, ge=1, le=4), as_of: str = "latest", min_p: float = 0.003):
    """Прогноз ИИ №3 по ячейкам H3 res-5: [h3, p_fire, p_climatology, actual] (actual — для Time Machine)."""
    if as_of == "latest":
        df = _parquet("risk_latest.parquet")
        df = df[df["horizon_weeks"] == horizon]
        actual = np.full(len(df), -1)
    else:
        df = _parquet("time_machine.parquet")
        df = df[(pd.to_datetime(df["as_of"]).dt.strftime("%Y-%m-%d") == as_of) & (df["horizon_weeks"] == horizon)]
        if df.empty:
            raise HTTPException(404, f"нет сценария Time Machine на {as_of}")
        actual = df["actual"].to_numpy()
    keep = (df["p_fire"].to_numpy() >= min_p) | (actual == 1)
    df, actual = df[keep], actual[keep]
    rows = [[c, round(float(p), 4), round(float(q), 4), int(x)] for c, p, q, x in
            zip(df["h3_r5"], df["p_fire"], df["p_climatology"], actual)]
    t = df["target_week"].iloc[0] if len(df) else None
    return _json({"as_of": as_of, "horizon_weeks": horizon, "target_week": str(pd.Timestamp(t).date()) if t is not None else None,
                  "fields": ["h3", "p_fire", "p_climatology", "actual"], "rows": rows})


@router.get("/helios/alerts")
def helios_alerts():
    df = _parquet("nrt_alerts.parquet")
    order = {"ROUTINE": 1, "HIGH": 2, "CRITICAL": 3}
    rows = [[round(float(lo), 4), round(float(la), 4), str(p), round(float(pr), 3), round(float(pe), 3), round(float(f), 1),
             int(n), str(st), pd.Timestamp(t).isoformat(), pk] for lo, la, p, pr, pe, f, n, st, t, pk in
            zip(df["lon"], df["lat"], df["priority"], df["p_real"], df["p_escalation"], df["frp_sum"], df["cluster_n"],
                df["stream"].astype(str), df["acq_dt"], df["packet_hex"])]
    rows.sort(key=lambda r: (-order.get(r[2], 0), r[8]))
    return _json({"fields": ["lng", "lat", "priority", "p_real", "p_escalation", "frp", "pixels", "stream", "acq", "packet"],
                  "rows": rows, "updated": (_report("nrt_summary") or {}).get("computed_at")})


@router.get("/helios/static")
def helios_static():
    st = static_registry()
    return _json({"fields": ["lng", "lat", "score", "detections", "night_share", "first_year", "last_year"],
                  "rows": [[round(float(lo), 4), round(float(la), 4), round(float(s), 2), int(n), round(float(ns), 2), int(a), int(b)]
                           for lo, la, s, n, ns, a, b in zip(st["lon"], st["lat"], st["static_score"], st["n"],
                                                             st["night_share"], st["first_year"], st["last_year"])]})


@router.get("/helios/blind")
def helios_blind():
    df = _parquet("blind_spots_nrt.parquet")
    return _json({"fields": ["h3", "blind_score", "cloud", "expected_p", "message"],
                  "rows": [[c, round(float(s), 3), round(float(cl), 2), round(float(e), 3), m or ""] for c, s, cl, e, m in
                           zip(df["h3"], df["blind_score"], df["cloud_frac"], df["expected_fire_p"], df["message"])]})


@router.get("/helios/spread")
def helios_spread():
    df = _parquet("spread_forecasts.parquet")
    feats = []
    for r in df.to_dict("records"):
        for hz in ("24h", "12h", "6h"):
            ring = r.get(f"polygon_{hz}")
            if ring is None:
                continue
            feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [list(map(list, ring))]},
                          "properties": {"horizon": hz, "gfdi": r["gfdi"], "danger": r["danger_ru"], "ros_kmh": r["ros_kmh"],
                                         "wind_kmh": r["wind_kmh"], "to_deg": r["spread_to_deg"]}})
    return _json({"type": "FeatureCollection", "features": feats})


@router.get("/helios/satellites")
def helios_satellites():
    from helios.apis.celestrak import SATELLITES, fetch_all
    from helios.comms.orbits import Orbit

    now = pd.Timestamp.now(tz="UTC").floor("min")
    times = pd.date_range(now - pd.Timedelta(minutes=20), now + pd.Timedelta(minutes=80), freq="60s")
    out = []
    for name, (l1, l2) in fetch_all().items():
        la, lo, alt = Orbit(name, l1, l2).subpoint(times)
        role = SATELLITES[name][1]
        out.append({"name": name, "role": role, "lng": round(float(lo[20]), 3), "lat": round(float(la[20]), 3),
                    "alt_km": round(float(alt[20]), 1),
                    "track": [[round(float(b), 3), round(float(a), 3)] for a, b in zip(la, lo)] if role == "observer" else []})
    return _json({"time": now.isoformat(), "satellites": out})


@router.get("/helios/area")
def helios_area(bbox: str, region: str | None = None):
    """Карточка HELIOS для выбранной области: прогноз ИИ №3, Fire DNA, сдвиг сезона, слепые зоны, свежие тревоги."""
    b = parse_bbox(bbox)
    out: dict = {"bbox": list(b), "covered": not (region and len(region) == 2 and region != "KZ")}
    if not out["covered"]:
        return _json(out)
    risk = PROCESSED / "risk_latest.parquet"
    if risk.exists():
        r = pd.read_parquet(risk)
        r = r[in_bbox(r["lon"].to_numpy(), r["lat"].to_numpy(), b)]
        if len(r):
            out["forecast"] = {
                "as_of_week": str(pd.Timestamp(r["as_of_week"].iloc[0]).date()),
                "by_horizon": {int(h): {"max": round(float(g["p_fire"].max()), 4), "mean": round(float(g["p_fire"].mean()), 4),
                                        "climatology_mean": round(float(g["p_climatology"].mean()), 4),
                                        "cells_over_10pct": int((g["p_fire"] >= 0.1).sum())}
                               for h, g in r.groupby("horizon_weeks")},
            }
    dna = PROCESSED / "fire_dna_r7.parquet"
    if dna.exists():
        d = pd.read_parquet(dna, columns=["lat", "lon", "dna_class", "n_det"])
        d = d[in_bbox(d["lon"].to_numpy(), d["lat"].to_numpy(), b) & (d["n_det"] >= 3)]
        if len(d):
            out["fire_dna"] = {k: int(v) for k, v in d["dna_class"].value_counts().items()}
    sh = PROCESSED / "season_shift_r4.parquet"
    if sh.exists():
        s = pd.read_parquet(sh)
        s = s[in_bbox(s["lon"].to_numpy(), s["lat"].to_numpy(), b)]
        if len(s):
            out["season_shift"] = {"cells": int(len(s)), "median_days_per_decade": round(float(s["days_per_decade"].median()), 1),
                                   "significant_cells": int(s["significant"].sum())}
    reg = _report("season_shift_region")
    if reg:
        out["season_shift_region"] = {m: reg["all_sensors"][m].get("days_per_decade") for m in ("start_doy", "peak_doy", "end_doy")}
        out["season_shift_verdict"] = reg.get("verdict")
    bl = PROCESSED / "blind_spots_nrt.parquet"
    if bl.exists():
        x = pd.read_parquet(bl)
        x = x[in_bbox(x["lon"].to_numpy(), x["lat"].to_numpy(), b)]
        out["blind_cells"] = int((x["message"].fillna("") != "").sum())
    al = PROCESSED / "nrt_alerts.parquet"
    if al.exists():
        x = pd.read_parquet(al)
        x = x[in_bbox(x["lon"].to_numpy(), x["lat"].to_numpy(), b)]
        out["alerts"] = {str(k): int(v) for k, v in x["priority"].astype(str).value_counts().items()}
    st = static_registry()
    out["static_sources"] = int(in_bbox(st["lon"].to_numpy(), st["lat"].to_numpy(), b).sum())
    m3 = _report("ai3_ground_forecast_metrics")
    if m3:
        t = m3["horizons"]["h1"]["test"]
        out["model_quality"] = {"roc_auc": t["ai"]["roc_auc"], "pr_auc": t["ai"]["pr_auc"],
                                "baseline_pr_auc": t["baseline_climatology"]["pr_auc"]}
    return _json(out)


@router.get("/helios/context")
def helios_context(bbox: str, region: str | None = None):
    """Короткая сводка для промпта Gemini (Node-сервер фронтенда добавляет её к AreaSummary)."""
    resp = helios_area(bbox, region)
    data = json.loads(resp.body)
    data["note"] = ("HELIOS-SHIELD server pipeline on real NASA FIRMS data (Kazakhstan): AI #3 = gradient boosting "
                    "fire-risk forecast per H3 res-5 cell (probability of any fire in the target week), Fire DNA = "
                    "probabilistic burn-type classes, season_shift = Theil–Sen days/decade.")
    return _json(data)


@router.get("/helios/mission")
def helios_mission():
    from helios.comms.physics import mission_design_table

    bl = PROCESSED / "comm_blackouts.parquet"
    blackouts = []
    if bl.exists():
        b = pd.read_parquet(bl)
        b = b[b["computed_at"] == b["computed_at"].max()]
        blackouts = json.loads(b.drop(columns=["gaps"], errors="ignore").to_json(orient="records", date_format="iso"))
    passes = []
    pp = PROCESSED / "comm_passes.parquet"
    if pp.exists():
        p = pd.read_parquet(pp).sort_values("aos").head(80)
        passes = json.loads(p.to_json(orient="records", date_format="iso"))
    return _json({
        "ai1": _report("ai1_edge_detector_metrics"), "ai2": _report("ai2_link_metrics"),
        "delivery": _report("delivery_summary"), "delays": _report("satellite_delays"),
        "blackouts": blackouts, "passes": passes, "design": mission_design_table(),
    })


@router.get("/helios/link")
def helios_link(xray_flux: float = 1e-6, kp: float = 3.0, rain_mm_h: float = 0.0, cloud_frac: float = 0.2,
                distance_km: float = 800.0, elevation_deg: float = 30.0, laser_power_w: float = 2.0):
    from helios.comms.physics import simulate_space_link

    return _json(simulate_space_link(xray_flux, kp, rain_mm_h, cloud_frac, distance_km, elevation_deg, laser_power_w))
