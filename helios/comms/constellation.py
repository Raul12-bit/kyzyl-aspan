"""Пять спутников на реальных орбитах — когда оборвётся связь и когда снимки окажутся на Земле.

Спутники НЕ модернизируем: ни межспутникового лазера, ни новой бортовой программы. Всё решают орбитальная
механика (SGP4 по элементам CelesTrak), физика радиолинии (запас канала по ITU-R) и прогноз погоды над
антеннами (Open-Meteo). Каждый спутник летает так, как работает на самом деле (NASA/NOAA, ноябрь 2026 г.):

  * Terra      — прямое вещание выключено 11.05.2024 (не хватает мощности батарей); данные идут через
                 ретрансляторы TDRS на станцию White Sands. Три TDRS (11, 12, 13) видят Terra всё время;
  * Aqua       — сброс накопленных данных на Шпицбергене и в Покер-Флэт (Аляска); прямое вещание MODIS
                 (X, 15 Мбит/с) идёт постоянно, но на время сброса приостанавливается;
  * NOAA-20/21 — сброс на Шпицбергене и в Мак-Мердо (Антарктида), резерв — Тролль; прямое вещание VIIRS
                 (HRD, X, 15 Мбит/с) идёт непрерывно;
  * Suomi NPP  — NOAA прекратила выдачу его данных 02.11.2026; орбита показана, в итоговую статистику
                 он не входит (`retired`).

Что считается для каждого спутника каждые 30 с:

  1. Когда оборвётся связь (`forecast`): уход станции за горизонт известен точно из орбиты; раньше канал может
     оборвать погода — запас линии считается по прогнозу осадков и облачности над антенной, а риск обрыва в
     ближайшие 5 минут = нейросеть ИИ №2 + физическая поправка (нейросеть училась почти без дождя и сама ливень
     недооценивает). Если связи нет — через сколько минут и с какой станцией она появится. Станция «на
     обслуживании» (как Мак-Мердо в ноябре 2026 г.) не принимает вовсе.
  2. Когда снятое сейчас окажется на Земле (`delivery`): данные лежат на борту до ближайшего сеанса со своей
     станцией (store-and-forward). Быстрее — только прямое вещание: его в реальном времени принимает любая
     антенна, которая видит спутник. Сценарий `db`: своя станция приёма в Астане (антенна 3 м, X-диапазон) —
     с высоты 700–830 км она видит спутник над всем Казахстаном. Это наземное оборудование, спутники те же.
  3. Пожар в регионе проекта (`region`): какие пролёты в окне снимут Казахстан, когда их данные будут на Земле
     и какой спутник принесёт сведения первым. Если связь у одного спутника пропала, сведения о том же пожаре
     доставит следующий пролёт другого — «эстафета» по времени, без связи между спутниками.
"""

from __future__ import annotations

import time
from functools import lru_cache

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

from ..apis import celestrak
from ..config import settings
from ..utils import get_logger
from . import physics
from .link_sim import Environment, channel_margins
from .orbits import HALF_SWATH_KM, Orbit, haversine_km, line_of_sight, look_angles, sun_ecef_unit
from .stations import BY_ID

log = get_logger("helios.constellation")

SATS = ["TERRA", "AQUA", "SUOMI NPP", "NOAA 20", "NOAA 21"]
SENSOR = {"TERRA": "MODIS", "AQUA": "MODIS", "SUOMI NPP": "VIIRS", "NOAA 20": "VIIRS", "NOAA 21": "VIIRS"}
# Реальный наземный сегмент каждого спутника (см. описание модуля)
ACCESS: dict[str, tuple[str, ...]] = {
    "TERRA": (),
    "AQUA": ("SVALSAT", "POKER_FLAT"),
    "SUOMI NPP": ("SVALSAT", "MCMURDO", "TROLLSAT"),
    "NOAA 20": ("SVALSAT", "MCMURDO", "TROLLSAT"),
    "NOAA 21": ("SVALSAT", "MCMURDO", "TROLLSAT"),
}
VIA_TDRS = {"TERRA"}
TDRS = ("TDRS 11", "TDRS 12", "TDRS 13")
TDRS_GROUND = "WHITE_SANDS"
TDRS_MBPS = 150.0  # обратный канал Terra через TDRSS (Ku)
DIRECT_BROADCAST = {"AQUA", "SUOMI NPP", "NOAA 20", "NOAA 21"}  # у Terra выключено с 11.05.2024
PAUSES_BROADCAST_WHILE_DUMPING = {"AQUA"}
DB_STATION = "ASTANA_DB"
DB_MBPS = 15.0  # прямое вещание MODIS и VIIRS HRD
RETIRED = {"SUOMI NPP": "2026-11-02"}
STATION_ORDER = ("SVALSAT", "POKER_FLAT", "TROLLSAT", "MCMURDO", TDRS_GROUND)

