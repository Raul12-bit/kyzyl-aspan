"""Единый фильтр шума MODIS + VIIRS.

Что берём у других (с указанием авторства) и что улучшаем:

| Шаг | Источник | Улучшение HELIOS |
|---|---|---|
| Унифицированная вероятность P(fire) из MODIS 0–100% и VIIRS l/n/h + контраст ΔT(4–11 мкм) | flare-chronos (MIT) | + штраф за солнечный блик, + подтверждение соседями |
| Фильтр Южно-Атлантической аномалии (ночные «протонные» пиксели) | flare-chronos (MIT) | без изменений (важно для глобального режима) |
| День/ночь по зенитному углу Солнца (SZA < 85°) | flare-chronos (MIT) | векторно |
| Отсев low confidence (MODIS < 30, VIIRS «l») | рекомендации FIRMS / Kiln-Watch | low confidence НЕ выкидываем вслепую: если точку подтвердили соседи/другой спутник — оставляем |
| Постоянные источники (факелы, заводы) | flare-chronos + MODIS-VIIRS-fires + Kiln-Watch | единый реестр с 4 уликами (см. persistence.py) |
| Солнечный блик | — | НОВОЕ: угол блика по геометрии Солнца и сенсора |
| Одиночные точки | — | НОВОЕ: пространственно-временная поддержка (KD-дерево 3 км × ±2 сут) |
| Кросс-сенсорное подтверждение | идея эпизодов flare-chronos | НОВОЕ: другой спутник видел то же место ±60 мин |

На выходе у каждой точки: p_fire, флаги и причина отсева noise_reason; keep_veg — то,
что дальше считается растительным/природным пожаром.
"""

from __future__ import annotations

import h3
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from ..config import settings
from ..utils import get_logger
from .footprint import pixel_area_km2, scan_angle_deg, track_azimuth_deg, view_zenith_deg
from .solar import daynight, glint_angle, solar_position

log = get_logger("helios.filters")


# ----------------------------------------------------------------------------- геометрия и H3
def add_geometry(df: pd.DataFrame) -> pd.DataFrame:
    """SZA, день/ночь, угол скана, VZA, площадь пикселя, угол блика, H3-ячейки."""
    out = df.copy()
    sza, sun_az = solar_position(out["lat"].to_numpy(), out["lon"].to_numpy(), out["acq_dt"])
    out["sza"] = sza
    out["daynight_sza"] = pd.Categorical(daynight(sza), categories=["D", "N"])
    sensor = out["sensor"].astype(str).to_numpy()
    out["scan_deg"] = scan_angle_deg(sensor, out["scan"].to_numpy(), out["track"].to_numpy())
    out["vza"] = view_zenith_deg(sensor, out["scan_deg"].to_numpy())
    out["pixel_km2"] = pixel_area_km2(out["scan"].to_numpy(), out["track"].to_numpy())
    trk = track_azimuth_deg(out["lat"].to_numpy(), out["stream"].astype(str).to_numpy(), out["daynight_sza"].astype(str).to_numpy())
    out["glint_deg"] = np.where(out["daynight_sza"] == "D", glint_angle(sza, sun_az, out["vza"].to_numpy(), trk), 180.0).astype(np.float32)
    res = settings()["h3"]
    lat, lon = out["lat"].to_numpy(), out["lon"].to_numpy()
    out["h3_r8"] = [h3.latlng_to_cell(a, b, res["res_fine"]) for a, b in zip(lat, lon)]
    out["h3_r7"] = [h3.cell_to_parent(c, res["res_cell"]) for c in out["h3_r8"]]
    out["h3_r5"] = [h3.cell_to_parent(c, res["res_model"]) for c in out["h3_r7"]]
    return out


# ----------------------------------------------------------------------------- P(fire)
def unified_probability(df: pd.DataFrame) -> np.ndarray:
    """MODIS: логистика по confidence% (якоря Giglio 2003/2016); VIIRS: якоря по l/n/h.
    Оба усиливаются контрастом ΔT = T(4 мкм) − T(11 мкм). Коэффициенты — flare-chronos (MIT)."""
    dt45 = np.maximum(0.0, (df["bright_mir"] - df["bright_tir"]).fillna(0).to_numpy(dtype=np.float64))
    is_day = (df["daynight_sza"] == "D").to_numpy()
    p = np.zeros(len(df), dtype=np.float64)
    m = (df["sensor"] == "MODIS").to_numpy()
    conf = np.clip(df["conf_pct"].fillna(50).to_numpy(dtype=np.float64), 0, 100)
    z = (conf - 38.0) / 19.0 + 0.015 * np.clip(dt45 - 18.0, -10, 40)
    p[m] = 1.0 / (1.0 + np.exp(-z[m]))
    cat = df["conf_cat"].astype(str).to_numpy()
    anchor = np.where(cat == "h", 0.94, np.where(cat == "n", np.where(is_day, 0.78, 0.84), np.where(is_day, 0.28, 0.38)))
    pv = np.clip(anchor + 0.06 * np.tanh((dt45 - 20.0) / 15.0), 0.05, 0.99)
    p[~m] = pv[~m]
    return p


def saa_flag(df: pd.DataFrame, p: np.ndarray) -> np.ndarray:
    """Ночные ложные пиксели в Южно-Атлантической аномалии (flare-chronos, MIT)."""
    w, s, e, n = settings()["filters"]["saa_bbox"]
    in_saa = df["lon"].between(w, e).to_numpy() & df["lat"].between(s, n).to_numpy()
    night = (df["daynight_sza"] == "N").to_numpy()
    dt45 = (df["bright_mir"] - df["bright_tir"]).fillna(0).to_numpy()
    frp = df["frp"].fillna(0).to_numpy()
    return in_saa & night & (((dt45 < 16.5) & (frp < 2.2)) | ((p < 0.45) & (dt45 < 19.5)))


