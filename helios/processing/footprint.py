"""Геометрия пикселя MODIS (1 км) и VIIRS (375 м) по углу сканирования.

Формулы сферической геометрии сканирования (Giglio et al. 2016; Wolfe et al. 2013;
Schroeder et al. 2014) и обращение «размер пикселя -> угол скана» взяты из
flare-chronos (MIT, (c) 2026 Xiro The Dev) и переписаны на numpy (векторно, быстро
для миллионов точек).
"""

from __future__ import annotations

import numpy as np

R_EARTH_KM = 6378.137
MODIS_ORBIT_KM = R_EARTH_KM + 705.0
MODIS_SAMPLING_RAD = 0.0014184397
VIIRS_ORBIT_KM = R_EARTH_KM + 829.0
VIIRS_TRACK_RAD = 0.0004340
VIIRS_MAX_SCAN_DEG = 56.28


def _modis_scan_km(theta: np.ndarray) -> np.ndarray:
    ratio_sq = (R_EARTH_KM / MODIS_ORBIT_KM) ** 2
    root = np.sqrt(np.maximum(1e-9, ratio_sq - np.sin(theta) ** 2))
    return R_EARTH_KM * MODIS_SAMPLING_RAD * (np.cos(theta) / root - 1.0)


def _viirs_track_km(theta: np.ndarray) -> np.ndarray:
    ratio_sq = (R_EARTH_KM / VIIRS_ORBIT_KM) ** 2
    root = np.sqrt(np.maximum(1e-9, ratio_sq - np.sin(theta) ** 2))
    return VIIRS_ORBIT_KM * VIIRS_TRACK_RAD * (np.cos(theta) - root)


def _bisect(fn, target: np.ndarray, hi_rad: float, iters: int = 40) -> np.ndarray:
    lo = np.zeros_like(target, dtype=np.float64)
    hi = np.full_like(target, hi_rad, dtype=np.float64)
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        below = fn(mid) < target
        lo = np.where(below, mid, lo)
        hi = np.where(below, hi, mid)
    return 0.5 * (lo + hi)


def scan_angle_deg(sensor: np.ndarray, scan_km: np.ndarray, track_km: np.ndarray) -> np.ndarray:
    """Угол сканирования (°) из размеров пикселя, отдельно для MODIS и VIIRS."""
    sensor = np.asarray(sensor).astype(str)
    scan_km = np.nan_to_num(np.asarray(scan_km, dtype=np.float64), nan=1.0)
    track_km = np.nan_to_num(np.asarray(track_km, dtype=np.float64), nan=0.4)
    out = np.zeros(len(sensor), dtype=np.float64)
    m = sensor == "MODIS"
    if m.any():
        tgt = np.maximum(scan_km[m], _modis_scan_km(np.array([0.0]))[0])
        out[m] = _bisect(_modis_scan_km, tgt, np.radians(55.5))
    v = ~m
    if v.any():
        tgt = np.clip(track_km[v], _viirs_track_km(np.array([0.0]))[0], _viirs_track_km(np.array([np.radians(VIIRS_MAX_SCAN_DEG)]))[0])
        out[v] = _bisect(_viirs_track_km, tgt, np.radians(VIIRS_MAX_SCAN_DEG))
    return np.degrees(out).astype(np.float32)


def view_zenith_deg(sensor: np.ndarray, scan_deg: np.ndarray) -> np.ndarray:
    """Зенитный угол визирования на земле: sin(vza) = (r / R_e) * sin(scan)."""
    sensor = np.asarray(sensor).astype(str)
    r = np.where(sensor == "MODIS", MODIS_ORBIT_KM, VIIRS_ORBIT_KM)
    s = np.clip(r / R_EARTH_KM * np.sin(np.radians(scan_deg)), -1, 1)
    return np.degrees(np.arcsin(s)).astype(np.float32)


def track_azimuth_deg(lat: np.ndarray, stream: np.ndarray, daynight: np.ndarray) -> np.ndarray:
    """Азимут подспутниковой трассы солнечно-синхронной орбиты (адаптировано из flare-chronos)."""
    stream = np.asarray(stream).astype(str)
    inc = np.where(np.char.startswith(stream, "MODIS"), 98.2, 98.7)
    cos_lat = np.maximum(0.15, np.cos(np.radians(lat)))
    base = np.degrees(np.arcsin(np.clip(np.cos(np.radians(inc)) / cos_lat, -1, 1)))
    terra = stream == "MODIS_T"
    day = np.asarray(daynight).astype(str) == "D"
    ascending = np.where(terra, ~day, day)  # Terra — утренняя нисходящая, остальные — дневные восходящие
    return np.where(ascending, np.mod(360.0 + base, 360.0), np.mod(180.0 - base, 360.0)).astype(np.float32)


def pixel_area_km2(scan_km: np.ndarray, track_km: np.ndarray) -> np.ndarray:
    return (np.asarray(scan_km, dtype=np.float32) * np.asarray(track_km, dtype=np.float32)).astype(np.float32)
