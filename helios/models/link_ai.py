"""ИИ №2 (на борту): «пропадёт ли этот канал в ближайшие 5 минут?» → выбор канала заранее.

Вход (то, что знает спутник): геометрия пролёта (угол места, скорость его изменения, время до
ухода за горизонт), измеренный запас линии по пилот-тону и его тренд, прогноз погоды над
станцией (его заранее закладывает наземный ИИ №3), Kp, рентген, F10.7, угол на Солнце.
Выход: вероятность обрыва для канала S / X / Ka / лазер. Канал с минимальным риском и
достаточной скоростью выбирается ДО того, как связь пропадёт; при риске на всех каналах
короткие пакеты тревоги уходят первыми.

Сравнение: правило «запас < 2 дБ → обрыв» (реактивное) и физика по прогнозу погоды.
"""

from __future__ import annotations

import json
import time
from functools import lru_cache

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

from ..config import MODELS_DIR, PROCESSED, REPORTS_DIR, settings
from ..utils import get_logger, save_json

log = get_logger("helios.ai2")

FEATURES = [
    "el", "el_rate", "range_km", "t_since_aos", "t_to_los", "max_el_pass", "sun_sep", "geomag_abs", "alt_km",
    "fc_precip", "fc_cloud", "rh", "kp", "log_xray", "f107", "margin_now", "margin_trend",
    "ch_S", "ch_X", "ch_Ka", "ch_OPT",
]
ONNX_PATH = MODELS_DIR / "link_ai.onnx"
META_PATH = MODELS_DIR / "link_ai_meta.json"
JSON_PATH = MODELS_DIR / "link_ai_weights.json"


def _model(n_in: int, mean, std):
    import torch
    from torch import nn

    class LinkMLP(nn.Module):
        def __init__(self):
            super().__init__()
            self.register_buffer("mean", torch.tensor(mean, dtype=torch.float32))
            self.register_buffer("std", torch.tensor(std, dtype=torch.float32))
            self.net = nn.Sequential(nn.Linear(n_in, 32), nn.ReLU(), nn.Linear(32, 16), nn.ReLU(), nn.Linear(16, 1))

        def forward(self, x):
            return torch.sigmoid(self.net((x - self.mean) / self.std))

    return LinkMLP()


