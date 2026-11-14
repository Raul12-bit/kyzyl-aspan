"""Гармонизация 26 лет MODIS + VIIRS в одну непрерывную летопись.

Идея (как у Flare-Chronos): вместо сырых точек считаем «сгоревшие гексагоны» —
число пар (H3 res-7 ячейка, местные сутки) с пожаром. Пиксель 1 км и три пикселя
375 м в одном гексагоне дают одну единицу, это гасит разницу разрешений.

Дальше (идея Kiln-Watch, своя реализация + улучшения):
* общая шкала — Aqua MODIS (единственный спутник, летающий с 2002 г. через все эпохи VIIRS);
* мост «поток → опорный поток» в окне перекрытия: отношение сумм по каждому
  календарному месяцу, отдельно день/ночь, со сжатием к общему отношению по
  эмпирическому Байесу (меньше шума в «тихих» месяцах);
* НОВОЕ: доля рабочих дней спутника (coverage) берётся по «маякам» — постоянным
  факелам, которые видны почти каждый день; пропуски из-за сбоев спутника не
  выглядят как «нет пожаров»;
* НОВОЕ: бутстреп по годам → неопределённость калибровки и 95% интервал на каждое значение;
* проверки: ступенька при появлении SNPP (2012) и NOAA-20 (2018) до/после,
  тест «MODIS выключили» (учимся на 2012–2016, восстанавливаем 2017–2020 только по VIIRS).
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from ..config import settings
from ..utils import get_logger

log = get_logger("helios.harmonize")

STREAMS = ["MODIS_A", "MODIS_T", "VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21"]
DN = ["D", "N"]


# ----------------------------------------------------------------------------- базовые величины
def local_date(df: pd.DataFrame) -> pd.Series:
    """Местные солнечные сутки (UTC + долгота/15 ч): ночной пролёт 01:30 относится к новым суткам."""
    shifted = df["acq_dt"].dt.tz_convert(None) + pd.to_timedelta(df["lon"] / 15.0, unit="h")
    return shifted.dt.normalize()


def stream_coverage(all_det: pd.DataFrame) -> pd.DataFrame:
    """Доля суток в месяце, когда поток вообще что-то видел (маяки — постоянные факелы)."""
    d = pd.DataFrame({"stream": all_det["stream"].astype(str), "date": local_date(all_det)}).drop_duplicates()
    d["month"] = d["date"].dt.to_period("M")
    cov = d.groupby(["stream", "month"]).size().rename("active_days").reset_index()
    cov["coverage"] = cov["active_days"] / cov["month"].dt.days_in_month
    return cov


def celldays(df: pd.DataFrame) -> pd.DataFrame:
    """Уникальные (поток, сутки, день/ночь, H3 res-7) среди отфильтрованных растительных пожаров."""
    d = df.loc[df["keep_veg"], ["stream", "daynight_sza", "h3_r7", "h3_r5", "frp", "lat", "lon", "acq_dt"]].copy()
    d["date"] = local_date(d)
    d["stream"] = d["stream"].astype(str)
    d["dn"] = d["daynight_sza"].astype(str)
    g = d.groupby(["stream", "date", "dn", "h3_r7"], observed=True).agg(
        h3_r5=("h3_r5", "first"), n_det=("frp", "size"), frp_sum=("frp", "sum")
    ).reset_index()
    return g


def monthly_stream_table(cd: pd.DataFrame, cov: pd.DataFrame) -> pd.DataFrame:
    """Помесячно: cell-days по потокам и дню/ночи + coverage."""
    t = cd.assign(month=cd["date"].dt.to_period("M")).groupby(["stream", "month", "dn"]).size().rename("celldays").reset_index()
    t = t.merge(cov[["stream", "month", "coverage"]], on=["stream", "month"], how="left")
    return t


# ----------------------------------------------------------------------------- калибровка
def ratio_calibration_eb(pairs: pd.DataFrame) -> dict:
    """pairs: [cal_month, ref, src] (уже нормированы на coverage). Отношение сумм по месяцам,
    сжатое к общему отношению эмпирическим Байесом (метод моментов для τ²)."""
    num = pairs.groupby("cal_month")["ref"].sum().reindex(range(1, 13), fill_value=0.0)
    den = pairs.groupby("cal_month")["src"].sum().reindex(range(1, 13), fill_value=0.0)
    N, D = float(num.sum()), float(den.sum())
    if N <= 0 or D <= 0:
        return {"beta": [1.0] * 12, "pooled": 1.0, "tau2": 0.0, "calibrated": False}
    pooled = N / D
    L = math.log(pooled)
    ok = (num > 0) & (den > 0)
    logs = np.log(num[ok] / den[ok])
    v = 1.0 / num[ok] + 1.0 / den[ok]
    tau2 = max(0.0, float(np.mean((logs - L) ** 2) - np.mean(v))) if ok.any() else 0.0
    beta = []
    for m in range(1, 13):
        if num[m] > 0 and den[m] > 0:
            vm = 1.0 / num[m] + 1.0 / den[m]
            lam = tau2 / (tau2 + vm) if tau2 > 0 else 0.0
            beta.append(math.exp(lam * math.log(num[m] / den[m]) + (1 - lam) * L))
        else:
            beta.append(pooled)
    return {"beta": beta, "pooled": pooled, "tau2": tau2, "calibrated": True}


def fit_bridge(mt: pd.DataFrame, src: str, ref: str, start: str, end: str, dn: str,
               n_boot: int = 200, min_cov: float = 0.8) -> dict:
    """Калибровка src -> ref (один день/ночь) + бутстреп по годам."""
    a = mt[(mt.stream == ref) & (mt.dn == dn)].set_index("month")
    b = mt[(mt.stream == src) & (mt.dn == dn)].set_index("month")
    months = pd.period_range(start, end, freq="M")
    rows = []
    for m in months:
        if m in a.index and m in b.index and a.loc[m, "coverage"] >= min_cov and b.loc[m, "coverage"] >= min_cov:
            rows.append({"month": m, "cal_month": m.month,
                         "ref": a.loc[m, "celldays"] / a.loc[m, "coverage"],
                         "src": b.loc[m, "celldays"] / b.loc[m, "coverage"]})
    pairs = pd.DataFrame(rows)
    if pairs.empty:
        return {"beta": [1.0] * 12, "pooled": 1.0, "sigma2": [0.25] * 12, "n_months": 0, "calibrated": False}
    fit = ratio_calibration_eb(pairs)
    # бутстреп по годам — неопределённость калибровки по месяцам
    rng = np.random.default_rng(7)
    years = pairs["month"].dt.year.unique()
    boot = []
    for _ in range(n_boot):
        pick = rng.choice(years, size=len(years), replace=True)
        sample = pd.concat([pairs[pairs["month"].dt.year == y] for y in pick])
        boot.append(np.log(ratio_calibration_eb(sample)["beta"]))
    sigma2 = np.var(np.array(boot), axis=0).tolist()
    # сверхпуассоновский разброс «месяц к месяцу» (то, что не объясняет счётный шум) —
    # без него 95% интервалы на тесте «MODIS выключили» накрывали только ~63% месяцев
    beta_m = np.array(fit["beta"])[pairs["cal_month"].to_numpy() - 1]
    resid = np.log((pairs["ref"] + 0.5) / (beta_m * pairs["src"] + 0.5))
    noise = 1.0 / (pairs["ref"] + 0.5) + 1.0 / (pairs["src"] + 0.5)
    sigma2_extra = max(0.0025, float(np.var(resid) - np.mean(noise))) if len(pairs) >= 6 else 0.05
    return {**fit, "sigma2": [max(s, 0.0025) for s in sigma2], "sigma2_extra": sigma2_extra,
            "n_months": int(len(pairs))}


def fit_all_bridges(mt: pd.DataFrame) -> dict:
    """Все мосты из конфига, затем цепочки до опорного потока (Aqua MODIS)."""
    cfg = settings()["harmonization"]
    ref0 = cfg["reference"]
    bridges = {}
    for src, b in cfg["bridges"].items():
        if src not in set(mt.stream):
            continue
        bridges[src] = {"ref": b["ref"], **{dn: fit_bridge(mt, src, b["ref"], b["start"], b["end"], dn) for dn in DN}}
    # цепочки: beta_total(src) = beta(src->ref) * beta_total(ref)
    to_ref: dict[str, dict] = {ref0: {dn: {"beta": [1.0] * 12, "sigma2": [0.0] * 12, "sigma2_extra": 0.0} for dn in DN}}
    pending = dict(bridges)
    while pending:
        progressed = False
        for src, b in list(pending.items()):
            if b["ref"] in to_ref:
                to_ref[src] = {
                    dn: {
                        "beta": [x * y for x, y in zip(b[dn]["beta"], to_ref[b["ref"]][dn]["beta"])],
                        "sigma2": [x + y for x, y in zip(b[dn]["sigma2"], to_ref[b["ref"]][dn]["sigma2"])],
                        "sigma2_extra": b[dn].get("sigma2_extra", 0.05) + to_ref[b["ref"]][dn]["sigma2_extra"],
                    }
                    for dn in DN
                }
                pending.pop(src)
                progressed = True
        if not progressed:
            break
    return {"bridges": bridges, "to_ref": to_ref}


# ----------------------------------------------------------------------------- гармонизированный ряд
def harmonized_monthly(mt: pd.DataFrame, cal: dict, min_cov: float = 0.5) -> pd.DataFrame:
    """Помесячный ряд на шкале Aqua MODIS с 95% интервалом (обратно-дисперсионное среднее потоков)."""
    to_ref = cal["to_ref"]
    rows = []
    for (month, dn), g in mt.groupby(["month", "dn"]):
        est = []
        for _, r in g.iterrows():
            if r.stream not in to_ref or not (r.coverage >= min_cov):
                continue
            beta = to_ref[r.stream][dn]["beta"][month.month - 1]
            s2 = to_ref[r.stream][dn]["sigma2"][month.month - 1] + to_ref[r.stream][dn]["sigma2_extra"]
            val = beta * r.celldays / r.coverage
            var = val ** 2 * s2 + beta ** 2 * max(r.celldays, 1.0) / r.coverage ** 2
            est.append((val, var, r.stream))
        if not est:
            continue
        w = np.array([1.0 / max(v, 1e-6) for _, v, _ in est])
        vals = np.array([x for x, _, _ in est])
        rows.append({"month": month, "dn": dn, "value": float((w * vals).sum() / w.sum()),
                     "var": float(1.0 / w.sum()), "streams": ",".join(sorted(s for _, _, s in est))})
    h = pd.DataFrame(rows)
    wide = h.pivot_table(index="month", columns="dn", values=["value", "var"], aggfunc="first")
    out = pd.DataFrame(index=wide.index)
    out["harmonized_day"] = wide[("value", "D")] if ("value", "D") in wide else np.nan
    out["harmonized_night"] = wide[("value", "N")] if ("value", "N") in wide else np.nan
    out["harmonized"] = out[["harmonized_day", "harmonized_night"]].sum(axis=1, min_count=1)
    var = wide["var"].sum(axis=1, min_count=1)
    out["lo95"] = (out["harmonized"] - 1.96 * np.sqrt(var)).clip(lower=0)
    out["hi95"] = out["harmonized"] + 1.96 * np.sqrt(var)
    streams = h.groupby("month")["streams"].agg(lambda s: ",".join(sorted(set(",".join(s).split(",")))))
    out["streams"] = streams
    return out.reset_index()


def raw_monthly(cd: pd.DataFrame, filtered: pd.DataFrame) -> pd.DataFrame:
    """Наивные метрики для сравнения: сумма точек всех спутников и union cell-days."""
    det = filtered.loc[filtered["keep_veg"]]
    raw_det = det.groupby(local_date(det).dt.to_period("M")).size().rename("raw_detections")
    union = cd[["date", "h3_r7"]].drop_duplicates()
    raw_union = union.groupby(union["date"].dt.to_period("M")).size().rename("raw_union_celldays")
    per_stream = cd.assign(month=cd["date"].dt.to_period("M")).groupby(["month", "stream"]).size().unstack(fill_value=0)
    per_stream.columns = [f"celldays_{c}" for c in per_stream.columns]
    out = pd.concat([raw_det, raw_union, per_stream], axis=1)
    out.index.name = "month"
    return out.reset_index()


# ----------------------------------------------------------------------------- проверки
def step_ratio(series: pd.Series, transition: str, window: int = 24) -> float | None:
    """Ступенька при смене состава спутников на десезонализированном ряду: mean(после)/mean(до)."""
    s = series.dropna()
    if s.empty:
        return None
    clim = s.groupby(s.index.month).transform("mean").replace(0, np.nan)
    anom = (s / clim).dropna()
    t = pd.Period(transition, freq="M")
    before = anom[(anom.index < t) & (anom.index >= t - window)]
    after = anom[(anom.index >= t) & (anom.index < t + window)]
    if len(before) < 12 or len(after) < 12:
        return None
    return round(float(after.mean() / before.mean()), 3)


def denial_test(mt: pd.DataFrame) -> dict:
    """«MODIS выключили»: калибруем SNPP->Aqua на 2012–2016, восстанавливаем Aqua 2017–2020 по SNPP."""
    cfg = settings()["harmonization"]
    (tr0, tr1), (te0, te1) = cfg["denial_train"], cfg["denial_test"]
    preds, truth, inside = [], [], []
    for dn in DN:
        fit = fit_bridge(mt, "VIIRS_SNPP", "MODIS_A", tr0, tr1, dn, n_boot=100)
        a = mt[(mt.stream == "MODIS_A") & (mt.dn == dn)].set_index("month")
        b = mt[(mt.stream == "VIIRS_SNPP") & (mt.dn == dn)].set_index("month")
        for m in pd.period_range(te0, te1, freq="M"):
            if m in a.index and m in b.index and a.loc[m, "coverage"] >= 0.8 and b.loc[m, "coverage"] >= 0.8:
                beta = fit["beta"][m.month - 1]
                p = beta * b.loc[m, "celldays"] / b.loc[m, "coverage"]
                t = a.loc[m, "celldays"] / a.loc[m, "coverage"]
                s2 = fit["sigma2"][m.month - 1] + fit["sigma2_extra"]
                sd = math.sqrt(p ** 2 * s2 + beta ** 2 * max(b.loc[m, "celldays"], 1) + max(t, 1))
                preds.append((m, dn, p))
                truth.append(t)
                inside.append(abs(p - t) <= 1.96 * sd)
    if not preds:
        return {"available": False}
    pdf = pd.DataFrame(preds, columns=["month", "dn", "pred"]).assign(truth=truth)
    tot = pdf.groupby("month")[["pred", "truth"]].sum()
    tot = tot[tot.truth > 0]
    err = (tot.pred.sum() - tot.truth.sum()) / tot.truth.sum()
    rho = spearmanr(tot.pred, tot.truth).statistic if len(tot) > 3 else None
    return {
        "available": True,
        "train": [tr0, tr1], "test": [te0, te1],
        "months": int(len(tot)),
        "total_error_pct": round(100 * float(err), 1),
        "median_abs_pct_error_monthly": round(100 * float(np.median(np.abs(tot.pred - tot.truth) / tot.truth)), 1),
        "spearman_rho": None if rho is None else round(float(rho), 3),
        "interval_coverage_95": round(float(np.mean(inside)), 3),
    }


# ----------------------------------------------------------------------------- календарь
def burning_calendar(hm: pd.DataFrame, raw: pd.DataFrame) -> pd.DataFrame:
    """Календарь горения год × месяц: гармонизированное значение, сырые метрики, аномалия."""
    cal = hm.merge(raw, on="month", how="outer").sort_values("month")
    cal["year"] = cal["month"].dt.year
    cal["mon"] = cal["month"].dt.month
    med = cal.groupby("mon")["harmonized"].transform("median")
    mad = cal.groupby("mon")["harmonized"].transform(lambda s: (s - s.median()).abs().median())
    cal["anomaly_z"] = ((cal["harmonized"] - med) / (1.4826 * mad.replace(0, np.nan))).round(2)
    cal["pct_rank"] = cal.groupby("mon")["harmonized"].rank(pct=True).round(3)
    return cal


def run(filtered: pd.DataFrame) -> dict:
    """Полный цикл гармонизации. filtered — выход filters.apply_filters()."""
    cov = stream_coverage(filtered)
    cd = celldays(filtered)
    mt = monthly_stream_table(cd, cov)
    cal = fit_all_bridges(mt)
    hm = harmonized_monthly(mt, cal)
    raw = raw_monthly(cd, filtered)
    calendar = burning_calendar(hm, raw)

    series = calendar.set_index("month")
    aqua = mt[(mt.stream == "MODIS_A")].groupby("month")["celldays"].sum()
    steps = {}
    for name, when in (("SNPP_2012", "2012-01"), ("NOAA20_2018", "2018-04")):
        steps[name] = {
            "raw_detections": step_ratio(series["raw_detections"], when),
            "raw_union_celldays": step_ratio(series["raw_union_celldays"], when),
            "harmonized": step_ratio(series["harmonized"], when),
            "aqua_only": step_ratio(aqua, when),
        }
    # дрейф орбиты Aqua (после 2022 пролёт позже 13:30): отношение Aqua/SNPP по годам
    yearly = mt.assign(year=mt["month"].dt.year).groupby(["year", "stream"])["celldays"].sum().unstack()
    drift = {}
    if {"MODIS_A", "VIIRS_SNPP"} <= set(yearly.columns):
        ratio = (yearly["MODIS_A"] / yearly["VIIRS_SNPP"]).dropna()
        drift = {int(y): round(float(v), 3) for y, v in ratio.items()}
    validation = {"denial_test": denial_test(mt), "step_tests": steps, "aqua_to_snpp_ratio_by_year": drift}
    log.info("harmonization: denial=%s steps=%s", validation["denial_test"], steps)
    calib_rows = []
    for src, b in cal["bridges"].items():
        for dn in DN:
            for m in range(12):
                calib_rows.append({"stream": src, "ref": b["ref"], "dn": dn, "cal_month": m + 1,
                                   "beta": round(b[dn]["beta"][m], 4), "sigma2": round(b[dn]["sigma2"][m], 5),
                                   "sigma2_extra": round(b[dn].get("sigma2_extra", 0.0), 5),
                                   "beta_to_aqua": round(cal["to_ref"][src][dn]["beta"][m], 4),
                                   "n_months": b[dn].get("n_months", 0)})
    return {
        "celldays": cd,
        "coverage": cov,
        "monthly_streams": mt,
        "calibration": pd.DataFrame(calib_rows),
        "calendar": calendar,
        "validation": validation,
        "to_ref": cal["to_ref"],
    }


def harmonized_cell_weekly(cd: pd.DataFrame, to_ref: dict, res_col: str = "h3_r5") -> pd.DataFrame:
    """Неделя × ячейка res-5: union cell-days (любой спутник) и Aqua-шкала (среднее по доступным потокам)."""
    d = cd.copy()
    d["week"] = d["date"].dt.to_period("W-SUN").dt.start_time
    union = d[["week", res_col, "h3_r7", "date"]].drop_duplicates().groupby(["week", res_col]).size().rename("union_celldays")
    d["beta"] = [to_ref.get(s, {}).get(dn, {"beta": [1.0] * 12})["beta"][m - 1]
                 for s, dn, m in zip(d["stream"], d["dn"], d["date"].dt.month)]
    per_stream = d.groupby(["week", res_col, "stream"]).agg(cdays=("h3_r7", "size"), beta=("beta", "mean")).reset_index()
    per_stream["aqua_scale"] = per_stream["cdays"] * per_stream["beta"]
    harm = per_stream.groupby(["week", res_col])["aqua_scale"].mean().rename("harmonized_celldays")
    frp = d.groupby(["week", res_col])["frp_sum"].sum().rename("frp_sum")
    out = pd.concat([union, harm, frp], axis=1).reset_index()
    return out
