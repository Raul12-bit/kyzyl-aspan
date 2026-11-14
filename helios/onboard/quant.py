"""Квантование MLP в int8 и эталонный целочисленный инференс (бит-в-бит как в C).

Схема (как в TFLite Micro, но проще и без float на борту):
  вход   z = (x − mean) / std  →  x_q = clip(round(z / s_i), −127, 127); s_i — свой масштаб признака:
         ≥ 4σ, а у тяжёлых хвостов (ливень, запас линии в бурю) — до 99,99-го процентиля |z|;
         масштаб входа вносится в веса первого слоя, поэтому на борту ничего не меняется
  слой   acc_j = Σ W_q[j,i]·x_q[i] + B_q[j]          (int32; W_q — int8 с масштабом на строку)
  ReLU   y_j = clip(rshift_round(acc_j · M_j, 24), 0, 127)   (M_j — множитель Q24, int32)
  выход  logit_q8 = rshift_round(acc_j · M_j, 24)  →  p_q15 = сигмоида по таблице 257 точек + интерполяция
rshift_round — симметричное округление только сдвигами неотрицательных чисел: одинаково на любом
компиляторе и процессоре (сдвиг отрицательных чисел в C зависит от реализации).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

S_IN = 4.0 / 127.0
Q = 24
LUT_LO, LUT_STEP_SHIFT, LUT_N = -2048, 4, 257  # logit Q8 ∈ [−8, 8], шаг 1/16


@dataclass
class QLayer:
    w: np.ndarray  # int8 [n_out, n_in]
    b: np.ndarray  # int32 [n_out]
    m: np.ndarray  # int32 [n_out] — множитель Q24
    act: str       # "relu" | "sigmoid"
    s_in: float
    s_out: float   # масштаб выхода (для ReLU); для сигмоиды — 1/256 (логит в Q8)


@dataclass
class QModel:
    name: str
    features: list[str]
    outputs: list[str]
    mean: np.ndarray
    std: np.ndarray
    s_x: np.ndarray  # масштаб каждого входа (z на единицу int8)
    layers: list[QLayer]
    lut: np.ndarray  # uint16 [257]


def load_float(path: Path) -> dict:
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    return {
        "features": d["features"], "outputs": d.get("outputs", ["p"]),
        "mean": np.asarray(d["mean"], np.float64), "std": np.asarray(d["std"], np.float64),
        "layers": [(np.asarray(L["W"], np.float64), np.asarray(L["b"], np.float64), L["act"]) for L in d["layers"]],
        "thresholds": d.get("thresholds"),
    }


def standardize(model: dict, x_raw: np.ndarray) -> np.ndarray:
    return (np.asarray(x_raw, np.float64) - model["mean"]) / np.where(model["std"] > 0, model["std"], 1.0)


def float_forward(model: dict, z: np.ndarray, collect: bool = False):
    a = np.asarray(z, np.float64)
    acts = []
    for w, b, act in model["layers"]:
        a = a @ w.T + b
        if act == "relu":
            a = np.maximum(a, 0.0)
            acts.append(a)
        elif act == "sigmoid":
            a = 1.0 / (1.0 + np.exp(-a))
    return (a, acts) if collect else a


def sigmoid_lut() -> np.ndarray:
    x = (LUT_LO + np.arange(LUT_N) * (1 << LUT_STEP_SHIFT)) / 256.0
    return np.round(32767.0 / (1.0 + np.exp(-x))).astype(np.uint16)


def quantize(name: str, model: dict, z_cal: np.ndarray, pct: float = 99.99) -> QModel:
    """z_cal — стандартизованные входы реальных данных для калибровки масштабов активаций."""
    rng = np.maximum(4.0, np.percentile(np.abs(z_cal), 99.99, axis=0))
    s_x = rng / 127.0
    z_cal = np.clip(z_cal, -rng, rng)
    _, acts = float_forward(model, z_cal, collect=True)
    layers, s_in, k = [], 1.0, 0
    for li, (w, b, act) in enumerate(model["layers"]):
        if li == 0:
            w = w * s_x[None, :]  # x_real = x_q · s_x  →  масштаб входа внутри весов
        sw = np.maximum(np.abs(w).max(axis=1), 1e-12) / 127.0
        wq = np.clip(np.round(w / sw[:, None]), -127, 127).astype(np.int8)
        bq = np.round(b / (s_in * sw)).astype(np.int64)
        if act == "relu":
            s_out = max(float(np.percentile(acts[k], pct)), 1e-6) / 127.0
            k += 1
            mult = s_in * sw / s_out
        else:
            s_out = 1.0 / 256.0
            mult = s_in * sw * 256.0
        mq = np.round(mult * (1 << Q)).astype(np.int64)
        assert np.all(np.abs(bq) < 2**31) and np.all(np.abs(mq) < 2**31), "переполнение int32"
        layers.append(QLayer(wq, bq.astype(np.int32), mq.astype(np.int32), act, s_in, s_out))
        s_in = s_out
    return QModel(name, model["features"], model["outputs"], model["mean"], model["std"], s_x, layers, sigmoid_lut())


def quantize_input(z: np.ndarray, s_x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(np.asarray(z, np.float64) / s_x), -127, 127).astype(np.int8)


def _rshift_round(v: np.ndarray, s: int) -> np.ndarray:
    v = v.astype(np.int64)
    half = np.int64(1) << (s - 1)
    pos = (v + half) >> s
    neg = -(((-v) + half) >> s)
    return np.where(v >= 0, pos, neg)


def int_forward(qm: QModel, x_q: np.ndarray) -> np.ndarray:
    """Эталон бит-в-бит: int8 входы [N, n_in] → вероятности Q15 (uint16) [N, n_out]."""
    a = np.asarray(x_q, np.int64)
    for L in qm.layers:
        acc = a @ L.w.astype(np.int64).T + L.b.astype(np.int64)
        assert np.all(np.abs(acc) < 2**31), "переполнение аккумулятора"
        y = _rshift_round(acc * L.m.astype(np.int64), Q)
        if L.act == "relu":
            a = np.clip(y, 0, 127)
        else:
            t = np.clip(y - LUT_LO, 0, (LUT_N - 1) << LUT_STEP_SHIFT)
            idx = np.minimum(t >> LUT_STEP_SHIFT, LUT_N - 2)
            frac = t - (idx << LUT_STEP_SHIFT)
            lut = qm.lut.astype(np.int64)
            lo, hi = lut[idx], lut[idx + 1]
            a = lo + (((hi - lo) * frac + (1 << (LUT_STEP_SHIFT - 1))) >> LUT_STEP_SHIFT)
    return a.astype(np.uint16)


def param_bytes(qm: QModel) -> dict:
    w = sum(L.w.size for L in qm.layers)
    b = sum(L.b.size for L in qm.layers)
    return {"weights_int8": int(w), "bias_int32": int(b), "rom_bytes": int(w + 4 * b * 2 + 2 * LUT_N),
            "max_width": int(max(max(L.w.shape) for L in qm.layers)),
            "macs": int(sum(L.w.size for L in qm.layers))}
