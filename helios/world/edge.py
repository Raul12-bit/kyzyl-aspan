"""ИИ №1 v2 на мировых данных: бортовая оценка каждого горячего пикселя — «настоящий ли пожар?» и
«разрастётся ли за 72 ч?». Только признаки, которые спутник считает сам в момент съёмки, + компактная
бортовая таблица истории (по данным до 2017 г. включительно — тест 2024–2025 честный).

Признаки: сенсор, ночь, яркостные температуры (MIR/TIR) и их разность, FRP, площадь пикселя, размер
скана, уверенность продукта, местное солнечное время, месяц, широта, число горячих пикселей рядом
(в той же ячейке H3 res 7 за сутки), бортовая история: климатология месяца для ячейки res 5 и
«известный постоянный источник» (реестр по данным ≤ 2017).

Метки (из того, что произошло на самом деле):
  real        — поле FIRMS type = 0 и точка не в мировом реестре постоянных источников (все годы);
  escalation  — real и ≥ 3 чистых обнаружения в той же ячейке res 7 за следующие 3 суток.

    python -m helios.world.edge
"""

from __future__ import annotations

import json
import time

import h3
import numpy as np
import polars as pl
from sklearn.metrics import average_precision_score, roc_auc_score

from ..config import MODELS_DIR, REPORTS_DIR
from ..utils import get_logger, save_json
from .aggregate import AGG, EPOCH, LDAY, con, parent
from .ingest import DET_DIR

log = get_logger("helios.world.edge")

FEATURES = ["is_viirs", "is_night", "bright_mir", "bright_tir", "dt45", "log_frp", "log_pixel_km2", "scan_km",
            "p_conf", "hour_sin", "hour_cos", "month_sin", "month_cos", "lat_n", "ctx_log_n",
            "hist_clim_month", "hist_static", "hist_years"]
JSON_PATH = MODELS_DIR / "edge_detector_world_weights.json"
ONNX_PATH = MODELS_DIR / "edge_detector_world.onnx"
HIST_UNTIL = 2017
YEARS = (2018, 2025)
TRAIN, VAL, TEST = (2018, 2022), 2023, (2024, 2025)


def _static_set_until(c, year: int) -> None:
    """Реестр постоянных источников только по данным ≤ year (для бортовой таблицы)."""
    from datetime import date

    g = (DET_DIR / "*.parquet").as_posix()
    d_end = (date(year + 1, 1, 1) - date(2000, 1, 1)).days
    c.execute(f"""
        CREATE OR REPLACE TEMP TABLE h8 AS
        SELECT h3, count(*) AS n, avg((type IN (1,2,3))::DOUBLE) AS st
        FROM read_parquet('{g}') WHERE day < {d_end} GROUP BY h3 HAVING count(*) >= 6""")
    c.execute(f"""
        CREATE OR REPLACE TEMP TABLE hist8 AS
        SELECT h3 FROM h8 WHERE st >= 0.5
        UNION
        SELECT h3 FROM (
            SELECT h3, count(*) AS ny FROM (
                SELECT p.h3, year({EPOCH} + p.day::INTEGER) AS y FROM read_parquet('{g}') p
                SEMI JOIN (SELECT h3 FROM h8 WHERE st < 0.5 AND n >= 30) k ON p.h3 = k.h3
                WHERE p.day < {d_end} GROUP BY 1, 2
            ) GROUP BY 1
        ) WHERE ny >= 3""")
    cells = c.sql("SELECT h3 FROM hist8").fetchnumpy()["h3"]
    ring: set[int] = set()
    for x in cells.tolist():
        ring.update(h3.str_to_int(k) for k in h3.grid_disk(h3.int_to_str(int(x)), 1))
    c.register("hist_ring_df", pl.DataFrame({"h3": np.fromiter(ring, dtype=np.uint64)}).to_arrow())
    c.execute("CREATE OR REPLACE TEMP TABLE hist_ring AS SELECT h3::UBIGINT AS h3 FROM hist_ring_df")
    log.info("бортовой реестр ≤ %d: %d ячеек (с буфером %d)", year, len(cells), len(ring))


