"""Три спутника на реальных орбитах и их «разговор» — демонстрация ИИ №2.

Terra, Aqua и Suomi NPP (элементы CelesTrak → SGP4) летят над реальными наземными станциями. Каждые 30 с
у каждого спутника решается, куда отправлять данные. Как в идее проекта, данные двух видов:

  * большие (снимки) — только по быстрым каналам: X, Ka или лазер;
  * тревоги по 24 байта — по любому живому каналу, в том числе резервному радио S-диапазона.

Действия:
  DOWNLINK  — быстрый канал к станции здоров: сбрасываем данные сами;
  HANDOFF   — быстрый канал скоро пропадёт: станция уйдёт за горизонт меньше чем через 3 мин (точно
              известно из орбиты) или ИИ №2 предсказывает обрыв (ливень, облака, мерцания; p ≥ 0,5).
              Спутник заранее отдаёт большие данные соседу по лазерной межспутниковой линии;
  RELAY     — сосед со здоровым каналом принимает чужие данные и сбрасывает их вместе со своими;
  ALERTS    — быстрых каналов и соседей нет, но резервное радио S-диапазона живо: уходят только тревоги;
  STORE     — связи нет совсем: всё копится на борту до следующего окна.

Межспутниковая линия возможна, если спутники видят друг друга (луч не ниже 120 км над Землёй) и до соседа
не больше 6000 км — дальность лазерных линий нынешних группировок.
"""

from __future__ import annotations

import time
from functools import lru_cache

import numpy as np
import pandas as pd

from ..apis import celestrak
from ..utils import get_logger
from . import physics
from .link_sim import Environment, channel_margins
from .orbits import Orbit, look_angles, sun_ecef_unit
from .stations import STATIONS

log = get_logger("helios.constellation")

SATS = ["TERRA", "AQUA", "SUOMI NPP"]
HANDOFF_MIN = 3.0
P_OUT = 0.5
ISL_MAX_KM = 6000.0
GRAZE_KM = 120.0
R_E = 6371.0
MIN_EL = 5.0
BULK = ("X", "Ka", "OPT")
PRODUCE_MBPS = {"TERRA": 10.6, "AQUA": 10.6, "SUOMI NPP": 15.0}  # MODIS ~10,6 Мбит/с, VIIRS ~15
ISL_MBPS = 1200.0
ACTIONS = {"STORE": 0, "DOWNLINK": 1, "HANDOFF": 2, "RELAY": 3, "ALERTS": 4}


def _ai2(feat: pd.DataFrame) -> np.ndarray:
    try:
        from ..models.link_ai import predict

        return predict(feat)
    except Exception:  # модель не обучена — оценка по запасу линии
        return 1 / (1 + np.exp(feat["margin_now"].to_numpy() - 1.0))


