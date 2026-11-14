"""Smart Alert Delivery + Collaborative Satellite Alert Network (симуляция на реальном пожарном дне).

1. Берём реальный день 2025 г. с максимумом пожаров в регионе (архив FIRMS).
2. ИИ №1 на «борту» оценивает каждое обнаружение → пакеты тревоги по приоритетам.
3. Сравниваем, когда тревога окажется на Земле:
   A. Как сейчас (NRT FIRMS/LANCE): реальная медианная задержка гранул по NASA CMR.
   B. ИИ на борту + «сохранить и передать» на ближайшую станцию сети (короткий пакет).
   C. B + станции прямого приёма в Казахстане (условные Астана/Алматы).
   D. B + ретранслятор на ГСО (реальные LCRD/TDRS + условный узел 76° в.д.).
4. Сеть спутников: для КРИТИЧНЫХ тревог ищем, какой спутник следующим пролетит над очагом,
   и проверяем по реальным данным, подтвердил ли он пожар.

Геометрия связи считается по текущим TLE: для каждого пролёта находим ближайший «такой же»
пролёт того же спутника над тем же местом сейчас — так положение спутника над очагом в момент
съёмки физически верное, а погода у станций — сегодняшний прогноз.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..apis import celestrak
from ..apis.celestrak import STREAM_TO_SAT
from ..config import PROCESSED, REPORTS_DIR
from ..utils import get_logger, save_json
from . import physics
from .link_sim import Environment, channel_margins
from .orbits import HALF_SWATH_KM, Orbit, haversine_km, line_of_sight, look_angles, next_overpass, sun_ecef_unit
from .scheduler import HYPOTHETICAL_RELAY_LON, geo_ecef
from .stations import STATIONS, optical_stations

log = get_logger("helios.delivery")

NASA_NETWORK = {"SVALSAT", "TROLLSAT", "MCMURDO", "FAIRBANKS", "WALLOPS", "WHITE_SANDS"}
KZ_DB = {"ASTANA_DB", "ALMATY_DB", "OGS_ASSY_TURGEN"}  # условные станции в Казахстане
REAL_RELAYS = ("STPSAT-6 (LCRD)", "TDRS 13")
DEFAULT_NRT_LATENCY_MIN = {"MODIS_T": 150.0, "MODIS_A": 150.0, "VIIRS_SNPP": 150.0, "VIIRS_NOAA20": 120.0, "VIIRS_NOAA21": 120.0}


def replay_day(det: pd.DataFrame, year: int = 2025) -> pd.Timestamp:
    k = det[det["keep_veg"] & (det["acq_dt"].dt.year == year)]
    day = k["acq_dt"].dt.floor("D").value_counts().idxmax()
    return day


def measured_nrt_latency() -> dict:
    try:
        from ..apis.earthdata import granule_latency

        lat = granule_latency(hours=48)
        if len(lat):
            return lat.groupby("stream")["latency_min"].median().round(1).to_dict()
    except Exception as exc:
        log.info("CMR latency: %s", exc)
    return {}


def _first_contact(sat_ecef: np.ndarray, times: pd.DatetimeIndex, stations: list[dict], env: Environment, sun: np.ndarray):
    """Первый момент (индекс) и станция, когда короткий пакет проходит (запас в режиме тревоги > 0)."""
    best_i, best_st, best_ch = None, None, None
    for st in stations:
        _, el, rng_km, los = look_angles(sat_ecef, st["lat"], st["lon"], st["alt_m"] / 1000)
        up = np.flatnonzero(np.nan_to_num(el, nan=-90) >= 5.0)
        if len(up) == 0 or (best_i is not None and up[0] >= best_i):
            continue
        v = env.at(st["id"], times[up])
        sun_sep = np.degrees(np.arccos(np.clip((los[up] * sun[up]).sum(1), -1, 1)))
        margins = channel_margins(st, rng_km[up], el[up], sun_sep, v, None, stochastic=False)
        for ch, m in margins.items():
            ok = np.flatnonzero(m + physics.alert_gain_db(ch) > 0)
            if len(ok) and (best_i is None or up[ok[0]] < best_i):
                best_i, best_st, best_ch = int(up[ok[0]]), st["id"], ch
    return best_i, best_st, best_ch


def run_delivery_simulation(year: int = 2025, horizon_h: int = 6, step_s: int = 20) -> dict:
    from ..models import edge_detector

    det = pd.read_parquet(PROCESSED / "detections_filtered.parquet")
    day = replay_day(det, year)
    day_det = det[(det["acq_dt"] >= day) & (det["acq_dt"] < day + pd.Timedelta(days=1))].reset_index(drop=True)
    scored = edge_detector.score_detections(day_det)
    alerts = edge_detector.make_alerts(scored, min_priority="ROUTINE")
    log.info("replay day %s: %d detections -> %d alerts", day.date(), len(day_det), len(alerts))
    tles = celestrak.fetch_all()
    now = pd.Timestamp.now(tz="UTC").floor("min")
    env = Environment(now, now + pd.Timedelta(hours=36), mode="forecast")
    nrt_lat = {**DEFAULT_NRT_LATENCY_MIN, **measured_nrt_latency()}
    ogs = [s for s in optical_stations() if s["real"]]  # реальные OGS: Table Mountain, Haleakalā, Tenerife
    rows = []
    for (stream, overpass), grp in alerts.groupby(["stream", "overpass"], observed=True):
        sat = STREAM_TO_SAT.get(str(stream))
        if sat not in tles:
            continue
        orbit = Orbit(sat, *tles[sat])
        lat0, lon0 = float(grp["lat"].mean()), float(grp["lon"].mean())
        sensor = "MODIS" if str(stream).startswith("MODIS") else "VIIRS"
        # тот же спутник над тем же местом, в ближайшие сутки (с той же стороны суток: день/ночь)
        t0 = next_overpass(orbit, lat0, lon0, now, horizon_h=24, half_swath_km=HALF_SWATH_KM[sensor])
        if t0 is None:
            continue
        times = pd.date_range(t0, t0 + pd.Timedelta(hours=horizon_h), freq=f"{step_s}s")
        ecef = orbit.ecef(times)
        sun = sun_ecef_unit(times)
        nasa = [s for s in STATIONS if s["id"] in NASA_NETWORK]
        kz = [s for s in STATIONS if s["id"] in KZ_DB]
        iB, stB, chB = _first_contact(ecef, times, nasa + ogs, env, sun)
        iC, stC, chC = _first_contact(ecef, times, nasa + ogs + kz, env, sun)
        # ретрансляторы на ГСО: прямая видимость LEO→ГСО (+ для лазерного — ясное небо у какой-либо OGS)
        clear = np.max([1 - env.at(s["id"], times)["cloud_opt"] for s in ogs], axis=0)
        relays = {n: Orbit(n, *tles[n]).ecef(times) for n in REAL_RELAYS if n in tles}
        relays["GEO-76E (условный)"] = geo_ecef(HYPOTHETICAL_RELAY_LON, len(times))
        first_relay = {}
        for rname, recef in relays.items():
            vis = line_of_sight(ecef, recef)
            ok = vis & (clear > 0.5) if rname != "TDRS 13" else vis
            idx = np.flatnonzero(ok)
            if len(idx):
                first_relay[rname] = int(idx[0])
        lat_B = (iB * step_s / 60 if iB is not None else horizon_h * 60) + 1 / 60
        lat_C = (iC * step_s / 60 if iC is not None else horizon_h * 60) + 1 / 60
        real = {k: v for k, v in first_relay.items() if k in REAL_RELAYS}
        r1 = min(real.items(), key=lambda kv: kv[1]) if real else (None, None)
        r2 = min(first_relay.items(), key=lambda kv: kv[1]) if first_relay else (None, None)
        lat_D1 = min(lat_B, r1[1] * step_s / 60 + 0.5 / 60) if r1[1] is not None else lat_B
        lat_D2 = min(lat_B, r2[1] * step_s / 60 + 0.5 / 60) if r2[1] is not None else lat_B
        for _, a in grp.iterrows():
            rows.append({
                "alert_id": a["alert_id"], "priority": a["priority"], "stream": str(stream), "lat": a["lat"], "lon": a["lon"],
                "acq_dt": a["acq_dt"], "t0_equiv": t0, "frp_sum": a["frp_sum"], "cluster_n": a["cluster_n"],
                "p_real": a["p_real"], "p_escalation": a["p_escalation"], "packet_hex": a["packet_hex"],
                "latency_A_nrt_min": nrt_lat.get(str(stream), 150.0),
                "latency_B_storeforward_min": round(lat_B, 2), "station_B": stB, "channel_B": chB,
                "latency_C_kz_station_min": round(lat_C, 2), "station_C": stC, "channel_C": chC,
                "latency_D1_real_relay_min": round(lat_D1, 2), "relay_D1": r1[0] if lat_D1 < lat_B else stB,
                "latency_D2_relay_76E_min": round(lat_D2, 2), "relay_D2": r2[0] if lat_D2 < lat_B else stB,
            })
    out = pd.DataFrame(rows)
    if out.empty:
        return {"alerts": 0}
    window = det[(det["acq_dt"] >= day) & (det["acq_dt"] < day + pd.Timedelta(days=2))]
    out = collaborative_verification(out, window, tles, now)
    out.to_parquet(PROCESSED / "delivery_alerts.parquet", index=False)

    def stats(col: str, sub: pd.DataFrame) -> dict:
        s = sub[col]
        return {"median_min": round(float(s.median()), 2), "p90_min": round(float(s.quantile(0.9)), 2),
                "share_within_15min": round(float((s <= 15).mean()), 3), "share_within_60min": round(float((s <= 60).mean()), 3)}

    summary = {"replay_day": str(day.date()), "detections": int(len(day_det)), "alerts": int(len(out)),
               "alerts_by_priority": out["priority"].value_counts().to_dict(), "strategies": {}}
    for name, col in (("A_today_nrt", "latency_A_nrt_min"), ("B_onboard_ai_store_forward", "latency_B_storeforward_min"),
                      ("C_plus_kz_direct_stations", "latency_C_kz_station_min"),
                      ("D1_plus_real_geo_relays", "latency_D1_real_relay_min"),
                      ("D2_plus_geo_relay_76E", "latency_D2_relay_76E_min")):
        summary["strategies"][name] = {"all": stats(col, out),
                                       "critical": stats(col, out[out["priority"] == "CRITICAL"]) if (out["priority"] == "CRITICAL").any() else None}
    crit = out[out["priority"] == "CRITICAL"]
    summary["collaborative_network"] = {
        "critical_alerts": int(len(crit)),
        "confirmed_by_other_satellite_12h": round(float(crit["confirmed"].mean()), 3) if len(crit) else None,
        "median_minutes_to_next_look": round(float(crit["next_look_min"].median()), 1) if len(crit) else None,
        "median_minutes_to_confirmation": round(float(crit.loc[crit["confirmed"], "confirm_delay_min"].median()), 1)
        if len(crit) and crit["confirmed"].any() else None,
    }
    save_json(summary, REPORTS_DIR / "delivery_summary.json")
    log.info("delivery: %s", summary)
    return summary


def collaborative_verification(alerts: pd.DataFrame, det: pd.DataFrame, tles: dict, now: pd.Timestamp) -> pd.DataFrame:
    """Для каждой тревоги: какой спутник посмотрит следующим и подтвердили ли пожар реальные данные."""
    kept = det[det["keep_veg"]][["lat", "lon", "acq_dt", "stream"]]
    out = alerts.copy()
    out["confirmed"] = False
    out["confirm_stream"] = None
    out["confirm_delay_min"] = np.nan
    out["next_look_sat"] = None
    out["next_look_min"] = np.nan
    for i, a in out.iterrows():
        win = kept[(kept["acq_dt"] > a["acq_dt"] + pd.Timedelta(minutes=10)) &
                   (kept["acq_dt"] <= a["acq_dt"] + pd.Timedelta(hours=12)) & (kept["stream"].astype(str) != a["stream"])]
        if len(win):
            d = haversine_km(win["lat"].to_numpy(), win["lon"].to_numpy(), a["lat"], a["lon"])
            near = win[d <= 5.0]
            if len(near):
                first = near.sort_values("acq_dt").iloc[0]
                out.at[i, "confirmed"] = True
                out.at[i, "confirm_stream"] = str(first["stream"])
                out.at[i, "confirm_delay_min"] = round((first["acq_dt"] - a["acq_dt"]).total_seconds() / 60, 1)
        if a["priority"] == "CRITICAL":
            best = None
            t_ref = a["t0_equiv"] + pd.Timedelta(minutes=10)
            for stream, sat in STREAM_TO_SAT.items():
                if stream == a["stream"] or sat not in tles:
                    continue
                t = next_overpass(Orbit(sat, *tles[sat]), a["lat"], a["lon"], t_ref, horizon_h=12,
                                  half_swath_km=HALF_SWATH_KM["MODIS" if stream.startswith("MODIS") else "VIIRS"], step_s=60)
                if t is not None and (best is None or t < best[1]):
                    best = (sat, t)
            if best:
                out.at[i, "next_look_sat"] = best[0]
                out.at[i, "next_look_min"] = round((best[1] - a["t0_equiv"]).total_seconds() / 60, 1)
    return out
