"""Наземные станции и ретрансляторы для моделирования связи.

Координаты реальных станций — открытые (приблизительно). Станции в Казахстане помечены
как «условные» (illustrative): реальной приёмной станции MODIS/VIIRS там может не быть,
это сценарий «что если поставить свою станцию прямого приёма».
"""

from __future__ import annotations

from .orbits import geomagnetic_lat

STATIONS: list[dict] = [
    {"id": "SVALSAT", "name": "Svalbard SvalSat (KSAT)", "lat": 78.229, "lon": 15.408, "alt_m": 500,
     "kind": "rf", "bands": ["S", "X", "Ka"], "dish_m": 11.3, "real": True},
    {"id": "TROLLSAT", "name": "TrollSat, Antarctica (KSAT)", "lat": -72.012, "lon": 2.535, "alt_m": 1270,
     "kind": "rf", "bands": ["S", "X", "Ka"], "dish_m": 7.3, "real": True},
    {"id": "MCMURDO", "name": "McMurdo, Antarctica (NASA NEN)", "lat": -77.839, "lon": 166.667, "alt_m": 100,
     "kind": "rf", "bands": ["S", "X"], "dish_m": 10.0, "real": True},
    {"id": "FAIRBANKS", "name": "Fairbanks CDA, Alaska (NOAA)", "lat": 64.972, "lon": -147.511, "alt_m": 300,
     "kind": "rf", "bands": ["S", "X"], "dish_m": 13.0, "real": True},
    # Aqua сбрасывает накопленные данные на Шпицбергене и в Покер-Флэт (NASA, «Aqua Direct Broadcast»)
    {"id": "POKER_FLAT", "name": "Poker Flat, Alaska (NASA NEN)", "lat": 65.117, "lon": -147.433, "alt_m": 500,
     "kind": "rf", "bands": ["S", "X"], "dish_m": 11.0, "real": True},
    {"id": "WALLOPS", "name": "Wallops, Virginia (NASA)", "lat": 37.940, "lon": -75.466, "alt_m": 10,
     "kind": "rf", "bands": ["S", "X"], "dish_m": 11.0, "real": True},
    {"id": "WHITE_SANDS", "name": "White Sands Complex, NM (TDRS ground)", "lat": 32.500, "lon": -106.608, "alt_m": 1450,
     "kind": "rf", "bands": ["S", "Ka"], "dish_m": 18.0, "real": True, "relay_ground": "TDRS 13"},
    {"id": "ASTANA_DB", "name": "Астана, станция прямого приёма (условная)", "lat": 51.169, "lon": 71.449, "alt_m": 350,
     "kind": "rf", "bands": ["X"], "dish_m": 3.0, "real": False},
    {"id": "ALMATY_DB", "name": "Алматы, станция прямого приёма (условная)", "lat": 43.238, "lon": 76.946, "alt_m": 850,
     "kind": "rf", "bands": ["X"], "dish_m": 3.0, "real": False},
    {"id": "OGS_TABLE_MTN", "name": "Table Mountain OGS-1, CA (LCRD)", "lat": 34.381, "lon": -117.680, "alt_m": 2286,
     "kind": "optical", "aperture_m": 1.0, "real": True, "relay_ground": "STPSAT-6 (LCRD)"},
    {"id": "OGS_HALEAKALA", "name": "Haleakalā OGS-2, Hawaii (LCRD)", "lat": 20.708, "lon": -156.257, "alt_m": 3055,
     "kind": "optical", "aperture_m": 0.6, "real": True, "relay_ground": "STPSAT-6 (LCRD)"},
    {"id": "OGS_TENERIFE", "name": "ESA Optical Ground Station, Tenerife", "lat": 28.300, "lon": -16.511, "alt_m": 2393,
     "kind": "optical", "aperture_m": 1.0, "real": True},
    {"id": "OGS_ASSY_TURGEN", "name": "Ассы-Тургень (Казахстан), оптическая станция (условная)", "lat": 43.225,
     "lon": 77.871, "alt_m": 2750, "kind": "optical", "aperture_m": 1.0, "real": False},
]

for _s in STATIONS:
    _s["geomag_lat"] = round(geomagnetic_lat(_s["lat"], _s["lon"]), 1)

BY_ID = {s["id"]: s for s in STATIONS}


def rf_stations() -> list[dict]:
    return [s for s in STATIONS if s["kind"] == "rf"]


def optical_stations() -> list[dict]:
    return [s for s in STATIONS if s["kind"] == "optical"]
