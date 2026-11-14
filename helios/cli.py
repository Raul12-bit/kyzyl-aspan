"""Командная строка HELIOS-SHIELD.

    python -m helios.cli check-apis        # проверить все API и ключи
    python -m helios.cli fetch-history     # скачать 26 лет FIRMS (MODIS+VIIRS) по стране
    python -m helios.cli build-history     # фильтрация шума + H3 + гармонизация + календарь
    python -m helios.cli fetch-weather     # NASA POWER (погода + облачность) по сетке H3
    python -m helios.cli train-edge        # ИИ №1 (борт): критичность обнаружения
    python -m helios.cli train-link        # ИИ №2 (борт): прогноз потери связи
    python -m helios.cli train-ground      # ИИ №3 (Земля): прогноз пожарного риска
    python -m helios.cli analytics         # Fire DNA, сдвиг сезона, слепые зоны, Time Machine
    python -m helios.cli update-current    # текущий год: погода POWER + пожары (MAP_KEY или NRT 7д)
    python -m helios.cli forecast          # текущий прогноз риска ИИ №3 на 1–4 недели
    python -m helios.cli simulate-delivery # умная доставка алертов (окна связи, ретранслятор)
    python -m helios.cli export-frontend   # данные в формате фронтенда Kyzyl Aspan (API /v1)
    python -m helios.cli nrt               # свежие пожары (NRT) -> фильтр -> ИИ №1 -> алерты
    python -m helios.cli refresh           # ежечасное автообновление: NRT -> ИИ №1 -> Supabase (лог: data/logs/refresh.log)
    python -m helios.cli sync-supabase     # выгрузка результатов в Supabase
    python -m helios.cli all               # всё по порядку
"""

from __future__ import annotations

import argparse
import sys
import time

from .config import ensure_dirs
from .utils import get_logger

log = get_logger("helios.cli")


def _run(step: str, fn, *args, **kwargs):
    t0 = time.time()
    log.info("=== %s ===", step)
    result = fn(*args, **kwargs)
    log.info("=== %s: готово за %.1f c ===", step, time.time() - t0)
    return result


def cmd_check_apis(_):
    from .apis.health import check_all

    report = check_all()
    for name, info in report.items():
        mark = "OK " if info.get("ok") else "-- "
        print(f"{mark}{name:22s} {info.get('detail', '')}")


def cmd_fetch_history(args):
    from .apis.firms import download_country_archive

    _run("FIRMS archive", download_country_archive, workers=args.workers)


def cmd_build_history(_):
    from .pipeline import build_history

    _run("History (filters + H3 + harmonization)", build_history)


def cmd_fetch_weather(_):
    from .pipeline import fetch_weather

    _run("NASA POWER weather", fetch_weather)


def cmd_train_edge(_):
    from .models.edge_detector import train

    _run("AI #1 edge detector", train)


def cmd_train_link(_):
    from .models.link_ai import train

    _run("AI #2 link predictor", train)


def cmd_train_ground(_):
    from .models.ground_forecast import train

    _run("AI #3 ground forecast", train)


def cmd_analytics(_):
    from .pipeline import run_analytics

    _run("Analytics", run_analytics)


def cmd_update_current(_):
    from .pipeline import update_current_year

    _run("Current year (POWER + FIRMS)", update_current_year)


def cmd_forecast(_):
    from .pipeline import forecast_now

    _run("AI #3 forecast now", forecast_now)


def cmd_export_frontend(_):
    from .frontend_export import export_all

    _run("Export for Kyzyl Aspan frontend", export_all)


def cmd_simulate_delivery(_):
    from .comms.delivery import run_delivery_simulation

    _run("Smart alert delivery", run_delivery_simulation)


def cmd_nrt(args):
    from .pipeline import run_nrt

    _run("NRT pipeline", run_nrt, period=args.period)


def cmd_refresh(args):
    """Ежечасное автообновление (его запускает Планировщик заданий Windows)."""
    import logging
    from logging.handlers import RotatingFileHandler

    from .config import DATA
    from .pipeline import refresh

    log_dir = DATA / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(log_dir / "refresh.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)
    _run("Hourly refresh", refresh, period=args.period)


def cmd_sync(args):
    from .db.supabase_sync import sync_all

    _run("Supabase sync", sync_all, only=args.only)


def cmd_all(args):
    for fn in (cmd_fetch_history, cmd_build_history, cmd_fetch_weather, cmd_train_edge,
               cmd_train_link, cmd_train_ground, cmd_analytics, cmd_update_current, cmd_forecast,
               cmd_simulate_delivery, cmd_export_frontend):
        try:
            fn(args)
        except Exception as exc:  # один упавший шаг (например, сеть) не должен ронять весь прогон
            log.exception("шаг %s упал: %s", fn.__name__, exc)
    cmd_nrt(args)
    cmd_sync(args)


def main(argv: list[str] | None = None) -> int:
    import os

    if sys.stdout is None or sys.stderr is None:  # запуск через pythonw (Планировщик, без окна консоли)
        devnull = open(os.devnull, "w", encoding="utf-8")
        sys.stdout = sys.stdout or devnull
        sys.stderr = sys.stderr or devnull
    ensure_dirs()
    p = argparse.ArgumentParser(prog="helios", description="HELIOS-SHIELD pipeline")
    sub = p.add_subparsers(dest="cmd", required=True)
    commands = {
        "check-apis": cmd_check_apis,
        "fetch-history": cmd_fetch_history,
        "build-history": cmd_build_history,
        "fetch-weather": cmd_fetch_weather,
        "train-edge": cmd_train_edge,
        "train-link": cmd_train_link,
        "train-ground": cmd_train_ground,
        "analytics": cmd_analytics,
        "update-current": cmd_update_current,
        "forecast": cmd_forecast,
        "simulate-delivery": cmd_simulate_delivery,
        "export-frontend": cmd_export_frontend,
        "nrt": cmd_nrt,
        "refresh": cmd_refresh,
        "sync-supabase": cmd_sync,
        "all": cmd_all,
    }
    for name, fn in commands.items():
        sp = sub.add_parser(name)
        sp.set_defaults(func=fn)
        sp.add_argument("--workers", type=int, default=4)
        sp.add_argument("--period", default="48h", choices=["24h", "48h", "7d"])
        sp.add_argument("--only", nargs="*", default=None, help="таблицы для sync-supabase")
    args = p.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
