"""Fire Time Machine — проверка ИИ на прошлом.

Пользователь выбирает дату (например, 1 июня 2024). Модель видит ТОЛЬКО данные до этой даты
и прогнозирует следующие 1–4 недели; затем «проигрываем историю» и сравниваем с тем, что
реально сгорело, а рядом — прогноз простого сезонного алгоритма (климатология).
Модели ИИ №3 обучены на 2013–2022, поэтому любые даты 2024–2025 — честная проверка
(для более ранних дат можно включить strict=True: модель переобучится до этой даты).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..config import PROCESSED, REPORTS_DIR
from ..utils import get_logger, save_json
from .ground_forecast import HORIZONS, _metrics, fit_model, load, panel, predict_week

log = get_logger("helios.timemachine")

DEFAULT_DATES = ["2024-04-01", "2024-06-03", "2024-08-26", "2025-04-07", "2025-07-07", "2025-09-01"]


def scenario(as_of: str, horizons=HORIZONS, strict: bool = False) -> tuple[dict, pd.DataFrame]:
    as_of_ts = pd.Timestamp(as_of)
    frames, res = [], {"as_of": as_of, "horizons": {}}
    for h in horizons:
        bundle = load(h)
        if pd.Timestamp(bundle["train_end"]) >= as_of_ts:
            if not strict:
                res.setdefault("warnings", []).append(f"h{h}: модель обучена до {bundle['train_end']} — включите strict")
            else:
                bundle = {"model": fit_model(panel(), h, str((as_of_ts - pd.Timedelta(days=7)).date())),
                          "features": bundle["features"], "train_end": str(as_of_ts.date())}
        pred = predict_week(as_of_ts, h, bundle)
        y = pred["actual"].to_numpy()
        res["horizons"][f"h{h}"] = {
            "target_week": str(pred["target_week"].iloc[0].date()) if pd.notna(pred["target_week"].iloc[0]) else None,
            "ai": _metrics(y, pred["p_fire"].to_numpy()),
            "seasonal_baseline": _metrics(y, pred["p_climatology"].to_numpy()),
            "cells_burned": int(y.sum()),
        }
        frames.append(pred.assign(as_of=as_of_ts))
    return res, pd.concat(frames, ignore_index=True)


def run_default_scenarios(dates=DEFAULT_DATES) -> list[dict]:
    results, frames = [], []
    for d in dates:
        try:
            r, df = scenario(d)
            results.append(r)
            # для фронтенда храним только информативные ячейки (риск или факт пожара)
            frames.append(df[(df["p_fire"] >= 0.02) | (df["actual"] == 1) | (df["p_climatology"] >= 0.05)])
            log.info("Time Machine %s: %s", d, {k: (v["ai"].get("pr_auc"), v["seasonal_baseline"].get("pr_auc"))
                                                for k, v in r["horizons"].items()})
        except Exception as exc:
            log.warning("Time Machine %s: %s", d, exc)
    if frames:
        pd.concat(frames, ignore_index=True).to_parquet(PROCESSED / "time_machine.parquet", index=False)
    save_json(results, REPORTS_DIR / "time_machine.json")
    return results
