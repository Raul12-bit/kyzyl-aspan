"""Экспорт данных HELIOS в формат фронтенда Kyzyl Aspan (контракт из kyzyl-aspan/PROGRESS.md §4.1).

    python -m helios.cli export-frontend

Готовит в data/processed/kyzyl/:
* detections.json   — представительная выборка реальных обнаружений для браузерного конвейера
                      (их фильтр шума + H3 в браузере), с метками серверного фильтра HELIOS в поле truth
                      (0 — пожар, 1 — постоянный источник, 2 — прочий шум);
* arrays.npz        — все 3.7 млн обнаружений в компактном виде (для /fires и сырых счётчиков календаря);
* hexdays_r5.parquet + calibration_r5.json — «сгоревшие гексагоны» на их сетке H3 res-5 и калибровка
                      к шкале Aqua MODIS (единица календаря приложения — MODIS-equivalent hexagon-days, res 5);
* onboard_model.json — их бортовая логистическая регрессия (тот же формат и признаки), переобученная на
                      реальных данных с метками серверного фильтра и пространственной отложенной выборкой;
* overview.json     — точки для 3D-глобуса (26 лет по Казахстану + пожары мира за последние сутки).
"""

from __future__ import annotations

import io
import json
import math
from datetime import datetime, timezone

import h3
import numpy as np
import pandas as pd

from .config import PROCESSED, REPORTS_DIR, settings
from .utils import get_logger, save_json

log = get_logger("helios.frontend")

OUT = PROCESSED / "kyzyl"
EPOCH = pd.Timestamp("2000-01-01", tz="UTC")
ARCHIVE_YEARS = 27  # END_YEAR − START_YEAR + 1 во фронтенде (2000…2026)
BASE_RES, HARM_RES = 6, 5  # сетки фронтенда: факелы — res 6, статистика — res 5
NOISE_RULE = {"min_detections": 8, "min_years": 5, "min_year_share": 0.6, "min_month_spread": 7}
SAMPLE_ROWS = 60_000


def month_index(ts: pd.Series) -> np.ndarray:
    return ((ts.dt.year - 2000) * 12 + ts.dt.month - 1).to_numpy(np.int16)


# ----------------------------------------------------------------------------- все обнаружения
def build_arrays(det: pd.DataFrame) -> dict[str, np.ndarray]:
    det = det.sort_values("acq_dt").reset_index(drop=True)
    modis = (det["sensor"].astype(str) == "MODIS").to_numpy()
    conf_pct = det["conf_pct"].to_numpy(np.float32)
    cat = det["conf_cat"].astype(str).map({"l": 0, "n": 1, "h": 2}).fillna(1).to_numpy(np.uint8)
    conf = np.where(modis, np.select([conf_pct < 30, conf_pct < 80], [0, 1], 2), cat).astype(np.uint8)
    truth = np.where(det["keep_veg"], 0, np.where(det["is_static"], 1, 2)).astype(np.uint8)
    return {
        "lng": det["lon"].to_numpy(np.float32),
        "lat": det["lat"].to_numpy(np.float32),
        "day": ((det["acq_dt"] - EPOCH).dt.days).to_numpy(np.int32),
        "month": month_index(det["acq_dt"]),
        "sensor": (~modis).astype(np.uint8),  # 0 MODIS, 1 VIIRS
        "frp": det["frp"].fillna(0).to_numpy(np.float32),
        "conf": conf,
        "truth": truth,
        "lowconf": det["is_low_conf"].to_numpy(bool),
        "static": det["is_static"].to_numpy(bool),
    }


def build_sample(a: dict[str, np.ndarray], target: int = SAMPLE_ROWS, seed: int = 2026) -> tuple[list, dict]:
    """Равномерная случайная выборка (сохраняет пропорции сенсоров, эпох и классов шума)."""
    n = len(a["day"])
    rng = np.random.default_rng(seed)
    idx = np.sort(rng.choice(n, size=min(target, n), replace=False))
    rows = [
        [round(float(a["lng"][i]), 4), round(float(a["lat"][i]), 4), int(a["sensor"][i]), int(a["day"][i]),
         round(float(a["frp"][i]), 1), int(a["conf"][i]), int(a["truth"][i])]
        for i in idx
    ]
    meta = {"total_rows": int(n), "sample_rows": int(len(idx)), "sample_rate": round(len(idx) / n, 5)}
    return rows, meta


# ----------------------------------------------------------------------------- гексагон-дни res 5
def build_hexdays_r5(celldays: pd.DataFrame) -> pd.DataFrame:
    """Уникальные (поток, сутки, день/ночь, ячейка res-5) среди отфильтрованных растительных пожаров."""
    cd = celldays[["stream", "date", "dn", "h3_r5"]].drop_duplicates().copy()
    cd["day"] = (pd.to_datetime(cd["date"]).dt.tz_localize("UTC") - EPOCH).dt.days.astype(np.int32)
    cd["month"] = month_index(pd.to_datetime(cd["date"]))
    cd["sensor"] = np.where(cd["stream"].astype(str).str.startswith("MODIS"), "MODIS", "VIIRS")
    return cd[["stream", "sensor", "day", "month", "dn", "h3_r5"]].reset_index(drop=True)


