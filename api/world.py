"""Мировой Data API HELIOS (/v1) — все страны, регионы (admin-1) и гексагоны любого масштаба.

Перекрывает KZ-эндпоинты из api/kyzyl.py, когда построены мировые агрегаты (helios.world.aggregate);
без них отдаёт старые ответы по Казахстану.

  GET /v1/hex?bbox&res=3..7&start=YYYY-MM&end=YYYY-MM&noise=1&sensors=MV
        горящие гексагоны по ВСЕМ обнаружениям (а не по выборке) — карта любого масштаба
  GET /v1/fires?bbox&start&end&limit      каждое обнаружение с размером пикселя (scan × track, км)
  GET /v1/calendar?bbox[&region=WORLD|ISO2|adm1]   гармонизированный ряд (калибровка — по стране)
  GET /v1/regions?q=                      поиск по 240 странам и 4 589 регионам на 7 языках
  GET /v1/regions/geo?country=ISO2        границы регионов страны (упрощённые)
  GET /v1/regions/stats?country=ISO2|WORLD&start&end   активность по регионам / странам (хороплет)
  GET /v1/area/stats?bbox[&region]&start&end&lowconf=1&static=1&sensors=MV   итоги для панели района
  GET /v1/overview                        глобус: самые активные ячейки последнего года
  GET /v1/detections                      выборка строк для браузерных демо (фильтр шума и т.п.)
"""

from __future__ import annotations

import json
import math
import threading
from functools import lru_cache

import duckdb
import h3
import numpy as np
import pandas as pd
import polars as pl
from fastapi import APIRouter, HTTPException, Query, Response

from api import kyzyl
from api.kyzyl import _json, parse_bbox
from helios.world.aggregate import AGG, MODIS_MASK, STREAM_OF_SAT, VIIRS_MASK
from helios.world.ingest import DET_DIR
from helios.world.regions import NE_ADM0, REGIONS_DIR, area_km2, region_index

router = APIRouter(prefix="/v1", tags=["world"])
_LOCK = threading.Lock()
_DB_LOCK = threading.Lock()
_DB: duckdb.DuckDBPyConnection | None = None

CAL_RES = 6  # сетка гармонизации и статистики районов: H3 res 6 (~36 км²)
OVERLAP = ("2012-03", "2020-12")
VIIRS_START = (2012 - 2000) * 12
CENTRAL_ASIA = {"KZ", "UZ", "KG", "TJ", "TM", "AF", "MN"}
METHOD = ("helios-shield-world-0.2: NASA FIRMS MODIS C6.1 + VIIRS S-NPP, all countries → noise filter (FIRMS type, "
          "low confidence, global 26-year static-source registry) → H3 res-6 burning hexagon-days in local solar "
          "days → per-country empirical-Bayes calibration of every stream (satellite × day/night) to Aqua MODIS")
CONF = ["low", "nominal", "high"]
SAT_NAME = ["Terra", "Aqua", "Suomi NPP", "NOAA-20", "NOAA-21"]


def available() -> bool:
    return (AGG / "area_month.parquet").exists() and (AGG / "cellmonth_r6.parquet").exists()


def _p(name: str) -> str:
    return (AGG / name).as_posix()


def db() -> duckdb.DuckDBPyConnection:
    """Общая in-memory база (таблица буфера постоянных источников); на запрос — свой cursor()."""
    global _DB
    with _DB_LOCK:
        if _DB is None:
            c = duckdb.connect()
            c.execute("SET threads=8; SET memory_limit='4GB'")
            st = pl.read_parquet(AGG / "static_r8.parquet", columns=["h3"])
            cells: set[int] = set()
            for x in st["h3"].to_list():
                cells.update(h3.str_to_int(k) for k in h3.grid_disk(h3.int_to_str(x), 1))
            c.register("sb", pl.DataFrame({"h3": np.fromiter(cells, dtype=np.uint64)}).to_arrow())
            c.execute("CREATE TABLE static_buf AS SELECT h3::UBIGINT AS h3 FROM sb")
            c.unregister("sb")
            _DB = c
    return _DB.cursor()


# ----------------------------------------------------------------------------- время
def month_index(s: str, default: int) -> int:
    if not s:
        return default
    try:
        y, m = int(s[:4]), int(s[5:7])
    except ValueError as exc:
        raise HTTPException(400, "дата: YYYY-MM или YYYY-MM-DD") from exc
    return (y - 2000) * 12 + m - 1


def day_index(s: str) -> int:
    return (pd.Timestamp(s) - pd.Timestamp("2000-01-01")).days


@lru_cache(maxsize=1)
def month_span() -> tuple[int, int]:
    am = area_month()
    w = am.filter(pl.col("area") == "WORLD")
    return int(w["month"].min()), int(w["month"].max())


# ----------------------------------------------------------------------------- данные в памяти
@lru_cache(maxsize=1)
def area_month() -> pl.DataFrame:
    return pl.read_parquet(AGG / "area_month.parquet")


@lru_cache(maxsize=1)
def cells_r6() -> dict[str, np.ndarray]:
    df = pl.read_parquet(AGG / "cells_r6.parquet")
    return {k: df[k].to_numpy() for k in ("h3", "lat", "lon", "region")} | {"iso2": df["iso2"].to_numpy()}