P_OUT = 0.5
MIN_EL = 5.0
LOOKAHEAD_MIN = 5.0  # горизонт прогноза риска обрыва
PRODUCE_MBPS = {"TERRA": 10.6, "AQUA": 10.6, "SUOMI NPP": 15.0, "NOAA 20": 15.0, "NOAA 21": 15.0}  # MODIS / VIIRS
ACTIONS = {"STORE": 0, "DOWNLINK": 1, "BROADCAST": 5}
INF = 10 ** 9


# ----------------------------------------------------------------------------- риск обрыва канала
def _ai2(feat: pd.DataFrame) -> np.ndarray:
    try:
        from ..models.link_ai import predict

        return predict(feat)
    except Exception:  # модель не обучена — оценка по запасу линии
        return 1 / (1 + np.exp(feat["margin_now"].to_numpy() - 1.0))


def forward_min(x: np.ndarray, h: int) -> np.ndarray:
    """Минимум x на следующих h шагах (t+1 … t+h); на краю — последнее значение."""
    if len(x) == 0:
        return x
    pad = np.concatenate([x[1:], np.full(h, x[-1])])
    return sliding_window_view(pad, h).min(axis=1)[: len(x)]


def outage_risk(p_ai: np.ndarray, margin_db: np.ndarray, step_s: int, horizon_min: float = LOOKAHEAD_MIN) -> np.ndarray:
    """Вероятность обрыва в ближайшие horizon_min минут: нейросеть ИИ №2 + физика по прогнозу погоды.

    Нейросеть обучена на станциях, где дождя почти не бывает (среднее 0,09 мм/ч), и при ливне ошибочно снижает
    риск. Физическая поправка этого не допускает: если прогнозный запас линии (дождь, облака, угол места по
    орбите) в ближайшие минуты падает к нулю, риск растёт до 1 — монотонно, как и должно быть.
    """
    h = max(1, int(round(horizon_min * 60 / step_s)))
    p_phys = 1.0 / (1.0 + np.exp((forward_min(margin_db, h) - 1.0) / 0.7))
    return 1.0 - (1.0 - np.asarray(p_ai, dtype=float)) * (1.0 - p_phys)


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


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    edges = np.diff(np.concatenate([[0], mask.astype(int), [0]]))
    return list(zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))


# ----------------------------------------------------------------------------- чистая математика окна
def link_forecast(ok: np.ndarray, step_s: int) -> tuple[np.ndarray, np.ndarray]:
    """Для каждого шага: через сколько минут связь оборвётся (если она есть) и через сколько появится (если нет).

    NaN — изменение не наступает до конца окна. Событие наступает на шаге t + минуты·60/step_s.
    """
    T = len(ok)
    nxt_false = np.full(T + 1, INF, dtype=np.int64)
    nxt_true = np.full(T + 1, INF, dtype=np.int64)
    for t in range(T - 1, -1, -1):
        nxt_false[t] = t if not ok[t] else nxt_false[t + 1]
        nxt_true[t] = t if ok[t] else nxt_true[t + 1]
    idx = np.arange(T)
    to_min = step_s / 60.0
    drop = np.where(ok & (nxt_false[:T] < INF), (nxt_false[:T] - idx) * to_min, np.nan)
    nxt = np.where(~ok & (nxt_true[:T] < INF), (nxt_true[:T] - idx) * to_min, np.nan)
    return drop, nxt


