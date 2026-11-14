"""ИИ №1 (на борту спутника): «это настоящий пожар и станет ли он большим?»

Крошечная нейросеть (MLP ~1.6 тыс. параметров, int8 ≈ несколько КБ) работает без интернета
на слабом бортовом процессоре. Вход — только то, что есть на борту в момент съёмки:
* свойства пикселя: яркостные температуры 4/11 мкм, ΔT, FRP, площадь пикселя, угол скана,
  день/ночь по Солнцу, угол блика, уверенность продукта;
* контекст пролёта: сколько горячих пикселей рядом в той же сцене и их суммарная FRP;
* бортовая таблица истории (26 лет сжаты в ~сотни КБ): как часто эта ячейка H3 горит в этот
  месяц, известный ли это факел/завод, сколько лет здесь бывают пожары.

Два выхода:
  p_real        — это природный/растительный пожар (а не факел, блик или шум);
  p_escalation  — пожар разрастётся: ≥6 «сгоревших гексагонов» в радиусе 10 км за 72 ч.
Метки берутся из будущего (что реально произошло дальше) — модель учится предсказывать
развитие пожара по первому снимку. История для бортовой таблицы — только до 2018 г.,
обучение — 2019–2023, проверка — 2024, честный тест — 2025.
"""

from __future__ import annotations

import json
import time
from functools import lru_cache

import h3
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from sklearn.metrics import average_precision_score, roc_auc_score

from ..config import MODELS_DIR, PROCESSED, REPORTS_DIR, settings
from ..utils import get_logger, save_json

log = get_logger("helios.ai1")

FEATURES = [
    "is_viirs", "is_night", "bright_mir", "bright_tir", "dt45", "log_frp", "log_pixel_km2", "scan_deg",
    "p_conf", "glint_n", "ctx_log_n", "ctx_log_frp", "hist_clim_month", "hist_static", "hist_static_score",
    "hist_years_r7", "month_sin", "month_cos", "lat_n",
]
ONNX_PATH = MODELS_DIR / "edge_detector.onnx"
ONNX_INT8_PATH = MODELS_DIR / "edge_detector_int8.onnx"
JSON_PATH = MODELS_DIR / "edge_detector_weights.json"
TABLE_PATH = MODELS_DIR / "onboard_history.npz"
META_PATH = MODELS_DIR / "edge_detector_meta.json"


# ----------------------------------------------------------------------------- бортовая таблица
def build_onboard_table(det: pd.DataFrame, until_year: int) -> dict:
    """Сжатая история до until_year: климатология res-5 по месяцам, годы res-7, факелы res-8."""
    from ..processing.persistence import build_static_registry

    hist = det[det["acq_dt"].dt.year <= until_year]
    kept = hist[hist["keep_veg"]]
    years = kept["acq_dt"].dt.year
    n_years = max(1, int(years.nunique()))
    m = kept.assign(month=kept["acq_dt"].dt.month, year=years)[["h3_r5", "month", "year"]].drop_duplicates()
    clim = m.groupby(["h3_r5", "month"]).size().div(n_years).clip(upper=1.0)
    r5_cells = np.array(sorted(clim.index.get_level_values(0).unique()))
    clim_mat = np.zeros((len(r5_cells), 12), dtype=np.uint8)
    pos = {c: i for i, c in enumerate(r5_cells)}
    for (c, mo), v in clim.items():
        clim_mat[pos[c], mo - 1] = int(round(v * 255))
    yr7 = kept.assign(year=years)[["h3_r7", "year"]].drop_duplicates().groupby("h3_r7").size()
    reg = build_static_registry(hist)
    static = reg[reg["is_static"]]
    static_cells, static_score = [], []
    for c, s in zip(static["h3_r8"], static["static_score"]):
        for nb in h3.grid_disk(c, 1):
            static_cells.append(nb)
            static_score.append(s)
    st = pd.DataFrame({"c": static_cells, "s": static_score}).groupby("c")["s"].max()
    table = {
        "until_year": until_year,
        "n_years": n_years,
        "r5_cells": np.array([h3.str_to_int(c) for c in r5_cells], dtype=np.uint64),
        "r5_clim_u8": clim_mat,
        "r7_cells": np.array([h3.str_to_int(c) for c in yr7.index], dtype=np.uint64),
        "r7_years_u8": np.minimum(yr7.to_numpy(), 255).astype(np.uint8),
        "r8_static_cells": np.array([h3.str_to_int(c) for c in st.index], dtype=np.uint64),
        "r8_static_score_u8": (st.to_numpy() * 255).round().astype(np.uint8),
    }
    return table