@lru_cache(maxsize=1)
def coverage_pd() -> pd.DataFrame:
    cov = pl.read_parquet(AGG / "coverage.parquet").to_pandas()
    cov["month"] = pd.PeriodIndex.from_fields(year=2000 + cov["month"] // 12, month=cov["month"] % 12 + 1, freq="M")
    return cov[["stream", "month", "coverage"]]


@lru_cache(maxsize=1)
def static_points() -> pl.DataFrame:
    return pl.read_parquet(AGG / "static_r8.parquet")


@lru_cache(maxsize=1)
def countries() -> list[dict]:
    """Страны Natural Earth: ISO2, названия на 7 языках, рамка."""
    import shapely
    from shapely.geometry import shape

    d = json.loads(NE_ADM0.read_text(encoding="utf-8"))
    out, seen = [], set()
    for f in d["features"]:
        p = f["properties"]
        iso2 = p.get("ISO_A2_EH") or p.get("ISO_A2")
        if not iso2 or len(iso2) != 2 or not iso2.isalpha() or iso2 in seen:
            continue
        seen.add(iso2)
        g = shape(f["geometry"])
        w, s, e, n = g.bounds
        # страны через антимеридиан (Россия, Фиджи…): рамка по основной части
        if e - w > 300:
            parts = list(getattr(g, "geoms", [g]))
            big = max(parts, key=lambda x: x.area)
            w, s, e, n = big.bounds
        names = {k: (p.get(f"NAME_{k.upper()}") or "").strip() for k in ("en", "ru", "zh", "de", "es", "fr", "pt")}
        names["en"] = names["en"] or p.get("NAME") or iso2
        out.append({"iso2": iso2.upper(), "names": {k: v for k, v in names.items() if v},
                    "bbox": [round(w, 2), round(s, 2), round(e, 2), round(n, 2)],
                    "area_km2": area_km2(g)})
    return out


@lru_cache(maxsize=1)
def region_by_id() -> dict[str, dict]:
    return {r["id"]: r for r in region_index()}


# ----------------------------------------------------------------------------- гексагоны
def _bbox_sql(b, margin: float) -> tuple[str, list]:
    w, s, e, n = b
    s, n = max(-90.0, s - margin), min(90.0, n + margin)
    if w <= e:
        w, e = max(-180.0, w - margin), min(180.0, e + margin)
        return "lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", [s, n, w, e]
    return "lat BETWEEN ? AND ? AND (lon >= ? OR lon <= ?)", [s, n, w - margin, e + margin]


def _day_cols(noise: bool, sensors: str) -> tuple[str, str, str]:
    pre = "d_c" if noise else "d_r"
    m, v = f"{pre}m", f"{pre}v"
    if sensors == "M":
        return m, m, "0"
    if sensors == "V":
        return v, "0", v
    return f"{pre}a", m, v


@router.get("/hex")
def get_hex(bbox: str, res: int = Query(5, ge=2, le=7), start: str = "", end: str = "", noise: int = 1,
            sensors: str = "MV", limit: int = Query(40_000, le=80_000)):
    if not available():
        raise HTTPException(503, "мировые агрегаты не построены: python -m helios.world.aggregate")
    b = parse_bbox(bbox)
    m0, m1 = month_span()
    a, z = month_index(start, m0), month_index(end, m1)
    edge = h3.average_hexagon_edge_length(res, "km") / 111.0 * 1.2
    where, args = _bbox_sql(b, edge)
    dcol, mcol, vcol = _day_cols(bool(noise), sensors.upper())
    sql = f"""
        SELECT h3, sum({dcol})::INTEGER AS days, sum({mcol})::INTEGER AS modis, sum({vcol})::INTEGER AS viirs,
               max(frp_max) AS frp
        FROM read_parquet('{_p(f"cellmonth_r{res}.parquet")}')
        WHERE month BETWEEN ? AND ? AND {where}
        GROUP BY h3 HAVING sum({dcol}) > 0 ORDER BY days DESC LIMIT {limit + 1}"""
    rows = db().execute(sql, [a, z, *args]).fetchall()
    truncated = len(rows) > limit
    rows = rows[:limit]
    cells = [[h3.int_to_str(c), d, mo, vi, round(float(f or 0), 1)] for c, d, mo, vi, f in rows]
    return _json({"res": res, "start": a, "end": z, "cells": cells, "maxDays": max((r[1] for r in rows), default=0),
                  "truncated": truncated,
                  "cellAreaKm2": round(h3.average_hexagon_area(res, "km^2"), 2)})


# ----------------------------------------------------------------------------- точки
def _det_files(d0: int, d1: int) -> list[str]:
    y0, y1 = 2000 + d0 // 366, 2000 + d1 // 365 + 1
    out = []
    for p in sorted(DET_DIR.glob("*.parquet")):
        y = int(p.stem.rsplit("_", 1)[1])
        if y0 - 1 <= y <= y1:
            out.append(p.as_posix())
    return out


@router.get("/fires")
def get_fires(bbox: str, start: str, end: str, limit: int = Query(60_000, le=100_000)):
    if not available():
        return kyzyl.get_fires(bbox, start, end, limit)
    b = parse_bbox(bbox)
    try:
        d0, d1 = day_index(start), day_index(end)
    except ValueError as exc:
        raise HTTPException(400, "start/end — YYYY-MM-DD") from exc
    files = _det_files(d0, d1)
    if not files:
        return _json({"type": "FeatureCollection", "features": [], "meta": {"total": 0, "truncated": False, "synthetic": False}})
    where, args = _bbox_sql(b, 0.0)
    src = f"read_parquet({files!r})"
    cur = db()
    total = cur.execute(f"SELECT count(*) FROM {src} WHERE day BETWEEN ? AND ? AND {where}", [d0, d1, *args]).fetchall()[0][0]
    sample = f"USING SAMPLE reservoir({limit} ROWS) REPEATABLE (7)" if total > limit else ""
    rows = cur.execute(f"""
        SELECT p.lat, p.lon, p.day, p.hhmm, p.sat, p.conf, p.frp, p.scan, p.track, p.type, p.night,
               (s.h3 IS NOT NULL OR p.type IN (1,2,3)) AS is_static
        FROM (SELECT * FROM (SELECT * FROM {src} WHERE day BETWEEN ? AND ? AND {where}) {sample}) p
        LEFT JOIN static_buf s ON p.h3 = s.h3""", [d0, d1, *args]).fetchall()
    base = pd.Timestamp("2000-01-01")
    feats = []
    for i, (la, lo, day, hhmm, sat, conf, frp, scan, track, typ, night, is_static) in enumerate(rows):
        sensor = "MODIS" if sat < 2 else "VIIRS"
        truth = "static" if is_static else ("false-alarm" if conf == 0 else "fire")
        feats.append({
            "type": "Feature", "id": i,
            "geometry": {"type": "Point", "coordinates": [round(float(lo), 4), round(float(la), 4)]},
            "properties": {
                "id": f"{sensor[0]}{day}-{i}", "sensor": sensor, "satellite": SAT_NAME[sat] if sat < 5 else "?",
                "date": (base + pd.Timedelta(days=int(day))).strftime("%Y-%m-%d"), "time": f"{int(hhmm):04d}",
                "frp": round(float(frp), 1), "confidence": CONF[int(conf)], "truth": truth,
                "scan": round(float(scan or (1.0 if sat < 2 else 0.375)), 3),
                "track": round(float(track or (1.0 if sat < 2 else 0.375)), 3), "night": bool(night),
            },
        })
    return _json({"type": "FeatureCollection", "features": feats,
                  "meta": {"total": int(total), "truncated": len(feats) < total, "synthetic": False}})


# ----------------------------------------------------------------------------- календарь
def _mt(rows: pl.DataFrame) -> pd.DataFrame:
    """Месячные строки (c0..c9 = cell-days потока sat×день/ночь) → длинная таблица для гармонизации."""
    recs = []
    for k in range(10):
        col = f"c{k}"
        if col not in rows.columns:
            continue
        stream, dn = STREAM_OF_SAT[k // 2], ("N" if k % 2 else "D")
        sub = rows.select("month", pl.col(col).alias("celldays")).filter(pl.col("celldays") > 0).to_pandas()
        if sub.empty:
            continue
        sub["stream"], sub["dn"] = stream, dn
        recs.append(sub)
    if not recs:
        return pd.DataFrame(columns=["stream", "month", "dn", "celldays", "coverage"])
    t = pd.concat(recs, ignore_index=True)
    t["month"] = pd.PeriodIndex.from_fields(year=2000 + t["month"] // 12, month=t["month"] % 12 + 1, freq="M")
    return t.merge(coverage_pd(), on=["stream", "month"], how="left").fillna({"coverage": 0.0})


@lru_cache(maxsize=512)
def calibration_for(area: str) -> dict:
    """Калибровка потоков к Aqua MODIS: по стране (если данных хватает), иначе — мировая."""
    from helios.processing.harmonize import fit_all_bridges

    am = area_month()
    rows = am.filter(pl.col("area") == area)
    if area != "WORLD":
        overlap = rows.filter((pl.col("month") >= (2012 - 2000) * 12 + 2) & (pl.col("month") <= (2020 - 2000) * 12 + 11))
        if overlap.height == 0 or int(overlap["hex_m"].sum()) < 400 or int(overlap["hex_v"].sum()) < 400:
            return calibration_for("WORLD")
    cal = fit_all_bridges(_mt(rows))
    return cal["to_ref"]


def _area_rows_bbox(b) -> tuple[pl.DataFrame, str | None]:
    """Помесячные строки как в area_month, но для произвольной рамки (ячейки res 6 по центру)."""
    cr = cells_r6()
    w, s, e, n = b
    lat_ok = (cr["lat"] >= s) & (cr["lat"] <= n)
    lon_ok = (cr["lon"] >= w) & (cr["lon"] <= e) if w <= e else (cr["lon"] >= w) | (cr["lon"] <= e)
    sel = lat_ok & lon_ok
    if not sel.any():
        return pl.DataFrame(), None
    iso, cnt = np.unique(cr["iso2"][sel].astype(str), return_counts=True)
    main_iso = str(iso[np.argmax(cnt)]) if len(iso) else None
    cells = pl.DataFrame({"h3": cr["h3"][sel].astype(np.uint64)})
    from helios.world.aggregate import MONTH_OF

    mon = MONTH_OF.format(d="lday")
    bits = ", ".join(f"sum(((bits_c >> {k}) & 1)::INTEGER)::UINTEGER AS c{k}" for k in range(10))
    cur = db()
    cur.register("sel_cells", cells.to_arrow())
    rows = cur.sql(f"""
        SELECT {mon}::USMALLINT AS month, {bits}, sum((bits_r > 0)::INTEGER)::UINTEGER AS r_any,
               sum((bits_c > 0)::INTEGER)::UINTEGER AS hex_any,
               sum(((bits_c & {MODIS_MASK}) > 0)::INTEGER)::UINTEGER AS hex_m,
               sum(((bits_c & {VIIRS_MASK}) > 0)::INTEGER)::UINTEGER AS hex_v,
               sum(n_mc)::UBIGINT AS n_mc, sum(n_vc)::UBIGINT AS n_vc, sum(n_low)::UBIGINT AS n_low,
               sum(n_static)::UBIGINT AS n_static, sum(n_r)::UBIGINT AS n_r, sum(frp_sum)::DOUBLE AS frp_sum
        FROM read_parquet('{_p("cellday_r6.parquet")}') d SEMI JOIN sel_cells k ON d.h3 = k.h3::UBIGINT
        GROUP BY 1 ORDER BY 1""").pl()
    cur.unregister("sel_cells")
    return rows, main_iso


def _static_cells_in(b) -> int:
    st = static_points()
    lat, lon = st["lat"].to_numpy(), st["lon"].to_numpy()
    return int(kyzyl.in_bbox(lon, lat, b).sum())


@lru_cache(maxsize=512)
def _calendar(b: tuple[float, float, float, float], region: str | None) -> dict:
    from helios.processing.harmonize import harmonized_monthly

    meta_base = {"scale": "modis-equivalent-hex-days-per-month", "interval": 0.95,
                 "grid": {"system": "h3", "resolution": CAL_RES, "cellAreaKm2": round(h3.average_hexagon_area(CAL_RES, "km^2"), 1)},
                 "synthetic": False, "method": METHOD}
    m0, m1 = month_span()
    area = None
    if region:
        rid = region.upper() if len(region) == 2 else region
        if rid == "WORLD" or len(rid) == 2 or rid in region_by_id():
            area = rid
    if area:
        rows = area_month().filter(pl.col("area") == area).sort("month")
        cal_area = area if len(area) == 2 or area == "WORLD" else region_by_id()[area]["iso2"]
    else:
        rows, cal_area = _area_rows_bbox(b)
        cal_area = cal_area or "WORLD"
    empty = {"bbox": list(b), "points": [], "meta": {**meta_base, "rawRatio": None,
             "ratio": {"value": 1.0, "lo": 1.0, "hi": 1.0, "overlapStart": OVERLAP[0], "overlapEnd": OVERLAP[1], "calibrated": False},
             "noise": {"considered": 0, "lowConfidence": 0, "staticSources": 0, "staticCells": 0}, "coverage": 0.0}}
    if rows.is_empty():
        return empty
    cal = calibration_for(cal_area)
    mt = _mt(rows)
    hm = harmonized_monthly(mt, {"to_ref": cal}) if len(mt) else pd.DataFrame()
    hm_idx = {((p.year - 2000) * 12 + p.month - 1): r for p, r in zip(hm.get("month", []), hm.to_dict("records"))} if len(hm) else {}
    by_m = {int(r["month"]): r for r in rows.to_dicts()}
    months = np.arange(m0, m1 + 1)
    harm = np.array([float(hm_idx.get(m, {}).get("harmonized") or 0.0) for m in months])
    z = kyzyl._robust_z(harm, months % 12)
    points = []
    for k, m in enumerate(months):
        r, h = by_m.get(int(m), {}), hm_idx.get(int(m), {})
        v_ok = m >= VIIRS_START
        points.append({
            "year": int(2000 + m // 12), "month": int(m % 12 + 1),
            "modis": int(r.get("n_mc", 0)), "viirsRaw": int(r.get("n_vc", 0)) if v_ok else None,
            "modisHex": int(r.get("hex_m", 0)), "viirsHex": int(r.get("hex_v", 0)) if v_ok else None,
            "harmonized": round(float(h.get("harmonized") or 0.0), 2),
            "lo": round(float(h.get("lo95") or 0.0), 2), "hi": round(float(h.get("hi95") or 0.0), 2),
            "anomalyZ": z[k],
        })
    o0, o1 = (2012 - 2000) * 12 + 2, (2020 - 2000) * 12 + 11
    ov = rows.filter((pl.col("month") >= o0) & (pl.col("month") <= o1))
    raw_m, raw_v = float(ov["n_mc"].sum()), float(ov["n_vc"].sum())
    hm_m = ov["hex_m"].to_numpy().astype(float)
    hm_v = ov["hex_v"].to_numpy().astype(float)
    years = ov["month"].to_numpy() // 12
    ratio = float(hm_v.sum() / hm_m.sum()) if hm_m.sum() > 0 else 1.0
    rng = np.random.default_rng(0)
    boots, uy = [], np.unique(years)
    for _ in range(300 if len(uy) else 0):
        pick = rng.choice(uy, size=len(uy), replace=True)
        mm = np.concatenate([hm_m[years == y] for y in pick])
        vv = np.concatenate([hm_v[years == y] for y in pick])
        if mm.sum() > 0:
            boots.append(vv.sum() / mm.sum())
    tot = rows.select(pl.col("n_r").sum(), pl.col("n_low").sum(), pl.col("n_static").sum()).row(0)
    return {"bbox": list(b), "points": points, "meta": {
        **meta_base,
        "rawRatio": round(raw_v / raw_m, 3) if raw_m > 0 else None,
        "ratio": {"value": round(ratio, 3), "lo": round(float(np.quantile(boots, 0.025)), 3) if boots else ratio,
                  "hi": round(float(np.quantile(boots, 0.975)), 3) if boots else ratio,
                  "overlapStart": OVERLAP[0], "overlapEnd": OVERLAP[1], "calibrated": bool(hm_m.sum() > 50)},
        "noise": {"considered": int(tot[0] or 0), "lowConfidence": int(tot[1] or 0), "staticSources": int(tot[2] or 0),
                  "staticCells": _static_cells_in(b)},
        "coverage": 1.0, "calibration": cal_area,
    }}


@router.get("/calendar")
def get_calendar(bbox: str, region: str | None = None):
    if not available():
        return kyzyl.get_calendar(bbox, region)
    b = tuple(round(v, 3) for v in parse_bbox(bbox))
    with _LOCK:
        return _json(_calendar(b, region))


# ----------------------------------------------------------------------------- регионы
def _region_obj(kind: str, rid: str, names: dict, bbox: list, iso2: str, parent: str | None = None,
                featured: bool = False) -> dict:
    en = names.get("en") or rid
    ru = names.get("ru") or en
    aliases = sorted({v for k, v in names.items() if k not in ("en", "ru") and v and v not in (en, ru)})
    out = {"id": rid, "kind": kind, "name": {"en": en, "ru": ru}, "iso2": iso2, "bbox": bbox,
           "group": "central-asia" if iso2 in CENTRAL_ASIA else "world", "aliases": aliases}
    if parent:
        out["parentId"] = parent
    if featured:
        out["featured"] = True
    return out


@lru_cache(maxsize=1)
def search_items() -> list[dict]:
    featured_c = {"KZ", "UZ", "KG"}
    items = [_region_obj("country", c["iso2"], c["names"], c["bbox"], c["iso2"], featured=c["iso2"] in featured_c)
             for c in countries()]
    # самые «горящие» регионы Казахстана — в избранное (как раньше)
    am = area_month().filter(pl.col("level") == "region")
    kz = [r for r in region_index() if r["iso2"] == "KZ"]
    act = {a: int(v) for a, v in am.filter(pl.col("area").is_in([r["id"] for r in kz])).group_by("area")
           .agg(pl.col("hex_any").sum()).iter_rows()}
    top_kz = {r["id"] for r in sorted(kz, key=lambda r: -act.get(r["id"], 0))[:3]}
    items += [_region_obj("province", r["id"], r["names"] or {"en": r["name"]}, r["bbox"], r["iso2"], r["iso2"],
                          featured=r["id"] in top_kz) for r in region_index()]
    return items


@router.get("/regions")
def get_regions(q: str = ""):
    if not available():
        return kyzyl.get_regions(q)
    import re

    items = search_items()
    qq = kyzyl._norm(q)
    if not qq:
        feat = [r for r in items if r.get("featured")]
        return _json(sorted(feat, key=lambda r: (r["kind"] != "country", r["name"]["en"]))[:8])
    scored = []
    for r in items:
        terms = [kyzyl._norm(t) for t in (r["name"]["en"], r["name"]["ru"], *r.get("aliases", []))]
        best = 0
        for t in terms:
            if t == qq:
                best = max(best, 100)
            elif t.startswith(qq):
                best = max(best, 80)
            elif any(wd.startswith(qq) for wd in re.split(r"[\s\-–(),]+", t)):
                best = max(best, 60)
            elif len(qq) >= 3 and qq in t:
                best = max(best, 40)
        if kyzyl._norm(r["id"]) == qq:
            best = max(best, 100)
        if not best:
            continue
        best += 5 if r["group"] == "central-asia" else 0
        best += 3 if r["kind"] == "country" else 0
        scored.append((best, r["name"]["en"], r))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return _json([r for _, _, r in scored[:12]])


@lru_cache(maxsize=64)
def _geo_bytes(iso2: str) -> bytes:
    p = REGIONS_DIR / f"{iso2}.geojson"
    if not p.exists():
        raise HTTPException(404, f"нет регионов для {iso2}")
    return p.read_bytes()


@router.get("/regions/geo")
def get_regions_geo(country: str):
    iso2 = country.upper()
    if len(iso2) != 2 or not iso2.isalpha():
        raise HTTPException(400, "country — ISO2")
    return Response(content=_geo_bytes(iso2), media_type="application/geo+json",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/regions/stats")
def get_regions_stats(country: str = "WORLD", start: str = "", end: str = ""):
    """Хороплет: гексагоно-сутки (чистые, res 6) и обнаружения по регионам страны или по странам мира."""
    if not available():
        raise HTTPException(503, "мировые агрегаты не построены")
    m0, m1 = month_span()
    a, z = month_index(start, m0), month_index(end, m1)
    am = area_month().filter((pl.col("month") >= a) & (pl.col("month") <= z))
    key = country.upper()
    if key == "WORLD":
        sub = am.filter(pl.col("level") == "country")
        area_km2 = {c["iso2"]: c["area_km2"] for c in countries()}
    else:
        ids = [r["id"] for r in region_index() if r["iso2"] == key]
        sub = am.filter(pl.col("area").is_in(ids))
        area_km2 = {r["id"]: (r["area_km2"] or 0) for r in region_index() if r["iso2"] == key}
    g = sub.group_by("area").agg(pl.col("hex_any").sum().alias("hexdays"), (pl.col("n_mc") + pl.col("n_vc")).sum().alias("detections"),
                                 pl.col("frp_sum").sum().alias("frp"))
    rows = []
    for area, hexdays, det, frp in g.iter_rows():
        km2 = area_km2.get(area) or 0
        dens = hexdays * h3.average_hexagon_area(CAL_RES, "km^2") / km2 if km2 > 0 else None
        rows.append({"id": area, "hexdays": int(hexdays), "detections": int(det), "frp": round(float(frp), 1),
                     "density": round(dens, 4) if dens is not None else None})
    rows.sort(key=lambda r: -r["hexdays"])
    mx = max((r["density"] or 0 for r in rows), default=0)
    return _json({"level": "country" if key == "WORLD" else "region", "start": a, "end": z, "rows": rows,
                  "maxDensity": mx, "unit": "burning-hexagon-days × cell area / region area (res 6)"})


# ----------------------------------------------------------------------------- итоги района
@lru_cache(maxsize=256)
def _area_stats(b: tuple[float, float, float, float], region: str | None, a: int, z: int, lowconf: bool, static: bool,
                sensors: str) -> dict:
    cr = cells_r6()
    if region and (region.upper() == "WORLD"):
        sel = np.ones(len(cr["h3"]), bool)
    elif region and len(region) == 2:
        sel = cr["iso2"].astype(str) == region.upper()
    elif region and region in region_by_id():
        sel = cr["region"] == region_by_id()[region]["idx"]
    else:
        w, s, e, n = b
        sel = (cr["lat"] >= s) & (cr["lat"] <= n) & (((cr["lon"] >= w) & (cr["lon"] <= e)) if w <= e
                                                     else ((cr["lon"] >= w) | (cr["lon"] <= e)))
    if not sel.any():
        zero = {"considered": 0, "removedLowConfidence": 0, "removedStatic": 0, "rawModis": 0, "rawViirs": 0,
                "cellsAny": 0, "hexDaysAny": 0, "hexDaysModis": 0, "hexDaysViirs": 0}
        return {"totals": zero, "overlap": None, "grid": CAL_RES}
    clean = lowconf or static
    pre = "d_c" if clean else "d_r"
    dcol = {"M": f"{pre}m", "V": f"{pre}v"}.get(sensors, f"{pre}a")
    cur = db()
    cur.register("sel_cells", pl.DataFrame({"h3": cr["h3"][sel].astype(np.uint64)}).to_arrow())

    def agg(lo: int, hi: int) -> dict:
        r = cur.execute(f"""
            SELECT count(DISTINCT CASE WHEN {dcol} > 0 THEN m.h3 END), sum({dcol}), sum({pre}m), sum({pre}v)
            FROM read_parquet('{_p("cellmonth_r6.parquet")}') m SEMI JOIN sel_cells k ON m.h3 = k.h3::UBIGINT
            WHERE month BETWEEN ? AND ?""", [lo, hi]).fetchall()[0]
        return {"cellsAny": int(r[0] or 0), "hexDaysAny": int(r[1] or 0), "hexDaysModis": int(r[2] or 0),
                "hexDaysViirs": int(r[3] or 0)}

    hexes = agg(a, z)
    hexes_ov = agg(max(a, VIIRS_START), z) if z >= VIIRS_START else None
    cur.unregister("sel_cells")
    # счётчики обнаружений — из помесячных рядов (тот же выбор ячеек)
    if region and (region.upper() == "WORLD" or len(region) == 2 or region in region_by_id()):
        rows = area_month().filter(pl.col("area") == (region.upper() if len(region) == 2 else region))
    else:
        rows, _ = _area_rows_bbox(b)

    def counts(lo: int, hi: int) -> dict:
        r = rows.filter((pl.col("month") >= lo) & (pl.col("month") <= hi))
        if r.is_empty():
            return {"considered": 0, "removedLowConfidence": 0, "removedStatic": 0, "rawModis": 0, "rawViirs": 0}
        n_r, n_low, n_st = (int(r[c].sum()) for c in ("n_r", "n_low", "n_static"))
        n_mc, n_vc = int(r["n_mc"].sum()), int(r["n_vc"].sum())
        # без фильтра «оставлено» = всё; частичный фильтр — вычитаем только включённую часть
        kept_m, kept_v = n_mc, n_vc
        extra = (0 if lowconf else n_low) + (0 if static else n_st)
        share_m = n_mc / max(n_mc + n_vc, 1)
        return {"considered": n_r, "removedLowConfidence": n_low if lowconf else 0, "removedStatic": n_st if static else 0,
                "rawModis": (kept_m + round(extra * share_m)) if sensors != "V" else 0,
                "rawViirs": (kept_v + round(extra * (1 - share_m))) if sensors != "M" else 0}

    totals = {**counts(a, z), **hexes}
    overlap = {**counts(max(a, VIIRS_START), z), **hexes_ov} if hexes_ov else None
    return {"totals": totals, "overlap": overlap, "grid": CAL_RES,
            "cellAreaKm2": round(h3.average_hexagon_area(CAL_RES, "km^2"), 1)}


@router.get("/area/stats")
def get_area_stats(bbox: str, region: str | None = None, start: str = "", end: str = "", lowconf: int = 1,
                   static: int = 1, sensors: str = "MV"):
    if not available():
        raise HTTPException(503, "мировые агрегаты не построены")
    b = tuple(round(v, 3) for v in parse_bbox(bbox))
    m0, m1 = month_span()
    a, z = month_index(start, m0), month_index(end, m1)
    return _json(_area_stats(b, region, a, z, bool(lowconf), bool(static), sensors.upper()))


# ----------------------------------------------------------------------------- глобус и выборка
@lru_cache(maxsize=1)
def _overview_bytes() -> bytes:
    _, m1 = month_span()
    rows = db().execute(f"""
        SELECT h3, sum(d_ca)::INTEGER AS d FROM read_parquet('{_p("cellmonth_r5.parquet")}')
        WHERE month > ? GROUP BY h3 ORDER BY d DESC LIMIT 12000""", [m1 - 12]).fetchall()
    pts = []
    mx = max((d for _, d in rows), default=1)
    for c, d in rows:
        la, lo = h3.cell_to_latlng(h3.int_to_str(c))
        pts.append([round(lo, 2), round(la, 2), round(math.sqrt(d / mx), 3)])
    return json.dumps({"points": pts, "synthetic": False, "period": "last 12 months of the NASA FIRMS archive"},
                      separators=(",", ":")).encode()


def _nrt_key() -> tuple | None:
    from helios.world.nrt import FEEDS, NRT_DIR

    files = [NRT_DIR / name for _, name, _ in FEEDS if (NRT_DIR / name).exists() and (NRT_DIR / name).stat().st_size > 200]
    return tuple((f.name, int(f.stat().st_mtime)) for f in files) or None


@lru_cache(maxsize=2)
def _nrt_overview_bytes(key: tuple) -> bytes:
    """Глобус: чистые пожары NASA FIRMS NRT за последние 48 ч (MODIS, VIIRS NOAA-20/21), ячейки H3 res 5."""
    from h3ronpy import vector as h3v

    from helios.world.nrt import _static_buffer, global_nrt_frame

    df = global_nrt_frame(download=False).filter(~pl.col("low") & pl.col("date").is_not_null())
    ts = df.select((pl.col("date").cast(pl.Datetime("ms")) + pl.duration(hours=pl.col("hhmm") // 100,
                                                                          minutes=pl.col("hhmm") % 100)).alias("ts"))["ts"]
    df = df.with_columns(ts.alias("ts"))
    t1 = df["ts"].max()
    df = df.filter(pl.col("ts") >= t1 - pd.Timedelta(hours=48))
    r8 = np.asarray(h3v.coordinates_to_cells(df["lat"].to_numpy(), df["lon"].to_numpy(), 8).to_numpy(), np.uint64)
    df = df.filter(pl.Series(~np.isin(r8, _static_buffer())))
    r5 = np.asarray(h3v.coordinates_to_cells(df["lat"].to_numpy(), df["lon"].to_numpy(), 5).to_numpy(), np.uint64)
    g = pl.DataFrame({"h3": r5, "frp": df["frp"].to_numpy()}).group_by("h3").agg(pl.col("frp").sum(), pl.len().alias("n"))
    g = g.sort("frp", descending=True).head(20_000)
    xy = h3v.cells_to_coordinates(g["h3"].to_numpy())
    mx = float(np.sqrt(max(g["frp"].max() or 1.0, 1.0)))
    w_ = np.clip(np.sqrt(np.maximum(g["frp"].to_numpy(), 0)) / mx, 0.08, 1.0)
    pts = [[round(float(lo), 3), round(float(la), 3), round(float(v), 3)]
           for lo, la, v in zip(np.asarray(xy.column("lng")), np.asarray(xy.column("lat")), w_)]
    out = {"points": pts, "synthetic": False, "source": "NASA FIRMS NRT: MODIS (Terra, Aqua), VIIRS NOAA-20, VIIRS NOAA-21",
           "from": (t1 - pd.Timedelta(hours=48)).isoformat() + "Z", "to": t1.isoformat() + "Z",
           "detections": int(df.height), "cells": int(g.height)}
    return json.dumps(out, separators=(",", ":")).encode()


@router.get("/overview")
def get_overview():
    """Глобус: свежие пожары NRT за 48 ч, если ленты скачаны (обновляются каждые 3 ч), иначе — архив."""
    key = _nrt_key()
    if key:
        try:
            return Response(content=_nrt_overview_bytes(key), media_type="application/json",
                            headers={"Cache-Control": "public, max-age=600"})
        except Exception as exc:  # битый файл ленты — показываем архив
            print(f"[helios-api] NRT overview failed: {exc}")
    if not available():
        return kyzyl.get_overview()
    return Response(content=_overview_bytes(), media_type="application/json")


@lru_cache(maxsize=1)
def _detections_bytes() -> bytes:
    """Равномерная выборка 60 000 строк всего мирового архива (для браузерных демо фильтра и бортовой модели)."""
    files = [p.as_posix() for p in sorted(DET_DIR.glob("*.parquet"))]
    cur = db()
    total = cur.execute(f"SELECT count(*) FROM read_parquet({files!r})").fetchall()[0][0]
    rows = cur.execute(f"""
        SELECT p.lon, p.lat, (p.sat >= 2)::INTEGER, p.day, p.frp, p.conf,
               CASE WHEN s.h3 IS NOT NULL OR p.type IN (1,2,3) THEN 1 WHEN p.conf = 0 THEN 2 ELSE 0 END
        FROM (SELECT * FROM read_parquet({files!r}) USING SAMPLE reservoir(60000 ROWS) REPEATABLE (11)) p
        LEFT JOIN static_buf s ON p.h3 = s.h3 ORDER BY p.day""").fetchall()
    out = {"version": 3, "synthetic": False,
           "rows": [[round(lo, 4), round(la, 4), se, int(d), round(float(f), 1), int(c), int(t)] for lo, la, se, d, f, c, t in rows],
           "meta": {"total_rows": int(total), "sample_rows": len(rows), "sample_rate": round(len(rows) / max(total, 1), 6),
                    "truthMeaning": "0 fire, 1 static source (global registry or FIRMS type), 2 low confidence"}}
    return json.dumps(out, separators=(",", ":")).encode()


@router.get("/detections")
def get_detections():
    if not available():
        return kyzyl.get_detections()
    return Response(content=_detections_bytes(), media_type="application/json")


def warmup() -> None:
    if not available():
        return
    db()
    area_month(), cells_r6(), coverage_pd(), static_points(), countries(), search_items()
    with _LOCK:
        _calendar((-180.0, -85.0, 180.0, 85.0), "WORLD")
        _calendar((46.47, 40.66, 87.36, 55.39), "KZ")
    _overview_bytes()
    _detections_bytes()


# ----------------------------------------------------------------------------- прогноз ИИ №3 (весь мир)
WF = AGG.parent / "forecast"


def forecast_ready() -> bool:
    return (WF / "time_machine.parquet").exists() or (WF / "risk_latest.parquet").exists()


@lru_cache(maxsize=1)
def world_report() -> dict | None:
    from helios.config import REPORTS_DIR

    p = REPORTS_DIR / "world_ai3_metrics.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@lru_cache(maxsize=2)
def risk_frame(kind: str) -> pl.DataFrame | None:
    p = WF / ("risk_latest.parquet" if kind == "latest" else "time_machine.parquet")
    if not p.exists():
        return None
    df = pl.read_parquet(p)
    from h3ronpy import vector as h3v

    xy = h3v.cells_to_coordinates(df["h3"].to_numpy().astype(np.uint64))
    return df.with_columns(pl.Series("lat", np.asarray(xy.column("lat"), np.float32)),
                           pl.Series("lon", np.asarray(xy.column("lng"), np.float32)))


def _json_file(name: str):
    p = WF / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


@router.get("/helios/status")
def helios_status_world():
    base = json.loads(kyzyl.helios_status().body)
    rep = world_report()
    if rep:
        base["models"]["ai3_ground"] = rep["variants"]["full"]
        base["models"]["ai3_world"] = {"cells": rep["cells"], "resolution": rep["resolution"],
                                       "operational": rep["variants"].get("oper"), "weeks": rep["weeks"]}
    if available():
        w = area_month().filter(pl.col("area") == "WORLD")
        base["world"] = {"countries": int(area_month().filter(pl.col("level") == "country")["area"].n_unique()),
                         "regions": int(area_month().filter(pl.col("level") == "region")["area"].n_unique()),
                         "detections": int(w["n_r"].sum()), "first_month": int(w["month"].min()),
                         "last_month": int(w["month"].max()), "static_cells": static_points().height}
    return _json(base)


@router.get("/helios/scenarios")
def helios_scenarios_world():
    if not forecast_ready():
        return kyzyl.helios_scenarios()
    now = _json_file("risk_latest.json") or {}
    tm = _json_file("time_machine.json") or []
    return _json({"latest": now.get("as_of"), "history_gap": None, "scope": "world", "scenarios": tm})


@router.get("/helios/risk")
def helios_risk_world(horizon: int = Query(1, ge=1, le=4), as_of: str = "latest", min_p: float = 0.02,
                      bbox: str | None = None):
    if not forecast_ready():
        return kyzyl.helios_risk(horizon, as_of, min_p)
    df = risk_frame("latest" if as_of == "latest" else "tm")
    if df is None:
        raise HTTPException(404, "нет прогноза")
    df = df.filter(pl.col("horizon") == horizon)
    if as_of != "latest":
        df = df.filter(pl.col("as_of") == as_of)
        if df.is_empty():
            raise HTTPException(404, f"нет сценария «Машины времени» на {as_of}")
    df = df.filter((pl.col("p") >= min_p) | (pl.col("actual") == 1))
    if bbox:
        b = parse_bbox(bbox)
        m = kyzyl.in_bbox(df["lon"].to_numpy(), df["lat"].to_numpy(), b)
        df = df.filter(pl.Series(m))
    actual = df["actual"].to_numpy() if as_of != "latest" else np.full(df.height, -1)
    rows = [[h3.int_to_str(int(c)), round(float(p), 4), round(float(q), 4), int(a)]
            for c, p, q, a in zip(df["h3"].to_list(), df["p"].to_list(), df["clim"].to_list(), actual.tolist())]
    base_date = (_json_file("risk_latest.json") or {}).get("week_start") if as_of == "latest" else as_of
    target = str((pd.Timestamp(base_date) + pd.Timedelta(weeks=horizon)).date()) if base_date else None
    return _json({"as_of": as_of, "horizon_weeks": horizon, "target_week": target, "scope": "world",
                  "fields": ["h3", "p_fire", "p_climatology", "actual"], "rows": rows})


@router.get("/helios/static")
def helios_static_world():
    if not available():
        return kyzyl.helios_static()
    st = static_points().sort("n", descending=True).head(40_000)
    return _json({"fields": ["lng", "lat", "score", "detections", "night_share", "first_year", "last_year"],
                  "rows": [[round(float(lo), 4), round(float(la), 4), round(float(s), 2), int(n), round(float(ns), 2), int(a), int(b)]
                           for lo, la, s, n, ns, a, b in zip(st["lon"], st["lat"], st["st_share"], st["n"], st["night_share"],
                                                             st["first_year"], st["last_year"])]})


@router.get("/helios/area")
def helios_area_world(bbox: str, region: str | None = None):
    """Карточка HELIOS для любой области мира: прогноз ИИ №3, постоянные источники, качество модели
    (+ Fire DNA, сдвиг сезона, слепые зоны и тревоги — там, где их считает казахстанский контур)."""
    b = parse_bbox(bbox)
    out: dict = {}
    w_, s_, e_, n_ = b
    in_kz = (region or "").upper() == "KZ" or (region or "").startswith("KAZ-") or (
        not region and w_ >= 46.0 and e_ <= 88.0 and s_ >= 40.0 and n_ <= 56.0)
    try:  # Fire DNA, сдвиг сезона, слепые зоны и тревоги считает казахстанский контур — только для Казахстана
        kz = json.loads(kyzyl.helios_area(bbox, "KZ").body) if in_kz else {}
        if kz.get("covered"):
            out.update({k: v for k, v in kz.items() if k in ("fire_dna", "season_shift", "season_shift_region",
                                                              "season_shift_verdict", "blind_cells", "alerts")})
    except Exception:
        pass
    out.update({"bbox": list(b), "covered": True})
    df = risk_frame("latest")
    if df is not None:
        r = df.filter(pl.Series(kyzyl.in_bbox(df["lon"].to_numpy(), df["lat"].to_numpy(), b)))
        if r.height:
            now = _json_file("risk_latest.json") or {}
            out["forecast"] = {"as_of_week": now.get("week_start"), "by_horizon": {
                int(h): {"max": round(float(g["p"].max()), 4), "mean": round(float(g["p"].mean()), 4),
                         "climatology_mean": round(float(g["clim"].mean()), 4),
                         "cells_over_10pct": int((g["p"] >= 0.1).sum())}
                for (h,), g in r.group_by("horizon")}}
    if available():
        out["static_sources"] = _static_cells_in(b)
    rep = world_report()
    if rep:
        t = rep["variants"]["oper"]["h1"]["test"] if "oper" in rep["variants"] else rep["variants"]["full"]["h1"]["test"]
        out["model_quality"] = {"roc_auc": t["ai"]["roc_auc"], "pr_auc": t["ai"]["pr_auc"],
                                "baseline_pr_auc": t["baseline_climatology"]["pr_auc"]}
    return _json(out)


@router.get("/helios/context")
def helios_context_world(bbox: str, region: str | None = None):
    """Сводка для промпта Gemini (сервер приложения добавляет её к AreaSummary) — любая область мира."""
    data = json.loads(helios_area_world(bbox, region).body)
    data["note"] = ("HELIOS-SHIELD on real NASA FIRMS data for every country (MODIS since 2000, VIIRS since 2012): "
                    "AI #3 = LightGBM fire-risk forecast per H3 res-5 cell (probability of any fire in the target week; "
                    "operational model = last 7 days of NASA FIRMS NRT + 2000–2025 climatology), static_sources = cells of "
                    "the global persistent heat-source registry (flares, plants, volcanoes) inside the area.")
    return _json(data)


@router.get("/helios/mission")
def helios_mission_world():
    """Результаты миссии: ИИ №1 мировой версии (если обучен) + бортовой код на C (размеры, самопроверка)."""
    from helios.config import ARTIFACTS, REPORTS_DIR

    data = json.loads(kyzyl.helios_mission().body)
    p = REPORTS_DIR / "ai1_world_metrics.json"
    if p.exists():
        data["ai1"] = json.loads(p.read_text(encoding="utf-8"))
    rep = ARTIFACTS / "onboard_c" / "report.json"
    if rep.exists():
        r = json.loads(rep.read_text(encoding="utf-8"))
        data["onboard_c"] = {
            "selftest": r.get("selftest"), "targets": [{"target": b["target"], "ok": b["ok"], "rom_bytes": b.get("rom_bytes")}
                                                         for b in r.get("cross", [])],
            "ai1": {k: r["ai1"].get(k) for k in ("macs", "mean_abs_err", "priority_agreement")},
            "ai2": {k: r["ai2"].get(k) for k in ("macs", "mean_abs_err", "decision_agreement_at_0.5")},
        }
    return _json(data)


@router.get("/helios/constellation")
def helios_constellation(minutes: int = Query(120, ge=30, le=240), storm: str | None = None):
    """Terra, Aqua и Suomi NPP на реальных орбитах: когда связь с Землёй вот-вот пропадёт (по орбите или по
    прогнозу ИИ №2), спутник заранее отдаёт данные соседу по лазеру, тот сбрасывает их на станцию."""
    from helios.comms.constellation import simulate
    from helios.comms.stations import STATIONS

    if storm and storm != "auto" and storm not in {s["id"] for s in STATIONS}:
        raise HTTPException(400, "storm — id станции или auto")
    return _json(simulate(minutes, 30, storm or None))
