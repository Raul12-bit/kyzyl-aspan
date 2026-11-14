"""Прогноз распространения активного пожара по погоде (часть ИИ №3 «на Земле»).

Казахстан — в основном степь, поэтому берём травяную модель Макартура Mk5:
  GFDI = exp(−1.523 + 1.027·ln Q − 0.009432·(100−C)^1.536 + 0.02764·T − 0.2205·√H + 0.6422·√V)
  (Purton 1982; Noble et al. 1980), Q — запас топлива т/га, C — степень высыхания травы %,
  T — °C, H — влажность %, V — ветер км/ч. Скорость фронта R ≈ 0.13·GFDI км/ч (Noble 1980).
Форма — эллипс по ветру, отношение длины к ширине LB = 1.1·V^0.464 (Alexander 1985).
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

DANGER = [(3, "низкая"), (8, "умеренная"), (20, "высокая"), (50, "очень высокая"), (100, "чрезвычайная"),
          (150, "экстремальная"), (1e9, "катастрофическая")]


def curing_pct(month: int, precip_30d_mm: float | None = None) -> float:
    base = {1: 100, 2: 100, 3: 60, 4: 50, 5: 55, 6: 75, 7: 90, 8: 95, 9: 95, 10: 90, 11: 95, 12: 100}[month]
    if precip_30d_mm is not None:
        base -= min(25.0, max(0.0, precip_30d_mm - 25.0) * 0.5)
    return float(np.clip(base, 20, 100))


def gfdi(temp_c: float, rh: float, wind_kmh: float, curing: float = 90.0, fuel_t_ha: float = 4.5) -> float:
    return math.exp(-1.523 + 1.027 * math.log(fuel_t_ha) - 0.009432 * (100 - curing) ** 1.536 + 0.02764 * temp_c
                    - 0.2205 * math.sqrt(max(rh, 1.0)) + 0.6422 * math.sqrt(max(wind_kmh, 0.0)))


def danger_class(index: float) -> str:
    return next(name for thr, name in DANGER if index < thr)


def spread_ellipse(lat: float, lon: float, ros_kmh: float, wind_from_deg: float, wind_kmh: float, hours: float,
                   n: int = 36) -> list[list[float]]:
    """Полигон зоны возможного распространения за `hours` (GeoJSON-порядок lon, lat)."""
    head = ros_kmh * hours
    back = 0.15 * head
    lb = max(1.0, 1.1 * max(wind_kmh, 1.0) ** 0.464)
    a = (head + back) / 2
    b = a / lb
    center_shift = (head - back) / 2
    to_dir = math.radians((wind_from_deg + 180) % 360)
    pts = []
    for k in range(n + 1):
        t = 2 * math.pi * k / n
        x_al, y_cr = center_shift + a * math.cos(t), b * math.sin(t)
        east = x_al * math.sin(to_dir) + y_cr * math.cos(to_dir)
        north = x_al * math.cos(to_dir) - y_cr * math.sin(to_dir)
        pts.append([round(lon + east / (111.32 * math.cos(math.radians(lat))), 5), round(lat + north / 111.32, 5)])
    return pts


def forecast_spread(clusters: pd.DataFrame, horizons_h=(6, 12, 24)) -> pd.DataFrame:
    """clusters: [cluster_id, lat, lon, frp_sum] → прогноз по погоде Open-Meteo на ближайшие сутки."""
    from ..apis.open_meteo import forecast

    if clusters.empty:
        return clusters
    frames = forecast(clusters["lat"].tolist(), clusters["lon"].tolist(),
                      hourly=["temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m", "precipitation"],
                      days=2)
    now = pd.Timestamp.now(tz="UTC").floor("h")
    rows = []
    for (_, c), f in zip(clusters.iterrows(), frames):
        nxt = f[(f.index >= now) & (f.index < now + pd.Timedelta(hours=24))]
        if nxt.empty:
            continue
        worst = nxt.iloc[int(np.argmax(nxt["wind_speed_10m"].to_numpy() - 0.3 * nxt["relative_humidity_2m"].to_numpy()))]
        cur = curing_pct(now.month)
        idx = gfdi(worst["temperature_2m"], worst["relative_humidity_2m"], worst["wind_speed_10m"], cur)
        ros = 0.13 * idx
        row = {"cluster_id": c["cluster_id"], "lat": c["lat"], "lon": c["lon"], "gfdi": round(idx, 1),
               "danger_ru": danger_class(idx), "ros_kmh": round(ros, 2), "wind_kmh": round(float(worst["wind_speed_10m"]), 1),
               "wind_from_deg": round(float(worst["wind_direction_10m"]), 0),
               "spread_to_deg": round((float(worst["wind_direction_10m"]) + 180) % 360, 0),
               "rain_next_24h_mm": round(float(nxt["precipitation"].sum()), 1)}
        for hz in horizons_h:
            row[f"polygon_{hz}h"] = spread_ellipse(c["lat"], c["lon"], ros, row["wind_from_deg"], row["wind_kmh"], hz)
        rows.append(row)
    return pd.DataFrame(rows)
