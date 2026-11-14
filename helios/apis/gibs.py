"""NASA GIBS — готовые слои снимков для карты фронтенда (WMTS, без ключа)."""

from __future__ import annotations

from datetime import date

from ..config import settings

# слой -> (описание, формат, max zoom)
LAYERS = {
    "MODIS_Terra_CorrectedReflectance_TrueColor": ("Terra MODIS, истинные цвета", "jpg", 9),
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor": ("NOAA-20 VIIRS, истинные цвета", "jpg", 9),
    "VIIRS_NOAA20_Thermal_Anomalies_375m_All": ("NOAA-20 VIIRS, тепловые аномалии 375 м", "png", 9),
    "VIIRS_NOAA21_Thermal_Anomalies_375m_All": ("NOAA-21 VIIRS, тепловые аномалии 375 м", "png", 9),
    "MODIS_Combined_Thermal_Anomalies_All": ("MODIS Terra+Aqua, тепловые аномалии 1 км", "png", 9),
    "MODIS_Terra_Cloud_Top_Temp_Day": ("Terra MODIS, температура верхней границы облаков", "png", 6),
}


def tile_url(layer: str, day: date | None = None) -> str:
    """Шаблон XYZ-тайла для Leaflet/MapLibre: {z}/{y}/{x}."""
    _, fmt, zoom = LAYERS.get(layer, ("", "png", 9))
    base = settings()["apis"]["gibs_wmts"]
    when = (day or date.today()).isoformat()
    matrix = f"GoogleMapsCompatible_Level{zoom}"
    return f"{base}/{layer}/default/{when}/{matrix}/{{z}}/{{y}}/{{x}}.{fmt}"


def layer_catalog(day: date | None = None) -> list[dict]:
    return [
        {"id": lid, "title": title, "max_zoom": zoom, "url": tile_url(lid, day)}
        for lid, (title, _, zoom) in LAYERS.items()
    ]
