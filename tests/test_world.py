"""Тесты мирового контура и бортового int8-кода (быстрые, без сети и без больших данных)."""

from __future__ import annotations

import duckdb
import h3
import numpy as np

from helios.comms import packets
from helios.onboard import quant as Q
from helios.world.aggregate import parent


def test_h3_parent_bit_math_matches_library():
    cells = [h3.latlng_to_cell(la, lo, 8) for la, lo in ((51.1, 71.4), (-23.5, -46.6), (64.0, -150.0), (0.1, 179.9))]
    con = duckdb.connect()
    for r in (2, 3, 5, 6, 7):
        got = [x[0] for x in con.execute(f"SELECT {parent('h', r)} FROM (SELECT unnest(?::UBIGINT[]) AS h)",
                                         [[h3.str_to_int(c) for c in cells]]).fetchall()]
        assert got == [h3.str_to_int(h3.cell_to_parent(c, r)) for c in cells]


def test_rshift_round_is_symmetric_and_exact():
    v = np.array([-5, -3, -2, -1, 0, 1, 2, 3, 5], dtype=np.int64) << 23  # ±x.5 в Q24 → от нуля
    out = Q._rshift_round(v, 24)
    assert out.tolist() == [-3, -2, -1, -1, 0, 1, 1, 2, 3]


def test_sigmoid_lut_monotonic_and_bounded():
    lut = Q.sigmoid_lut()
    assert len(lut) == Q.LUT_N and np.all(np.diff(lut.astype(int)) >= 0)
    assert lut[0] < 20 and lut[-1] > 32740 and abs(int(lut[Q.LUT_N // 2]) - 16384) <= 1


def test_int8_mlp_tracks_float_model():
    rng = np.random.default_rng(0)
    model = {"features": [f"f{i}" for i in range(10)], "outputs": ["p", "q"], "mean": np.zeros(10), "std": np.ones(10),
             "layers": [(rng.normal(0, 0.4, (16, 10)), rng.normal(0, 0.1, 16), "relu"),
                        (rng.normal(0, 0.4, (8, 16)), rng.normal(0, 0.1, 8), "relu"),
                        (rng.normal(0, 0.6, (2, 8)), rng.normal(0, 0.1, 2), "sigmoid")]}
    z = rng.normal(0, 1, (4000, 10))
    qm = Q.quantize("test", model, z)
    p_int = Q.int_forward(qm, Q.quantize_input(z, qm.s_x)) / 32767.0
    p_flt = Q.float_forward(model, z)
    assert np.abs(p_int - p_flt).mean() < 0.01
    assert ((p_int >= 0.5) == (p_flt >= 0.5)).mean() > 0.97


def test_alert_packet_roundtrip_24_bytes():
    pkt = packets.encode("CRITICAL", "VIIRS_NOAA20", 1794700000, 51.12345, 71.4321, 187.4, 12, 0.91, 0.987, flags=1)
    assert len(pkt) == 24 == packets.PACKET_BYTES
    d = packets.decode(pkt)
    assert d["priority"] == "CRITICAL" and d["stream"] == "VIIRS_NOAA20" and abs(d["lat"] - 51.12345) < 1e-5
