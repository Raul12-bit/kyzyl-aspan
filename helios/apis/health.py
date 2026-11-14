"""Проверка всех внешних API и ключей одной командой: python -m helios.cli check-apis"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from ..config import env


def _try(fn):
    try:
        detail = fn()
        return {"ok": True, "detail": detail}
    except Exception as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {str(exc)[:140]}"}


def check_all() -> dict[str, dict]:
    from . import celestrak, earthdata, eonet, firms, nasa_power, open_meteo, space_weather

    today = date.today()
    report = {
        "FIRMS archive (no key)": _try(lambda: "годовой архив по стране доступен"
                                       if firms.http().head(firms.archive_url("modis", 2024, "Kazakhstan"), timeout=30).status_code == 200
                                       else (_ for _ in ()).throw(RuntimeError("archive 404"))),
        "FIRMS NRT feeds": _try(lambda: f"{len(firms.fetch_open_nrt('24h'))} свежих точек в bbox"),
        "FIRMS MAP_KEY": _try(lambda: str(firms.mapkey_status())[:120] if env("FIRMS_MAP_KEY")
                              else (_ for _ in ()).throw(RuntimeError("FIRMS_MAP_KEY не задан (нужен для Area API)"))),
        "NASA POWER": _try(lambda: f"{len(nasa_power.fetch_point(51.1, 71.4, today - timedelta(days=10), today - timedelta(days=3)))} дней"),
        "NASA CMR latency": _try(lambda: f"{len(earthdata.granule_latency(hours=6))} гранул за 6 ч"),
        "NASA EONET": _try(lambda: f"{len(eonet.wildfire_events(days=30))} событий в регионе за 30 дней"),
        "NASA DONKI": _try(lambda: f"{len(space_weather.donki_flares(today - timedelta(days=7), today))} вспышек за 7 дней"),
        "NOAA SWPC": _try(lambda: str(space_weather.current_conditions())[:120]),
        "GFZ Kp/F10.7": _try(lambda: f"{len(space_weather.gfz_index('Kp', datetime.now(timezone.utc) - timedelta(days=2), datetime.now(timezone.utc)))} значений Kp"),
        "CelesTrak TLE": _try(lambda: ", ".join(celestrak.fetch_all().keys())),
        "Open-Meteo": _try(lambda: f"{len(open_meteo.forecast([51.1], [71.4], days=1)[0])} часов прогноза"),
        "Gemini key": _try(lambda: "задан" if env("GEMINI_API_KEY")
                           else (_ for _ in ()).throw(RuntimeError("GEMINI_API_KEY не задан — работает офлайн-аналитик"))),
        "Supabase": _try(_supabase_detail),
    }
    return report


def _supabase_detail() -> str:
    from ..db.supabase_sync import SupabaseClient

    client = SupabaseClient()
    return client.ping()
