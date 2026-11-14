"""NASA Earthdata CMR — метаданные гранул (поиск без ключа).

Здесь CMR используется для мониторинга ЗАДЕРЖЕК спутников (задача ИИ №3 из разговора
с ментором): для каждой гранулы активных пожаров берём время съёмки и время появления
в архиве. Если у спутника задержка растёт — на Земле могли «не увидеть» пожар вовремя.

EARTHDATA_TOKEN (необязательно) нужен только для скачивания самих файлов гранул.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from ..config import env, settings
from ..utils import get_json, get_logger

log = get_logger("helios.earthdata")

# поток -> короткое имя коллекции NRT активных пожаров в CMR
NRT_COLLECTIONS = {
    "MODIS_T": "MOD14",
    "MODIS_A": "MYD14",
    "VIIRS_SNPP": "VNP14IMG_NRT",
    "VIIRS_NOAA20": "VJ114IMG_NRT",
    "VIIRS_NOAA21": "VJ214IMG_NRT",
}


def search_granules(short_name: str, start: datetime, end: datetime, bbox: list[float] | None = None,
                    page_size: int = 500) -> list[dict]:
    params = {
        "short_name": short_name,
        "temporal": f"{start:%Y-%m-%dT%H:%M:%SZ},{end:%Y-%m-%dT%H:%M:%SZ}",
        "page_size": page_size,
        "sort_key": "-start_date",
    }
    if bbox:
        params["bounding_box"] = ",".join(str(x) for x in bbox)
    headers = {"Authorization": f"Bearer {env('EARTHDATA_TOKEN')}"} if env("EARTHDATA_TOKEN") else None
    data = get_json(f"{settings()['apis']['cmr']}/granules.json", params=params, timeout=60, headers=headers)
    return data.get("feed", {}).get("entry", [])


def granule_latency(hours: int = 24, bbox: list[float] | None = None) -> pd.DataFrame:
    """Задержка доставки (мин) по гранулам за последние `hours` часов для каждого спутника."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    rows = []
    for stream, short in NRT_COLLECTIONS.items():
        try:
            entries = search_granules(short, start, end, bbox=bbox)
        except Exception as exc:
            log.warning("CMR %s: %s", short, exc)
            continue
        for e in entries:
            gid = e.get("producer_granule_id") or e.get("title", "")
            if short in ("MOD14", "MYD14") and "NRT" not in gid:
                continue  # берём только NRT-гранулы MODIS
            t_end = pd.to_datetime(e.get("time_end") or e.get("time_start"), utc=True)
            upd = pd.to_datetime(e.get("updated"), utc=True)
            rows.append({
                "stream": stream,
                "granule": gid,
                "time_start": pd.to_datetime(e.get("time_start"), utc=True),
                "available_at": upd,
                "latency_min": (upd - t_end).total_seconds() / 60.0,
                "day_night": e.get("day_night_flag"),
            })
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    return df[df["latency_min"].between(0, 24 * 60)].reset_index(drop=True)


def latency_report(df: pd.DataFrame) -> pd.DataFrame:
    """Медиана/перцентили задержки и флаг аномалии (робастный z-score по свежим гранулам)."""
    if df.empty:
        return df
    out = []
    for stream, g in df.groupby("stream"):
        lat = g.sort_values("time_start")["latency_min"].to_numpy()
        med = float(np.median(lat))
        mad = float(np.median(np.abs(lat - med))) or 1.0
        recent = float(np.median(lat[-5:]))
        z = (recent - med) / (1.4826 * mad)
        out.append({
            "stream": stream,
            "granules": int(len(lat)),
            "median_latency_min": round(med, 1),
            "p90_latency_min": round(float(np.percentile(lat, 90)), 1),
            "recent_latency_min": round(recent, 1),
            "robust_z": round(float(z), 2),
            "status": "DELAYED" if z > 3 and recent > med + 30 else "OK",
            "last_granule": g["time_start"].max(),
        })
    return pd.DataFrame(out)
