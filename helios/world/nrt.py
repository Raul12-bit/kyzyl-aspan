"""Свежие пожары всего мира за 7 дней (открытые ленты NASA FIRMS NRT, без ключа) для текущего прогноза.

Ленты: MODIS C6.1, VIIRS NOAA-20, VIIRS NOAA-21 (и S-NPP, пока лента жива). Файлы по 10–100 МБ, сервер
медленный — качаем частями в несколько потоков (как архив). Фильтр: low confidence и буфер мирового
реестра постоянных источников (в NRT нет поля type).
"""

from __future__ import annotations

import concurrent.futures as cf
import time
from pathlib import Path

import h3
import numpy as np
import polars as pl
import requests
from h3ronpy import vector as h3v

from ..config import RAW
from ..utils import get_logger
from .aggregate import AGG
from .fetch import UA, _fetch_range

log = get_logger("helios.world.nrt")

BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
FEEDS = [
    ("modis-c6.1", "MODIS_C6_1_Global_7d.csv", 0),
    ("noaa-20-viirs-c2", "J1_VIIRS_C2_Global_7d.csv", 3),
    ("noaa-21-viirs-c2", "J2_VIIRS_C2_Global_7d.csv", 4),
    ("suomi-npp-viirs-c2", "SUOMI_VIIRS_C2_Global_7d.csv", 2),
]
NRT_DIR = RAW / "global_nrt"
CHUNK = 2 * 1024 * 1024


def _download(url: str, dest: Path, threads: int = 8, max_age_h: float = 3.0, download: bool = True) -> Path | None:
    if dest.exists() and (not download or time.time() - dest.stat().st_mtime < max_age_h * 3600):
        return dest
    if not download:
        return None
    head = requests.head(url, timeout=30, headers=UA, allow_redirects=True)
    if head.status_code != 200:
        log.warning("NRT нет файла %s (%s)", dest.name, head.status_code)
        return None
    size = int(head.headers.get("Content-Length", 0))
    dest.parent.mkdir(parents=True, exist_ok=True)
    if size <= 0 or head.headers.get("accept-ranges", "").lower() != "bytes":
        r = requests.get(url, timeout=600, headers=UA)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return dest
    parts = [(a, min(size, a + CHUNK) - 1) for a in range(0, size, CHUNK)]
    buf = bytearray(size)

    def job(ab):
        sess = requests.Session()
        for k in range(30):
            try:
                data = _fetch_range(sess, url, ab[0], ab[1])
                buf[ab[0]:ab[1] + 1] = data
                return
            except Exception:
                time.sleep(min(30, 1.5 ** k))
        raise IOError(f"кусок {ab} не скачался")

    with cf.ThreadPoolExecutor(threads) as ex:
        list(ex.map(job, parts))
    tmp = dest.with_suffix(".tmp")
    tmp.write_bytes(bytes(buf))
    tmp.replace(dest)
    log.info("NRT %s: %.1f МБ", dest.name, size / 2**20)
    return dest


def _static_buffer() -> np.ndarray:
    st = pl.read_parquet(AGG / "static_r8.parquet", columns=["h3"])
    cells: set[int] = set()
    for x in st["h3"].to_list():
        cells.update(h3.str_to_int(k) for k in h3.grid_disk(h3.int_to_str(x), 1))
    return np.fromiter(cells, dtype=np.uint64)


def refresh_files(max_age_h: float = 3.0) -> list[str]:
    """Перекачивает ленты старше max_age_h часов (для часового обновления и глобуса сайта)."""
    done = []
    for folder, name, _sat in FEEDS:
        try:
            if _download(f"{BASE}/{folder}/csv/{name}", NRT_DIR / name, max_age_h=max_age_h):
                done.append(name)
        except Exception as e:
            log.warning("NRT %s: %s", name, e)
    return done


def global_nrt_frame(download: bool = True) -> pl.DataFrame:
    frames = []
    for folder, name, sat in FEEDS:
        try:
            p = _download(f"{BASE}/{folder}/csv/{name}", NRT_DIR / name, download=download)
        except Exception as e:
            log.warning("NRT %s: %s", name, e)
            continue
        if p is None or p.stat().st_size < 200:
            continue
        df = pl.read_csv(p, columns=["latitude", "longitude", "acq_date", "acq_time", "confidence", "frp", "daynight"],
                         schema_overrides={"acq_time": pl.Utf8, "confidence": pl.Utf8}, ignore_errors=True)
        conf = pl.col("confidence").str.strip_chars().str.to_lowercase()
        low = (conf == "l") if sat >= 2 else (conf.cast(pl.Float32, strict=False).fill_null(0) < 30)
        frames.append(df.select(
            pl.col("latitude").cast(pl.Float64).alias("lat"), pl.col("longitude").cast(pl.Float64).alias("lon"),
            pl.col("acq_date").str.to_date("%Y-%m-%d", strict=False).alias("date"),
            pl.col("acq_date").alias("date_str"),
            pl.col("acq_time").str.strip_chars().cast(pl.Int32, strict=False).fill_null(0).alias("hhmm"),
            low.alias("low"), pl.col("frp").cast(pl.Float32, strict=False).fill_null(0).alias("frp"),
            pl.lit(sat, dtype=pl.UInt8).alias("sat"), (pl.col("daynight") == "N").alias("night")))
    if not frames:
        raise RuntimeError("ни одна лента NRT не скачалась")
    return pl.concat(frames)


def global_nrt_week() -> tuple[np.ndarray, np.ndarray, np.ndarray, str]:
    """Ячейки res 5 с чистым огнём за последние 7 дней: (ячейки, дней с огнём, обнаружений, дата «на сегодня»)."""
    df = global_nrt_frame().filter(~pl.col("low") & pl.col("date").is_not_null())
    as_of = df["date"].max()
    r8 = np.asarray(h3v.coordinates_to_cells(df["lat"].to_numpy(), df["lon"].to_numpy(), 8).to_numpy(), np.uint64)
    clean = ~np.isin(r8, _static_buffer())
    df = df.with_columns(pl.Series("r8", r8)).filter(pl.Series(clean))
    r5 = np.asarray(h3v.coordinates_to_cells(df["lat"].to_numpy(), df["lon"].to_numpy(), 5).to_numpy(), np.uint64)
    hours = (df["hhmm"].to_numpy() // 100) + (df["hhmm"].to_numpy() % 100) / 60.0 + df["lon"].to_numpy() / 15.0
    lday = (df["date"].cast(pl.Int32).to_numpy() + np.floor(hours / 24.0)).astype(np.int64)
    g = pl.DataFrame({"h3": r5, "lday": lday}).group_by("h3").agg(pl.col("lday").n_unique().alias("days"),
                                                                 pl.len().alias("n"))
    log.info("NRT мир: %d чистых обнаружений, %d ячеек res 5, на %s", df.height, g.height, as_of)
    return (g["h3"].to_numpy().astype(np.uint64), g["days"].to_numpy(), g["n"].to_numpy(), str(as_of))
