"""Open-Meteo — почасовой прогноз и архив (ERA5) без ключа.

Нужен там, где NASA POWER слишком груб по времени:
* погода у наземных станций (дождь → замирания Ka-диапазона, облака → лазерный канал);
* ветер над активными пожарами (направление распространения);
* облачность в часы пролётов спутников (слепые зоны).
"""

from __future__ import annotations

from datetime import date

import pandas as pd

from ..config import settings
from ..utils import get_json

HOURLY_DEFAULT = [
    "precipitation", "cloud_cover", "cloud_cover_low", "relative_humidity_2m",
    "temperature_2m", "wind_speed_10m", "wind_direction_10m",
]


def _frames(payload, n: int) -> list[pd.DataFrame]:
    items = payload if isinstance(payload, list) else [payload]
    out = []
    for item in items[:n]:
        h = item.get("hourly", {})
        df = pd.DataFrame(h)
        if "time" in df:
            df["time"] = pd.to_datetime(df["time"], utc=True)
            df = df.set_index("time")
        out.append(df)
    return out


def forecast(lats: list[float], lons: list[float], hourly: list[str] | None = None, days: int = 7) -> list[pd.DataFrame]:
    hourly = hourly or HOURLY_DEFAULT
    data = get_json(
        settings()["apis"]["open_meteo_forecast"],
        params={
            "latitude": ",".join(f"{x:.4f}" for x in lats),
            "longitude": ",".join(f"{x:.4f}" for x in lons),
            "hourly": ",".join(hourly),
            "forecast_days": days,
            "wind_speed_unit": "kmh",
            "timezone": "GMT",
        },
        timeout=60,
        ttl_s=1800,
    )
    return _frames(data, len(lats))


def archive(lats: list[float], lons: list[float], start: date, end: date, hourly: list[str] | None = None) -> list[pd.DataFrame]:
    hourly = hourly or HOURLY_DEFAULT
    data = get_json(
        settings()["apis"]["open_meteo_archive"],
        params={
            "latitude": ",".join(f"{x:.4f}" for x in lats),
            "longitude": ",".join(f"{x:.4f}" for x in lons),
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "hourly": ",".join(hourly),
            "wind_speed_unit": "kmh",
            "timezone": "GMT",
        },
        timeout=120,
        ttl_s=7 * 86400,
    )
    return _frames(data, len(lats))
