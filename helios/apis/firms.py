"""NASA FIRMS — активные пожары MODIS (1 км) и VIIRS (375 м).

Три способа получить данные:
1. Годовой архив по стране (научное качество, с полем `type`) — БЕЗ ключа.
   https://firms.modaps.eosdis.nasa.gov/data/country/{stream}/{year}/{stream}_{year}_{Country}.csv
2. Открытые NRT-ленты (24h / 48h / 7d по регионам) — БЕЗ ключа.
3. Area API с MAP_KEY (любой bbox, любые даты, NRT и SP) — ключ бесплатный:
   https://firms.modaps.eosdis.nasa.gov/api/map_key/

Все источники приводятся к единой схеме (`normalize`), чтобы MODIS и VIIRS шли
через одни и те же фильтры.
"""

from __future__ import annotations

import io
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

import numpy as np
import pandas as pd

from ..config import PROCESSED, RAW, env, settings
from ..utils import download, get_logger, get_json, http

log = get_logger("helios.firms")

# Открытые NRT-ленты FIRMS (без ключа): папка -> шаблон имени файла
OPEN_FEEDS = {
    "MODIS": ("modis-c6.1", "MODIS_C6_1_{region}_{period}.csv"),
    "VIIRS_SNPP": ("suomi-npp-viirs-c2", "SUOMI_VIIRS_C2_{region}_{period}.csv"),
    "VIIRS_NOAA20": ("noaa-20-viirs-c2", "J1_VIIRS_C2_{region}_{period}.csv"),
    "VIIRS_NOAA21": ("noaa-21-viirs-c2", "J2_VIIRS_C2_{region}_{period}.csv"),
}

# Источники Area API (MAP_KEY)
AREA_SOURCES = {
    ("MODIS", "nrt"): "MODIS_NRT",
    ("MODIS", "sp"): "MODIS_SP",
    ("VIIRS_SNPP", "nrt"): "VIIRS_SNPP_NRT",
    ("VIIRS_SNPP", "sp"): "VIIRS_SNPP_SP",
    ("VIIRS_NOAA20", "nrt"): "VIIRS_NOAA20_NRT",
    ("VIIRS_NOAA20", "sp"): "VIIRS_NOAA20_SP",
    ("VIIRS_NOAA21", "nrt"): "VIIRS_NOAA21_NRT",
}

ARCHIVE_TO_STREAM = {
    "modis": "MODIS",
    "viirs-snpp": "VIIRS_SNPP",
    "viirs-jpss1": "VIIRS_NOAA20",
    "viirs-jpss2": "VIIRS_NOAA21",
}

SCHEMA = [
    "lat", "lon", "acq_dt", "sensor", "stream", "bright_mir", "bright_tir", "frp",
    "scan", "track", "conf_pct", "conf_cat", "daynight", "version", "type", "quality",
]


# ----------------------------------------------------------------------------- нормализация
def normalize(df: pd.DataFrame, stream: str, quality: str) -> pd.DataFrame:
    """Привести CSV FIRMS (любой источник) к единой схеме SCHEMA."""
    if df is None or df.empty:
        return pd.DataFrame(columns=SCHEMA)
    is_modis = "brightness" in df.columns
    out = pd.DataFrame(index=df.index)
    out["lat"] = pd.to_numeric(df["latitude"], errors="coerce")
    out["lon"] = pd.to_numeric(df["longitude"], errors="coerce")
    hhmm = pd.to_numeric(df["acq_time"], errors="coerce").fillna(0).astype(int).astype(str).str.zfill(4)
    out["acq_dt"] = pd.to_datetime(
        df["acq_date"].astype(str) + " " + hhmm, format="%Y-%m-%d %H%M", utc=True, errors="coerce"
    )
    if is_modis:
        sat = df["satellite"].astype(str).str.strip().str[0].str.upper()  # Terra/Aqua или T/A
        out["sensor"] = "MODIS"
        out["stream"] = np.where(sat == "A", "MODIS_A", "MODIS_T")
        out["bright_mir"] = pd.to_numeric(df["brightness"], errors="coerce")
        out["bright_tir"] = pd.to_numeric(df["bright_t31"], errors="coerce")
        conf = pd.to_numeric(df["confidence"], errors="coerce")
        out["conf_pct"] = conf
        out["conf_cat"] = np.select([conf < 30, conf < 80], ["l", "n"], "h")
    else:
        out["sensor"] = "VIIRS"
        out["stream"] = stream
        out["bright_mir"] = pd.to_numeric(df["bright_ti4"], errors="coerce")
        out["bright_tir"] = pd.to_numeric(df["bright_ti5"], errors="coerce")
        out["conf_pct"] = np.nan
        # архив: l/n/h; NRT: low/nominal/high
        out["conf_cat"] = df["confidence"].astype(str).str.strip().str.lower().str[0]
    out["frp"] = pd.to_numeric(df["frp"], errors="coerce").clip(lower=0)
    out["scan"] = pd.to_numeric(df["scan"], errors="coerce")
    out["track"] = pd.to_numeric(df["track"], errors="coerce")
    out["daynight"] = df["daynight"].astype(str).str.strip().str.upper().str[0]
    out["version"] = df["version"].astype(str)
    out["type"] = pd.to_numeric(df["type"], errors="coerce") if "type" in df.columns else np.nan
    out["quality"] = quality
    out = out.dropna(subset=["lat", "lon", "acq_dt"])
    for c in ("bright_mir", "bright_tir", "frp", "scan", "track", "conf_pct"):
        out[c] = out[c].astype("float32")
    out["type"] = out["type"].astype("float32")
    for c in ("sensor", "stream", "conf_cat", "daynight", "quality"):
        out[c] = out[c].astype("category")
    return out[SCHEMA].reset_index(drop=True)


