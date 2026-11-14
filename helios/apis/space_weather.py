"""Космическая погода: NOAA SWPC (сейчас), GFZ Potsdam (история), NASA DONKI (вспышки).

* Kp — геомагнитная активность (бури → ионосферные мерцания S/X-диапазона у полярных станций);
* поток рентгена GOES и класс вспышки (A/B/C/M/X);
* F10.7 — радиопоток Солнца (растёт шумовая температура антенны, когда Солнце рядом с лучом).
"""

from __future__ import annotations

import math
from datetime import date, datetime, timezone

import pandas as pd
import requests

from ..config import env, settings
from ..utils import get_json, get_logger

log = get_logger("helios.spaceweather")

_CLASS = {"A": 1e-8, "B": 1e-7, "C": 1e-6, "M": 1e-5, "X": 1e-4}


def flare_class_to_flux(cls: str | None) -> float:
    """'M1.2' -> 1.2e-5 Вт/м² (диапазон 0.1–0.8 нм)."""
    if not cls:
        return 1e-8
    cls = cls.strip().upper()
    try:
        return _CLASS[cls[0]] * float(cls[1:] or 1.0)
    except (KeyError, ValueError):
        return 1e-8


def flux_to_flare_class(flux: float) -> str:
    flux = max(float(flux), 1e-9)
    for letter in ("X", "M", "C", "B", "A"):
        if flux >= _CLASS[letter]:
            return f"{letter}{flux / _CLASS[letter]:.1f}"
    return "A0.1"


def kp_recent() -> pd.DataFrame:
    data = get_json(f"{settings()['apis']['swpc']}/products/noaa-planetary-k-index.json", ttl_s=900)
    if data and isinstance(data[0], list):  # старый формат: первая строка — заголовок
        df = pd.DataFrame(data[1:], columns=data[0])
    else:
        df = pd.DataFrame(data)
    df["time"] = pd.to_datetime(df["time_tag"], utc=True)
    df["kp"] = pd.to_numeric(df["Kp"] if "Kp" in df else df["kp"], errors="coerce")
    return df[["time", "kp"]]


def xray_flux_recent() -> pd.DataFrame:
    data = get_json(f"{settings()['apis']['swpc']}/json/goes/primary/xrays-1-day.json", ttl_s=600)
    df = pd.DataFrame(data)
    df = df[df["energy"] == "0.1-0.8nm"].copy()
    df["time"] = pd.to_datetime(df["time_tag"], utc=True)
    df["flux"] = pd.to_numeric(df["flux"], errors="coerce")
    return df[["time", "flux"]]


def flares_recent() -> list[dict]:
    return get_json(f"{settings()['apis']['swpc']}/json/goes/primary/xray-flares-7-day.json", ttl_s=900)


def gfz_index(index: str, start: datetime, end: datetime) -> pd.DataFrame:
    """История индексов GFZ: Kp (3 ч), ap, Fobs (F10.7, сутки), SN (число Вольфа)."""
    data = get_json(
        settings()["apis"]["gfz"],
        params={
            "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "index": index,
        },
        timeout=90,
        ttl_s=6 * 3600,
    )
    df = pd.DataFrame({"time": pd.to_datetime(data["datetime"], utc=True), index.lower(): data[index]})
    return df


def donki_flares(start: date, end: date) -> list[dict]:
    """Вспышки из NASA DONKI (ключ NASA_API_KEY или DEMO_KEY; при сбое — зеркало CCMC)."""
    key = env("NASA_API_KEY", "DEMO_KEY")
    params = {"startDate": start.isoformat(), "endDate": end.isoformat()}
    errors = []
    for url, extra in (
        (f"{settings()['apis']['donki']}/FLR", {"api_key": key}),
        (f"{settings()['apis']['donki_mirror']}/FLR", {}),
    ):
        try:  # без повторов и с коротким таймаутом: DONKI часто недоступен, не ждём минутами
            r = requests.get(url, params={**params, **extra}, timeout=15)
            r.raise_for_status()
            return r.json() or []
        except Exception as exc:
            log.info("DONKI %s: %s", url, exc)
            errors.append(f"{url.split('/')[2]}: {type(exc).__name__}")
    # не маскируем отказ пустым списком: вспышки за 7 дней всё равно есть в NOAA SWPC (flares_recent)
    raise RuntimeError("DONKI недоступен (" + "; ".join(errors) + ") — используем NOAA SWPC")


def current_conditions() -> dict:
    """Сводка «прямо сейчас» для ИИ №2 и симулятора лазер/радио."""
    out = {"time": datetime.now(timezone.utc).isoformat(), "kp": None, "xray_flux": None, "flare_class": None}
    try:
        kp = kp_recent().dropna()
        out["kp"] = float(kp["kp"].iloc[-1])
    except Exception as exc:
        log.warning("SWPC Kp: %s", exc)
    try:
        xr = xray_flux_recent().dropna()
        flux = float(xr["flux"].iloc[-1])
        out["xray_flux"] = flux
        out["flare_class"] = flux_to_flare_class(flux)
    except Exception as exc:
        log.warning("SWPC X-ray: %s", exc)
    try:
        now = datetime.now(timezone.utc)
        f107 = gfz_index("Fobs", now.replace(day=1) - pd.Timedelta(days=40), now).dropna()
        out["f107"] = float(f107["fobs"].iloc[-1])
    except Exception as exc:
        log.info("GFZ F10.7: %s", exc)
    out["solar_activity_index"] = (
        None if out["xray_flux"] is None else round(max(1.0, math.log10(out["xray_flux"] / 1e-8) * 25), 1)
    )
    return out
