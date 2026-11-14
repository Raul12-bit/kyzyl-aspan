"""Солнечная геометрия (векторно, numpy).

* Зенитный угол Солнца (SZA) и день/ночь по физике (SZA < 85°), а не по флагу NRT —
  формулы NOAA/Spencer, идея и коэффициенты из flare-chronos (MIT, (c) 2026 Xiro The Dev).
* НОВОЕ: азимут Солнца и угол солнечного блика (sun glint) — днём зеркальное отражение
  от воды/крыш даёт ложные «горячие» пиксели. Сторона полосы обзора в FIRMS не известна,
  поэтому считаем блик для обеих сторон и берём минимум (консервативно).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

DAYNIGHT_SZA_DEG = 85.0


def solar_position(lat: np.ndarray, lon: np.ndarray, dt_utc: pd.Series | pd.DatetimeIndex):
    """Вернуть (sza_deg, sun_azimuth_deg) для массивов координат и времени UTC."""
    dt = pd.DatetimeIndex(dt_utc)
    doy = dt.dayofyear.to_numpy(dtype=np.float64)
    hours = dt.hour.to_numpy() + dt.minute.to_numpy() / 60.0 + dt.second.to_numpy() / 3600.0
    gamma = 2.0 * np.pi / 365.25 * (doy - 1.0 + (hours - 12.0) / 24.0)
    eqtime = 229.18 * (0.000075 + 0.001868 * np.cos(gamma) - 0.032077 * np.sin(gamma)
                       - 0.014615 * np.cos(2 * gamma) - 0.040849 * np.sin(2 * gamma))
    decl = (0.006918 - 0.399912 * np.cos(gamma) + 0.070257 * np.sin(gamma)
            - 0.006758 * np.cos(2 * gamma) + 0.000907 * np.sin(2 * gamma)
            - 0.002697 * np.cos(3 * gamma) + 0.001480 * np.sin(3 * gamma))
    tst = np.mod(hours * 60.0 + eqtime + 4.0 * np.asarray(lon, dtype=np.float64), 1440.0)
    ha = np.radians(tst / 4.0 - 180.0)
    phi = np.radians(np.asarray(lat, dtype=np.float64))
    cos_sza = np.clip(np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(ha), -1, 1)
    sza = np.degrees(np.arccos(cos_sza))
    az = np.degrees(np.arctan2(np.sin(ha), np.cos(ha) * np.sin(phi) - np.tan(decl) * np.cos(phi))) + 180.0
    return sza.astype(np.float32), np.mod(az, 360.0).astype(np.float32)


def daynight(sza: np.ndarray) -> np.ndarray:
    return np.where(sza < DAYNIGHT_SZA_DEG, "D", "N")


def glint_angle(sza: np.ndarray, sun_az: np.ndarray, vza: np.ndarray, track_az: np.ndarray) -> np.ndarray:
    """Минимальный угол блика (°) для двух возможных сторон полосы обзора.

    cos(g) = cos(θs)cos(θv) − sin(θs)sin(θv)cos(φ),  φ = азимут Солнца − азимут сенсора.
    Сенсор смотрит перпендикулярно трассе спутника: азимут сенсора = трасса ± 90°.
    """
    ts, tv = np.radians(sza), np.radians(vza)
    out = np.full(np.shape(sza), 180.0, dtype=np.float32)
    for side in (90.0, -90.0):
        phi = np.radians(sun_az - (track_az + side))
        cos_g = np.cos(ts) * np.cos(tv) - np.sin(ts) * np.sin(tv) * np.cos(phi)
        out = np.minimum(out, np.degrees(np.arccos(np.clip(cos_g, -1, 1))).astype(np.float32))
    return out
