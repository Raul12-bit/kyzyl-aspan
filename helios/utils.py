"""Общие утилиты: логирование, HTTP с повторами и кэшем, работа со временем."""

from __future__ import annotations

import hashlib
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .config import CACHE

_LOG_READY = False


def get_logger(name: str = "helios") -> logging.Logger:
    global _LOG_READY
    if not _LOG_READY:
        try:  # Windows-консоль: печатаем кириллицу без ошибок
            sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
            sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )
        _LOG_READY = True
    return logging.getLogger(name)


log = get_logger()
_SESSION: requests.Session | None = None


def http() -> requests.Session:
    """Общая HTTP-сессия с повторами на 429/5xx и нейтральным User-Agent."""
    global _SESSION
    if _SESSION is None:
        s = requests.Session()
        retry = Retry(
            total=5,
            backoff_factor=1.5,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET", "POST"]),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_maxsize=16)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        s.headers["User-Agent"] = "HELIOS-SHIELD/0.1 (research client)"
        _SESSION = s
    return _SESSION


def _cache_path(key: str, suffix: str = ".json") -> Path:
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:20]
    CACHE.mkdir(parents=True, exist_ok=True)
    return CACHE / f"{digest}{suffix}"


def get_json(
    url: str,
    params: dict | None = None,
    timeout: float = 60,
    ttl_s: float | None = None,
    headers: dict | None = None,
) -> Any:
    """GET → JSON. При ttl_s ответ кэшируется на диск (повторные запуски не дёргают API)."""
    key = url + "?" + json.dumps(params or {}, sort_keys=True)
    path = _cache_path(key)
    if ttl_s is not None and path.exists() and time.time() - path.stat().st_mtime < ttl_s:
        return json.loads(path.read_text(encoding="utf-8"))
    r = http().get(url, params=params, timeout=timeout, headers=headers)
    r.raise_for_status()
    data = r.json()
    if ttl_s is not None:
        path.write_text(json.dumps(data), encoding="utf-8")
    return data


def get_text(url: str, params: dict | None = None, timeout: float = 60, ttl_s: float | None = None) -> str:
    key = url + "?" + json.dumps(params or {}, sort_keys=True)
    path = _cache_path(key, ".txt")
    if ttl_s is not None and path.exists() and time.time() - path.stat().st_mtime < ttl_s:
        return path.read_text(encoding="utf-8")
    r = http().get(url, params=params, timeout=timeout)
    r.raise_for_status()
    if ttl_s is not None:
        path.write_text(r.text, encoding="utf-8")
    return r.text


def download(url: str, dest: Path, timeout: float = 300, skip_existing: bool = True) -> Path | None:
    """Скачать файл. Возвращает None, если на сервере файла нет (404)."""
    dest = Path(dest)
    if skip_existing and dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = http().get(url, timeout=timeout, stream=True)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    tmp = dest.with_suffix(dest.suffix + ".part")
    with open(tmp, "wb") as f:
        for chunk in r.iter_content(chunk_size=1 << 20):
            f.write(chunk)
    tmp.replace(dest)
    return dest


def save_json(obj: Any, path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    return path


def _json_default(o: Any) -> Any:
    try:
        import numpy as np

        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return None if np.isnan(o) else float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, np.bool_):
            return bool(o)
    except ImportError:
        pass
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return str(o)
