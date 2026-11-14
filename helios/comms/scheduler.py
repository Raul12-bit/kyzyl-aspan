"""Predictive Connection Scheduler: куда и когда передавать данные в ближайшие часы.

Для каждого спутника: пролёты над станциями (SGP4), прогноз погоды над антеннами
(Open-Meteo), космическая погода сейчас (SWPC/GFZ) → физический запас каждого канала →
ИИ №2 оценивает риск обрыва → план: лучший канал на каждый пролёт, объём данных и
«окна без связи» (когда ни станция, ни ретранслятор недоступны) — их знаем заранее.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..apis import celestrak
from ..utils import get_logger
from . import physics
from .link_sim import OBSERVERS, Environment, channel_margins
from .orbits import Orbit, line_of_sight, look_angles, sun_ecef_unit
from .stations import STATIONS, optical_stations

log = get_logger("helios.scheduler")

# Условный ретранслятор на ГСО над Индийским океаном (как LCRD, но на 76° в.д.) — сценарий «что если»
HYPOTHETICAL_RELAY_LON = 76.0


def geo_ecef(lon_deg: float, n: int) -> np.ndarray:
    r = 42164.0
    return np.tile([r * np.cos(np.radians(lon_deg)), r * np.sin(np.radians(lon_deg)), 0.0], (n, 1))


def _ai2_probs(df: pd.DataFrame) -> np.ndarray:
    try:
        from ..models.link_ai import predict

        return predict(df)
    except Exception as exc:  # модель ещё не обучена — физика без ИИ
        log.info("AI#2 недоступен (%s): риск по запасу линии", exc)
        return 1 / (1 + np.exp(df["margin_now"].to_numpy() - 1.0))


def plan(hours: int = 24, start: pd.Timestamp | None = None, step_s: int = 30,
         include_hypothetical_relay: bool = True) -> dict:
    start = (start or pd.Timestamp.now(tz="UTC")).floor("min")
    end = start + pd.Timedelta(hours=hours)
    times = pd.date_range(start, end, freq=f"{step_s}s")
    env = Environment(start, end, mode="forecast")
    tles = celestrak.fetch_all()
    sun = sun_ecef_unit(times)
    pass_rows, gaps = [], []
    relays = {name: Orbit(name, *tles[name]).ecef(times) for name in ("STPSAT-6 (LCRD)", "TDRS 13") if name in tles}
    if include_hypothetical_relay:
        relays["GEO-76E (условный)"] = geo_ecef(HYPOTHETICAL_RELAY_LON, len(times))
    ogs_clear = np.max([1 - env.at(s["id"], times)["cloud_opt"] for s in optical_stations()], axis=0)
    for sat in OBSERVERS:
        if sat not in tles:
            continue
        ecef = Orbit(sat, *tles[sat]).ecef(times)
        any_link = np.zeros(len(times), dtype=bool)
        for st in STATIONS:
            _, el, rng_km, los = look_angles(ecef, st["lat"], st["lon"], st["alt_m"] / 1000)
            up = np.nan_to_num(el, nan=-90) >= 5.0
            if not up.any():
                continue
            vals = env.at(st["id"], times)
            sun_sep = np.degrees(np.arccos(np.clip((los * sun).sum(1), -1, 1)))
            edges = np.diff(np.concatenate([[0], up.astype(int), [0]]))
            for a, b in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
                sl = slice(a, b)
                v = {k: x[sl] for k, x in vals.items()}
                margins = channel_margins(st, rng_km[sl], el[sl], sun_sep[sl], v, None, stochastic=False)
                n = b - a
                best, best_score = None, -1.0
                row = {"satellite": sat, "station": st["id"], "station_name": st["name"], "aos": times[a],
                       "los": times[b - 1], "max_el": round(float(el[sl].max()), 1), "duration_min": round(n * step_s / 60, 1)}
                for ch, m in margins.items():
                    feat = pd.DataFrame({
                        "el": el[sl], "el_rate": np.gradient(el[sl]) * (60.0 / step_s), "range_km": rng_km[sl],
                        "t_since_aos": np.arange(n) * step_s / 60, "t_to_los": (n - 1 - np.arange(n)) * step_s / 60,
                        "max_el_pass": float(el[sl].max()), "sun_sep": sun_sep[sl], "geomag_abs": abs(st["geomag_lat"]),
                        "alt_km": st["alt_m"] / 1000, "fc_precip": v["precip"], "fc_cloud": v["cloud_opt"], "rh": v["rh"],
                        "kp": v["kp"], "log_xray": np.log10(np.maximum(v["xray"], 1e-9)), "f107": v["f107"],
                        "margin_now": m, "margin_trend": np.concatenate([[0, 0], m[2:] - m[:-2]]),
                        **{f"ch_{c}": float(c == ch) for c in ("S", "X", "Ka", "OPT")},
                    })
                    p_out = _ai2_probs(feat)
                    avail = (m > 0) * (1 - p_out)
                    rate = physics.OPTICAL["rate_bps"] if ch == "OPT" else physics.RF_CHANNELS[ch]["rate_bps"]
                    gb = float((avail * rate * step_s).sum() / 8e9)
                    row[f"{ch}_availability"] = round(float(avail.mean()), 3)
                    row[f"{ch}_volume_gb"] = round(gb, 2)
                    alert_ok = (m + physics.alert_gain_db(ch)) > 0
                    any_link[sl] |= alert_ok
                    if gb > best_score:
                        best, best_score = ch, gb
                row["recommended_channel"] = best
                row["expected_volume_gb"] = round(best_score, 2)
                pass_rows.append(row)
        relay_cov, real_ok, all_ok = {}, np.zeros(len(times), bool), np.zeros(len(times), bool)
        for rname, recef in relays.items():
            vis = line_of_sight(ecef, recef)
            # лазерный ретранслятор полезен, только если на Земле хотя бы одна оптическая станция без облаков
            ok = vis & (ogs_clear > 0.5) if "LCRD" in rname or "условный" in rname else vis
            relay_cov[rname] = round(float(ok.mean()), 3)
            all_ok |= ok
            if "условный" not in rname:
                real_ok |= ok

        def _gaps(link: np.ndarray) -> tuple[float, list]:
            down = ~link
            e = np.diff(np.concatenate([[0], down.astype(int), [0]]))
            segs = [(times[a], times[b - 1], (b - a) * step_s / 60) for a, b in zip(np.flatnonzero(e == 1), np.flatnonzero(e == -1))]
            return round(float(down.sum() * step_s / 60), 1), segs

        ground_min, segs = _gaps(any_link)          # реалистично: только наземные станции
        real_min, real_segs = _gaps(any_link | real_ok)
        all_min, _ = _gaps(any_link | all_ok)
        gaps.append({
            "satellite": sat, "hours": hours,
            "minutes_without_any_link": ground_min,
            "longest_gap_min": round(max((s[2] for s in segs), default=0.0), 1),
            "next_gap_start": segs[0][0] if segs else None, "next_gap_end": segs[0][1] if segs else None,
            "minutes_without_link_with_real_relays": real_min,
            "minutes_without_link_with_relay_76E": all_min,
            "relay_coverage": relay_cov,
            "gaps": [{"start": str(a), "end": str(b), "minutes": round(m, 1)} for a, b, m in segs[:60]],
        })
    passes = pd.DataFrame(pass_rows).sort_values("aos").reset_index(drop=True) if pass_rows else pd.DataFrame()
    return {"start": start, "end": end, "passes": passes, "blackouts": gaps}