def _isl_visible(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Луч между спутниками не задевает Землю (+120 км атмосферы) и короче ISL_MAX_KM."""
    d = b - a
    dist = np.linalg.norm(d, axis=1)
    t = np.clip(-(a * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
    closest = np.linalg.norm(a + d * t[:, None], axis=1)
    return (closest > R_E + GRAZE_KM) & (dist <= ISL_MAX_KM), dist


def _shown_station(c: dict, action: int, t: int) -> int:
    """Станция, с которой спутник реально на связи: для тревог — та, где живо резервное радио."""
    return int(c["alert_st"][t]) if action == ACTIONS["ALERTS"] else int(c["st"][t])


def _features(st: dict, el, rng_km, sun_sep, v: dict, m, ttl, step_s: int, ch: str) -> pd.DataFrame:
    n = len(el)
    return pd.DataFrame({
        "el": el, "el_rate": np.gradient(el) * (60.0 / step_s) if n > 1 else np.zeros(n), "range_km": rng_km,
        "t_since_aos": np.arange(n) * step_s / 60, "t_to_los": ttl, "max_el_pass": float(el.max()),
        "sun_sep": sun_sep, "geomag_abs": abs(st["geomag_lat"]), "alt_km": st["alt_m"] / 1000,
        "fc_precip": v["precip"], "fc_cloud": v["cloud_opt"], "rh": v["rh"], "kp": v["kp"],
        "log_xray": np.log10(np.maximum(v["xray"], 1e-9)), "f107": v["f107"], "margin_now": m,
        "margin_trend": np.concatenate([[0, 0], m[2:] - m[:-2]]) if n > 2 else np.zeros(n),
        **{f"ch_{c}": float(c == ch) for c in ("S", "X", "Ka", "OPT")},
    })


@lru_cache(maxsize=32)
def _simulate_cached(start_key: str, minutes: int, step_s: int, storm: str | None = None) -> dict:
    start = pd.Timestamp(start_key)
    end = start + pd.Timedelta(minutes=minutes)
    times = pd.date_range(start, end, freq=f"{step_s}s")
    T = len(times)
    stations = [s for s in STATIONS if "условн" not in s["name"]]
    tles = celestrak.fetch_all()
    sats = [s for s in SATS if s in tles]
    env = Environment(start, end, mode="forecast")
    sun = sun_ecef_unit(times)
    ecef = {s: Orbit(s, *tles[s]).ecef(times) for s in sats}
    contact = {s: {"st": np.full(T, -1), "el": np.full(T, -90.0), "p": np.ones(T), "ttl": np.zeros(T),
                   "rate": np.zeros(T), "ch": np.array([""] * T, dtype=object), "alert_ok": np.zeros(T, bool),
                   "alert_st": np.full(T, -1), "alert_p": np.ones(T), "storm": np.zeros(T, bool)} for s in sats}
    for s in sats:
        for j, st in enumerate(stations):
            _, el, rng_km, los = look_angles(ecef[s], st["lat"], st["lon"], st["alt_m"] / 1000)
            el = np.nan_to_num(el, nan=-90)
            up = el >= MIN_EL
            if not up.any():
                continue
            vals = env.at(st["id"], times)
            stormy = bool(storm and st["id"] == storm)
            if stormy:  # «что если»: гроза над станцией — ливень 30 мм/ч, сплошная облачность
                vals = {**vals, "precip": np.full(T, 30.0), "cloud": np.ones(T), "cloud_opt": np.ones(T),
                        "rh": np.full(T, 98.0)}
            sun_sep = np.degrees(np.arccos(np.clip((los * sun).sum(1), -1, 1)))
            edges = np.diff(np.concatenate([[0], up.astype(int), [0]]))
            for a, b in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
                sl = slice(a, b)
                n = b - a
                v = {k: x[sl] for k, x in vals.items()}
                margins = channel_margins(st, rng_km[sl], el[sl], sun_sep[sl], v, None, stochastic=False)
                ttl = (n - 1 - np.arange(n)) * step_s / 60  # точно из орбиты: минут до ухода за горизонт
                best_p, best_rate = np.ones(n), np.zeros(n)
                best_ch = np.array([""] * n, dtype=object)
                alert_ok = np.zeros(n, bool)
                alert_p = np.ones(n)
                for ch, m in margins.items():
                    p = np.where(m > 0, _ai2(_features(st, el[sl], rng_km[sl], sun_sep[sl], v, m, ttl, step_s, ch)), 1.0)
                    ok = ((m + physics.alert_gain_db(ch)) > 0) & (p < P_OUT)
                    alert_ok |= ok
                    alert_p = np.where(ok & (p < alert_p), p, alert_p)
                    if ch not in BULK:
                        continue
                    rate = physics.OPTICAL["rate_bps"] if ch == "OPT" else physics.RF_CHANNELS[ch]["rate_bps"]
                    better = p < best_p - 1e-9
                    best_p = np.where(better, p, best_p)
                    best_ch = np.where(better, ch, best_ch)
                    best_rate = np.where(better, rate / 1e6, best_rate)
                c = contact[s]
                # из станций в зоне — та, где быстрый канал надёжнее, при равенстве — выше над горизонтом
                take = (best_p + (90 - el[sl]) / 1000) < (c["p"][sl] + (90 - c["el"][sl]) / 1000)
                idx = np.arange(a, b)[take]
                for key, val in (("st", j), ("el", el[sl][take]), ("p", best_p[take]), ("ttl", ttl[take]),
                                 ("rate", best_rate[take]), ("ch", best_ch[take]), ("storm", stormy)):
                    c[key][idx] = val
                c["alert_ok"][np.arange(a, b)] |= alert_ok
                # тревоги уходят туда, где живо резервное радио (не обязательно на станцию быстрого канала)
                better = alert_ok & (alert_p < c["alert_p"][sl])
                c["alert_p"][np.arange(a, b)[better]] = alert_p[better]
                c["alert_st"][np.arange(a, b)[better]] = j
    pairs = {}
    for i in range(len(sats)):
        for k in range(i + 1, len(sats)):
            vis, dist = _isl_visible(ecef[sats[i]], ecef[sats[k]])
            pairs[(i, k)] = pairs[(k, i)] = (vis, dist)

    queue = np.zeros(len(sats))
    act = np.zeros((len(sats), T), np.int8)
    partner = np.full((len(sats), T), -1, np.int8)
    qlog = np.zeros((len(sats), T), np.float32)
    direct_mb = relayed_mb = 0.0
    events, prev = [], [(-1, -1, -1)] * len(sats)
    reasons = {"los": 0, "ai2": 0, "no_station": 0}
    for t in range(T):
        queue += np.array([PRODUCE_MBPS[s] for s in sats]) * step_s / 8
        healthy = [contact[s]["st"][t] >= 0 and contact[s]["p"][t] < P_OUT and contact[s]["ttl"][t] >= HANDOFF_MIN
                   for s in sats]
        reason_t = [None] * len(sats)
        for i, s in enumerate(sats):
            c = contact[s]
            if healthy[i]:
                act[i, t] = ACTIONS["DOWNLINK"]
                continue
            best, best_ttl = -1, -1.0
            for k in range(len(sats)):
                if k != i and healthy[k] and pairs[(i, k)][0][t] and contact[sats[k]]["ttl"][t] > best_ttl:
                    best, best_ttl = k, contact[sats[k]]["ttl"][t]
            if best >= 0 and queue[i] > 0:
                act[i, t] = ACTIONS["HANDOFF"]
                partner[i, t] = best
                partner[best, t] = i
                moved = min(queue[i], ISL_MBPS * step_s / 8)
                queue[i] -= moved
                queue[best] += moved
                relayed_mb += moved
                if c["st"][t] < 0:
                    reason_t[i] = "no_station"
                elif c["p"][t] >= P_OUT:
                    reason_t[i] = "ai2"
                else:
                    reason_t[i] = "los"
            elif c["st"][t] >= 0 and c["p"][t] < 0.95:
                act[i, t] = ACTIONS["DOWNLINK"]  # соседа нет — качаем, пока канал хоть как-то жив
            elif c["alert_ok"][t]:
                act[i, t] = ACTIONS["ALERTS"]    # только тревоги по резервному радио
            else:
                act[i, t] = ACTIONS["STORE"]
        for i, s in enumerate(sats):
            if act[i, t] == ACTIONS["DOWNLINK"] and partner[i, t] >= 0:
                act[i, t] = ACTIONS["RELAY"]
            if act[i, t] in (ACTIONS["DOWNLINK"], ACTIONS["RELAY"]):
                sent = min(queue[i], contact[s]["rate"][t] * step_s / 8)
                queue[i] -= sent
                direct_mb += sent
            qlog[i, t] = queue[i]
            state = (int(act[i, t]), int(partner[i, t]), _shown_station(contact[s], int(act[i, t]), t))
            if state != prev[i]:
                c = contact[s]
                if reason_t[i]:
                    reasons[reason_t[i]] += 1
                events.append({"t": int(t), "sat": i, "action": int(act[i, t]), "partner": int(partner[i, t]),
                               "station": state[2], "channel": str(c["ch"][t]), "p_out": round(float(c["p"][t]), 3),
                               "ttl_min": round(float(c["ttl"][t]), 1), "reason": reason_t[i], "storm": bool(c["storm"][t])})
                prev[i] = state
    tracks = {}
    for s in sats:
        la, lo, alt = Orbit(s, *tles[s]).subpoint(times)
        tracks[s] = [[round(float(x), 3), round(float(y), 3), round(float(z), 1)] for y, x, z in zip(la, lo, alt)]
    states = [[[int(act[i, t]), int(partner[i, t]), _shown_station(contact[s], int(act[i, t]), t), round(float(contact[s]["p"][t]), 3),
                round(float(contact[s]["ttl"][t]), 1), round(float(qlog[i, t]), 1), str(contact[s]["ch"][t])]
               for t in range(T)] for i, s in enumerate(sats)]
    minutes_by = {k: {s: round(float((act[i] == v).sum()) * step_s / 60, 1) for i, s in enumerate(sats)} for k, v in ACTIONS.items()}
    return {
        "start": start.isoformat(), "step_s": step_s, "minutes": minutes, "storm": storm,
        "satellites": [{"name": s, "track": tracks[s]} for s in sats],
        "stations": [{"id": st["id"], "name": st["name"], "lat": st["lat"], "lon": st["lon"],
                      "kind": "optical" if st.get("kind") == "optical" else "radio"} for st in stations],
        "states_fields": ["action", "partner", "station", "p_out", "ttl_min", "queue_mb", "channel"],
        "actions": ACTIONS, "states": states, "events": events,
        "summary": {"minutes": minutes_by, "delivered_mb": round(direct_mb), "relayed_mb": round(relayed_mb),
                    "handoffs": reasons, "isl_max_km": ISL_MAX_KM, "handoff_min": HANDOFF_MIN, "p_out_threshold": P_OUT},
    }


def _changed(base: dict, other: dict) -> int:
    return sum(1 for i, lst in enumerate(other["states"]) for t, s in enumerate(lst) if s[0] != base["states"][i][t][0])


@lru_cache(maxsize=8)
def _best_storm_cached(start_key: str, minutes: int, step_s: int) -> str | None:
    """Станция, где гроза сильнее всего меняет решения ИИ №2 в этом окне (передачи соседу весят втрое).

    Полярные станции почти не страдают: слой дождя там тонкий (P.839), и X-канал выдерживает ливень —
    поэтому «гроза над самой загруженной станцией» часто ничего не меняет, и мы перебираем станции честно.
    """
    base = _simulate_cached(start_key, minutes, step_s, None)
    used = sorted({s[2] for lst in base["states"] for s in lst if s[0] in (1, 3) and s[2] >= 0})
    best, best_score = None, 0
    for j in used:
        sid = base["stations"][j]["id"]
        other = _simulate_cached(start_key, minutes, step_s, sid)
        score = _changed(base, other) + 3 * other["summary"]["handoffs"]["ai2"]
        if score > best_score:
            best, best_score = sid, score
    if best is None and used:
        best = base["stations"][used[0]]["id"]
    return best


def simulate(minutes: int = 120, step_s: int = 30, storm: str | None = None) -> dict:
    """Окно от текущих 10 минут (кэш). storm — id станции, над которой «включить грозу», или "auto"."""
    now = pd.Timestamp.now(tz="UTC").floor("10min")
    t0 = time.time()
    if storm == "auto":
        storm = _best_storm_cached(now.isoformat(), minutes, step_s)
    out = _simulate_cached(now.isoformat(), minutes, step_s, storm)
    log.info("созвездие: %d событий, %.1f с", len(out["events"]), time.time() - t0)
    return out
