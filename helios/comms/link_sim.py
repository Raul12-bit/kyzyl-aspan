"""Симулятор каналов связи на реальных входах (обучающие данные для ИИ №2 и планировщика).

Реальное: орбиты (TLE CelesTrak → SGP4), погода у станций (Open-Meteo ERA5/прогноз:
осадки, облачность нижнего/среднего/верхнего яруса, влажность), геомагнитный индекс Kp
и радиопоток F10.7 (GFZ Potsdam), вспышки (NOAA SWPC).
Смоделированное: запас каждой линии по физике (physics.py) + случайные, но ПЛАВНЫЕ во
времени (AR(1)) дождевые ячейки, облака на луче и всплески мерцаний. Открытой телеметрии
спутников нет, поэтому разметка «физическая», а не с борта.

Окна моделирования: свежие дни + реальные геомагнитные бури (май 2024, Kp 9; октябрь 2024).
Для старых окон геометрия пролётов считается по текущим TLE — она статистически
представительна (те же орбиты), но не повторяет точное положение спутников в тот день.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from scipy.stats import norm

from ..apis import celestrak, open_meteo, space_weather
from ..utils import get_logger
from . import physics
from .orbits import Orbit, look_angles, sun_ecef_unit, unix_seconds
from .stations import STATIONS

log = get_logger("helios.linksim")

OBSERVERS = ["TERRA", "AQUA", "SUOMI NPP", "NOAA 20", "NOAA 21"]
CHANNELS = ["S", "X", "Ka", "OPT"]
HOURLY = ["precipitation", "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "relative_humidity_2m"]
STORM_WINDOWS = [("2024-05-08", "2024-05-15"), ("2024-10-07", "2024-10-12")]


class Environment:
    """Погода у станций и космическая погода на интервале [start, end]."""

    def __init__(self, start: pd.Timestamp, end: pd.Timestamp, mode: str = "archive", seed: int = 0):
        self.start, self.end, self.mode = start, end, mode
        self.rng = np.random.default_rng(seed)
        lats = [s["lat"] for s in STATIONS]
        lons = [s["lon"] for s in STATIONS]
        try:
            if mode == "archive":
                frames = open_meteo.archive(lats, lons, start.date(), end.date(), hourly=HOURLY)
            else:
                frames = open_meteo.forecast(lats, lons, hourly=HOURLY, days=3)
        except Exception as exc:
            log.warning("Open-Meteo недоступен (%s): климатическая погода", exc)
            idx = pd.date_range(start.floor("h"), end.ceil("h"), freq="h", tz="UTC")
            frames = [pd.DataFrame({"precipitation": self.rng.exponential(0.1, len(idx)),
                                    **{c: self.rng.uniform(0, 100, len(idx)) for c in HOURLY[1:5]},
                                    "relative_humidity_2m": 70.0}, index=idx) for _ in STATIONS]
        self.weather = {s["id"]: f for s, f in zip(STATIONS, frames)}
        self.kp = self._gfz("Kp", 2.0)
        self.f107 = self._gfz("Fobs", 120.0)
        self.xray = self._xray()

    def _gfz(self, index: str, default: float) -> pd.Series:
        try:
            df = space_weather.gfz_index(index, self.start - timedelta(days=2), self.end + timedelta(days=1))
            s = df.set_index("time")[index.lower()].astype(float)
            s = s[s > -1]
            if len(s):
                return s
        except Exception as exc:
            log.info("GFZ %s: %s", index, exc)
        if index == "Kp":
            try:
                k = space_weather.kp_recent().set_index("time")["kp"]
                if len(k):
                    return k
            except Exception:
                pass
        return pd.Series([default], index=[self.start])

    def _xray(self) -> pd.Series:
        """Поток рентгена: реальный (SWPC, последние сутки) или модель вспышек ~ F10.7 (Пуассон)."""
        idx = pd.date_range(self.start.floor("min"), self.end.ceil("min"), freq="min", tz="UTC")
        f107 = float(np.nanmean(self.f107.values)) if len(self.f107) else 120.0
        flux = np.full(len(idx), 1e-7 * (f107 / 100.0) ** 2)
        days = (self.end - self.start).total_seconds() / 86400
        for _ in range(self.rng.poisson(max(0.3, 3.0 * f107 / 150.0) * days)):
            peak = 1e-6 * (self.rng.pareto(0.8) + 1.0)  # от C1, степенной закон
            t0 = self.rng.integers(0, len(idx))
            dur = int(self.rng.integers(10, 60))
            tail = peak * np.exp(-np.arange(min(dur * 3, len(idx) - t0)) / dur)
            flux[t0:t0 + len(tail)] = np.maximum(flux[t0:t0 + len(tail)], tail)
        series = pd.Series(np.minimum(flux, 2e-3), index=idx)
        try:
            real = space_weather.xray_flux_recent().set_index("time")["flux"]
            common = series.index.intersection(real.index)
            if len(common):
                series.loc[common] = real.loc[common].to_numpy()
        except Exception:
            pass
        return series

    @staticmethod
    def _interp(series: pd.Series, times: pd.DatetimeIndex) -> np.ndarray:
        s = series.dropna()
        if len(s) == 0:
            return np.zeros(len(times))
        return np.interp(unix_seconds(times), unix_seconds(s.index), s.to_numpy(dtype=float))

    def at(self, station_id: str, times: pd.DatetimeIndex) -> dict[str, np.ndarray]:
        w = self.weather[station_id]
        g = lambda c: np.clip(self._interp(w[c], times) / 100.0, 0, 1) if c in w else np.zeros(len(times))
        low, mid, high = g("cloud_cover_low"), g("cloud_cover_mid"), g("cloud_cover_high")
        return {
            "precip": np.maximum(self._interp(w["precipitation"], times), 0.0),
            "cloud": g("cloud_cover"),
            # для лазера важны плотные облака: нижний ярус целиком, средний почти, перистые — слабо
            "cloud_opt": 1 - (1 - low) * (1 - 0.8 * mid) * (1 - 0.15 * high),
            "rh": self._interp(w["relative_humidity_2m"], times),
            "kp": self._interp(self.kp, times),
            "f107": self._interp(self.f107, times),
            "xray": self._interp(self.xray, times),
        }


def ar1(n: int, rho: float, rng: np.random.Generator) -> np.ndarray:
    """Гауссов AR(1) с единичной дисперсией: плавные во времени случайные процессы."""
    x = np.empty(n)
    x[0] = rng.normal()
    s = np.sqrt(1 - rho ** 2)
    eps = rng.normal(size=n)
    for i in range(1, n):
        x[i] = rho * x[i - 1] + s * eps[i]
    return x


def channel_margins(station: dict, rng_km, el, sun_sep, v: dict, rng: np.random.Generator | None,
                    stochastic: bool = True) -> dict[str, np.ndarray]:
    """Запасы всех каналов станции (дБ). Стохастика — коррелированная во времени (AR(1))."""
    n = len(el)
    if stochastic and rng is not None:
        rain = v["precip"] * np.exp(0.9 * ar1(n, 0.95, rng) - 0.4) * (ar1(n, 0.97, rng) > -1.0)
        scint = np.exp(0.6 * ar1(n, 0.9, rng))
        blocked = norm.cdf(ar1(n, 0.985, rng)) < v["cloud_opt"]
        cloud_for_opt = blocked.astype(float)
    else:
        rain, scint, cloud_for_opt = v["precip"], 1.0, v["cloud_opt"]
    lwc = v["cloud"] * 0.25 + 0.08 * rain
    out = {}
    if station["kind"] == "rf":
        for band in station["bands"]:
            out[band] = physics.rf_margin_db(
                band, rng_km, el, station["dish_m"], station["lat"], station["alt_m"] / 1000, rain, lwc,
                v["rh"], v["kp"], station["geomag_lat"], sun_sep, float(np.mean(v["f107"])),
                float(np.max(v["xray"])), None, scint,
            )
    else:
        out["OPT"] = physics.optical_ground_margin_db(rng_km, el, cloud_for_opt, station["aperture_m"], sun_sep, None,
                                                      rain_mm_h=rain, lat=station["lat"], alt_km=station["alt_m"] / 1000)
    return out


def _window_rows(start: pd.Timestamp, end: pd.Timestamp, tles: dict, step_s: int, horizon_s: int, min_el: float,
                 rng: np.random.Generator, seed: int) -> list[pd.DataFrame]:
    env = Environment(start, end, "archive", seed)
    times = pd.date_range(start, end, freq=f"{step_s}s", tz="UTC")
    sun = sun_ecef_unit(times)
    h = horizon_s // step_s
    rows = []
    for sat in OBSERVERS:
        if sat not in tles:
            continue
        ecef = Orbit(sat, *tles[sat]).ecef(times)
        for st in STATIONS:
            _, el, rng_km, los = look_angles(ecef, st["lat"], st["lon"], st["alt_m"] / 1000)
            up = np.nan_to_num(el, nan=-90) >= min_el
            if not up.any():
                continue
            vals = env.at(st["id"], times)
            sun_sep = np.degrees(np.arccos(np.clip((los * sun).sum(1), -1, 1)))
            edges = np.diff(np.concatenate([[0], up.astype(int), [0]]))
            for a, b in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
                if b - a < 4:
                    continue
                sl = slice(a, b)
                v = {k: x[sl] for k, x in vals.items()}
                margins = channel_margins(st, rng_km[sl], el[sl], sun_sep[sl], v, rng)
                el_rate = np.gradient(el[sl]) * (60.0 / step_s)
                t_since = np.arange(b - a) * step_s / 60.0
                t_to = (b - a - 1 - np.arange(b - a)) * step_s / 60.0
                # прогноз погоды, который наземный ИИ №3 закладывает на борт перед пролётом (с ошибкой)
                fc_precip = np.maximum(v["precip"] * np.exp(rng.normal(0, 0.5)) + rng.normal(0, 0.1), 0)
                fc_cloud = np.clip(v["cloud_opt"] + rng.normal(0, 0.12), 0, 1)
                pass_id = f"{sat}|{st['id']}|{times[a]:%Y%m%d%H%M}"
                for ch, m in margins.items():
                    meas = m + rng.normal(0, 0.5, len(m))  # измеренный запас по пилот-тону (с шумом)
                    trend = np.concatenate([[0, 0], meas[2:] - meas[:-2]])
                    fut = np.array([m[i + 1:i + 1 + h].min() if i + 1 < len(m) else m[i] for i in range(len(m))])
                    valid = t_to >= horizon_s / 60.0  # плановый уход за горизонт — не «обрыв»
                    rows.append(pd.DataFrame({
                        "time": times[sl], "pass_id": pass_id, "satellite": sat, "station": st["id"], "channel": ch,
                        "el": el[sl], "el_rate": el_rate, "range_km": rng_km[sl], "t_since_aos": t_since,
                        "t_to_los": t_to, "max_el_pass": float(el[sl].max()), "sun_sep": sun_sep[sl],
                        "geomag_abs": abs(st["geomag_lat"]), "alt_km": st["alt_m"] / 1000, "fc_precip": fc_precip,
                        "fc_cloud": fc_cloud, "rh": v["rh"], "kp": v["kp"],
                        "log_xray": np.log10(np.maximum(v["xray"], 1e-9)), "f107": v["f107"],
                        "margin_now": meas, "margin_trend": trend, "margin_true": m,
                        "outage_next": (fut < 0).astype(np.int8),
                    })[valid])
    return rows


def simulate_dataset(days: int = 10, step_s: int = 30, end: pd.Timestamp | None = None, seed: int = 0,
                     horizon_s: int = 300, min_el: float = 5.0, include_storms: bool = True) -> pd.DataFrame:
    """Строки «спутник × станция × канал × момент» с признаками и меткой outage_next (5 мин)."""
    rng = np.random.default_rng(seed)
    end = end or pd.Timestamp(datetime.now(timezone.utc) - timedelta(days=6)).floor("h")
    windows = [(end - pd.Timedelta(days=days), end)]
    if include_storms:
        windows += [(pd.Timestamp(a, tz="UTC"), pd.Timestamp(b, tz="UTC")) for a, b in STORM_WINDOWS]
    tles = celestrak.fetch_all(roles=("observer",))
    rows = []
    for i, (a, b) in enumerate(windows):
        log.info("link sim window %s .. %s", a, b)
        rows += _window_rows(a, b, tles, step_s, horizon_s, min_el, rng, seed + i)
    data = pd.concat(rows, ignore_index=True)
    for ch in CHANNELS:
        data[f"ch_{ch}"] = (data["channel"] == ch).astype(np.float32)
    log.info("link dataset: %d rows, outage rate %.3f (%s), max Kp %.1f", len(data), data["outage_next"].mean(),
             data.groupby("channel")["outage_next"].mean().round(3).to_dict(), data["kp"].max())
    return data