def save_table(table: dict, path=TABLE_PATH) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **{k: (np.asarray(v) if not isinstance(v, int) else np.array([v])) for k, v in table.items()})
    return path.stat().st_size


@lru_cache(maxsize=1)
def load_table(path_str: str = str(TABLE_PATH)) -> dict:
    z = np.load(path_str)
    return {k: (int(z[k][0]) if z[k].shape == (1,) else z[k]) for k in z.files}


def _lookup(keys: np.ndarray, table_keys: np.ndarray, values: np.ndarray, default=0):
    order = np.argsort(table_keys)
    tk, tv = table_keys[order], values[order]
    idx = np.searchsorted(tk, keys)
    idx = np.clip(idx, 0, len(tk) - 1)
    hit = tk[idx] == keys if len(tk) else np.zeros(len(keys), bool)
    out = np.where(hit[..., None] if tv.ndim > 1 else hit, tv[idx], default)
    return out, hit


# ----------------------------------------------------------------------------- признаки
def overpass_context(df: pd.DataFrame, radius_km: float = 5.0, window_min: float = 5.0) -> tuple[np.ndarray, np.ndarray]:
    """Сколько горячих пикселей в той же сцене (тот же спутник, ±5 мин) в радиусе 5 км, и их FRP."""
    n = np.zeros(len(df), dtype=np.float32)
    frp_sum = np.zeros(len(df), dtype=np.float32)
    t = (df["acq_dt"] - pd.Timestamp("2000-01-01", tz="UTC")).dt.total_seconds().to_numpy() / 60.0
    lat0 = float(df["lat"].mean()) if len(df) else 0.0
    x = np.radians(df["lon"].to_numpy()) * 6371 * np.cos(np.radians(lat0))
    y = np.radians(df["lat"].to_numpy()) * 6371
    frp = df["frp"].fillna(0).to_numpy(np.float32)
    keys = df["stream"].astype(str).to_numpy() + "_" + df["acq_dt"].dt.year.astype(str).to_numpy()
    for k in np.unique(keys):
        idx = np.flatnonzero(keys == k)
        pts = np.column_stack([x[idx], y[idx], t[idx] * (radius_km / window_min)])
        tree = cKDTree(pts)
        nbrs = tree.query_ball_point(pts, r=radius_km)
        n[idx] = np.array([len(a) - 1 for a in nbrs], dtype=np.float32)
        frp_sum[idx] = np.array([frp[idx[a]].sum() for a in nbrs], dtype=np.float32)
    return n, frp_sum


