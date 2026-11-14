"""Настройки проекта: YAML-конфиг + переменные окружения (.env)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(os.getenv("HELIOS_ROOT", Path(__file__).resolve().parent.parent))
load_dotenv(ROOT / ".env")

DATA = Path(os.getenv("HELIOS_DATA_DIR", ROOT / "data"))
RAW = DATA / "raw"
PROCESSED = DATA / "processed"
CACHE = DATA / "cache"
ARTIFACTS = Path(os.getenv("HELIOS_ARTIFACTS_DIR", ROOT / "artifacts"))
MODELS_DIR = ARTIFACTS / "models"
REPORTS_DIR = ARTIFACTS / "reports"


@lru_cache(maxsize=1)
def settings() -> dict:
    path = Path(os.getenv("HELIOS_CONFIG", ROOT / "config" / "settings.yaml"))
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    return value if value not in (None, "") else default


def region() -> dict:
    return settings()["region"]


def ensure_dirs() -> None:
    for d in (RAW, PROCESSED, CACHE, MODELS_DIR, REPORTS_DIR):
        d.mkdir(parents=True, exist_ok=True)