def build_dataset(per_file: dict[str, int] | None = None) -> pl.DataFrame:
    t0 = time.time()
    per_file = per_file or {"modis": 180_000, "viirs-snpp": 360_000}
    c = con()
    files = []
    for p in sorted(DET_DIR.glob("*.parquet")):
        kind, year = p.stem.rsplit("_", 1)
        if YEARS[0] <= int(year) <= YEARS[1]:
            files.append((p.as_posix(), per_file["modis" if kind == "modis" else "viirs-snpp"]))
    parts = " UNION ALL ".join(
        f"SELECT * FROM (SELECT * FROM read_parquet('{f}') USING SAMPLE reservoir({k} ROWS) REPEATABLE (3))" for f, k in files)
    c.execute(f"""
        CREATE OR REPLACE TEMP TABLE s AS
        SELECT row_number() OVER () AS id, *, {parent('h3', 7)} AS r7, {parent('h3', 5)} AS r5, {LDAY} AS lday,
               month({EPOCH} + day::INTEGER) AS mon, year({EPOCH} + day::INTEGER) AS yr
        FROM ({parts})""")
    # реестр всех лет (метка) и реестр ≤ 2017 (бортовой признак)
    st = pl.read_parquet(AGG / "static_r8.parquet", columns=["h3"])
    ring: set[int] = set()
    for x in st["h3"].to_list():
        ring.update(h3.str_to_int(k) for k in h3.grid_disk(h3.int_to_str(x), 1))
    c.register("label_ring_df", pl.DataFrame({"h3": np.fromiter(ring, dtype=np.uint64)}).to_arrow())
    c.execute("CREATE OR REPLACE TEMP TABLE label_ring AS SELECT h3::UBIGINT AS h3 FROM label_ring_df")
    _static_set_until(c, HIST_UNTIL)
    cd7 = (AGG / "cellday_r7.parquet").as_posix()
    cm5 = (AGG / "cellmonth_r5.parquet").as_posix()
    cm7 = (AGG / "cellmonth_r7.parquet").as_posix()
    last_m = (HIST_UNTIL - 2000) * 12 + 11
    df = c.sql(f"""
        WITH ctx AS (
            SELECT s.id, coalesce(max(c.n_r), 0) AS ctx_n FROM s LEFT JOIN read_parquet('{cd7}') c
            ON c.h3 = s.r7 AND c.lday = s.lday GROUP BY s.id),
        fut AS (
            SELECT s.id, coalesce(sum(c.n_mc + c.n_vc), 0) AS fut_n FROM s LEFT JOIN read_parquet('{cd7}') c
            ON c.h3 = s.r7 AND c.lday BETWEEN s.lday + 1 AND s.lday + 3 GROUP BY s.id),
        clim AS (
            SELECT h3, mon, count(*)::DOUBLE / {HIST_UNTIL - 2000 + 1} AS clim FROM (
                SELECT h3, (month % 12) + 1 AS mon, month // 12 AS y FROM read_parquet('{cm5}')
                WHERE month <= {last_m} AND d_ca > 0 GROUP BY 1, 2, 3) GROUP BY 1, 2),
        yrs AS (
            SELECT h3, count(*)::DOUBLE / {HIST_UNTIL - 2000 + 1} AS years FROM (
                SELECT h3, month // 12 AS y FROM read_parquet('{cm7}')
                WHERE month <= {last_m} AND d_ca > 0 GROUP BY 1, 2) GROUP BY 1)
        SELECT s.id, s.sat, s.night, s.bt, s.bt2, s.frp, s.scan, s.track, s.conf, s.hhmm, s.lon, s.lat, s.mon, s.yr,
               (s.type = 0 AND lr.h3 IS NULL) AS y_real, (hr.h3 IS NOT NULL) AS hist_static,
               ctx.ctx_n, fut.fut_n, coalesce(clim.clim, 0) AS hist_clim, coalesce(yrs.years, 0) AS hist_years
        FROM s
        LEFT JOIN label_ring lr ON lr.h3 = s.h3
        LEFT JOIN hist_ring hr ON hr.h3 = s.h3
        LEFT JOIN ctx ON ctx.id = s.id
        LEFT JOIN fut ON fut.id = s.id
        LEFT JOIN clim ON clim.h3 = s.r5 AND clim.mon = s.mon
        LEFT JOIN yrs ON yrs.h3 = s.r7""").pl()
    log.info("датасет ИИ №1 мир: %d строк, %.0f с", df.height, time.time() - t0)
    return df