def build_features(df: pd.DataFrame, table: dict) -> pd.DataFrame:
    is_viirs = (df["sensor"].astype(str) == "VIIRS").to_numpy(np.float32)
    ctx_n, ctx_frp = overpass_context(df)
    month = df["acq_dt"].dt.month.to_numpy()
    r5 = np.array([h3.str_to_int(c) for c in df["h3_r5"]], dtype=np.uint64)
    r7 = np.array([h3.str_to_int(c) for c in df["h3_r7"]], dtype=np.uint64)
    r8 = np.array([h3.str_to_int(c) for c in df["h3_r8"]], dtype=np.uint64)
    clim_rows, _ = _lookup(r5, table["r5_cells"], table["r5_clim_u8"])
    clim = clim_rows[np.arange(len(df)), month - 1].astype(np.float32) / 255.0 if len(df) else np.zeros(0, np.float32)
    yrs, _ = _lookup(r7, table["r7_cells"], table["r7_years_u8"])
    sscore, shit = _lookup(r8, table["r8_static_cells"], table["r8_static_score_u8"])
    out = pd.DataFrame({
        "is_viirs": is_viirs,
        "is_night": (df["daynight_sza"].astype(str) == "N").to_numpy(np.float32),
        "bright_mir": df["bright_mir"].fillna(300).to_numpy(np.float32),
        "bright_tir": df["bright_tir"].fillna(280).to_numpy(np.float32),
        "dt45": (df["bright_mir"] - df["bright_tir"]).fillna(15).to_numpy(np.float32),
        "log_frp": np.log1p(df["frp"].fillna(0).to_numpy(np.float32)),
        "log_pixel_km2": np.log(np.maximum(df["pixel_km2"].fillna(0.2).to_numpy(np.float32), 0.05)),
        "scan_deg": df["scan_deg"].fillna(0).to_numpy(np.float32),
        "p_conf": df["p_fire_raw"].fillna(0.5).to_numpy(np.float32),
        "glint_n": (np.minimum(df["glint_deg"].fillna(90).to_numpy(np.float32), 90.0) / 90.0),
        "ctx_log_n": np.log1p(ctx_n),
        "ctx_log_frp": np.log1p(ctx_frp),
        "hist_clim_month": clim,
        "hist_static": shit.astype(np.float32),
        "hist_static_score": sscore.astype(np.float32) / 255.0,
        "hist_years_r7": yrs.astype(np.float32) / max(1, table["n_years"]),
        "month_sin": np.sin(2 * np.pi * month / 12).astype(np.float32),
        "month_cos": np.cos(2 * np.pi * month / 12).astype(np.float32),
        "lat_n": ((df["lat"].to_numpy() - 48.0) / 5.0).astype(np.float32),
    })
    return out[FEATURES]


# ----------------------------------------------------------------------------- метки из будущего
def escalation_counts(det: pd.DataFrame, celldays: pd.DataFrame, radius_km: float, days_ahead: int = 3) -> np.ndarray:
    """Число «сгоревших гексагонов» (любой спутник) в радиусе R за следующие 1..days_ahead суток."""
    from ..processing.harmonize import local_date

    cd = celldays[["date", "h3_r7"]].drop_duplicates()
    ll = np.array([h3.cell_to_latlng(c) for c in cd["h3_r7"].unique()])
    centers = dict(zip(cd["h3_r7"].unique(), map(tuple, ll)))
    cd = cd.assign(lat=[centers[c][0] for c in cd["h3_r7"]], lon=[centers[c][1] for c in cd["h3_r7"]])
    lat0 = 48.0
    to_xy = lambda la, lo: np.column_stack([np.radians(lo) * 6371 * np.cos(np.radians(lat0)), np.radians(la) * 6371])
    trees = {d: cKDTree(to_xy(g["lat"].to_numpy(), g["lon"].to_numpy())) for d, g in cd.groupby("date")}
    dates = local_date(det)
    counts = np.zeros(len(det), dtype=np.int32)
    xy = to_xy(det["lat"].to_numpy(), det["lon"].to_numpy())
    for d, idx in pd.Series(np.arange(len(det))).groupby(dates.to_numpy()).groups.items():
        idx = np.asarray(idx)
        for k in range(1, days_ahead + 1):
            tree = trees.get(pd.Timestamp(d) + pd.Timedelta(days=k))
            if tree is not None:
                counts[idx] += tree.query_ball_point(xy[idx], r=radius_km, return_length=True)
    return counts


# ----------------------------------------------------------------------------- модель
def _torch_model(n_in: int, mean: np.ndarray, std: np.ndarray):
    import torch
    from torch import nn

    class EdgeMLP(nn.Module):
        def __init__(self):
            super().__init__()
            self.register_buffer("mean", torch.tensor(mean, dtype=torch.float32))
            self.register_buffer("std", torch.tensor(std, dtype=torch.float32))
            self.body = nn.Sequential(nn.Linear(n_in, 32), nn.ReLU(), nn.Linear(32, 24), nn.ReLU())
            self.head = nn.Linear(24, 2)

        def forward(self, x):
            z = self.body((x - self.mean) / self.std)
            return torch.sigmoid(self.head(z))  # [p_real, p_escalation]

    return EdgeMLP()


