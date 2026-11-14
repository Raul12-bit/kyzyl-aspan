"""ИИ №3 на мировых данных: вероятность пожара в каждой ячейке H3 res 5 (~252 км²) на 1–4 недели вперёд.

Данные: все чистые обнаружения NASA FIRMS (MODIS c 2000 г., VIIRS S-NPP c 2012 г.) во всех странах →
недельная матрица «дней с огнём» (ячейка × неделя). Модели LightGBM, по одной на горизонт:

  full  — вся история ячейки (последние недели, 13/52 недели, давность огня, соседи, регион, климатология);
          для «Машины времени» и честной оценки (обучение 2013–2022, валидация 2023, тест 2024–2025);
  oper  — только то, что есть в любой момент «сейчас»: последние 7 дней (открытая лента NRT) +
          климатология архива прошлых лет + соседи + сезон; этой моделью считается текущий прогноз.

Оценка — на ВСЕХ ячейках мира и неделях 2024–2025 с настоящей долей пожаров (без прореживания),
против сезонного алгоритма (доля прошлых лет с огнём в те же ±2 недели).

    python -m helios.world.forecast            # обучение + оценка + прогнозы «сейчас» и «Машина времени»
"""

from __future__ import annotations

import json
import time
from datetime import date, timedelta

import h3
import lightgbm as lgb
import numpy as np
import polars as pl
from sklearn.metrics import average_precision_score, roc_auc_score

from ..config import MODELS_DIR, REPORTS_DIR
from ..utils import get_logger
from .aggregate import AGG, con, parent
from .ingest import WORLD

log = get_logger("helios.world.forecast")

EPOCH = date(2000, 1, 1)
HORIZONS = (1, 2, 3, 4)
TRAIN_WEEKS = ("2013-01-07", "2022-12-26")
VAL_WEEKS = ("2023-01-02", "2023-12-25")
TEST_WEEKS = ("2024-01-01", "2025-12-22")
VIIRS_WEEK = (date(2012, 1, 20) - EPOCH).days // 7
FULL = ["d0", "d1", "d2", "d3", "s4", "s13", "s52", "s52_prev", "since", "n4", "nb_d0", "nb_max_d0", "nb_s4",
        "reg_d0", "reg_s4", "clim_frac", "clim_days", "ly_d", "ly_win", "nb_clim", "reg_clim",
        "woy_sin", "woy_cos", "lat", "lon_sin", "lon_cos", "viirs_on"]
OPER = ["d0", "n0", "nb_d0", "nb_max_d0", "reg_d0", "clim_frac", "clim_days", "ly_d", "ly_win", "nb_clim", "reg_clim",
        "woy_sin", "woy_cos", "lat", "lon_sin", "lon_cos", "viirs_on"]
TM_DATES = ("2024-04-01", "2024-07-15", "2024-09-02", "2025-03-17", "2025-08-04", "2025-10-13")
OUT_DIR = WORLD / "forecast"


def week_of(iso: str) -> int:
    return (date.fromisoformat(iso) - EPOCH).days // 7


def week_date(w: int) -> date:
    return EPOCH + timedelta(days=7 * int(w))


