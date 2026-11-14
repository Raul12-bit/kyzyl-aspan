"""ИИ №3 (Земля, «суперкомпьютер»): прогноз пожарного риска на 1–4 недели по ячейкам H3.

Модель: HistGradientBoosting (sklearn) на панели «ячейка res-5 × неделя».
Обучение 2013–2022, валидация 2023, честный тест 2024–2025 (модель этих лет не видела).
Сравнение с базовыми линиями:
* сезонная климатология (как «обычно горит в эту неделю»),
* персистентность (горело на этой неделе → будет гореть на следующей).
"""

from __future__ import annotations

import json
import time

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from ..config import MODELS_DIR, REPORTS_DIR, settings
from ..utils import get_logger, save_json
from .features import FEATURES, Panel

log = get_logger("helios.ai3")

HORIZONS = (1, 2, 3, 4)
_PANEL: Panel | None = None


def panel() -> Panel:
    global _PANEL
    if _PANEL is None:
        _PANEL = Panel()
    return _PANEL


def _metrics(y: np.ndarray, p: np.ndarray) -> dict:
    if y.sum() == 0 or y.sum() == len(y):
        return {"n": int(len(y)), "positives": int(y.sum())}
    order = np.argsort(-p)
    top10 = order[: max(1, len(p) // 10)]
    return {
        "n": int(len(y)),
        "positives": int(y.sum()),
        "roc_auc": round(float(roc_auc_score(y, p)), 4),
        "pr_auc": round(float(average_precision_score(y, p)), 4),
        "brier": round(float(brier_score_loss(y, np.clip(p, 0, 1))), 5),
        "recall_top10pct": round(float(y[top10].sum() / y.sum()), 4),
    }


def fit_model(pn: Panel, horizon: int, train_end: str, val_year: int | None = None,
              train_start: str = "2013-01-01") -> HistGradientBoostingClassifier:
    rate = settings()["models"]["ground"]["negative_sample_rate"]
    Xtr, ytr, wtr = pn.rows(pn.week_index(train_start, train_end), horizon, neg_rate=rate, seed=horizon)
    model = HistGradientBoostingClassifier(
        max_iter=500, learning_rate=0.06, max_leaf_nodes=63, min_samples_leaf=80,
        l2_regularization=1.0, early_stopping=True, validation_fraction=0.1, n_iter_no_change=25,
        random_state=horizon,
    )
    model.fit(Xtr[FEATURES], ytr, sample_weight=wtr)
    log.info("AI#3 h=%d: trained on %d rows (%d positives), %d iters", horizon, len(ytr), int(ytr.sum()), model.n_iter_)
    return model


def evaluate(pn: Panel, model, horizon: int, start: str, end: str) -> dict:
    X, y, _ = pn.rows(pn.week_index(start, end), horizon)
    p_ai = model.predict_proba(X[FEATURES])[:, 1]
    return {
        "ai": _metrics(y, p_ai),
        "baseline_climatology": _metrics(y, X["clim_woy_next"].to_numpy()),
        "baseline_persistence": _metrics(y, (X["a_t"].to_numpy() > 0).astype(float) * 0.9 + X["clim_woy_next"].to_numpy() * 0.1),
    }


def train() -> dict:
    cfg = settings()["models"]["ground"]
    pn = panel()
    tr0, tr1 = cfg["train_years"]
    report = {"train": [tr0, tr1], "val": cfg["val_year"], "test": cfg["test_years"], "horizons": {}}
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    for h in HORIZONS:
        t0 = time.time()
        model = fit_model(pn, h, f"{tr1}-12-31", train_start=f"{tr0}-01-01")
        val = evaluate(pn, model, h, f"{cfg['val_year']}-01-01", f"{cfg['val_year']}-12-31")
        test = evaluate(pn, model, h, f"{cfg['test_years'][0]}-01-01", f"{cfg['test_years'][-1]}-12-31")
        joblib.dump({"model": model, "features": FEATURES, "horizon": h, "train_end": f"{tr1}-12-31"},
                    MODELS_DIR / f"ground_forecast_h{h}.joblib")
        report["horizons"][f"h{h}"] = {"val": val, "test": test, "seconds": round(time.time() - t0, 1)}
        log.info("AI#3 h=%d test: AI %s | clim %s", h, test["ai"], test["baseline_climatology"])
    # важность признаков (перестановочная, на подвыборке теста) для горизонта 1 недели
    try:
        from sklearn.inspection import permutation_importance

        m1 = joblib.load(MODELS_DIR / "ground_forecast_h1.joblib")["model"]
        X, y, _ = pn.rows(pn.week_index(f"{cfg['test_years'][0]}-04-01", f"{cfg['test_years'][0]}-10-31"), 1, neg_rate=0.2)
        imp = permutation_importance(m1, X[FEATURES], y, n_repeats=3, random_state=0, scoring="average_precision")
        report["feature_importance_h1"] = dict(sorted(
            {f: round(float(v), 4) for f, v in zip(FEATURES, imp.importances_mean)}.items(), key=lambda kv: -kv[1]))
    except Exception as exc:
        log.warning("permutation importance: %s", exc)
    save_json(report, REPORTS_DIR / "ai3_ground_forecast_metrics.json")
    return report


def load(horizon: int = 1) -> dict:
    return joblib.load(MODELS_DIR / f"ground_forecast_h{horizon}.joblib")


def predict_week(week_start: str | pd.Timestamp, horizon: int = 1, model_bundle: dict | None = None) -> pd.DataFrame:
    """Риск на неделю (week_start + horizon) для всех ячеек по данным до конца week_start."""
    pn = panel()
    w = int(pd.Index(pn.weeks).get_indexer([pd.Timestamp(week_start).normalize()], method="ffill")[0])
    bundle = model_bundle or load(horizon)
    X, y, _ = pn.rows(np.array([w]), horizon, allow_future=True)
    prob = bundle["model"].predict_proba(X[bundle["features"]])[:, 1]
    out = pd.DataFrame({
        "h3_r5": pn.cells[X["cell_idx"].to_numpy()],
        "lat": X["lat"].to_numpy(), "lon": X["lon"].to_numpy(),
        "as_of_week": pn.weeks[w], "target_week": pd.Timestamp(pn.weeks[w]) + pd.Timedelta(weeks=horizon),
        "horizon_weeks": horizon,
        "p_fire": prob.round(4),
        "p_climatology": X["clim_woy_next"].to_numpy().round(4),
        "recent_celldays_4w": X["sum4"].to_numpy(),
        "precip_28d": X["precip_28d"].to_numpy().round(1),
        "gwet": X["gwet"].to_numpy().round(3),
        "actual": y,
    })
    return out


# ----------------------------------------------------------------------------- задержки спутников
def satellite_delay_report(hours: int = 24) -> pd.DataFrame:
    """Какой спутник «опаздывает»: задержка гранул NRT по CMR + робастная аномалия."""
    from ..apis.earthdata import granule_latency, latency_report

    lat = granule_latency(hours=hours)
    rep = latency_report(lat)
    if len(rep):
        save_json(json.loads(rep.to_json(orient="records", date_format="iso")), REPORTS_DIR / "satellite_delays.json")
    return rep