def train() -> dict:
    import torch

    cfg = settings()["models"]["edge"]
    t0 = time.time()
    det = pd.read_parquet(PROCESSED / "detections_filtered.parquet")
    celldays = pd.read_parquet(PROCESSED / "celldays.parquet")
    table = build_onboard_table(det, cfg["history_until_year"])
    size = save_table(table)
    load_table.cache_clear()
    log.info("onboard history table: %.1f KB", size / 1024)

    y0, y1 = cfg["train_years"]
    sub = det[det["acq_dt"].dt.year.between(y0, cfg["test_year"])].reset_index(drop=True)
    X = build_features(sub, table)
    esc = escalation_counts(sub, celldays, cfg["escalation_radius_km"], days_ahead=max(1, cfg["escalation_window_h"] // 24))
    y_real = sub["keep_veg"].to_numpy(np.float32)
    y_esc = (y_real > 0) & (esc >= cfg["escalation_min_celldays"])
    y = np.column_stack([y_real, y_esc.astype(np.float32)])
    year = sub["acq_dt"].dt.year.to_numpy()
    tr, va, te = (year >= y0) & (year <= y1), year == cfg["val_year"], year == cfg["test_year"]
    rng = np.random.default_rng(0)
    tr_idx = np.flatnonzero(tr)
    if len(tr_idx) > 900_000:
        tr_idx = rng.choice(tr_idx, 900_000, replace=False)
    Xn = X.to_numpy(np.float32)
    mean, std = Xn[tr_idx].mean(0), Xn[tr_idx].std(0) + 1e-6
    log.info("AI#1 data: train %d, val %d, test %d; real=%.3f esc=%.3f", len(tr_idx), va.sum(), te.sum(),
             y_real[tr].mean(), y_esc[tr].mean())

    torch.manual_seed(0)
    model = _torch_model(len(FEATURES), mean, std)
    pos_w = torch.tensor([1.0, float(min(8.0, (1 - y_esc[tr].mean()) / max(y_esc[tr].mean(), 1e-3)) ** 0.5)])
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-4)
    Xt, yt = torch.tensor(Xn[tr_idx]), torch.tensor(y[tr_idx])
    Xv, yv = torch.tensor(Xn[va]), y[va]
    best, best_state = -1.0, None
    for epoch in range(10):
        model.train()
        perm = torch.randperm(len(Xt))
        for i in range(0, len(perm), 2048):
            b = perm[i:i + 2048]
            p = model(Xt[b]).clamp(1e-6, 1 - 1e-6)
            loss = -(pos_w * (yt[b] * torch.log(p)) + (1 - yt[b]) * torch.log(1 - p)).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            pv = model(Xv).numpy()
        score = roc_auc_score(yv[:, 0], pv[:, 0]) + average_precision_score(yv[:, 1], pv[:, 1])
        log.info("AI#1 epoch %d: loss %.4f val real-AUC %.4f esc-AP %.4f", epoch, float(loss),
                 roc_auc_score(yv[:, 0], pv[:, 0]), average_precision_score(yv[:, 1], pv[:, 1]))
        if score > best:
            best, best_state = score, {k: v.clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    model.eval()

    with torch.no_grad():
        p_val = model(Xv).numpy()
        p_test = model(torch.tensor(Xn[te])).numpy()
    real_val = p_val[:, 0] >= 0.5
    t_crit = float(np.quantile(p_val[real_val, 1], 0.95)) if real_val.any() else 0.7
    t_high = float(np.quantile(p_val[real_val, 1], 0.80)) if real_val.any() else 0.4

    export_onnx(model, len(FEATURES))
    int8_ok = quantize_int8()
    export_json(model, mean, std, t_crit, t_high)

    yte = y[te]
    sub_te = sub[te]
    metrics = {
        "test_year": cfg["test_year"],
        "n_test": int(te.sum()),
        "p_real": {
            "roc_auc": round(float(roc_auc_score(yte[:, 0], p_test[:, 0])), 4),
            "pr_auc": round(float(average_precision_score(yte[:, 0], p_test[:, 0])), 4),
            "baseline_confidence_only_auc": round(float(roc_auc_score(yte[:, 0], sub_te["p_fire_raw"])), 4),
        },
        "p_escalation": {
            "positives_share": round(float(yte[:, 1].mean()), 4),
            "roc_auc": round(float(roc_auc_score(yte[:, 1], p_test[:, 1])), 4),
            "pr_auc": round(float(average_precision_score(yte[:, 1], p_test[:, 1])), 4),
            "baseline_frp_only_auc": round(float(roc_auc_score(yte[:, 1], sub_te["frp"].fillna(0))), 4),
            "baseline_frp_only_pr_auc": round(float(average_precision_score(yte[:, 1], sub_te["frp"].fillna(0))), 4),
        },
        "thresholds": {"critical": round(t_crit, 4), "high": round(t_high, 4), "real": 0.5},
    }
    crit = (p_test[:, 0] >= 0.5) & (p_test[:, 1] >= t_crit)
    high = (p_test[:, 0] >= 0.5) & (p_test[:, 1] >= t_high)
    metrics["critical_precision"] = round(float(yte[crit, 1].mean()), 4) if crit.any() else None
    metrics["critical_recall"] = round(float(yte[crit, 1].sum() / max(yte[:, 1].sum(), 1)), 4)
    metrics["high_or_critical_recall"] = round(float(yte[high, 1].sum() / max(yte[:, 1].sum(), 1)), 4)
    metrics["model"] = model_footprint(int8_ok)
    metrics["onboard_table_kb"] = round(size / 1024, 1)
    metrics["train_seconds"] = round(time.time() - t0, 1)
    save_json({"features": FEATURES, **metrics}, META_PATH)
    save_json(metrics, REPORTS_DIR / "ai1_edge_detector_metrics.json")
    log.info("AI#1 test: %s", metrics)
    _session.cache_clear()
    return metrics


def export_onnx(model, n_in: int) -> None:
    import torch

    dummy = torch.zeros(1, n_in)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    kwargs = dict(input_names=["features"], output_names=["probs"], dynamic_axes={"features": {0: "batch"}, "probs": {0: "batch"}},
                  opset_version=17)
    try:
        torch.onnx.export(model, dummy, str(ONNX_PATH), dynamo=False, **kwargs)
    except TypeError:
        torch.onnx.export(model, dummy, str(ONNX_PATH), **kwargs)


def quantize_int8() -> bool:
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(str(ONNX_PATH), str(ONNX_INT8_PATH), weight_type=QuantType.QInt8)
        return True
    except Exception as exc:
        log.warning("int8 quantization failed: %s", exc)
        return False


def export_json(model, mean, std, t_crit: float, t_high: float) -> None:
    """Веса в JSON: модель можно запустить хоть на микроконтроллере, хоть в браузере."""
    sd = {k: v.detach().cpu().numpy().round(6).tolist() for k, v in model.state_dict().items()}
    save_json({"features": FEATURES, "mean": np.asarray(mean).round(6).tolist(), "std": np.asarray(std).round(6).tolist(),
               "layers": [{"W": sd["body.0.weight"], "b": sd["body.0.bias"], "act": "relu"},
                          {"W": sd["body.2.weight"], "b": sd["body.2.bias"], "act": "relu"},
                          {"W": sd["head.weight"], "b": sd["head.bias"], "act": "sigmoid"}],
               "outputs": ["p_real", "p_escalation"], "thresholds": {"critical": t_crit, "high": t_high, "real": 0.5}},
              JSON_PATH)


def mlp_numpy(x: np.ndarray, weights: dict) -> np.ndarray:
    """Эталонный инференс на чистом numpy (то же, что на борту)."""
    z = (x - np.array(weights["mean"])) / np.array(weights["std"])
    for layer in weights["layers"]:
        z = z @ np.array(layer["W"]).T + np.array(layer["b"])
        z = np.maximum(z, 0) if layer["act"] == "relu" else 1 / (1 + np.exp(-z))
    return z


def model_footprint(int8_ok: bool) -> dict:
    import onnxruntime as ort

    out = {"onnx_fp32_kb": round(ONNX_PATH.stat().st_size / 1024, 1)}
    if int8_ok and ONNX_INT8_PATH.exists():
        out["onnx_int8_kb"] = round(ONNX_INT8_PATH.stat().st_size / 1024, 1)
    sess = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    x = np.random.default_rng(0).normal(size=(10_000, len(FEATURES))).astype(np.float32) * 0 + 1
    t0 = time.perf_counter()
    for _ in range(5):
        sess.run(None, {"features": x})
    out["latency_us_per_detection_cpu"] = round((time.perf_counter() - t0) / 5 / len(x) * 1e6, 3)
    w = json.loads(JSON_PATH.read_text(encoding="utf-8")) if JSON_PATH.exists() else None
    if w:
        out["parameters"] = int(sum(np.array(l["W"]).size + np.array(l["b"]).size for l in w["layers"]))
    return out


# ----------------------------------------------------------------------------- инференс
@lru_cache(maxsize=1)
def _session():
    import onnxruntime as ort

    path = ONNX_INT8_PATH if ONNX_INT8_PATH.exists() else ONNX_PATH
    return ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])