def train(days: int | None = None) -> dict:
    import torch

    from ..comms.link_sim import simulate_dataset

    cfg = settings()["models"]["link"]
    t0 = time.time()
    data = simulate_dataset(days=days or cfg["sim_days"], step_s=cfg["step_s"], min_el=cfg["min_elevation_deg"])
    data.to_parquet(PROCESSED / "link_dataset.parquet", index=False)
    # Задача ИИ №2 — РАННЕЕ предупреждение: канал сейчас жив (запас > 0), а через ≤5 мин пропадёт.
    data = data[data["margin_now"] > 0].reset_index(drop=True)
    # разбиение по пролётам (25% пролётов — тест, модель их не видела)
    passes = data["pass_id"].unique()
    test_passes = set(np.random.default_rng(3).choice(passes, size=len(passes) // 4, replace=False))
    te = data["pass_id"].isin(test_passes).to_numpy()
    tr = ~te
    X = data[FEATURES].to_numpy(np.float32)
    y = data["outage_next"].to_numpy(np.float32)
    mean, std = X[tr].mean(0), X[tr].std(0) + 1e-6
    torch.manual_seed(1)
    model = _model(len(FEATURES), mean, std)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-4)
    Xt, yt = torch.tensor(X[tr]), torch.tensor(y[tr])[:, None]
    pos_w = float(min(10.0, (1 - y[tr].mean()) / max(y[tr].mean(), 1e-3)) ** 0.5)
    for epoch in range(25):
        perm = torch.randperm(len(Xt))
        for i in range(0, len(perm), 1024):
            b = perm[i:i + 1024]
            p = model(Xt[b]).clamp(1e-6, 1 - 1e-6)
            loss = -(pos_w * yt[b] * torch.log(p) + (1 - yt[b]) * torch.log(1 - p)).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
    model.eval()
    with torch.no_grad():
        p_te = model(torch.tensor(X[te])).numpy()[:, 0]
    d_te = data[te]
    yt_ = y[te]
    rule = -d_te["margin_now"].to_numpy()  # реактивное правило: чем меньше запас сейчас, тем ближе обрыв

    def recall_at_far(score: np.ndarray, far: float = 0.05) -> float:
        thr = np.quantile(score[yt_ == 0], 1 - far)
        return round(float((score[yt_ == 1] > thr).mean()), 4) if (yt_ == 1).any() else 0.0

    metrics = {
        "rows_alive": int(len(data)), "test_rows": int(te.sum()), "outage_rate": round(float(y.mean()), 4),
        "outage_rate_by_channel": data.groupby("channel")["outage_next"].mean().round(4).to_dict(),
        "max_kp_in_data": round(float(data["kp"].max()), 2),
        "ai": {"roc_auc": round(float(roc_auc_score(yt_, p_te)), 4),
               "pr_auc": round(float(average_precision_score(yt_, p_te)), 4),
               "early_warning_recall_at_5pct_false_alarms": recall_at_far(p_te)},
        "baseline_margin_rule": {"roc_auc": round(float(roc_auc_score(yt_, rule)), 4),
                                 "pr_auc": round(float(average_precision_score(yt_, rule)), 4),
                                 "early_warning_recall_at_5pct_false_alarms": recall_at_far(rule)},
    }
    by_ch = {}
    for ch, g in d_te.assign(p=p_te, r=rule).groupby("channel"):
        if g["outage_next"].nunique() == 2:
            by_ch[ch] = {"ai_roc_auc": round(float(roc_auc_score(g["outage_next"], g["p"])), 4),
                         "ai_pr_auc": round(float(average_precision_score(g["outage_next"], g["p"])), 4),
                         "rule_pr_auc": round(float(average_precision_score(g["outage_next"], g["r"])), 4),
                         "positives": int(g["outage_next"].sum())}
    metrics["by_channel"] = by_ch

    import torch.onnx

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    kwargs = dict(input_names=["features"], output_names=["p_outage"], dynamic_axes={"features": {0: "batch"}, "p_outage": {0: "batch"}},
                  opset_version=17)
    try:
        torch.onnx.export(model, torch.zeros(1, len(FEATURES)), str(ONNX_PATH), dynamo=False, **kwargs)
    except TypeError:
        torch.onnx.export(model, torch.zeros(1, len(FEATURES)), str(ONNX_PATH), **kwargs)
    sd = {k: v.detach().numpy().round(6).tolist() for k, v in model.state_dict().items()}
    save_json({"features": FEATURES, "mean": mean.round(6).tolist(), "std": std.round(6).tolist(),
               "layers": [{"W": sd["net.0.weight"], "b": sd["net.0.bias"], "act": "relu"},
                          {"W": sd["net.2.weight"], "b": sd["net.2.bias"], "act": "relu"},
                          {"W": sd["net.4.weight"], "b": sd["net.4.bias"], "act": "sigmoid"}]}, JSON_PATH)
    metrics["model"] = {"onnx_kb": round(ONNX_PATH.stat().st_size / 1024, 1),
                        "parameters": int(sum(np.array(v).size for k, v in sd.items() if k.startswith("net")))}
    metrics["train_seconds"] = round(time.time() - t0, 1)
    save_json({"features": FEATURES, **metrics}, META_PATH)
    save_json(metrics, REPORTS_DIR / "ai2_link_metrics.json")
    _session.cache_clear()
    log.info("AI#2: %s", metrics)
    return metrics


@lru_cache(maxsize=1)
def _session():
    import onnxruntime as ort

    return ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])


def predict(df: pd.DataFrame) -> np.ndarray:
    """P(обрыв в ближайшие 5 мин) для строк с колонками FEATURES."""
    X = df.reindex(columns=FEATURES).fillna(0).to_numpy(np.float32)
    return _session().run(None, {"features": X})[0][:, 0]


def metrics() -> dict:
    return json.loads(META_PATH.read_text(encoding="utf-8")) if META_PATH.exists() else {}