class Panel:
    """Плотные матрицы ячейка × неделя: D (дней с огнём, 0–7), N (чистых обнаружений, ≤255), их суммы."""

    def __init__(self, min_weeks: int = 0) -> None:
        t0 = time.time()
        c = con()
        df = c.sql(f"""
            SELECT h3, (lday // 7)::INTEGER AS w, count(*)::INTEGER AS d, sum(n_mc + n_vc)::INTEGER AS n
            FROM read_parquet('{(AGG / 'cellday_r5.parquet').as_posix()}') WHERE bits_c > 0 AND lday >= 0
            GROUP BY 1, 2""").pl()
        cells = np.unique(df["h3"].to_numpy())
        self.cells = cells.astype(np.uint64)
        self.C = len(cells)
        self.last_week = int(df["w"].max())
        self.W = max(self.last_week + 1 + 8, min_weeks)
        ci = np.searchsorted(cells, df["h3"].to_numpy())
        w = df["w"].to_numpy()
        self.D = np.zeros((self.C, self.W), np.uint8)
        self.N = np.zeros((self.C, self.W), np.uint8)
        self.D[ci, w] = np.minimum(df["d"].to_numpy(), 7)
        self.N[ci, w] = np.minimum(df["n"].to_numpy(), 255)
        self.CS = np.zeros((self.C, self.W + 1), np.uint16)
        np.cumsum(self.D, axis=1, dtype=np.uint16, out=self.CS[:, 1:])
        # последняя неделя с огнём ≤ w: отсортированные (ячейка, неделя)
        order = np.lexsort((w, ci))
        self.fire_key = (ci[order].astype(np.int64) << 20) | w[order].astype(np.int64)
        # центры, соседи (кольцо 1), родитель res 3
        from h3ronpy import vector as h3v

        xy = h3v.cells_to_coordinates(self.cells)
        self.lat = np.asarray(xy.column("lat"), np.float32)
        self.lon = np.asarray(xy.column("lng"), np.float32)
        self.nb = np.full((self.C, 6), -1, np.int64)
        for i, x in enumerate(self.cells.tolist()):
            ring = [h3.str_to_int(k) for k in h3.grid_ring(h3.int_to_str(x), 1)]
            idx = np.searchsorted(cells, ring)
            ok = (idx < self.C) & (cells[np.minimum(idx, self.C - 1)] == np.asarray(ring, np.uint64))
            k = idx[ok][:6]
            self.nb[i, : len(k)] = k
        p3 = c.sql(f"SELECT {parent('h::UBIGINT', 3)} AS p FROM (SELECT unnest(?::UBIGINT[]) AS h)",
                   params=[self.cells.tolist()]).fetchnumpy()["p"]
        self.par_ids, self.par = np.unique(p3, return_inverse=True)
        R = np.zeros((len(self.par_ids), self.W), np.int32)
        np.add.at(R, self.par, self.D.astype(np.int32))
        self.R = R
        self.RCS = np.zeros((len(self.par_ids), self.W + 1), np.int32)
        np.cumsum(R, axis=1, out=self.RCS[:, 1:])
        self.par_size = np.bincount(self.par).astype(np.float32)
        log.info("панель: %d ячеек × %d недель, %.0f с", self.C, self.W, time.time() - t0)

    # ------------------------------------------------------------------ признаки
    def _win(self, CS: np.ndarray, rows: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
        """Сумма по неделям [a, b] (включительно) через накопленные суммы; вне диапазона — 0."""
        a = np.clip(a, 0, self.W)
        b = np.clip(b + 1, 0, self.W)
        return CS[rows, b].astype(np.int32) - CS[rows, np.minimum(a, b)].astype(np.int32)

    def features(self, ci: np.ndarray, w: np.ndarray, h: int, names: list[str]) -> np.ndarray:
        ci = np.asarray(ci, np.int64)
        w = np.asarray(w, np.int64)
        t = w + h
        D = self.D
        out: dict[str, np.ndarray] = {}
        g = lambda k: D[ci, np.clip(w - k, 0, self.W - 1)].astype(np.float32) * (w - k >= 0)  # noqa: E731
        out["d0"], out["d1"], out["d2"], out["d3"] = g(0), g(1), g(2), g(3)
        out["n0"] = np.log1p(self.N[ci, w].astype(np.float32))
        if "s4" in names:
            out["s4"] = self._win(self.CS, ci, w - 3, w).astype(np.float32)
            out["s13"] = self._win(self.CS, ci, w - 12, w).astype(np.float32)
            out["s52"] = self._win(self.CS, ci, w - 51, w).astype(np.float32)
            out["s52_prev"] = self._win(self.CS, ci, w - 103, w - 52).astype(np.float32)
            n4 = sum(self.N[ci, np.clip(w - k, 0, self.W - 1)].astype(np.float32) for k in range(4))
            out["n4"] = np.log1p(n4)
            key = (ci << 20) | w
            pos = np.searchsorted(self.fire_key, key, "right") - 1
            okp = pos >= 0
            last_ci = np.where(okp, self.fire_key[np.maximum(pos, 0)] >> 20, -1)
            last_w = np.where(okp, self.fire_key[np.maximum(pos, 0)] & ((1 << 20) - 1), -10_000)
            out["since"] = np.where(last_ci == ci, np.minimum(w - last_w, 520), 520).astype(np.float32)
        nbm = self.nb[ci]
        valid = nbm >= 0
        nbi = np.where(valid, nbm, 0)
        nb_d0 = D[nbi, w[:, None]].astype(np.float32) * valid
        out["nb_d0"] = nb_d0.mean(axis=1)
        out["nb_max_d0"] = nb_d0.max(axis=1)
        if "nb_s4" in names:
            s4n = (self.CS[nbi, np.clip(w + 1, 0, self.W)[:, None]].astype(np.int32)
                   - self.CS[nbi, np.clip(w - 3, 0, self.W)[:, None]].astype(np.int32)) * valid
            out["nb_s4"] = s4n.mean(axis=1).astype(np.float32)
        p = self.par[ci]
        size = self.par_size[p]
        out["reg_d0"] = self.R[p, w].astype(np.float32) / size
        if "reg_s4" in names:
            out["reg_s4"] = self._win(self.RCS, p, w - 3, w).astype(np.float32) / size
        # климатология: те же ±2 недели целевой недели в прошлые 1–5 лет (только прошлое)
        pres, days, nbp, regp, avail = [], [], [], [], []
        for k in range(1, 6):
            a, b = t - 52 * k - 2, t - 52 * k + 2
            ok = (a >= 0) & (b <= w)
            s = self._win(self.CS, ci, a, b) * ok
            pres.append((s > 0).astype(np.float32))
            days.append(s.astype(np.float32))
            sn = np.stack([self._win(self.CS, nbi[:, j], a, b) for j in range(6)], 1) * valid * ok[:, None]
            nbp.append((sn > 0).mean(axis=1).astype(np.float32))
            regp.append(self._win(self.RCS, p, a, b).astype(np.float32) * ok / size)
            avail.append(ok.astype(np.float32))
        av = np.maximum(np.sum(avail, axis=0), 1.0)
        out["clim_frac"] = np.sum(pres, axis=0) / av
        out["clim_days"] = np.sum(days, axis=0) / av
        out["nb_clim"] = np.sum(nbp, axis=0) / av
        out["reg_clim"] = np.sum(regp, axis=0) / av
        out["ly_d"] = D[ci, np.clip(t - 52, 0, self.W - 1)].astype(np.float32) * (t - 52 <= w)
        out["ly_win"] = days[0]
        doy = np.array([(week_date(x).timetuple().tm_yday) for x in np.unique(t)], np.float32)
        doy_map = dict(zip(np.unique(t).tolist(), doy.tolist()))
        ang = 2 * np.pi * np.array([doy_map[x] for x in t.tolist()], np.float32) / 365.25
        out["woy_sin"], out["woy_cos"] = np.sin(ang), np.cos(ang)
        out["lat"] = self.lat[ci]
        lon = np.radians(self.lon[ci])
        out["lon_sin"], out["lon_cos"] = np.sin(lon), np.cos(lon)
        out["viirs_on"] = (w >= VIIRS_WEEK).astype(np.float32)
        return np.column_stack([out[n] for n in names]).astype(np.float32)

    def target(self, ci: np.ndarray, w: np.ndarray, h: int) -> np.ndarray:
        return (self.D[ci, w + h] > 0).astype(np.uint8)


# ----------------------------------------------------------------------------- обучение
def _sample(pn: Panel, w0: int, w1: int, h: int, n_pos: int, n_neg: int, rng) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """Все/часть положительных (ячейка, неделя) + случайные отрицательные с весом (их реальная доля)."""
    sub = pn.D[:, w0 + h:w1 + h + 1]
    pc, pw = np.nonzero(sub)
    pw = pw + w0
    total_pos = len(pc)
    if total_pos > n_pos:
        k = rng.choice(total_pos, n_pos, replace=False)
        pc, pw = pc[k], pw[k]
    nc = rng.integers(0, pn.C, n_neg * 2)
    nw = rng.integers(w0, w1 + 1, n_neg * 2)
    neg = pn.D[nc, nw + h] == 0
    nc, nw = nc[neg][:n_neg], nw[neg][:n_neg]
    total_neg = pn.C * (w1 - w0 + 1) - total_pos
    w_pos = total_pos / max(len(pc), 1)
    w_neg = total_neg / max(len(nc), 1)
    ci = np.concatenate([pc, nc])
    ww = np.concatenate([pw, nw])
    wt = np.concatenate([np.full(len(pc), w_pos), np.full(len(nc), w_neg)]).astype(np.float32)
    return ci, ww, wt, total_pos / (total_pos + total_neg)


def _metrics(y: np.ndarray, p: np.ndarray, weeks: np.ndarray) -> dict:
    """ROC-AUC, PR-AUC и доля пожаров, пойманных топ-10% ячеек каждой недели."""
    out = {"roc_auc": round(float(roc_auc_score(y, p)), 4), "pr_auc": round(float(average_precision_score(y, p)), 4)}
    caught = total = 0
    for wk in np.unique(weeks):
        m = weeks == wk
        yy, pp = y[m], p[m]
        if yy.sum() == 0:
            continue
        k = max(1, int(0.1 * len(pp)))
        top = np.argpartition(-pp, k - 1)[:k]
        caught += int(yy[top].sum())
        total += int(yy.sum())
    out["top10_capture"] = round(caught / max(total, 1), 4)
    return out


def train_all(n_pos: int = 2_500_000, n_neg: int = 3_500_000, rounds: int = 600) -> dict:
    t0 = time.time()
    pn = Panel(min_weeks=(date.today() - EPOCH).days // 7 + 8)  # запас недель для прогноза «сейчас»
    rng = np.random.default_rng(42)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tr0, tr1 = week_of(TRAIN_WEEKS[0]), week_of(TRAIN_WEEKS[1])
    va0, va1 = week_of(VAL_WEEKS[0]), week_of(VAL_WEEKS[1])
    te0, te1 = week_of(TEST_WEEKS[0]), week_of(TEST_WEEKS[1])
    report: dict = {"cells": pn.C, "weeks": [TRAIN_WEEKS, VAL_WEEKS, TEST_WEEKS], "resolution": 5,
                    "cell_area_km2": round(h3.average_hexagon_area(5, "km^2"), 1), "variants": {}}
    from .regions import assign_points, region_index

    reg = assign_points(pn.lat, pn.lon)
    iso = np.array([r["iso2"] for r in region_index()] + [""], dtype=object)[reg].astype(str)
    iso_codes, iso_idx = np.unique(iso, return_inverse=True)
    for variant, names in (("full", FULL), ("oper", OPER)):
        report["variants"][variant] = {}
        for h in HORIZONS:
            t1 = time.time()
            ci, ww, wt, base = _sample(pn, tr0, tr1 - h, h, n_pos, n_neg, rng)
            X = pn.features(ci, ww, h, names)
            y = pn.target(ci, ww, h)
            vci, vww, vwt, _ = _sample(pn, va0, va1 - h, h, 400_000, 600_000, rng)
            Xv, yv = pn.features(vci, vww, h, names), pn.target(vci, vww, h)
            params = {"objective": "binary", "learning_rate": 0.06, "num_leaves": 127, "min_data_in_leaf": 200,
                      "feature_fraction": 0.85, "bagging_fraction": 0.8, "bagging_freq": 1, "lambda_l2": 1.0,
                      "num_threads": 10, "verbose": -1, "max_bin": 127}
            dtr = lgb.Dataset(X, y, weight=wt, feature_name=names, free_raw_data=True)
            dva = lgb.Dataset(Xv, yv, weight=vwt, reference=dtr)
            model = lgb.train(params, dtr, rounds, valid_sets=[dva], callbacks=[lgb.early_stopping(40, verbose=False)])
            del X, dtr
            # тест: все ячейки × все недели 2024–2025
            ps, ys, cs, ws_ = [], [], [], []
            for wk in range(te0, te1 - h + 1, 2):  # каждая вторая неделя 2024–2025: несмещённо и вдвое быстрее
                cia = np.arange(pn.C)
                wka = np.full(pn.C, wk)
                Xt = pn.features(cia, wka, h, names)
                ps.append(model.predict(Xt, num_threads=10).astype(np.float32))
                cs.append(Xt[:, names.index("clim_frac")].astype(np.float32))
                ys.append(pn.target(cia, wka, h))
                ws_.append(wka.astype(np.int32))
            p, y_t, clim, wks = np.concatenate(ps), np.concatenate(ys), np.concatenate(cs), np.concatenate(ws_)
            m_ai, m_clim = _metrics(y_t, p, wks), _metrics(y_t, clim, wks)
            by_c = {}
            cell_iso = np.tile(iso_idx.astype(np.int32), len(np.unique(wks)))
            for code in ("KZ", "RU", "BR", "AU", "US", "CD", "AO", "IN", "ID", "CA", "AR", "ZM"):
                if code not in iso_codes:
                    continue
                m = cell_iso == int(np.searchsorted(iso_codes, code))
                if m.any() and y_t[m].sum() > 50:
                    by_c[code] = {"ai_pr_auc": round(float(average_precision_score(y_t[m], p[m])), 4),
                                  "clim_pr_auc": round(float(average_precision_score(y_t[m], clim[m])), 4),
                                  "ai_roc_auc": round(float(roc_auc_score(y_t[m], p[m])), 4)}
            gain = model.feature_importance("gain")
            imp = sorted(zip(names, (gain / gain.sum()).round(4).tolist()), key=lambda x: -x[1])[:10]
            model.save_model(str(MODELS_DIR / f"world_forecast_{variant}_h{h}.txt"))
            rec = {"test": {"ai": m_ai, "baseline_climatology": m_clim, "base_rate": round(float(y_t.mean()), 5),
                            "rows": int(len(y_t))},
                   "train_rows": int(len(ci)), "train_base_rate": round(base, 5), "iterations": model.best_iteration,
                   "by_country": by_c, "importance": imp, "seconds": round(time.time() - t1)}
            report["variants"][variant][f"h{h}"] = rec
            log.info("ИИ №3 мир %s h=%d: %s vs клим %s (%.0f с)", variant, h, m_ai, m_clim, time.time() - t1)
            del p, y_t, clim, wks, ps, ys, cs, ws_
    report["seconds"] = round(time.time() - t0)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (REPORTS_DIR / "world_ai3_metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    time_machine(pn)
    try:
        report["now"] = forecast_now(pn)
    except Exception as e:  # без сети — только «Машина времени»
        log.warning("прогноз «сейчас» не посчитан: %s", e)
    return report


# ----------------------------------------------------------------------------- прогнозы
def _predict_rows(pn: Panel, w: int, variant: str, min_p: float = 0.003) -> pl.DataFrame:
    names = FULL if variant == "full" else OPER
    rows = []
    for h in HORIZONS:
        model = lgb.Booster(model_file=str(MODELS_DIR / f"world_forecast_{variant}_h{h}.txt"))
        ci = np.arange(pn.C)
        X = pn.features(ci, np.full(pn.C, w), h, names)
        p = model.predict(X, num_threads=10)
        clim = X[:, names.index("clim_frac")]
        actual = pn.D[ci, w + h] > 0 if w + h <= pn.last_week else np.zeros(pn.C, bool)
        keep = (p >= min_p) | actual
        rows.append(pl.DataFrame({"h3": pn.cells[keep], "horizon": np.full(int(keep.sum()), h, np.int8),
                                  "p": p[keep].astype(np.float32), "clim": clim[keep].astype(np.float32),
                                  "actual": actual[keep].astype(np.int8)}))
    return pl.concat(rows)


def time_machine(pn: Panel) -> list[dict]:
    """«Как будто сегодня» прошлая дата: прогноз полной моделью по всем ячейкам мира + что сгорело на самом деле."""
    out, meta = [], []
    for d in TM_DATES:
        w = week_of(d)
        rec = {"as_of": d, "horizons": {}}
        ci = np.arange(pn.C)
        for h in HORIZONS:
            model = lgb.Booster(model_file=str(MODELS_DIR / f"world_forecast_full_h{h}.txt"))
            X = pn.features(ci, np.full(pn.C, w), h, FULL)
            p = model.predict(X, num_threads=10).astype(np.float32)
            clim = X[:, FULL.index("clim_frac")]
            y = pn.target(ci, np.full(pn.C, w), h)
            if y.sum() > 0:
                rec["horizons"][str(h)] = {
                    "ai": {"roc_auc": round(float(roc_auc_score(y, p)), 4), "pr_auc": round(float(average_precision_score(y, p)), 4)},
                    "baseline": {"roc_auc": round(float(roc_auc_score(y, clim)), 4),
                                 "pr_auc": round(float(average_precision_score(y, clim)), 4)},
                    "target_week": str(week_date(w + h)), "fires": int(y.sum())}
            keep = (p >= 0.003) | (y == 1)
            out.append(pl.DataFrame({"h3": pn.cells[keep], "horizon": np.full(int(keep.sum()), h, np.int8),
                                     "p": p[keep], "clim": clim[keep].astype(np.float32), "actual": y[keep].astype(np.int8),
                                     "as_of": [d] * int(keep.sum())}))
        meta.append(rec)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pl.concat(out).write_parquet(OUT_DIR / "time_machine.parquet", compression="zstd")
    (OUT_DIR / "time_machine.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    log.info("Машина времени: %s", [(m["as_of"], m["horizons"].get("1", {}).get("ai")) for m in meta])
    return meta


def forecast_now(pn: Panel | None = None) -> dict:
    """Текущий прогноз оперативной моделью: последние 7 дней — открытая лента FIRMS NRT (весь мир)."""
    from .nrt import global_nrt_week

    cells, days, n_det, as_of = global_nrt_week()
    w_now = week_of(as_of)
    # недели между концом архива и «сейчас» остаются пустыми: оперативная модель их и не использует —
    # ей нужны только текущая неделя (NRT) и те же недели прошлых лет (архив)
    pn = pn if pn is not None and pn.W > w_now + 5 else Panel(min_weeks=w_now + 8)
    idx = np.searchsorted(pn.cells, cells)
    ok = (idx < pn.C) & (pn.cells[np.minimum(idx, pn.C - 1)] == cells)
    pn.D[:, w_now] = 0
    pn.N[:, w_now] = 0
    pn.D[idx[ok], w_now] = np.minimum(days[ok], 7)
    pn.N[idx[ok], w_now] = np.minimum(n_det[ok], 255)
    np.cumsum(pn.D, axis=1, dtype=np.uint16, out=pn.CS[:, 1:])
    pn.R[:, w_now] = np.bincount(pn.par, weights=pn.D[:, w_now].astype(np.float64), minlength=len(pn.par_ids)).astype(np.int32)
    np.cumsum(pn.R, axis=1, out=pn.RCS[:, 1:])
    os_ = OUT_DIR
    os_.mkdir(parents=True, exist_ok=True)
    df = _predict_rows(pn, w_now, "oper").with_columns(pl.lit(as_of).alias("as_of"))
    df.write_parquet(OUT_DIR / "risk_latest.parquet", compression="zstd")
    meta = {"as_of": as_of, "week_start": str(week_date(w_now)), "cells_with_fire_last_7d": int(ok.sum()),
            "new_cells_never_burned": int((~ok).sum()), "rows": df.height}
    (OUT_DIR / "risk_latest.json").write_text(json.dumps(meta), encoding="utf-8")
    log.info("прогноз сейчас: %s", meta)
    return meta


if __name__ == "__main__":
    import sys

    if "--now" in sys.argv:
        forecast_now()
    else:
        train_all()
