"""NASA POWER (LaRC) — суточная погода и облачность для любой точки с 1981 г., без ключа.

Используем для ИИ №3 (погодные драйверы пожаров) и детектора слепых зон (CLOUD_AMT).
Параметры:
  T2M_MAX      — макс. температура, °C
  RH2M         — относительная влажность, %
  WS10M        — ветер 10 м, м/с
  PRECTOTCORR  — осадки, мм/сут
  CLOUD_AMT    — облачность, %
  GWETTOP      — влажность верхнего слоя почвы (0..1)
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

import numpy as np
import pandas as pd

from ..config import RAW, settings
from ..utils import get_json, get_logger

log = get_logger("helios.power")

PARAMS = ["T2M_MAX", "RH2M", "WS10M", "PRECTOTCORR", "CLOUD_AMT", "GWETTOP"]


def fetch_point(lat: float, lon: float, start: date, end: date, params: list[str] | None = None) -> pd.DataFrame:
    params = params or PARAMS
    data = get_json(
        settings()["apis"]["power"],
        params={
            "parameters": ",".join(params),
            "community": "AG",
            "latitude": round(lat, 4),
            "longitude": round(lon, 4),
            "start": start.strftime("%Y%m%d"),
            "end": end.strftime("%Y%m%d"),
            "format": "JSON",
        },
        timeout=180,
    )
    block = data["properties"]["parameter"]
    df = pd.DataFrame({p: pd.Series(block.get(p, {}), dtype="float64") for p in params})
    df.index = pd.to_datetime(df.index, format="%Y%m%d")
    df.index.name = "date"
    return df.replace(-999.0, np.nan).astype("float32")


def fetch_grid(points: dict[str, tuple[float, float]], start: date, end: date, workers: int = 4) -> pd.DataFrame:
    """Погода для набора точек (обычно центры H3 res-3). Возобновляемая: готовые точки берутся с диска."""
    folder = RAW / "power" / f"{start:%Y%m%d}_{end:%Y%m%d}"
    folder.mkdir(parents=True, exist_ok=True)

    def _one(cell: str, lat: float, lon: float) -> pd.DataFrame:
        path = folder / f"{cell}.parquet"
        if path.exists():
            return pd.read_parquet(path)
        df = fetch_point(lat, lon, start, end).reset_index()
        df.insert(0, "cell", cell)
        df.to_parquet(path, index=False)
        return df

    frames, failed = [], 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_one, c, la, lo): c for c, (la, lo) in points.items()}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                frames.append(f.result())
            except Exception as exc:
                failed += 1
                log.warning("POWER %s: %s", futs[f], exc)
            if i % 25 == 0:
                log.info("POWER: %d/%d points", i, len(futs))
    if failed:
        log.warning("POWER: %d points failed (перезапуск докачает)", failed)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
