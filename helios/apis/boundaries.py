"""Контур региона (geoBoundaries, OSM, ODbL) и маска H3-ячеек внутри страны."""

from __future__ import annotations

import json
from functools import lru_cache

import h3
import numpy as np

from ..config import PROCESSED, RAW, settings
from ..utils import download, get_json, get_logger

log = get_logger("helios.boundaries")


def region_geojson() -> dict:
    """GeoJSON-геометрия страны. Если сеть недоступна — прямоугольник bbox."""
    reg = settings()["region"]
    path = RAW / "boundaries" / f"{reg['iso3']}_ADM0_simplified.geojson"
    try:
        if not path.exists():
            meta = get_json(f"{settings()['apis']['geoboundaries']}/{reg['iso3']}/ADM0/", ttl_s=30 * 86400)
            download(meta["simplifiedGeometryGeoJSON"], path)
        fc = json.loads(path.read_text(encoding="utf-8"))
        geom = fc["features"][0]["geometry"] if fc.get("type") == "FeatureCollection" else fc
        return geom
    except Exception as exc:
        log.warning("geoBoundaries недоступен (%s) — использую bbox", exc)
        w, s, e, n = reg["bbox"]
        return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


@lru_cache(maxsize=8)
def region_cells(res: int) -> frozenset[str]:
    """Все H3-ячейки разрешения `res`, центр которых внутри страны (с кэшем на диск)."""
    reg = settings()["region"]
    path = PROCESSED / f"region_cells_{reg['id']}_r{res}.json"
    if path.exists():
        return frozenset(json.loads(path.read_text(encoding="utf-8")))
    cells = h3.geo_to_cells(region_geojson(), res)
    PROCESSED.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sorted(cells)), encoding="utf-8")
    log.info("region mask res %d: %d cells", res, len(cells))
    return frozenset(cells)


def in_region(lat: np.ndarray, lon: np.ndarray, res: int = 5) -> np.ndarray:
    """Маска точек внутри страны (с буфером в одно кольцо H3, чтобы не терять приграничные пожары)."""
    base = region_cells(res)
    buffered = set(base)
    for c in base:
        buffered.update(h3.grid_disk(c, 1))
    cells = [h3.latlng_to_cell(float(a), float(b), res) for a, b in zip(lat, lon)]
    return np.fromiter((c in buffered for c in cells), dtype=bool, count=len(cells))
