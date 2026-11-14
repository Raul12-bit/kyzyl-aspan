"""Fire Blind Spot Detector — «пустая карта» не всегда означает «пожаров нет».

Если в ячейке пожары исторически вероятны, а во время пролётов спутников было облачно,
отсутствие точек ничего не доказывает. Показываем: «Недостаточно данных. Возможны
пропущенные очаги».

* История (2012–2025): ожидаемая вероятность пожара (климатология прошлых лет) × облачность
  NASA POWER CLOUD_AMT за неделю. Проверка: после «слепых» недель пожары находятся
  чаще, чем после ясных недель с той же климатологией (значит, часть очагов действительно
  пропускалась).
* Сейчас: облачность Open-Meteo в часы пролётов (≈13:30 и ≈01:30 местного) + ожидаемый риск
  (ИИ №3 или климатология) по сетке H3 res-3.
"""

from __future__ import annotations

import h3
import numpy as np
import pandas as pd

from ..config import settings
from ..utils import get_logger

log = get_logger("helios.blindspots")

MESSAGE_RU = "Недостаточно данных: во время пролётов было облачно. Возможны пропущенные очаги."


def historical_blind_spots(threshold: float = 0.2, start: str = "2012-01-01", end: str = "2025-12-31") -> pd.DataFrame | None:
    """Порог 0.2: проверка показала, что облака «прячут» очаги именно в ячейках с высоким
    ожидаемым риском (p ≥ 0.5: +14% находок после облачных недель), а в малорисковых облака
    приходят вместе с дождём и пожаров, наоборот, меньше."""
    from ..models.features import Panel

    pn = Panel()
    ww = pn.weather_weekly
    if ww is None:
        log.warning("нет погоды NASA POWER — исторические слепые зоны не посчитать")
        return None
    years, woys = pn.iso
    rows = []
    bins = np.array([0.05, 0.1, 0.2, 0.35, 0.5, 1.01])
    # счётчики по корзинам ожидаемого риска: [облачно-n, облачно-пожар, ясно-n, ясно-пожар]
    strat = np.zeros((len(bins) - 1, 4))
    for w in pn.week_index(start, end):
        if w + 1 >= len(pn.weeks):
            break
        exp_p = pn.clim[int(years[w])][int(woys[w]) - 1]
        cloud = np.nan_to_num(ww["cloud"][w], nan=50.0) / 100.0
        score = exp_p * np.clip((cloud - 0.4) / 0.5, 0, 1) ** 1.5
        observed = pn.B[w]
        nxt = pn.B[w + 1]
        flag = (score >= threshold) & ~observed
        # проверка: при ОДИНАКОВОМ ожидаемом риске сравниваем «облачно и пусто» с «ясно и пусто»
        b = np.digitize(exp_p, bins) - 1
        ok = (b >= 0) & (b < len(bins) - 1) & ~observed
        cloudy, clear = ok & (cloud >= 0.7), ok & (cloud < 0.4)
        np.add.at(strat[:, 0], b[cloudy], 1)
        np.add.at(strat[:, 1], b[cloudy], nxt[cloudy])
        np.add.at(strat[:, 2], b[clear], 1)
        np.add.at(strat[:, 3], b[clear], nxt[clear])
        for i in np.flatnonzero(flag):
            rows.append((pn.cells[i], pn.weeks[w], float(exp_p[i]), float(cloud[i]), float(score[i]), bool(nxt[i])))
    df = pd.DataFrame(rows, columns=["h3_r5", "week", "expected_fire_p", "cloud_frac", "blind_score", "fire_next_week"])
    table = []
    for k in range(len(bins) - 1):
        cn, cf, sn, sf = strat[k]
        if cn >= 50 and sn >= 50:
            table.append({"expected_p_bin": f"{bins[k]:.2f}-{min(bins[k + 1], 1):.2f}", "cloudy_n": int(cn),
                          "fire_next_after_cloudy": round(cf / cn, 4), "clear_n": int(sn),
                          "fire_next_after_clear": round(sf / sn, 4), "lift": round((cf / cn) / max(sf / sn, 1e-6), 3)})
    w_lift = (sum(t["lift"] * t["cloudy_n"] for t in table) / max(sum(t["cloudy_n"] for t in table), 1)) if table else None
    df.attrs["validation"] = {"flagged_cell_weeks": int(len(df)), "stratified": table,
                              "weighted_lift": None if w_lift is None else round(w_lift, 3),
                              "interpretation": "lift>1: после облачных «пустых» недель пожары находят чаще, "
                                                "чем после ясных при том же ожидаемом риске — часть очагов была скрыта облаками"}
    log.info("blind spots history: lift %s", df.attrs["validation"]["weighted_lift"])
    return df


def overpass_hours_utc(lon: float) -> list[int]:
    """Часы UTC дневного (~13:30) и ночного (~01:30) пролётов VIIRS/Aqua для долготы."""
    off = lon / 15.0
    return sorted({int((13.5 - off) % 24), int((1.5 - off) % 24)})


def recent_blind_spots(risk_r5: pd.DataFrame | None = None, recent_fire_cells: set[str] | None = None,
                       threshold: float = 0.2) -> pd.DataFrame:
    """Слепые зоны за последние ~2 суток по сетке res-3 (облачность Open-Meteo в часы пролётов)."""
    from ..apis.boundaries import region_cells
    from ..apis.open_meteo import forecast

    res_w = settings()["h3"]["res_weather"]
    cells = sorted(region_cells(res_w))
    ll = np.array([h3.cell_to_latlng(c) for c in cells])
    clouds = []
    for i in range(0, len(cells), 90):  # пачками по 90 точек
        frames = forecast(list(ll[i:i + 90, 0]), list(ll[i:i + 90, 1]), hourly=["cloud_cover"], days=1)
        clouds += frames
    rows = []
    now = pd.Timestamp.now(tz="UTC")
    for c, (lat, lon), f in zip(cells, ll, clouds):
        if f is None or f.empty:
            continue
        past = f[(f.index <= now) & (f.index >= now - pd.Timedelta(hours=48))]
        hrs = overpass_hours_utc(lon)
        sel = past[past.index.hour.isin(hrs)]["cloud_cover"]
        cloud = float(sel.mean() / 100) if len(sel) else float(past["cloud_cover"].mean() / 100)
        rows.append({"h3_r3": c, "lat": round(lat, 4), "lon": round(lon, 4), "cloud_at_overpasses": round(cloud, 3)})
    df = pd.DataFrame(rows)
    if risk_r5 is not None and len(risk_r5):
        r = risk_r5.assign(h3_r3=[h3.cell_to_parent(c, res_w) for c in risk_r5["h3_r5"]])
        exp = r.groupby("h3_r3")["p_fire"].quantile(0.9).rename("expected_fire_p")
        df = df.merge(exp, on="h3_r3", how="left")
    else:
        df["expected_fire_p"] = np.nan
    df["expected_fire_p"] = df["expected_fire_p"].fillna(0.0)
    df["blind_score"] = (df["expected_fire_p"] * np.clip((df["cloud_at_overpasses"] - 0.4) / 0.5, 0, 1) ** 1.5).round(4)
    seen = recent_fire_cells or set()
    df["fires_seen_48h"] = df["h3_r3"].isin(seen)
    df["is_blind"] = (df["blind_score"] >= threshold) & ~df["fires_seen_48h"]
    df["message"] = np.where(df["is_blind"], MESSAGE_RU, "")
    df["computed_at"] = now
    return df