def thresholds() -> dict:
    meta = json.loads(META_PATH.read_text(encoding="utf-8")) if META_PATH.exists() else {}
    return meta.get("thresholds", {"critical": 0.6, "high": 0.35, "real": 0.5})


def score_detections(df: pd.DataFrame) -> pd.DataFrame:
    """Бортовой инференс ИИ №1 для отфильтрованных точек (после add_geometry/apply_filters)."""
    if df.empty:
        return df.assign(p_real=[], p_escalation=[], priority=[])
    X = build_features(df, load_table()).to_numpy(np.float32)
    probs = _session().run(None, {"features": X})[0]
    th = thresholds()
    out = df.copy()
    out["p_real"] = probs[:, 0].round(4)
    out["p_escalation"] = probs[:, 1].round(4)
    pr = np.where(out["p_real"] < th["real"], "SUPPRESS",
                  np.where(out["p_escalation"] >= th["critical"], "CRITICAL",
                           np.where(out["p_escalation"] >= th["high"], "HIGH", "ROUTINE")))
    out["priority"] = pd.Categorical(pr, categories=["SUPPRESS", "ROUTINE", "HIGH", "CRITICAL"], ordered=True)
    return out


def make_alerts(scored: pd.DataFrame, min_priority: str = "ROUTINE") -> pd.DataFrame:
    """Склеить пиксели одного пролёта и одной ячейки res-7 в один алерт + 24-байтный пакет."""
    from ..comms import packets

    if scored.empty:
        return pd.DataFrame()
    s = scored[scored["priority"] >= min_priority].copy()
    if s.empty:
        return pd.DataFrame()
    s["overpass"] = s["acq_dt"].dt.floor("10min")
    s["prio_rank"] = s["priority"].cat.codes
    g = s.groupby(["stream", "overpass", "h3_r7"], observed=True)
    alerts = g.agg(
        lat=("lat", "mean"), lon=("lon", "mean"), acq_dt=("acq_dt", "min"), frp_sum=("frp", "sum"),
        cluster_n=("frp", "size"), p_real=("p_real", "max"), p_escalation=("p_escalation", "max"),
        prio_rank=("prio_rank", "max"), night=("daynight_sza", lambda x: (x.astype(str) == "N").any()),
        h3_r5=("h3_r5", "first"),
    ).reset_index()
    cats = scored["priority"].cat.categories
    alerts["priority"] = [cats[i] for i in alerts["prio_rank"]]
    alerts["packet_hex"] = [
        packets.encode(p, st, int(t.timestamp()), la, lo, f, n, pe, prl,
                       flags=packets.FLAG_NIGHT if nt else 0).hex()
        for p, st, t, la, lo, f, n, pe, prl, nt in zip(
            alerts["priority"], alerts["stream"].astype(str), alerts["acq_dt"], alerts["lat"], alerts["lon"],
            alerts["frp_sum"], alerts["cluster_n"], alerts["p_escalation"], alerts["p_real"], alerts["night"])
    ]
    alerts["alert_id"] = [f"{st}-{t:%Y%m%d%H%M}-{c}" for st, t, c in zip(alerts["stream"].astype(str), alerts["overpass"], alerts["h3_r7"])]
    return alerts.drop(columns=["prio_rank"]).sort_values(["acq_dt", "priority"], ascending=[True, False]).reset_index(drop=True)
