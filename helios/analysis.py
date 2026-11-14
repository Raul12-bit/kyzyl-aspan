"""Сводка по ячейке/точке для ИИ-аналитика (Gemini) и карточки региона на сайте.

Все числа берутся из пайплайна; Gemini только формулирует текст (принцип Kiln-Watch).
"""

from __future__ import annotations

import json
from functools import lru_cache

import h3
import pandas as pd

from .config import PROCESSED, REPORTS_DIR, settings


@lru_cache(maxsize=1)
def _tables() -> dict:
    def rd(name):
        path = PROCESSED / name
        return pd.read_parquet(path) if path.exists() else None

    dna = rd("fire_dna_r7.parquet")
    if dna is not None:
        dna["h3_r5"] = [h3.cell_to_parent(c, 5) for c in dna["h3_r7"]]
    return {
        "weekly": rd("cell_weekly_r5.parquet"),
        "risk": rd("risk_latest.parquet"),
        "dna": dna,
        "shift": rd("season_shift_r4.parquet"),
        "weather": rd("weather_daily_r3.parquet"),
        "nrt": rd("nrt_scored.parquet"),
        "blind": rd("blind_spots_nrt.parquet"),
    }


def reload() -> None:
    _tables.cache_clear()


def resolve_cell(h3_cell: str | None = None, lat: float | None = None, lon: float | None = None, res: int = 5) -> str:
    if h3_cell:
        r = h3.get_resolution(h3_cell)
        return h3.cell_to_parent(h3_cell, res) if r > res else h3_cell
    if lat is None or lon is None:
        raise ValueError("нужна ячейка h3 или координаты lat/lon")
    return h3.latlng_to_cell(float(lat), float(lon), res)


def cell_stats(h3_cell: str | None = None, lat: float | None = None, lon: float | None = None) -> dict:
    t = _tables()
    c5 = resolve_cell(h3_cell, lat, lon, 5)
    clat, clon = h3.cell_to_latlng(c5)
    out: dict = {"h3_r5": c5, "center": [round(clat, 4), round(clon, 4)], "region": settings()["region"]["name"]}
    w = t["weekly"]
    if w is not None:
        g = w[w["h3_r5"] == c5].copy()
        g["year"] = pd.to_datetime(g["week"]).dt.year
        by_year = g.groupby("year")["union_celldays"].sum()
        out["burned_hexagons_by_year_last5"] = {int(y): int(v) for y, v in by_year.tail(5).items()}
        out["fire_weeks_total_2001_2025"] = int((g["union_celldays"] > 0).sum())
        if len(g):
            peak_week = pd.to_datetime(g["week"]).dt.isocalendar().week.value_counts().idxmax()
            out["typical_peak_iso_week"] = int(peak_week)
    r = t["risk"]
    if r is not None:
        rr = r[r["h3_r5"] == c5].sort_values("horizon_weeks")
        if len(rr):
            out["forecast_as_of_week"] = str(pd.Timestamp(rr["as_of_week"].iloc[0]).date())
            out["risk_probability_next_7d"] = round(float(rr["p_fire"].iloc[0]), 4)
            out["risk_by_horizon_weeks"] = {int(h): round(float(p), 4) for h, p in zip(rr["horizon_weeks"], rr["p_fire"])}
            out["climatology_probability"] = round(float(rr["p_climatology"].iloc[0]), 4)
    d = t["dna"]
    if d is not None:
        kids = d[d["h3_r5"] == c5]
        if len(kids):
            counts = kids["dna_class"].value_counts()
            top = counts.idxmax()
            row = kids[kids["dna_class"] == top].sort_values("n_det", ascending=False).iloc[0]
            out["fire_dna"] = {"class": top, "label_ru": row["label_ru"], "confidence": float(row["confidence"]),
                               "cells_by_class": {k: int(v) for k, v in counts.items()}}
    s = t["shift"]
    if s is not None:
        c4 = h3.cell_to_parent(c5, 4)
        ss = s[s["h3_r4"] == c4]
        if len(ss) and pd.notna(ss["days_per_decade"].iloc[0]):
            out["season_shift_days_per_decade"] = float(ss["days_per_decade"].iloc[0])
            out["season_shift_significant"] = bool(ss["significant"].iloc[0])
    wx = t["weather"]
    if wx is not None:
        c3 = h3.cell_to_parent(c5, settings()["h3"]["res_weather"])
        ww = wx[wx["cell"] == c3].sort_values("date").tail(30)
        if len(ww):
            last7 = ww.tail(7)
            out["weather"] = {"as_of": str(pd.Timestamp(ww["date"].iloc[-1]).date()),
                              "t2m_max": round(float(last7["T2M_MAX"].mean()), 1), "rh2m": round(float(last7["RH2M"].mean()), 0),
                              "ws10m": round(float(last7["WS10M"].mean()), 1), "precip_7d": round(float(last7["PRECTOTCORR"].sum()), 1),
                              "soil_wetness": round(float(last7["GWETTOP"].mean()), 2), "source": "NASA POWER"}
    n = t["nrt"]
    if n is not None:
        nn = n[n["h3_r5"] == c5]
        out["detections_last_7d"] = int(nn["keep_veg"].sum())
        out["static_source_detections_last_7d"] = int(nn["is_static"].sum())
        if len(nn) and "priority" in nn:
            out["max_priority_last_7d"] = str(nn["priority"].max())
    b = t["blind"]
    if b is not None:
        c3 = h3.cell_to_parent(c5, settings()["h3"]["res_weather"])
        bb = b[b["h3"] == c3]
        out["blind_spot"] = bool(len(bb) and bb["message"].iloc[0])
    rep = REPORTS_DIR / "ai3_ground_forecast_metrics.json"
    if rep.exists():
        m = json.loads(rep.read_text(encoding="utf-8"))["horizons"]["h1"]["test"]
        out["model_quality_test_2024_2025"] = {"roc_auc": m["ai"].get("roc_auc"), "pr_auc": m["ai"].get("pr_auc"),
                                               "baseline_climatology_pr_auc": m["baseline_climatology"].get("pr_auc")}
    return out