def features(df: pl.DataFrame) -> np.ndarray:
    viirs = (df["sat"].to_numpy() >= 2).astype(np.float32)
    bt = df["bt"].fill_null(330).to_numpy().astype(np.float32)
    bt2 = df["bt2"].fill_null(295).to_numpy().astype(np.float32)
    scan = df["scan"].fill_null(1).to_numpy().astype(np.float32)
    track = df["track"].fill_null(1).to_numpy().astype(np.float32)
    hh = df["hhmm"].to_numpy()
    hour = ((hh // 100) + (hh % 100) / 60.0 + df["lon"].to_numpy() / 15.0) % 24
    mon = df["mon"].to_numpy()
    conf = df["conf"].to_numpy()
    cols = {
        "is_viirs": viirs, "is_night": df["night"].to_numpy().astype(np.float32), "bright_mir": bt, "bright_tir": bt2,
        "dt45": bt - bt2, "log_frp": np.log1p(np.maximum(df["frp"].to_numpy(), 0)).astype(np.float32),
        "log_pixel_km2": np.log(np.maximum(scan * track, 0.01)), "scan_km": scan,
        "p_conf": np.choose(conf.astype(int), [0.3, 0.6, 0.9]).astype(np.float32),
        "hour_sin": np.sin(2 * np.pi * hour / 24).astype(np.float32), "hour_cos": np.cos(2 * np.pi * hour / 24).astype(np.float32),
        "month_sin": np.sin(2 * np.pi * (mon - 1) / 12).astype(np.float32), "month_cos": np.cos(2 * np.pi * (mon - 1) / 12).astype(np.float32),
        "lat_n": (df["lat"].to_numpy() / 90.0).astype(np.float32), "ctx_log_n": np.log1p(df["ctx_n"].to_numpy()).astype(np.float32),
        "hist_clim_month": df["hist_clim"].to_numpy().astype(np.float32),
        "hist_static": df["hist_static"].to_numpy().astype(np.float32),
        "hist_years": df["hist_years"].to_numpy().astype(np.float32),
    }
    return np.column_stack([cols[f] for f in FEATURES]).astype(np.float32)


def train(epochs: int = 8) -> dict:
    import torch

    from ..models.edge_detector import _torch_model

    t0 = time.time()
    df = build_dataset()
    X = features(df)
    y_real = df["y_real"].to_numpy().astype(np.float32)
    y_esc = ((y_real > 0) & (df["fut_n"].to_numpy() >= 3)).astype(np.float32)
    y = np.column_stack([y_real, y_esc])
    yr = df["yr"].to_numpy()
    tr = (yr >= TRAIN[0]) & (yr <= TRAIN[1])
    va = yr == VAL
    te = (yr >= TEST[0]) & (yr <= TEST[1])
    mean, std = X[tr].mean(0), X[tr].std(0) + 1e-6
    # калибровочная выборка для бортового int8 (helios/onboard/export_c.py)
    np.save(MODELS_DIR / "edge_world_calib.npy", X[np.random.default_rng(1).choice(len(X), min(60_000, len(X)), replace=False)])
    torch.manual_seed(0)
    model = _torch_model(len(FEATURES), mean, std)
    pos_w = torch.tensor([1.0, float(min(8.0, (1 - y_esc[tr].mean()) / max(y_esc[tr].mean(), 1e-3)) ** 0.5)])
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-4)
    Xt, yt = torch.tensor(X[tr]), torch.tensor(y[tr])
    Xv, yv = torch.tensor(X[va]), y[va]
    best, best_state = -1.0, None
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(len(Xt))
        for i in range(0, len(perm), 4096):
            b = perm[i:i + 4096]
            p = model(Xt[b]).clamp(1e-6, 1 - 1e-6)
            loss = -(pos_w * (yt[b] * torch.log(p)) + (1 - yt[b]) * torch.log(1 - p)).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            pv = model(Xv).numpy()
        score = roc_auc_score(yv[:, 0], pv[:, 0]) + average_precision_score(yv[:, 1], pv[:, 1])
        log.info("ИИ №1 мир, эпоха %d: real-AUC %.4f esc-AP %.4f", epoch, roc_auc_score(yv[:, 0], pv[:, 0]),
                 average_precision_score(yv[:, 1], pv[:, 1]))
        if score > best:
            best, best_state = score, {k: v.clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        p_val = model(Xv).numpy()
        p_te = model(torch.tensor(X[te])).numpy()
    real_val = p_val[:, 0] >= 0.5
    t_crit = float(np.quantile(p_val[real_val, 1], 0.95))
    t_high = float(np.quantile(p_val[real_val, 1], 0.80))
    sd = {k: v.detach().numpy() for k, v in model.state_dict().items()}
    layers = [{"W": sd["body.0.weight"].round(6).tolist(), "b": sd["body.0.bias"].round(6).tolist(), "act": "relu"},
              {"W": sd["body.2.weight"].round(6).tolist(), "b": sd["body.2.bias"].round(6).tolist(), "act": "relu"},
              {"W": sd["head.weight"].round(6).tolist(), "b": sd["head.bias"].round(6).tolist(), "act": "sigmoid"}]
    save_json({"features": FEATURES, "mean": mean.round(6).tolist(), "std": std.round(6).tolist(), "layers": layers,
               "outputs": ["p_real", "p_escalation"], "thresholds": {"critical": t_crit, "high": t_high, "real": 0.5},
               "history_until": HIST_UNTIL}, JSON_PATH)
    try:
        torch.onnx.export(model, torch.zeros(1, len(FEATURES)), str(ONNX_PATH), dynamo=False, input_names=["features"],
                          output_names=["probs"], dynamic_axes={"features": {0: "batch"}, "probs": {0: "batch"}}, opset_version=17)
    except TypeError:
        torch.onnx.export(model, torch.zeros(1, len(FEATURES)), str(ONNX_PATH), input_names=["features"],
                          output_names=["probs"], dynamic_axes={"features": {0: "batch"}, "probs": {0: "batch"}}, opset_version=17)
    yte = y[te]
    conf_te = X[te][:, FEATURES.index("p_conf")]
    frp_te = X[te][:, FEATURES.index("log_frp")]
    params = int(sum(v.size for k, v in sd.items() if k.startswith(("body", "head")) and v.ndim >= 1))
    metrics = {
        "scope": "world", "train_years": list(TRAIN), "val_year": VAL, "test_years": list(TEST), "history_until": HIST_UNTIL,
        "n_train": int(tr.sum()), "n_test": int(te.sum()),
        "p_real": {"roc_auc": round(float(roc_auc_score(yte[:, 0], p_te[:, 0])), 4),
                   "pr_auc": round(float(average_precision_score(yte[:, 0], p_te[:, 0])), 4),
                   "baseline_confidence_only_auc": round(float(roc_auc_score(yte[:, 0], conf_te)), 4),
                   "real_share": round(float(yte[:, 0].mean()), 4)},
        "p_escalation": {"positives_share": round(float(yte[:, 1].mean()), 4),
                         "roc_auc": round(float(roc_auc_score(yte[:, 1], p_te[:, 1])), 4),
                         "pr_auc": round(float(average_precision_score(yte[:, 1], p_te[:, 1])), 4),
                         "baseline_frp_only_auc": round(float(roc_auc_score(yte[:, 1], frp_te)), 4),
                         "baseline_frp_only_pr_auc": round(float(average_precision_score(yte[:, 1], frp_te)), 4)},
        "thresholds": {"critical": round(t_crit, 4), "high": round(t_high, 4), "real": 0.5},
        "model": {"parameters": params, "onnx_fp32_kb": round(ONNX_PATH.stat().st_size / 1024, 1)},
        "seconds": round(time.time() - t0),
    }
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (REPORTS_DIR / "ai1_world_metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("ИИ №1 мир, тест 2024–2025: %s", json.dumps(metrics, ensure_ascii=False)[:500])
    return metrics


if __name__ == "__main__":
    train()
