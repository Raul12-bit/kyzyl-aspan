"""NASA EONET — каталог природных событий (лесные пожары) для сверки наших алертов."""

from __future__ import annotations

from ..config import settings
from ..utils import get_json


def wildfire_events(days: int = 30, bbox: list[float] | None = None, status: str = "all", limit: int = 200) -> list[dict]:
    w, s, e, n = bbox or settings()["region"]["bbox"]
    data = get_json(
        f"{settings()['apis']['eonet']}/events",
        params={"category": "wildfires", "days": days, "status": status, "limit": limit, "bbox": f"{w},{n},{e},{s}"},
        timeout=60,
        ttl_s=3600,
    )
    out = []
    for ev in data.get("events", []):
        for g in ev.get("geometry", []):
            if g.get("type") != "Point":
                continue
            lon, lat = g["coordinates"][:2]
            out.append({"id": ev["id"], "title": ev["title"], "date": g.get("date"), "lat": lat, "lon": lon,
                        "sources": [s_.get("url") for s_ in ev.get("sources", [])]})
    return out
