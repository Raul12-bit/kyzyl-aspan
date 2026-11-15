"""CelesTrak — актуальные орбитальные элементы (TLE) спутников, без ключа.

Спутники наблюдения пожаров (MODIS/VIIRS) и ретрансляторы:
* STPSat-6 несёт LCRD — лазерный ретранслятор NASA на ГСО (оптическая связь до 1.2 Гбит/с);
* TDRS — радио-ретрансляторы NASA (S/Ka).
"""

from __future__ import annotations

import time
from pathlib import Path

from ..config import CACHE, settings
from ..utils import get_logger, http

log = get_logger("helios.celestrak")

# имя -> (NORAD ID, роль, сенсор)
SATELLITES: dict[str, tuple[int, str, str | None]] = {
    "TERRA": (25994, "observer", "MODIS"),
    "AQUA": (27424, "observer", "MODIS"),
    "SUOMI NPP": (37849, "observer", "VIIRS"),
    "NOAA 20": (43013, "observer", "VIIRS"),
    "NOAA 21": (54234, "observer", "VIIRS"),
    "STPSAT-6 (LCRD)": (49817, "relay_optical", None),
    # TDRS третьего поколения (174° з.д., 41° з.д., 11° з.д.): втроём видят Terra 100% времени
    "TDRS 11": (39070, "relay_radio", None),
    "TDRS 12": (39504, "relay_radio", None),
    "TDRS 13": (42915, "relay_radio", None),
}

# поток FIRMS -> имя спутника
STREAM_TO_SAT = {
    "MODIS_T": "TERRA",
    "MODIS_A": "AQUA",
    "VIIRS_SNPP": "SUOMI NPP",
    "VIIRS_NOAA20": "NOAA 20",
    "VIIRS_NOAA21": "NOAA 21",
}


def fetch_tle(norad: int, max_age_h: float = 12) -> tuple[str, str, str]:
    path = Path(CACHE) / f"tle_{norad}.txt"
    if path.exists() and time.time() - path.stat().st_mtime < max_age_h * 3600:
        lines = path.read_text(encoding="utf-8").splitlines()
    else:
        r = http().get(settings()["apis"]["celestrak"], params={"CATNR": norad, "FORMAT": "TLE"}, timeout=60)
        r.raise_for_status()
        lines = [ln.rstrip() for ln in r.text.splitlines() if ln.strip()]
        if len(lines) < 3 or not lines[1].startswith("1 "):
            if path.exists():  # CelesTrak недоступен — берём последний известный TLE
                lines = path.read_text(encoding="utf-8").splitlines()
            else:
                raise RuntimeError(f"TLE {norad}: {r.text[:120]}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(lines[:3]), encoding="utf-8")
    return lines[0].strip(), lines[1], lines[2]


def fetch_all(roles: tuple[str, ...] = ("observer", "relay_optical", "relay_radio")) -> dict[str, tuple[str, str]]:
    out = {}
    for name, (norad, role, _) in SATELLITES.items():
        if role not in roles:
            continue
        try:
            _, l1, l2 = fetch_tle(norad)
            out[name] = (l1, l2)
        except Exception as exc:
            log.warning("TLE %s (%s): %s", name, norad, exc)
    return out
