"""Fire Season Shift Detector — сдвигается ли пожарный сезон и не артефакт ли это смены спутников.

Для каждого года: начало (10% годовой активности), пик (центр масс 30-дневного окна максимума),
конец (90%). Тренд — наклон Тейла–Сена + тест Манна–Кендалла (непараметрические, устойчивы к
выбросам). Проверка на артефакт: тот же расчёт ТОЛЬКО по Aqua MODIS (один и тот же сенсор
с 2003 г.). Если сдвиг значим и в смешанном ряду, и в Aqua-only — он реальный.
"""

from __future__ import annotations

import h3
import numpy as np
import pandas as pd
from scipy.stats import kendalltau, theilslopes


def season_metrics(daily: pd.Series) -> dict | None:
    """daily: индекс — даты одного года, значения — активность (cell-days)."""
    if daily.sum() < 20:
        return None
    s = daily.reindex(pd.date_range(f"{daily.index[0].year}-01-01", f"{daily.index[0].year}-12-31"), fill_value=0)
    c = s.cumsum() / s.sum()
    doy = np.arange(1, len(s) + 1)
    roll = s.rolling(30, center=True, min_periods=1).sum().to_numpy()
    k = int(np.argmax(roll))
    lo, hi = max(0, k - 15), min(len(s), k + 15)
    w = s.to_numpy()[lo:hi]
    peak = float((doy[lo:hi] * w).sum() / max(w.sum(), 1))
    return {"start_doy": int(doy[np.searchsorted(c.to_numpy(), 0.10)]), "peak_doy": round(peak, 1),
            "end_doy": int(doy[min(np.searchsorted(c.to_numpy(), 0.90), len(doy) - 1)]), "total": float(s.sum())}


def trend(years: np.ndarray, values: np.ndarray) -> dict:
    if len(years) < 8:
        return {"n_years": int(len(years))}
    slope, _, lo, hi = theilslopes(values, years)
    tau, p = kendalltau(years, values)
    return {"n_years": int(len(years)), "days_per_decade": round(10 * slope, 1),
            "ci95_days_per_decade": [round(10 * lo, 1), round(10 * hi, 1)], "kendall_tau": round(float(tau), 3),
            "p_value": round(float(p), 4), "significant": bool(p < 0.05)}


def _yearly(cd: pd.DataFrame) -> pd.DataFrame:
    rows = []
    union = cd[["date", "h3_r7"]].drop_duplicates()
    for y, g in union.groupby(union["date"].dt.year):
        m = season_metrics(g.groupby("date").size())
        if m:
            rows.append({"year": int(y), **m})
    return pd.DataFrame(rows)


def region_season_shift(cd: pd.DataFrame, start_year: int = 2003, end_year: int = 2025) -> dict:
    cd = cd[cd["date"].dt.year.between(start_year, end_year)]
    mixed = _yearly(cd)
    aqua = _yearly(cd[cd["stream"] == "MODIS_A"])
    out = {"period": [start_year, end_year]}
    for name, df in (("all_sensors", mixed), ("aqua_only", aqua)):
        out[name] = {m: trend(df["year"].to_numpy(), df[m].to_numpy()) for m in ("start_doy", "peak_doy", "end_doy")} if len(df) else {}
        out[name]["yearly"] = df.to_dict("records")
    verdict = {}
    for m in ("start_doy", "peak_doy", "end_doy"):
        a, b = out["all_sensors"].get(m, {}), out["aqua_only"].get(m, {})
        if a.get("significant") and b.get("significant"):
            verdict[m] = "реальный сдвиг (значим и в Aqua-only)"
        elif a.get("significant") and not b.get("significant"):
            verdict[m] = "вероятный артефакт смены спутников"
        elif b.get("significant"):
            verdict[m] = "сдвиг по Aqua-only, смешанный ряд шумнее"
        else:
            verdict[m] = "значимого сдвига нет"
    out["verdict"] = verdict
    return out


def cell_season_shift(cd: pd.DataFrame, res: int = 4, start_year: int = 2003, end_year: int = 2025,
                      min_years: int = 10) -> pd.DataFrame:
    """Карта сдвига пика сезона по ячейкам H3 res-4 (~1770 км²), только Aqua MODIS (без артефактов)."""
    d = cd[(cd["stream"] == "MODIS_A") & cd["date"].dt.year.between(start_year, end_year)].copy()
    d["r4"] = [h3.cell_to_parent(c, res) for c in d["h3_r7"]]
    d = d[["date", "h3_r7", "r4"]].drop_duplicates()
    rows = []
    for cell, g in d.groupby("r4"):
        yrs = []
        for y, gy in g.groupby(g["date"].dt.year):
            doy = gy["date"].dt.dayofyear.to_numpy()
            if len(doy) >= 3:
                ang = 2 * np.pi * doy / 365.25
                yrs.append((y, (np.degrees(np.arctan2(np.sin(ang).mean(), np.cos(ang).mean())) % 360) / 360 * 365.25, len(doy)))
        if len(yrs) < min_years:
            continue
        arr = np.array(yrs)
        t = trend(arr[:, 0], arr[:, 1])
        lat, lon = h3.cell_to_latlng(cell)
        rows.append({"h3_r4": cell, "lat": round(lat, 4), "lon": round(lon, 4), "years": int(len(arr)),
                     "mean_peak_doy": round(float(arr[:, 1].mean()), 1), **{k: v for k, v in t.items() if k != "ci95_days_per_decade"}})
    return pd.DataFrame(rows)
