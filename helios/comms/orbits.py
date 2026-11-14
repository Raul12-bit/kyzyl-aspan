"""Орбитальная механика: SGP4 по TLE → положение спутника, пролёты над станциями, полосы обзора.

Используется ИИ №2 (когда будет связь), планировщиком связи и «сетью спутников»
(какой спутник следующим пролетит над очагом и подтвердит его).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sgp4.api import Satrec

R_E = 6378.137
E2 = 6.69437999014e-3  # эксцентриситет² WGS-84
GEO_NORTH_POLE = (80.8, -72.8)  # геомагнитный северный полюс (IGRF, ~2025)


def unix_seconds(times) -> np.ndarray:
    """Секунды UNIX независимо от единиц хранения (pandas 3 часто хранит время в мкс)."""
    t = pd.DatetimeIndex(times)
    t = t.tz_convert("UTC") if t.tz is not None else t.tz_localize("UTC")
    return t.as_unit("ns").asi8 / 1e9


def julian(times: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray]:
    unix = unix_seconds(times)
    jd_full = unix / 86400.0 + 2440587.5
    jd = np.floor(jd_full - 0.5) + 0.5
    return jd, jd_full - jd


def gmst_rad(jd: np.ndarray, fr: np.ndarray) -> np.ndarray:
    T = (jd - 2451545.0 + fr) / 36525.0
    sec = 67310.54841 + (876600.0 * 3600 + 8640184.812866) * T + 0.093104 * T ** 2 - 6.2e-6 * T ** 3
    return np.radians(np.mod(sec / 240.0, 360.0))


def rot_z(vec: np.ndarray, theta: np.ndarray) -> np.ndarray:
    c, s = np.cos(theta), np.sin(theta)
    x, y, z = vec[:, 0], vec[:, 1], vec[:, 2]
    return np.column_stack([c * x + s * y, -s * x + c * y, z])


def geodetic_to_ecef(lat: float, lon: float, alt_km: float = 0.0) -> np.ndarray:
    phi, lam = np.radians(lat), np.radians(lon)
    n = R_E / np.sqrt(1 - E2 * np.sin(phi) ** 2)
    return np.array([(n + alt_km) * np.cos(phi) * np.cos(lam), (n + alt_km) * np.cos(phi) * np.sin(lam),
                     (n * (1 - E2) + alt_km) * np.sin(phi)])


def ecef_to_latlon(xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x, y, z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    lon = np.degrees(np.arctan2(y, x))
    p = np.sqrt(x ** 2 + y ** 2)
    lat = np.arctan2(z, p * (1 - E2))
    for _ in range(3):
        n = R_E / np.sqrt(1 - E2 * np.sin(lat) ** 2)
        lat = np.arctan2(z + E2 * n * np.sin(lat), p)
    n = R_E / np.sqrt(1 - E2 * np.sin(lat) ** 2)
    alt = p / np.cos(lat) - n
    return np.degrees(lat), lon, alt


def sun_ecef_unit(times: pd.DatetimeIndex) -> np.ndarray:
    """Направление на Солнце (Astronomical Almanac, точность ~0.01°) в ECEF."""
    jd, fr = julian(times)
    n = jd + fr - 2451545.0
    L = np.radians(np.mod(280.460 + 0.9856474 * n, 360))
    g = np.radians(np.mod(357.528 + 0.9856003 * n, 360))
    lam = L + np.radians(1.915) * np.sin(g) + np.radians(0.020) * np.sin(2 * g)
    eps = np.radians(23.439 - 4e-7 * n)
    eci = np.column_stack([np.cos(lam), np.cos(eps) * np.sin(lam), np.sin(eps) * np.sin(lam)])
    return rot_z(eci, gmst_rad(jd, fr))


def geomagnetic_lat(lat: float, lon: float) -> float:
    """Геомагнитная широта по дипольной модели (для ионосферных мерцаний)."""
    pl, pn = np.radians(GEO_NORTH_POLE[0]), np.radians(GEO_NORTH_POLE[1])
    p, l = np.radians(lat), np.radians(lon)
    return float(np.degrees(np.arcsin(np.sin(p) * np.sin(pl) + np.cos(p) * np.cos(pl) * np.cos(l - pn))))


@dataclass
class Orbit:
    name: str
    line1: str
    line2: str

    def __post_init__(self):
        self.sat = Satrec.twoline2rv(self.line1, self.line2)

    def ecef(self, times: pd.DatetimeIndex) -> np.ndarray:
        jd, fr = julian(times)
        err, r, _ = self.sat.sgp4_array(jd, fr)
        r = np.where(err[:, None] == 0, r, np.nan)
        return rot_z(r, gmst_rad(jd, fr))

    def subpoint(self, times: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        return ecef_to_latlon(self.ecef(times))


def look_angles(sat_ecef: np.ndarray, lat: float, lon: float, alt_km: float = 0.0):
    """Азимут, угол места (°) и наклонная дальность (км) со станции на спутник."""
    sta = geodetic_to_ecef(lat, lon, alt_km)
    rho = sat_ecef - sta
    phi, lam = np.radians(lat), np.radians(lon)
    e = -np.sin(lam) * rho[:, 0] + np.cos(lam) * rho[:, 1]
    n = -np.sin(phi) * np.cos(lam) * rho[:, 0] - np.sin(phi) * np.sin(lam) * rho[:, 1] + np.cos(phi) * rho[:, 2]
    u = np.cos(phi) * np.cos(lam) * rho[:, 0] + np.cos(phi) * np.sin(lam) * rho[:, 1] + np.sin(phi) * rho[:, 2]
    rng = np.sqrt(e ** 2 + n ** 2 + u ** 2)
    el = np.degrees(np.arctan2(u, np.sqrt(e ** 2 + n ** 2)))
    az = np.mod(np.degrees(np.arctan2(e, n)), 360)
    return az, el, rng, rho / rng[:, None]


def passes(orbit: Orbit, station: dict, start: pd.Timestamp, end: pd.Timestamp, step_s: int = 30,
           min_el: float = 5.0) -> pd.DataFrame:
    times = pd.date_range(start, end, freq=f"{step_s}s", tz="UTC")
    _, el, rng, _ = look_angles(orbit.ecef(times), station["lat"], station["lon"], station.get("alt_m", 0) / 1000)
    up = np.nan_to_num(el, nan=-90) >= min_el
    edges = np.diff(np.concatenate([[0], up.astype(int), [0]]))
    rows = []
    for a, b in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        k = a + int(np.argmax(el[a:b]))
        rows.append({"satellite": orbit.name, "station": station["id"], "aos": times[a], "los": times[b - 1],
                     "tca": times[k], "max_el": round(float(el[k]), 1), "min_range_km": round(float(rng[a:b].min()), 0),
                     "duration_s": int((b - a) * step_s)})
    return pd.DataFrame(rows)


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


HALF_SWATH_KM = {"MODIS": 1165.0, "VIIRS": 1520.0}


def next_overpass(orbit: Orbit, lat: float, lon: float, start: pd.Timestamp, horizon_h: float = 24,
                  half_swath_km: float = 1520.0, step_s: int = 20) -> pd.Timestamp | None:
    """Ближайший момент, когда точка попадёт в полосу обзора спутника (после start)."""
    times = pd.date_range(start, start + pd.Timedelta(hours=horizon_h), freq=f"{step_s}s")
    la, lo, _ = orbit.subpoint(times)
    d = haversine_km(la, lo, lat, lon)
    inside = np.flatnonzero(np.nan_to_num(d, nan=1e9) <= half_swath_km)
    if len(inside) == 0:
        return None
    # первое непрерывное «окно» видимости; внутри него — момент минимального угла обзора
    breaks = np.flatnonzero(np.diff(inside) > 1)
    run = inside[: (breaks[0] + 1) if len(breaks) else len(inside)]
    return times[int(run[np.argmin(d[run])])]


def line_of_sight(a: np.ndarray, b: np.ndarray, grazing_km: float = 100.0) -> np.ndarray:
    """Не закрыта ли линия a→b Землёй (с запасом на атмосферу), для каждой строки."""
    d = b - a
    t = np.clip(-(a * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
    closest = a + d * t[:, None]
    return np.linalg.norm(closest, axis=1) > R_E + grazing_km
