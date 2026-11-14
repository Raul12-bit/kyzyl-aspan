"""Реестр постоянных источников тепла (факелы нефтепромыслов, заводы, ТЭЦ, котельные).

Собрано из трёх проектов и усилено:
1. Маска по полю FIRMS `type` (1 вулкан, 2 статичный наземный источник, 3 офшор):
   ячейка статична, если ≥50% типизированных точек — 1/2/3 (идея Kiln-Watch, своя реализация).
   Маска переносится на NRT-данные, где поля `type` нет.
2. Временная устойчивость: точка горит ≥10 разных месяцев в году (flare-chronos, MIT)
   ИЛИ ≥6 месяцев в году на протяжении ≥3 лет (НОВОЕ: ловит факелы с перерывами).
3. Пространственная повторяемость: годовая кластеризация HDBSCAN (MODIS-VIIRS-fires,
   Franklin et al. 2025, MIT); плотный компактный кластер на том же месте ≥4 лет —
   постоянный источник (НОВОЕ: проверка повторяемости между годами и компактности).
4. НОВОЕ: итоговый static_score 0..1 из всех улик + доля ночных обнаружений
   (факелы горят и ночью, а сельхозпалы — днём) + стабильность FRP.
"""

from __future__ import annotations

import h3
import numpy as np
import pandas as pd
from sklearn.cluster import HDBSCAN

from ..config import settings
from ..utils import get_logger

log = get_logger("helios.persistence")


def _project_km(lat: np.ndarray, lon: np.ndarray, lat0: float) -> np.ndarray:
    return np.column_stack([np.radians(lon) * 6371.0 * np.cos(np.radians(lat0)), np.radians(lat) * 6371.0])


def hdbscan_recurrent_cells(df: pd.DataFrame, min_cluster: int, min_years: int, res: int = 7) -> pd.DataFrame:
    """Годовая HDBSCAN-кластеризация плотных точек -> ячейки res-7, где кластер повторяется ≥ min_years лет."""
    rows = []
    rng = np.random.default_rng(42)
    for year, g in df.groupby(df["acq_dt"].dt.year):
        # кандидаты: res-8 ячейки, горевшие ≥3 РАЗНЫХ дней за год (пал поля горит 1–2 дня,
        # факел — постоянно). Порог поднимается, пока точек не станет ≤40k: sklearn-HDBSCAN O(n²).
        day = g["acq_dt"].dt.normalize()
        days_per_cell = pd.DataFrame({"h3_r8": g["h3_r8"], "day": day}).drop_duplicates().groupby("h3_r8").size()
        days = g["h3_r8"].map(days_per_cell).to_numpy()
        # не больше 6 точек на ячейку: плотность кластера сохраняется, а n падает в разы
        rank = pd.Series(rng.random(len(g)), index=g.index).groupby(g["h3_r8"]).rank(method="first").to_numpy()
        min_days = 3
        cand = g[(days >= min_days) & (rank <= 6)]
        while len(cand) > 40_000 and min_days < 30:
            min_days += 2
            cand = g[(days >= min_days) & (rank <= 6)]
        if len(cand) < min_cluster:
            continue
        xy = _project_km(cand["lat"].to_numpy(), cand["lon"].to_numpy(), float(cand["lat"].mean()))
        try:  # параметр copy есть в свежих sklearn; на старых (Kaggle) — без него
            model = HDBSCAN(min_cluster_size=min_cluster, min_samples=3, copy=True)
        except TypeError:
            model = HDBSCAN(min_cluster_size=min_cluster, min_samples=3)
        labels = model.fit_predict(xy)
        cand = cand.assign(cl=labels)
        for cl, c in cand[cand.cl >= 0].groupby("cl"):
            spread = float(np.sqrt(np.var(xy[labels == cl], axis=0).sum()))
            if spread > 1.5:  # размазанный кластер — это не точечный источник
                continue
            rows.append({"year": int(year), "lat": float(c.lat.mean()), "lon": float(c.lon.mean()),
                         "n": int(len(c)), "spread_km": spread})
    if not rows:
        return pd.DataFrame(columns=["h3_r7", "hdb_years"])
    clusters = pd.DataFrame(rows)
    clusters["h3_r7"] = [h3.latlng_to_cell(a, b, res) for a, b in zip(clusters.lat, clusters.lon)]
    # повторяемость: учитываем соседние ячейки (k=1), центроиды «гуляют» на ~1 км
    years_by_cell: dict[str, set[int]] = {}
    for cell, year in zip(clusters.h3_r7, clusters.year):
        for nb in h3.grid_disk(cell, 1):
            years_by_cell.setdefault(nb, set()).add(year)
    centers = clusters.groupby("h3_r7").agg(n_clusters=("n", "size")).reset_index()
    centers["hdb_years"] = [len(years_by_cell.get(c, ())) for c in centers.h3_r7]
    return centers[centers.hdb_years >= min_years][["h3_r7", "hdb_years"]]