# ----------------------------------------------------------------------------- поддержка соседями
def _xyz(lat: np.ndarray, lon: np.ndarray, t_days: np.ndarray, km_per_day: float) -> np.ndarray:
    lat0 = float(np.nanmean(lat)) if len(lat) else 0.0
    x = np.radians(lon) * 6371.0 * np.cos(np.radians(lat0))
    y = np.radians(lat) * 6371.0
    return np.column_stack([x, y, t_days * km_per_day])


def spatiotemporal_support(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """(число соседей в 3 км и ±2 сут, подтверждён ли другим спутником в 2 км и ±60 мин)."""
    f = settings()["filters"]
    r_km, win = f["isolation_radius_km"], f["isolation_window_days"]
    neighbors = np.zeros(len(df), dtype=np.int32)
    confirmed = np.zeros(len(df), dtype=bool)
    t_days = (df["acq_dt"] - pd.Timestamp("2000-01-01", tz="UTC")).dt.total_seconds().to_numpy() / 86400.0
    lat, lon = df["lat"].to_numpy(), df["lon"].to_numpy()
    stream = df["stream"].astype(str).to_numpy()
    year = df["acq_dt"].dt.year.to_numpy()
    for y in np.unique(year):
        idx = np.flatnonzero(year == y)
        # окно ±2 сут масштабируем так, чтобы оно совпало с радиусом 3 км (эллипсоид)
        pts = _xyz(lat[idx], lon[idx], t_days[idx], r_km / win)
        tree = cKDTree(pts)
        neighbors[idx] = tree.query_ball_point(pts, r=r_km, return_length=True) - 1
        # кросс-сенсорное подтверждение: 2 км и ±60 мин, другой спутник
        pts2 = _xyz(lat[idx], lon[idx], t_days[idx], 2.0 / (60.0 / 1440.0))
        for s in np.unique(stream[idx]):
            mine = stream[idx] == s
            if mine.all() or not mine.any():
                continue
            other = cKDTree(pts2[~mine])
            cnt = other.query_ball_point(pts2[mine], r=2.0, return_length=True)
            confirmed[idx[mine]] = cnt > 0
    return neighbors, confirmed


# ----------------------------------------------------------------------------- главный фильтр
def apply_filters(df: pd.DataFrame, static_cells: set[str] | None = None) -> pd.DataFrame:
    """Полный фильтр шума. df должен пройти add_geometry(). Возвращает копию с флагами."""
    f = settings()["filters"]
    out = df.copy()
    p = unified_probability(out)
    out["p_fire_raw"] = p.astype(np.float32)

    out["is_low_conf"] = np.where(
        out["sensor"] == "MODIS", out["conf_pct"].fillna(0) < f["modis_min_conf"],
        (out["conf_cat"].astype(str) == "l") & bool(f["viirs_drop_low"]),
    )
    out["is_saa"] = saa_flag(out, p)
    glint = (out["daynight_sza"] == "D").to_numpy() & (out["glint_deg"].to_numpy() < f["glint_angle_deg"])
    out["is_glint_risk"] = glint & (out["conf_cat"].astype(str) != "h").to_numpy()

    nb, conf = spatiotemporal_support(out)
    out["neighbors"] = nb
    out["cross_confirmed"] = conf

    # корректировка вероятности (НОВОЕ)
    p = np.where(out["is_glint_risk"], p * 0.55, p)
    p = np.where(out["is_saa"], p * 0.12, p)
    p = np.where(nb >= 2, 1 - (1 - p) * 0.7, p)               # есть соседи — увереннее
    p = np.where(conf, 1 - (1 - p) * 0.5, p)                  # другой спутник подтвердил
    isolated = (nb == 0) & ~conf & (out["conf_cat"].astype(str) != "h").to_numpy()
    p = np.where(isolated, p * 0.75, p)                       # одиночка без подтверждения
    out["p_fire"] = np.clip(p, 0, 1).astype(np.float32)
    out["is_isolated"] = isolated

    # постоянные источники
    typed_static = out["type"].isin([1.0, 2.0, 3.0]).to_numpy()
    in_registry = out["h3_r8"].isin(static_cells).to_numpy() if static_cells else np.zeros(len(out), bool)
    out["is_static"] = typed_static | in_registry

    reason = np.full(len(out), "", dtype=object)
    reason[out["p_fire"].to_numpy() < f["p_fire_keep"]] = "low_probability"
    reason[out["is_glint_risk"].to_numpy() & (out["p_fire"].to_numpy() < f["p_fire_keep"])] = "sun_glint"
    reason[isolated & (out["p_fire"].to_numpy() < f["p_fire_keep"])] = "isolated"
    reason[out["is_saa"].to_numpy()] = "saa"
    reason[out["is_static"].to_numpy()] = "static_source"
    out["noise_reason"] = pd.Categorical(np.where(reason == "", "kept", reason))
    out["keep_veg"] = out["noise_reason"] == "kept"
    return out


def filter_report(df: pd.DataFrame) -> dict:
    """Сколько точек отсеяно и почему — по сенсорам (для слайдов и README)."""
    rep = (
        df.groupby(["sensor", "noise_reason"], observed=True).size().unstack(fill_value=0)
        if len(df) else pd.DataFrame()
    )
    total = df.groupby("sensor", observed=True).size()
    return {
        "total": {k: int(v) for k, v in total.items()},
        "by_reason": {s: {k: int(v) for k, v in row.items()} for s, row in rep.iterrows()},
        "kept_share": {s: round(float(rep.loc[s].get("kept", 0) / total[s]), 4) for s in rep.index},
    }