def clip_bbox(df: pd.DataFrame, bbox: list[float] | None = None) -> pd.DataFrame:
    w, s, e, n = bbox or settings()["region"]["bbox"]
    m = df["lon"].between(w, e) & df["lat"].between(s, n)
    return df.loc[m].reset_index(drop=True)


# ----------------------------------------------------------------------------- годовой архив
def archive_url(archive: str, year: int, country: str) -> str:
    base = settings()["apis"]["firms"]
    return f"{base}/data/country/{archive}/{year}/{archive}_{year}_{country}.csv"


def download_country_archive(
    country: str | None = None,
    start_year: int | None = None,
    end_year: int | None = None,
    workers: int = 4,
) -> list[tuple[str, int, str]]:
    """Скачать годовые CSV по стране для всех потоков (MODIS, VIIRS SNPP/NOAA-20/NOAA-21)."""
    cfg = settings()
    country = country or cfg["region"]["firms_country"]
    start_year = start_year or cfg["history"]["start_year"]
    end_year = end_year or cfg["history"]["end_year"]
    jobs = []
    for meta in cfg["history"]["streams"].values():
        for year in range(max(start_year, meta["first_year"]), end_year + 1):
            jobs.append((meta["archive"], year))

    done: list[tuple[str, int, str]] = []

    def _one(archive: str, year: int):
        dest = RAW / "firms" / country / archive / f"{year}.csv"
        path = download(archive_url(archive, year, country), dest)
        return archive, year, ("ok" if path else "missing")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(_one, a, y) for a, y in jobs]
        for f in as_completed(futs):
            try:
                archive, year, status = f.result()
            except Exception as exc:  # сеть/сервер — не валим весь пайплайн
                log.warning("archive download failed: %s", exc)
                continue
            done.append((archive, year, status))
            log.info("FIRMS %s %s: %s", archive, year, status)
    return sorted(done)


def load_country_archive(country: str | None = None, cache: bool = True) -> pd.DataFrame:
    """Собрать все скачанные годовые CSV в один DataFrame единой схемы (+ parquet-кэш)."""
    country = country or settings()["region"]["firms_country"]
    out_path = PROCESSED / f"firms_archive_{country}.parquet"
    if cache and out_path.exists():
        return pd.read_parquet(out_path)
    frames = []
    for archive, stream in ARCHIVE_TO_STREAM.items():
        folder = RAW / "firms" / country / archive
        for csv in sorted(folder.glob("*.csv")) if folder.exists() else []:
            raw = pd.read_csv(csv, low_memory=False)
            frames.append(normalize(raw, stream, "sp"))
    if not frames:
        raise FileNotFoundError("Архив FIRMS не скачан: запустите `python -m helios.cli fetch-history`")
    df = pd.concat(frames, ignore_index=True)
    for c in ("sensor", "stream", "conf_cat", "daynight", "quality"):
        df[c] = df[c].astype("category")
    df = df.sort_values("acq_dt").reset_index(drop=True)
    PROCESSED.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_path, index=False)
    log.info("FIRMS archive: %d detections -> %s", len(df), out_path)
    return df


