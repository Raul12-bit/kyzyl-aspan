"""Fire DNA — «характер горения» каждой ячейки H3 res-7 по её 26-летней истории.

Классы (вероятность + уверенность; истинную причину без полевых данных установить нельзя):
* industrial   — постоянный источник: факел, завод, ТЭЦ (горит круглый год, и днём, и ночью);
* agricultural — сельхозпалы: повторяются почти каждый год в узкое окно весной/осенью, днём, мелкие;
* wildfire     — природный/степной пожар: эпизодический, летний, крупный, быстро растёт по площади;
* sporadic     — мало наблюдений, характер не ясен.
Подход: прозрачные признаки + мягкая балльная модель (softmax) — объяснимо для жюри.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

LABELS_RU = {"industrial": "постоянный промышленный источник", "agricultural": "сельскохозяйственные палы",
             "wildfire": "природный (степной/лесной) пожар", "sporadic": "единичные случаи"}


def cell_features(det: pd.DataFrame, registry: pd.DataFrame) -> pd.DataFrame:
    d = det[["h3_r7", "h3_r8", "acq_dt", "frp", "daynight_sza", "keep_veg", "is_static"]].copy()
    d["date"] = d["acq_dt"].dt.normalize()
    d["year"] = d["acq_dt"].dt.year
    d["doy"] = d["acq_dt"].dt.dayofyear
    d["night"] = d["daynight_sza"].astype(str) == "N"
    g = d.groupby("h3_r7")
    ang = 2 * np.pi * d["doy"] / 365.25
    feats = pd.DataFrame({
        "n_det": g.size(),
        "n_days": g["date"].nunique(),
        "n_years": g["year"].nunique(),
        "first_year": g["year"].min(),
        "last_year": g["year"].max(),
        "night_share": g["night"].mean(),
        "static_share": g["is_static"].mean(),
        "frp_median": g["frp"].median(),
        "frp_p90": g["frp"].quantile(0.9),
        # сезонная концентрация (длина среднего вектора дня года): 1 = всё в одну неделю, 0 = круглый год
        "season_R": np.hypot(np.cos(ang).groupby(d["h3_r7"]).mean(), np.sin(ang).groupby(d["h3_r7"]).mean()),
        "peak_doy": (np.degrees(np.arctan2(np.sin(ang).groupby(d["h3_r7"]).mean(),
                                           np.cos(ang).groupby(d["h3_r7"]).mean())) % 360 / 360 * 365.25).round(0),
    })
    # «эпизодичность»: дней с огнём на один активный год
    feats["days_per_year"] = feats["n_days"] / feats["n_years"]
    feats["recurrence"] = feats["n_years"] / (feats["last_year"] - feats["first_year"] + 1)
    # максимальный «рост» события: соседние res-7 ячейки, горевшие в те же сутки
    daily = d[d["keep_veg"]].groupby(["date", "h3_r7"]).size().reset_index()
    import h3

    daily["r5"] = [h3.cell_to_parent(c, 5) for c in daily["h3_r7"]]
    spread = daily.groupby(["date", "r5"])["h3_r7"].transform("size")
    feats["max_event_cells"] = daily.assign(s=spread).groupby("h3_r7")["s"].max().reindex(feats.index).fillna(0)
    reg = registry.set_index("h3_r8")
    st = reg.loc[reg["is_static"], "static_score"]
    st7 = st.groupby([h3.cell_to_parent(c, 7) for c in st.index]).max()
    feats["static_score"] = st7.reindex(feats.index).fillna(0)
    return feats


def classify_cells(det: pd.DataFrame, registry: pd.DataFrame, temperature: float = 0.6) -> pd.DataFrame:
    f = cell_features(det, registry)
    month = ((f["peak_doy"] / 30.44).astype(int) % 12) + 1
    spring_autumn = month.isin([3, 4, 5, 9, 10, 11]).astype(float)
    summer = month.isin([6, 7, 8]).astype(float)
    s_ind = (3.0 * f["static_score"] + 2.0 * f["static_share"] + 1.5 * (1 - f["season_R"]) + 1.5 * f["night_share"]
             + 0.8 * np.clip((f["days_per_year"] - 5) / 20, 0, 1))
    s_agr = (2.0 * f["recurrence"] * (f["n_years"] >= 3) + 1.5 * f["season_R"] + 1.2 * spring_autumn
             + 1.0 * (f["night_share"] < 0.2) + 0.8 * (f["frp_median"] < 15) - 2.0 * f["static_share"])
    s_wild = (1.5 * summer + 1.5 * np.clip(np.log1p(f["max_event_cells"]) / 3, 0, 1.5) + 1.0 * (f["frp_p90"] > 30)
              + 1.0 * (1 - f["recurrence"]) + 0.5 * f["season_R"] - 2.0 * f["static_share"])
    s_spo = 2.5 * (f["n_days"] <= 2) + 1.0 * (f["n_years"] <= 1)
    scores = np.column_stack([s_ind, s_agr, s_wild, s_spo]) / temperature
    p = np.exp(scores - scores.max(1, keepdims=True))
    p /= p.sum(1, keepdims=True)
    classes = np.array(["industrial", "agricultural", "wildfire", "sporadic"])
    out = f.reset_index().rename(columns={"index": "h3_r7"})
    for i, c in enumerate(classes):
        out[f"p_{c}"] = p[:, i].round(3)
    out["dna_class"] = classes[p.argmax(1)]
    out["confidence"] = p.max(1).round(3)
    out["label_ru"] = out["dna_class"].map(LABELS_RU)
    import h3

    ll = np.array([h3.cell_to_latlng(c) for c in out["h3_r7"]])
    out["lat"], out["lon"] = ll[:, 0].round(5), ll[:, 1].round(5)
    return out