def build_static_registry(df: pd.DataFrame) -> pd.DataFrame:
    """Реестр статичных res-8 ячеек. df: нормализованные точки + h3_r8, h3_r7, daynight_sza."""
    f = settings()["filters"]
    d = df[["h3_r8", "h3_r7", "lat", "lon", "acq_dt", "type", "frp", "daynight_sza"]].copy()
    d["year"] = d["acq_dt"].dt.year
    d["month"] = d["acq_dt"].dt.month
    d["is_typed"] = d["type"].notna()
    d["is_static_type"] = d["type"].isin([1.0, 2.0, 3.0])
    d["is_night"] = d["daynight_sza"] == "N"

    g = d.groupby("h3_r8")
    reg = pd.DataFrame({
        "n": g.size(),
        "lat": g["lat"].mean(),
        "lon": g["lon"].mean(),
        "n_typed": g["is_typed"].sum(),
        "n_static_type": g["is_static_type"].sum(),
        "night_share": g["is_night"].mean(),
        "frp_median": g["frp"].median(),
        "frp_cv": g["frp"].std() / g["frp"].mean().replace(0, np.nan),
        "first_year": g["year"].min(),
        "last_year": g["year"].max(),
        "n_years": g["year"].nunique(),
    })
    # (1) маска по полю type
    reg["static_type_share"] = (reg.n_static_type / reg.n_typed.replace(0, np.nan)).fillna(0)
    reg["ev_type"] = (reg.static_type_share >= f["static_type_share"]) & (reg.n_typed >= 3)

    # (2) временная устойчивость: месяцы в году
    months = d.groupby(["h3_r8", "year"])["month"].nunique().rename("months").reset_index()
    max_months = months.groupby("h3_r8")["months"].max()
    years6 = months[months.months >= 6].groupby("h3_r8").size()
    reg["max_months_in_year"] = max_months
    reg["years_with_6m"] = years6.reindex(reg.index).fillna(0).astype(int)
    reg["ev_temporal"] = (reg.max_months_in_year >= f["static_min_months"]) | (reg.years_with_6m >= f["static_min_years"])

    # (3) HDBSCAN-повторяемость
    rec = hdbscan_recurrent_cells(d, f["hdbscan_min_cluster"], f["hdbscan_recurrence_years"])
    rec_cells = set(rec.h3_r7)
    parent = pd.Series([h3.cell_to_parent(c, 7) for c in reg.index], index=reg.index)
    reg["ev_hdbscan"] = parent.isin(rec_cells) & (reg.n_years >= 3)

    # (4) итоговый балл
    score = (
        0.45 * reg.ev_type.astype(float)
        + 0.30 * reg.ev_temporal.astype(float)
        + 0.25 * reg.ev_hdbscan.astype(float)
        + 0.10 * np.clip((reg.night_share - 0.25) / 0.5, 0, 1)
        + 0.05 * np.clip((reg.n_years - 3) / 10, 0, 1)
    )
    reg["static_score"] = np.clip(score, 0, 1).round(3)
    reg["is_static"] = (reg.static_score >= 0.45) & (reg.n >= 4)
    reg.index.name = "h3_r8"
    out = reg.reset_index()
    log.info(
        "static registry: %d static of %d cells (type=%d, temporal=%d, hdbscan=%d)",
        int(out.is_static.sum()), len(out), int(out.ev_type.sum()), int(out.ev_temporal.sum()), int(out.ev_hdbscan.sum()),
    )
    return out


def static_cell_set(registry: pd.DataFrame, buffer_k: int = 1) -> set[str]:
    """Статичные res-8 ячейки + буфер в k колец (пиксель MODIS 1 км «гуляет»)."""
    cells = set()
    for c in registry.loc[registry.is_static, "h3_r8"]:
        cells.update(h3.grid_disk(c, buffer_k))
    return cells