def ground_arrival(dump_ok: np.ndarray, db_ok: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Шаг, на котором данные, снятые на шаге t, окажутся на Земле (INF — не в этом окне), и путь.

    Сброс со своей памяти — на ближайшем шаге t' ≥ t, когда канал к станции жив (данные ждут на борту);
    прямое вещание — в тот же шаг, если его принимает антенна. Путь: 2 — прямой приём, 1 — сброс, 0 — нет.
    """
    T = len(dump_ok)
    nxt = np.full(T + 1, INF, dtype=np.int64)
    for t in range(T - 1, -1, -1):
        nxt[t] = t if dump_ok[t] else nxt[t + 1]
    arrive = np.where(db_ok, np.arange(T), nxt[:T])
    path = np.where(db_ok, 2, np.where(nxt[:T] < INF, 1, 0))
    return arrive, path


def distance_to_bbox_km(lat: np.ndarray, lon: np.ndarray, bbox) -> np.ndarray:
    """Расстояние от подспутниковой точки до прямоугольника региона (0 — точка внутри)."""
    w, s, e, n = bbox
    return haversine_km(lat, lon, np.clip(lat, s, n), np.clip(lon, w, e))


def _round(x: float, nd: int = 1) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


# ----------------------------------------------------------------------------- симуляция окна
@lru_cache(maxsize=32)
def _simulate_cached(start_key: str, minutes: int, step_s: int, storm: str | None = None,
                     outage: str | None = None, db: bool = False) -> dict:
    start = pd.Timestamp(start_key)
    end = start + pd.Timedelta(minutes=minutes)
    times = pd.date_range(start, end, freq=f"{step_s}s")
    T = len(times)
    order = STATION_ORDER + ((DB_STATION,) if db else ())
    stations = [BY_ID[sid] for sid in order]
    sidx = {st["id"]: j for j, st in enumerate(stations)}
    tles = celestrak.fetch_all()
    sats = [s for s in SATS if s in tles]
    env = Environment(start, end, mode="forecast")
    sun = sun_ecef_unit(times)
    ecef = {s: Orbit(s, *tles[s]).ecef(times) for s in sats}
    tdrs = {r: Orbit(r, *tles[r]).ecef(times) for r in TDRS if r in tles}
    contact = {s: {"st": np.full(T, -1), "el": np.full(T, -90.0), "p": np.ones(T), "ttl": np.zeros(T),
                   "rate": np.zeros(T), "ch": np.array([""] * T, dtype=object), "storm": np.zeros(T, bool),
                   "blocked": np.full(T, -1), "wx": np.zeros(T), "db": np.zeros(T, bool)} for s in sats}
    for s in sats:
        c = contact[s]
        for sid in ACCESS[s]:
            st, j = BY_ID[sid], sidx[sid]
            _, el, rng_km, los = look_angles(ecef[s], st["lat"], st["lon"], st["alt_m"] / 1000)
            el = np.nan_to_num(el, nan=-90)
            up = el >= MIN_EL
            if not up.any():
                continue
            if sid == outage:  # станция на обслуживании: спутник над ней, но принять некому
                c["blocked"][up] = j
                continue
            vals = env.at(sid, times)
            stormy = bool(storm and sid == storm)
            if stormy:  # «что если»: гроза над станцией — ливень 30 мм/ч, сплошная облачность
                vals = {**vals, "precip": np.full(T, 30.0), "cloud": np.ones(T), "cloud_opt": np.ones(T),
                        "rh": np.full(T, 98.0)}
            sun_sep = np.degrees(np.arccos(np.clip((los * sun).sum(1), -1, 1)))
            for a, b in _runs(up):
                sl = slice(a, b)
                n = b - a
                v = {k: x[sl] for k, x in vals.items()}
                margins = channel_margins(st, rng_km[sl], el[sl], sun_sep[sl], v, None, stochastic=False)
                ttl = (n - 1 - np.arange(n)) * step_s / 60  # точно из орбиты: минут до ухода за горизонт
                best_p, best_rate = np.ones(n), np.zeros(n)
                best_ch = np.array([""] * n, dtype=object)
                for ch, m in margins.items():
                    if ch not in ("X", "Ka"):  # накопленные данные сбрасываются только по быстрым каналам
                        continue
                    p_ai = _ai2(_features(st, el[sl], rng_km[sl], sun_sep[sl], v, m, ttl, step_s, ch))
                    p = np.where(m > 0, outage_risk(p_ai, m, step_s), 1.0)
                    better = p < best_p - 1e-9
                    best_p = np.where(better, p, best_p)
                    best_ch = np.where(better, ch, best_ch)
                    best_rate = np.where(better, physics.RF_CHANNELS[ch]["rate_bps"] / 1e6, best_rate)
                # из станций в зоне — та, где канал надёжнее, при равенстве — выше над горизонтом
                take = (best_p + (90 - el[sl]) / 1000) < (c["p"][sl] + (90 - c["el"][sl]) / 1000)
                idx = np.arange(a, b)[take]
                for key, val in (("st", j), ("el", el[sl][take]), ("p", best_p[take]), ("ttl", ttl[take]),
                                 ("rate", best_rate[take]), ("ch", best_ch[take]), ("storm", stormy),
                                 ("wx", v["precip"][take])):
                    c[key][idx] = val
        if s in VIA_TDRS and tdrs:
            # Terra: ретранслятор на ГСО вместо станции; погода и горизонт станции не мешают
            vis = np.array([line_of_sight(ecef[s], r_ecef, grazing_km=100.0) for r_ecef in tdrs.values()])
            any_vis = vis.any(axis=0)
            remain = np.zeros(T)
            for a, b in _runs(any_vis):  # пока виден хоть один TDRS: передача между ними бесшовная
                remain[a:b] = (b - 1 - np.arange(a, b)) * step_s / 60
            j = sidx[TDRS_GROUND]
            use = any_vis & (c["st"] < 0)
            c["st"][use], c["el"][use], c["p"][use], c["rate"][use], c["ch"][use] = j, 90.0, 0.01, TDRS_MBPS, "TDRS"
            c["ttl"][use] = remain[use]
        if db and s in DIRECT_BROADCAST:
            # прямое вещание принимает антенна в Астане, если запас линии на 15 Мбит/с положителен
            st = BY_ID[DB_STATION]
            _, el, rng_km, los = look_angles(ecef[s], st["lat"], st["lon"], st["alt_m"] / 1000)
            el = np.nan_to_num(el, nan=-90)
            up = el >= MIN_EL
            if up.any():
                vals = env.at(DB_STATION, times)
                sun_sep = np.degrees(np.arccos(np.clip((los * sun).sum(1), -1, 1)))
                margin = np.full(T, -99.0)
                for a, b in _runs(up):
                    sl = slice(a, b)
                    m = channel_margins(st, rng_km[sl], el[sl], sun_sep[sl], {k: x[sl] for k, x in vals.items()},
                                        None, stochastic=False)["X"]
                    margin[sl] = m + 10 * np.log10(physics.RF_CHANNELS["X"]["rate_bps"] / (DB_MBPS * 1e6))
                db_ok = up & (margin > 0)
                if s in PAUSES_BROADCAST_WHILE_DUMPING:
                    db_ok &= ~((c["st"] >= 0) & (c["p"] < P_OUT))
                c["db"] = db_ok
    N = len(sats)
    db_j = sidx.get(DB_STATION, -1)

    # ---------------------------------------------------------------- действия и память на борту
    act = np.zeros((N, T), np.int8)
    qlog = np.zeros((N, T), np.float32)
    delivered_mb = 0.0
    events, prev = [], [(-1, -1)] * N
    for i, s in enumerate(sats):
        c = contact[s]
        queue = 0.0
        produce = 0.0 if s in RETIRED else PRODUCE_MBPS[s]
        for t in range(T):
            queue += produce * step_s / 8
            if c["st"][t] >= 0 and c["p"][t] < P_OUT:
                act[i, t] = ACTIONS["DOWNLINK"]
                sent = min(queue, c["rate"][t] * step_s / 8)
                queue -= sent
                delivered_mb += sent
            elif c["db"][t]:
                act[i, t] = ACTIONS["BROADCAST"]
            else:
                act[i, t] = ACTIONS["STORE"]
            qlog[i, t] = queue
            shown = int(c["st"][t]) if act[i, t] == ACTIONS["DOWNLINK"] else (db_j if act[i, t] == ACTIONS["BROADCAST"] else -1)
            state = (int(act[i, t]), shown)
            if state != prev[i]:
                events.append({"t": int(t), "sat": i, "action": int(act[i, t]), "station": shown,
                               "channel": str(c["ch"][t]), "p_out": round(float(c["p"][t]), 3),
                               "ttl_min": round(float(c["ttl"][t]), 1), "storm": bool(c["storm"][t])})
                prev[i] = state

    # ---------------------------------------------------------------- когда оборвётся связь
    forecast = []
    for s in sats:
        c = contact[s]
        ok = (c["st"] >= 0) & (c["p"] < P_OUT)
        drop, nxt = link_forecast(ok, step_s)
        rows = []
        for t in range(T):
            if ok[t]:
                te = t + int(round(drop[t] * 60 / step_s)) if np.isfinite(drop[t]) else None
                if te is None:
                    reason = ""
                elif c["st"][te] >= 0:  # станция ещё над горизонтом, но канал не выдержит
                    reason = "weather" if c["wx"][te] >= 0.5 or c["storm"][te] else "margin"
                elif c["blocked"][te] >= 0:
                    reason = "outage"
                else:
                    reason = "los"
                rows.append([_round(drop[t]), None, -1, reason, round(float(c["p"][t]), 3)])
            else:
                tn = t + int(round(nxt[t] * 60 / step_s)) if np.isfinite(nxt[t]) else None
                if c["blocked"][t] >= 0:
                    reason = "outage"
                elif c["st"][t] >= 0:
                    reason = "weather" if c["wx"][t] >= 0.5 or c["storm"][t] else "margin"
                else:
                    reason = "los"
                rows.append([None, _round(nxt[t]), int(c["st"][tn]) if tn is not None else -1, reason,
                             round(float(c["p"][t]), 3)])
        forecast.append(rows)

    # ---------------------------------------------------------------- когда снятое окажется на Земле
    to_min = step_s / 60.0
    delivery, arrive_all, dump_all = [], [], []
    for s in sats:
        c = contact[s]
        dump_ok = (c["st"] >= 0) & (c["p"] < P_OUT)
        arrive, path = ground_arrival(dump_ok, c["db"])
        dump_only, _ = ground_arrival(dump_ok, np.zeros(T, bool))
        arrive_all.append(arrive)
        dump_all.append(dump_only)
        rows = []
        for t in range(T):
            p = int(path[t])
            how = "" if p == 0 else ("db" if p == 2 else ("tdrs" if c["ch"][arrive[t]] == "TDRS" else "dump"))
            station = db_j if p == 2 else (int(c["st"][arrive[t]]) if p == 1 else -1)
            rows.append([_round((arrive[t] - t) * to_min) if arrive[t] < INF else None, how, station,
                         _round((dump_only[t] - t) * to_min) if dump_only[t] < INF else None])
        delivery.append(rows)

    # ---------------------------------------------------------------- пожар в регионе: кто принесёт сведения первым
    tracks = {}
    for s in sats:
        la, lo, alt = Orbit(s, *tles[s]).subpoint(times)
        tracks[s] = [[round(float(x), 3), round(float(y), 3), round(float(z), 1)] for y, x, z in zip(la, lo, alt)]
    reg = settings()["region"]
    passes = []
    for i, s in enumerate(sats):
        if s in RETIRED:
            continue
        lon = np.array([p[0] for p in tracks[s]])
        lat = np.array([p[1] for p in tracks[s]])
        sees = distance_to_bbox_km(lat, lon, reg["bbox"]) <= HALF_SWATH_KM[SENSOR[s]]
        for a, b in _runs(sees):
            last = b - 1
            arr = arrive_all[i][a:b].max()  # когда на Земле окажется весь снимок региона с этого пролёта
            arr_dump = dump_all[i][a:b].max()
            row = delivery[i][last]
            passes.append({"sat": i, "t_start": int(a), "t_end": int(last),
                           "ground_t": int(arr) if arr < INF else None,
                           "wait_min": _round((arr - last) * to_min) if arr < INF else None,
                           "wait_dump_min": _round((arr_dump - last) * to_min) if arr_dump < INF else None,
                           "path": row[1], "station": row[2]})
    passes.sort(key=lambda r: r["t_start"])
    known = [p for p in passes if p["ground_t"] is not None]
    first = min(known, key=lambda p: p["ground_t"]) if known else None

    def _stats(values) -> dict:
        a = np.array([v for v in values if v is not None])
        if not len(a):
            return {"median_min": None, "p90_min": None, "max_min": None}
        return {"median_min": _round(np.median(a)), "p90_min": _round(np.quantile(a, 0.9)), "max_min": _round(a.max())}

    active = [i for i, s in enumerate(sats) if s not in RETIRED]
    latency = {
        "now": _stats([(dump_all[i][t] - t) * to_min for i in active for t in range(T) if dump_all[i][t] < INF]),
        "with_db": _stats([(arrive_all[i][t] - t) * to_min for i in active for t in range(T) if arrive_all[i][t] < INF]) if db else None,
        "beyond_window": int(sum(1 for i in active for t in range(T) if dump_all[i][t] >= INF)),
    }

    states = [[[int(act[i, t]), db_j if contact[s]["db"][t] else -1,
                int(contact[s]["st"][t]) if act[i, t] == ACTIONS["DOWNLINK"] else (db_j if act[i, t] == ACTIONS["BROADCAST"] else -1),
                round(float(contact[s]["p"][t]), 3), round(float(contact[s]["ttl"][t]), 1), round(float(qlog[i, t]), 1),
                str(contact[s]["ch"][t]) if act[i, t] == ACTIONS["DOWNLINK"] else ("DB" if act[i, t] == ACTIONS["BROADCAST"] else "")]
               for t in range(T)] for i, s in enumerate(sats)]
    minutes_by = {k: {s: round(float((act[i] == v).sum()) * step_s / 60, 1) for i, s in enumerate(sats)} for k, v in ACTIONS.items()}
    return {
        "start": start.isoformat(), "step_s": step_s, "minutes": minutes, "storm": storm, "outage": outage, "db": db,
        "satellites": [{"name": s, "track": tracks[s], "sensor": SENSOR[s], "retired": RETIRED.get(s),
                        "broadcast": s in DIRECT_BROADCAST, "access": "TDRS" if s in VIA_TDRS else list(ACCESS[s])}
                       for s in sats],
        "stations": [{"id": st["id"], "name": st["name"], "lat": st["lat"], "lon": st["lon"],
                      "kind": "optical" if st.get("kind") == "optical" else "radio"} for st in stations],
        "states_fields": ["action", "db_station", "station", "p_out", "ttl_min", "queue_mb", "channel"],
        "actions": ACTIONS, "states": states, "events": events,
        "forecast_fields": ["drop_min", "next_min", "next_station", "reason", "p_out_5min"],
        "forecast": forecast,
        "delivery_fields": ["ground_min", "path", "station", "dump_only_min"],
        "delivery": delivery,
        "region": {"name": reg["name"], "bbox": reg["bbox"], "passes": passes,
                   "first": {"sat": first["sat"], "t_end": first["t_end"], "ground_t": first["ground_t"]} if first else None},
        "summary": {"minutes": minutes_by, "delivered_mb": round(delivered_mb), "latency": latency,
                    "p_out_threshold": P_OUT, "lookahead_min": LOOKAHEAD_MIN},
    }


def _changed(base: dict, other: dict) -> int:
    return sum(1 for i, lst in enumerate(other["states"]) for t, s in enumerate(lst) if s[0] != base["states"][i][t][0])


@lru_cache(maxsize=8)
def _best_storm_cached(start_key: str, minutes: int, step_s: int, outage: str | None = None, db: bool = False) -> str | None:
    """Станция, где гроза сильнее всего меняет сеансы связи в этом окне.

    Полярные станции почти не страдают: слой дождя там тонкий (P.839), и X-канал выдерживает ливень —
    поэтому «гроза над самой загруженной станцией» часто ничего не меняет, и мы перебираем станции честно.
    """
    base = _simulate_cached(start_key, minutes, step_s, None, outage, db)
    used = sorted({s[2] for lst in base["states"] for s in lst if s[0] == ACTIONS["DOWNLINK"] and s[2] >= 0})
    best, best_score = None, 0
    for j in used:
        sid = base["stations"][j]["id"]
        if sid == TDRS_GROUND:  # гроза над White Sands не мешает связи Terra с TDRS на орбите
            continue
        score = _changed(base, _simulate_cached(start_key, minutes, step_s, sid, outage, db))
        if score > best_score:
            best, best_score = sid, score
    if best is None:
        best = next((base["stations"][j]["id"] for j in used if base["stations"][j]["id"] != TDRS_GROUND), None)
    return best


def point_passes(sim: dict, lat: float, lon: float) -> list[dict]:
    """Пролёты окна, в которых точка попадает в полосу обзора, и когда их данные окажутся на Земле.

    Берёт готовую симуляцию (треки + delivery), поэтому годится для любой точки без пересчёта связи.
    """
    to_min = sim["step_s"] / 60.0
    out = []
    for i, sat in enumerate(sim["satellites"]):
        if sat["retired"]:
            continue
        lon_t = np.array([p[0] for p in sat["track"]])
        lat_t = np.array([p[1] for p in sat["track"]])
        sees = haversine_km(lat_t, lon_t, lat, lon) <= HALF_SWATH_KM[sat["sensor"]]
        for a, b in _runs(sees):
            k = a + int(np.argmin(haversine_km(lat_t[a:b], lon_t[a:b], lat, lon)))  # ближе всего к надиру
            g, how, station, g_dump = sim["delivery"][i][k]
            out.append({"sat": i, "name": sat["name"], "t_obs": int(k),
                        "ground_t": None if g is None else k + int(round(g / to_min)),
                        "delay_min": g, "delay_dump_min": g_dump, "path": how, "station": station})
    return sorted(out, key=lambda r: r["t_obs"])


def time_to_know(passes: list[dict], T: int, sats: set[str] | None = None) -> np.ndarray:
    """Для пожара, вспыхнувшего на шаге t0: через сколько шагов его данные будут на Земле (NaN — не в окне).

    Пожар узнают по первому пролёту после вспышки, чьи данные раньше всех окажутся на Земле: если у одного
    спутника связь пропала, сведения доставит следующий пролёт другого — эстафета по времени.
    """
    out = np.full(T, np.nan)
    for t0 in range(T):
        best = min((p["ground_t"] for p in passes
                    if p["t_obs"] >= t0 and p["ground_t"] is not None and (sats is None or p["name"] in sats)),
                   default=None)
        if best is not None:
            out[t0] = best - t0
    return out


def simulate(minutes: int = 120, step_s: int = 30, storm: str | None = None, outage: str | None = None,
             db: bool = False) -> dict:
    """Окно от текущих 10 минут (кэш). storm — станция с грозой или "auto"; outage — станция на обслуживании;
    db — своя станция приёма прямого вещания в Астане (сценарий: наземное оборудование, спутники те же)."""
    now = pd.Timestamp.now(tz="UTC").floor("10min")
    t0 = time.time()
    if storm == "auto":
        storm = _best_storm_cached(now.isoformat(), minutes, step_s, outage, db)
    out = _simulate_cached(now.isoformat(), minutes, step_s, storm, outage, db)
    log.info("созвездие: %d событий, %.1f с", len(out["events"]), time.time() - t0)
    return out
