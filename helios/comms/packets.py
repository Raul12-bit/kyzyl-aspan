"""Компактный пакет тревоги (24 байта) — то, что спутник шлёт первым, по любому живому каналу.

Ментор: «сначала короткие сообщения, потом длинные». Полный снимок весит сотни МБ,
а пакет тревоги — 24 байта: его можно протолкнуть даже через узкий S-band/ретранслятор
за доли секунды.

Формат (big-endian):
  B  version | B priority | B sat_id | B flags | I unix_time | i lat*1e5 | i lon*1e5 |
  H frp*10 (МВт) | H cluster_n | B p_escalation*255 | B p_real*255 | H crc16
"""

from __future__ import annotations

import struct

PRIORITIES = {"SUPPRESS": 0, "ROUTINE": 1, "HIGH": 2, "CRITICAL": 3, "CONFIRMED": 4}
PRIORITY_NAMES = {v: k for k, v in PRIORITIES.items()}
SAT_IDS = {"MODIS_T": 1, "MODIS_A": 2, "VIIRS_SNPP": 3, "VIIRS_NOAA20": 4, "VIIRS_NOAA21": 5}
SAT_NAMES = {v: k for k, v in SAT_IDS.items()}
FLAG_NIGHT, FLAG_STATIC_NEAR, FLAG_GLINT, FLAG_CONFIRMED = 1, 2, 4, 8
_FMT = ">BBBBIiiHHBB"
PACKET_BYTES = struct.calcsize(_FMT) + 2


def crc16_ccitt(data: bytes, crc: int = 0xFFFF) -> int:
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def encode(priority: str, stream: str, unix_time: int, lat: float, lon: float, frp_mw: float,
           cluster_n: int, p_escalation: float, p_real: float, flags: int = 0) -> bytes:
    body = struct.pack(
        _FMT, 1, PRIORITIES.get(priority, 1), SAT_IDS.get(stream, 0), flags & 0xFF,
        int(unix_time) & 0xFFFFFFFF, int(round(lat * 1e5)), int(round(lon * 1e5)),
        min(int(round(frp_mw * 10)), 65535), min(int(cluster_n), 65535),
        int(round(max(0.0, min(1.0, p_escalation)) * 255)), int(round(max(0.0, min(1.0, p_real)) * 255)),
    )
    return body + struct.pack(">H", crc16_ccitt(body))


def decode(packet: bytes) -> dict:
    if len(packet) != PACKET_BYTES:
        raise ValueError(f"пакет должен быть {PACKET_BYTES} байт, получено {len(packet)}")
    body, crc = packet[:-2], struct.unpack(">H", packet[-2:])[0]
    if crc16_ccitt(body) != crc:
        raise ValueError("CRC не совпал — пакет повреждён")
    v, pr, sat, flags, t, lat, lon, frp, n, pe, preal = struct.unpack(_FMT, body)
    return {
        "version": v, "priority": PRIORITY_NAMES.get(pr, "ROUTINE"), "stream": SAT_NAMES.get(sat, "?"),
        "flags": flags, "unix_time": t, "lat": lat / 1e5, "lon": lon / 1e5, "frp_mw": frp / 10,
        "cluster_n": n, "p_escalation": round(pe / 255, 3), "p_real": round(preal / 255, 3),
    }