# ----------------------------------------------------------------------------- NRT без ключа
def _get_with_deadline(url: str, deadline_s: float = 180.0) -> tuple[int, str]:
    """GET с общим лимитом времени: сервер иногда отдаёт файл «по капле», и read-timeout не срабатывает."""
    t0 = time.time()
    with http().get(url, timeout=(15, 60), stream=True) as r:
        if r.status_code != 200:
            return r.status_code, ""
        chunks = []
        for chunk in r.iter_content(chunk_size=1 << 16):
            chunks.append(chunk)
            if time.time() - t0 > deadline_s:
                raise TimeoutError(f"загрузка дольше {deadline_s:.0f} с — пропускаю")
        return 200, b"".join(chunks).decode("utf-8", errors="replace")


def fetch_open_nrt(period: str = "48h", region: str | None = None, clip: bool = True) -> pd.DataFrame:
    """Свежие пожары из открытых лент FIRMS (24h | 48h | 7d) по всем спутникам."""
    region = region or settings()["region"]["firms_open_region"]
    base = settings()["apis"]["firms"]
    frames = []
    for stream, (folder, pattern) in OPEN_FEEDS.items():
        url = f"{base}/data/active_fire/{folder}/csv/{pattern.format(region=region, period=period)}"
        try:
            status, text = _get_with_deadline(url)
            if status != 200 or len(text) < 120:
                log.info("NRT %s: нет данных (%s)", stream, status)
                continue
            raw = pd.read_csv(io.StringIO(text))
        except Exception as exc:
            log.warning("NRT %s failed: %s", stream, exc)
            continue
        frames.append(normalize(raw, stream, "nrt"))
    if not frames:
        return pd.DataFrame(columns=SCHEMA)
    df = pd.concat(frames, ignore_index=True)
    return clip_bbox(df) if clip else df


# ----------------------------------------------------------------------------- Area API (MAP_KEY)
def map_key() -> str | None:
    return env("FIRMS_MAP_KEY")


def mapkey_status(key: str | None = None) -> dict:
    key = key or map_key()
    if not key:
        return {"ok": False, "reason": "FIRMS_MAP_KEY не задан в .env"}
    base = settings()["apis"]["firms"]
    data = get_json(f"{base}/mapserver/mapkey_status/", params={"MAP_KEY": key}, timeout=30)
    return {"ok": True, **data}


def fetch_area(
    source: str,
    day_range: int = 5,
    on_date: date | None = None,
    bbox: list[float] | None = None,
    key: str | None = None,
) -> pd.DataFrame:
    """Один запрос Area API. source — например VIIRS_NOAA20_NRT; day_range 1..5."""
    key = key or map_key()
    if not key:
        raise RuntimeError("Нужен FIRMS_MAP_KEY (бесплатно: firms.modaps.eosdis.nasa.gov/api/map_key/)")
    w, s, e, n = bbox or settings()["region"]["bbox"]
    base = settings()["apis"]["firms"]
    url = f"{base}/api/area/csv/{key}/{source}/{w},{s},{e},{n}/{day_range}"
    if on_date:
        url += f"/{on_date.isoformat()}"
    r = http().get(url, timeout=180)
    r.raise_for_status()
    if r.text.lower().startswith("invalid") or "error" in r.text[:80].lower():
        raise RuntimeError(f"FIRMS Area API: {r.text[:200]}")
    raw = pd.read_csv(io.StringIO(r.text))
    stream = next((k[0] for k, v in AREA_SOURCES.items() if v == source), "VIIRS_NOAA20")
    quality = "sp" if source.endswith("_SP") else "nrt"
    return normalize(raw, stream, quality)


def fetch_area_range(start: date, end: date, streams: list[str] | None = None, quality: str = "nrt") -> pd.DataFrame:
    """Area API за произвольный период (кусками по 5 дней) — например, весь 2026 год."""
    streams = streams or ["MODIS", "VIIRS_NOAA20", "VIIRS_NOAA21", "VIIRS_SNPP"]
    frames = []
    for stream in streams:
        source = AREA_SOURCES.get((stream, quality))
        if not source:
            continue
        day = start
        while day <= end:
            span = min(5, (end - day).days + 1)
            try:
                frames.append(fetch_area(source, day_range=span, on_date=day))
            except Exception as exc:
                log.warning("Area API %s %s: %s", source, day, exc)
            day += timedelta(days=span)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=SCHEMA)
