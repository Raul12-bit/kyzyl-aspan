"""Быстрые тесты ядра (без сети): python -m pytest -q"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from helios.comms import packets, physics
from helios.comms.orbits import julian, unix_seconds
from helios.processing import harmonize
from helios.processing.filters import add_geometry, apply_filters, unified_probability
from helios.processing.persistence import build_static_registry
from helios.processing.spread import gfdi


def _det(n: int, lat: float, lon: float, start: str, freq: str, sensor="VIIRS", conf="n", typ=0.0, frp=5.0, mir=330.0):
    t = pd.date_range(start, periods=n, freq=freq, tz="UTC")
    return pd.DataFrame({
        "lat": lat + np.random.default_rng(0).normal(0, 0.001, n), "lon": lon + np.random.default_rng(1).normal(0, 0.001, n),
        "acq_dt": t, "sensor": sensor, "stream": "VIIRS_NOAA20" if sensor == "VIIRS" else "MODIS_A",
        "bright_mir": np.float32(mir), "bright_tir": np.float32(290.0), "frp": np.float32(frp),
        "scan": np.float32(0.4 if sensor == "VIIRS" else 1.0), "track": np.float32(0.4 if sensor == "VIIRS" else 1.0),
        "conf_pct": np.nan if sensor == "VIIRS" else 60.0, "conf_cat": conf, "daynight": "D", "version": "2",
        "type": np.float32(typ), "quality": "sp",
    })


def test_packet_roundtrip_and_crc():
    pk = packets.encode("CRITICAL", "VIIRS_NOAA21", 1_790_000_000, 47.123456, 66.654321, 250.4, 33, 0.93, 0.99, packets.FLAG_NIGHT)
    assert len(pk) == packets.PACKET_BYTES == 24
    d = packets.decode(pk)
    assert d["priority"] == "CRITICAL" and d["stream"] == "VIIRS_NOAA21"
    assert abs(d["lat"] - 47.12346) < 1e-5 and d["cluster_n"] == 33
    broken = bytearray(pk)
    broken[5] ^= 0xFF
    with pytest.raises(ValueError):
        packets.decode(bytes(broken))


def test_physics_matches_mentor_formulas_with_honest_numbers():
    assert 8.5e6 < physics.plasma_frequency_hz(1e12) < 9.5e6           # f_p ≈ 9 МГц
    ne = physics.flare_d_region_ne(1e-4)                                 # вспышка X1
    assert physics.ionospheric_absorption_db(10e6, ne) > 10              # КВ глохнет
    assert physics.ionospheric_absorption_db(8.2e9, ne) < 1e-3           # X-диапазон — нет
    assert abs(physics.airy_half_angle_rad(1064e-9, 0.15) * 1e6 - 8.65) < 0.05
    assert abs(physics.beam_radius_m(800e3, 1064e-9, 0.075) - 3.61) < 0.05


def test_rain_attenuation_grows_with_rain_and_frequency():
    a_ka = physics.rain_attenuation_db(26.5, np.array([1.0, 10.0]), np.array([20.0, 20.0]), 50.0)
    a_x = physics.rain_attenuation_db(8.2, np.array([10.0]), np.array([20.0]), 50.0)
    assert a_ka[1] > a_ka[0] > 0 and a_ka[1] > a_x[0]


def test_julian_is_unit_independent():
    t_us = pd.DatetimeIndex(["2026-11-14 12:00:00"], tz="UTC").as_unit("us")
    t_ns = t_us.as_unit("ns")
    assert np.allclose(unix_seconds(t_us), unix_seconds(t_ns))
    jd, fr = julian(t_us)
    assert abs(jd[0] + fr[0] - 2461359.0) < 1e-6  # 2026-11-14 12:00 UTC


def test_unified_probability_order():
    df = pd.concat([_det(1, 48, 60, "2024-07-01", "D", conf=c) for c in ("l", "n", "h")], ignore_index=True)
    df = add_geometry(df)
    p = unified_probability(df)
    assert p[0] < p[1] < p[2]


def test_static_registry_flags_flare_not_field():
    flare = _det(400, 47.0, 53.0, "2015-01-01", "4D", typ=2.0)       # круглый год, 4+ лет, type=2
    field = _det(30, 52.0, 70.0, "2015-04-20", "6h", typ=0.0)        # неделя палов весной
    df = add_geometry(pd.concat([flare, field], ignore_index=True))
    reg = build_static_registry(df)
    static_lat = reg.loc[reg["is_static"], "lat"]
    assert (static_lat.between(46.9, 47.1)).any()
    assert not (static_lat.between(51.9, 52.1)).any()
    out = apply_filters(df, set(reg.loc[reg["is_static"], "h3_r8"]))
    assert out.loc[out["lat"].between(46.9, 47.1), "is_static"].all()
    assert out.loc[out["lat"].between(51.9, 52.1), "keep_veg"].mean() > 0.8


def test_ratio_calibration_recovers_known_ratio():
    rng = np.random.default_rng(0)
    rows = [{"cal_month": m, "ref": 40 * (1 + m % 3), "src": 40 * (1 + m % 3) / 0.4 * rng.uniform(0.95, 1.05)}
            for m in range(1, 13) for _ in range(5)]
    fit = harmonize.ratio_calibration_eb(pd.DataFrame(rows))
    assert fit["calibrated"] and abs(fit["pooled"] - 0.4) < 0.02
    assert all(abs(b - 0.4) < 0.05 for b in fit["beta"])


def test_gfdi_increases_with_wind_and_dryness():
    assert gfdi(30, 20, 40) > gfdi(30, 20, 10) > gfdi(30, 60, 10)
    assert math.isfinite(gfdi(-5, 90, 5))