def monthly_table(hd: pd.DataFrame, coverage: pd.DataFrame) -> pd.DataFrame:
    t = hd.groupby(["stream", "month", "dn"]).size().rename("celldays").reset_index()
    t["month"] = pd.PeriodIndex.from_fields(year=2000 + t["month"] // 12, month=t["month"] % 12 + 1, freq="M")
    cov = coverage.assign(month=pd.PeriodIndex(coverage["month"].astype(str), freq="M"))
    return t.merge(cov[["stream", "month", "coverage"]], on=["stream", "month"], how="left").fillna({"coverage": 0.0})


def calibration_r5(hd: pd.DataFrame, coverage: pd.DataFrame) -> dict:
    from .processing.harmonize import fit_all_bridges

    cal = fit_all_bridges(monthly_table(hd, coverage))
    return cal["to_ref"]


# ----------------------------------------------------------------------------- бортовая модель (их формат)
def _persistence(cells: np.ndarray, month: np.ndarray) -> pd.DataFrame:
    df = pd.DataFrame({"cell": cells, "year": month // 12, "cal": month % 12})
    g = df.groupby("cell")
    out = pd.DataFrame({
        "count": g.size(),
        "years": g["year"].nunique(),
        "months": g["cal"].nunique(),
        "first": g["year"].min(),
        "last": g["year"].max(),
    })
    out["year_share"] = out["years"] / (out["last"] - out["first"] + 1)
    r = NOISE_RULE
    out["is_static"] = ((out["count"] >= r["min_detections"]) & (out["years"] >= r["min_years"])
                        & (out["year_share"] >= r["min_year_share"]) & (out["months"] >= r["min_month_spread"]))
    return out


def _metrics(y: np.ndarray, pred: np.ndarray) -> dict:
    tp = int(((y == 1) & pred).sum())
    fp = int(((y == 0) & pred).sum())
    fn = int(((y == 1) & ~pred).sum())
    tn = int(((y == 0) & ~pred).sum())
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"accuracy": round((tp + tn) / max(len(y), 1), 4), "precision": round(precision, 4),
            "recall": round(recall, 4), "f1": round(f1, 4), "rows": int(len(y))}


def train_onboard(rows: list) -> dict:
    """Логистическая регрессия фронтенда (6 признаков) на реальной выборке, метки — серверный фильтр."""
    from sklearn.linear_model import LogisticRegression

    arr = np.array(rows, dtype=np.float64)
    lng, lat, frp, conf, truth = arr[:, 0], arr[:, 1], arr[:, 4], arr[:, 5].astype(int), arr[:, 6].astype(int)
    day = arr[:, 3].astype(int)
    dates = pd.to_datetime(day, unit="D", origin="2000-01-01")
    month = ((dates.year - 2000) * 12 + dates.month - 1).to_numpy()
    cells = np.array([h3.latlng_to_cell(float(b), float(a), BASE_RES) for a, b in zip(lng, lat)])
    per = _persistence(cells, month)
    p = per.loc[cells]
    X = np.column_stack([
        (conf == 0).astype(float), (conf == 2).astype(float), np.log1p(np.maximum(frp, 0)),
        p["years"].to_numpy() / ARCHIVE_YEARS, p["months"].to_numpy() / 12.0, np.log1p(p["count"].to_numpy()),
    ])
    y = (truth == 0).astype(int)
    # пространственная отложенная выборка: целые блоки H3 res-2, которые модель не видела
    blocks = np.array([h3.cell_to_parent(c, 2) for c in cells])
    test = np.array([int(b, 16) % 5 == 0 for b in blocks])
    mean = X[~test].mean(0)
    scale = X[~test].std(0)
    scale[scale == 0] = 1.0
    Z = (X - mean) / scale
    clf = LogisticRegression(class_weight="balanced", C=1.0, max_iter=2000)
    clf.fit(Z[~test], y[~test])
    p_train = clf.predict_proba(Z[~test])[:, 1]
    best_t, best_f1 = 0.5, -1.0
    for t in np.linspace(0.2, 0.8, 25):
        f1 = _metrics(y[~test], p_train >= t)["f1"]
        if f1 > best_f1:
            best_t, best_f1 = float(t), f1
    p_test = clf.predict_proba(Z[test])[:, 1]
    baseline = (conf != 0) & ~p["is_static"].to_numpy()
    return {
        "version": "helios-2026.11-real",
        "kind": "logistic-regression",
        "features": ["lowConfidence", "highConfidence", "logFrp", "yearsActive", "monthSpread", "logCellCount"],
        "mean": [round(float(v), 6) for v in mean],
        "scale": [round(float(v), 6) for v in scale],
        "weights": [round(float(v), 6) for v in clf.coef_[0]],
        "bias": round(float(clf.intercept_[0]), 6),
        "threshold": round(best_t, 3),
        "metrics": {
            "test": _metrics(y[test], p_test >= best_t),
            "baseline": _metrics(y[test], baseline[test]),
            "trainRows": int((~test).sum()),
        },
        "trainedOn": {
            "period": "2000-11..2025-12",
            "synthetic": False,
            "note": "Real NASA FIRMS detections (Kazakhstan, MODIS + VIIRS). Labels = HELIOS server-side noise filter "
                    "(4-evidence static registry, glint, isolation, cross-sensor support). Spatial hold-out: H3 res-2 blocks.",
        },
    }


# ----------------------------------------------------------------------------- глобус
def kz_overview(a: dict[str, np.ndarray], res: int = 3) -> list[list[float]]:
    keep = a["truth"] == 0
    cells = pd.Series([h3.latlng_to_cell(float(la), float(lo), res) for la, lo in zip(a["lat"][keep][::5], a["lng"][keep][::5])])
    counts = cells.value_counts()
    top = math.log1p(float(counts.max()))
    out = []
    for c, n in counts.items():
        la, lo = h3.cell_to_latlng(c)
        out.append([round(lo, 3), round(la, 3), round(math.log1p(float(n)) / top, 3)])
    return out


def global_overview(res: int = 2) -> dict | None:
    """Пожары всего мира за последние 24 ч (FIRMS MODIS, открытая лента без ключа)."""
    from .apis.firms import _get_with_deadline

    url = f"{settings()['apis']['firms']}/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv"
    try:
        status, text = _get_with_deadline(url, deadline_s=90)
    except Exception as exc:
        log.warning("global overview: %s", exc)
        return None
    if status != 200 or len(text) < 200:
        return None
    df = pd.read_csv(io.StringIO(text), usecols=["latitude", "longitude", "confidence"])
    df = df[pd.to_numeric(df["confidence"], errors="coerce") >= 30]
    cells = pd.Series([h3.latlng_to_cell(float(la), float(lo), res) for la, lo in zip(df["latitude"], df["longitude"])])
    counts = cells.value_counts()
    top = math.log1p(float(counts.max())) if len(counts) else 1.0
    pts = []
    for c, n in counts.items():
        la, lo = h3.cell_to_latlng(c)
        pts.append([round(lo, 3), round(la, 3), round(0.35 + 0.5 * math.log1p(float(n)) / top, 3)])
    payload = {"points": pts, "detections": int(len(df)), "computed_at": datetime.now(timezone.utc).isoformat()}
    OUT.mkdir(parents=True, exist_ok=True)
    save_json(payload, OUT / "overview_global.json")
    return payload


# ----------------------------------------------------------------------------- всё сразу
def export_all() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    det = pd.read_parquet(PROCESSED / "detections_filtered.parquet",
                          columns=["lat", "lon", "acq_dt", "sensor", "frp", "conf_pct", "conf_cat", "keep_veg",
                                   "is_static", "is_low_conf"])
    a = build_arrays(det)
    np.savez_compressed(OUT / "arrays.npz", **a)
    rows, meta = build_sample(a)
    sample = {"version": "helios-2026.11-real", "epoch": "2000-01-01", "synthetic": False,
              "fields": ["lng", "lat", "sensor", "day", "frp", "confidence", "truth"],
              "truthMeaning": "HELIOS server filter: 0 vegetation fire, 1 persistent heat source, 2 other noise",
              "rows": rows, **meta}
    (OUT / "detections.json").write_text(json.dumps(sample, separators=(",", ":")), encoding="utf-8")
    log.info("detections sample: %s", meta)

    cd = pd.read_parquet(PROCESSED / "celldays.parquet", columns=["stream", "date", "dn", "h3_r5"])
    hd = build_hexdays_r5(cd)
    hd.to_parquet(OUT / "hexdays_r5.parquet", index=False)
    coverage = pd.read_parquet(PROCESSED / "stream_coverage.parquet")
    save_json(calibration_r5(hd, coverage), OUT / "calibration_r5.json")

    model = train_onboard(rows)
    save_json(model, OUT / "onboard_model.json")
    log.info("onboard model (real): test %s | baseline %s", model["metrics"]["test"], model["metrics"]["baseline"])

    save_json({"points": kz_overview(a), "computed_at": datetime.now(timezone.utc).isoformat()}, OUT / "overview_kz.json")
    global_overview()
    summary = {"sample": meta, "hexdays_rows": int(len(hd)), "onboard": model["metrics"]}
    save_json(summary, REPORTS_DIR / "frontend_export.json")
    return summary
