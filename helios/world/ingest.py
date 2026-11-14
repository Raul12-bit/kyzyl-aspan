"""Годовой zip FIRMS «все страны» → компактный Parquet: одна строка = одно обнаружение.

Схема (≈18 байт на точку после zstd):
    lat, lon       float32   центр пикселя
    day            uint16    дни с 2000-01-01
    hhmm           uint16    время съёмки UTC
    sat            uint8     0 Terra, 1 Aqua, 2 Suomi-NPP, 3 NOAA-20, 4 NOAA-21
    conf           uint8     0 low, 1 nominal, 2 high (MODIS: <30 / 30–79 / ≥80)
    frp            float32   мощность излучения, МВт
    bt, bt2        float32   яркостная температура (MODIS 4/11 мкм, VIIRS I4/I5), К
    scan, track    float32   размер пикселя поперёк/вдоль трассы, км
    night          uint8     1 — ночной пролёт
    type           uint8     поле FIRMS: 0 растительность, 1 вулкан, 2 статичный источник, 3 офшор
    country        uint16    индекс страны FIRMS (world/countries_firms.json)
    h3             uint64    ячейка H3 res 8 (~0,74 км²); строки отсортированы по ней

    python -m helios.world.ingest            # все скачанные zip, которых ещё нет в Parquet
    python -m helios.world.ingest --watch    # ждать новые zip от загрузчика
"""

from __future__ import annotations

import argparse
import json
import re
import threading
import time
import zipfile
from datetime import date
from pathlib import Path

import numpy as np
import polars as pl
from h3ronpy import vector as h3v

from ..config import PROCESSED
from ..utils import get_logger
from .fetch import GLOBAL_DIR

log = get_logger("helios.world.ingest")

WORLD = PROCESSED / "world"
DET_DIR = WORLD / "det"
COUNTRIES_JSON = WORLD / "countries_firms.json"
EPOCH = date(2000, 1, 1)
SAT_CODE = {"Terra": 0, "T": 0, "Aqua": 1, "A": 1, "N": 2, "NPP": 2, "Suomi NPP": 2,
            "1": 3, "N20": 3, "NOAA-20": 3, "J1": 3, "2": 4, "N21": 4, "NOAA-21": 4, "J2": 4}
_lock = threading.Lock()


def _country_index(name: str) -> int:
    """Стабильный индекс страны (имя из файла FIRMS) — один список на все годы и сенсоры."""
    with _lock:
        names: list[str] = json.loads(COUNTRIES_JSON.read_text(encoding="utf-8")) if COUNTRIES_JSON.exists() else []
        if name not in names:
            names.append(name)
            COUNTRIES_JSON.parent.mkdir(parents=True, exist_ok=True)
            COUNTRIES_JSON.write_text(json.dumps(names, ensure_ascii=False, indent=0), encoding="utf-8")
        return names.index(name)


def parquet_path(zip_file: Path) -> Path:
    m = re.match(r"(.+)_(\d{4})_all_countries\.zip", zip_file.name)
    assert m, zip_file.name
    return DET_DIR / f"{m.group(1)}_{m.group(2)}.parquet"


def _read_member(z: zipfile.ZipFile, name: str, viirs: bool) -> pl.DataFrame | None:
    raw = z.read(name)
    if len(raw) < 64:
        return None
    bt, bt2 = ("bright_ti4", "bright_ti5") if viirs else ("brightness", "bright_t31")
    df = pl.read_csv(raw, columns=["latitude", "longitude", bt, "scan", "track", "acq_date", "acq_time",
                                   "satellite", "confidence", bt2, "frp", "daynight", "type"],
                     schema_overrides={"acq_time": pl.Utf8, "satellite": pl.Utf8, "confidence": pl.Utf8,
                                       "type": pl.Utf8}, ignore_errors=True)
    if df.is_empty():
        return None
    country = re.sub(r"^.*?_\d{4}_", "", Path(name).stem)
    conf = pl.col("confidence").str.strip_chars().str.to_lowercase()
    if viirs:
        conf_code = pl.when(conf == "h").then(2).when(conf == "n").then(1).otherwise(0)
    else:
        c = conf.cast(pl.Float32, strict=False).fill_null(0)
        conf_code = pl.when(c >= 80).then(2).when(c >= 30).then(1).otherwise(0)
    return df.select(
        pl.col("latitude").cast(pl.Float32).alias("lat"),
        pl.col("longitude").cast(pl.Float32).alias("lon"),
        (pl.col("acq_date").str.to_date("%Y-%m-%d", strict=False) - pl.lit(EPOCH)).dt.total_days().cast(pl.UInt16).alias("day"),
        pl.col("acq_time").str.strip_chars().cast(pl.UInt16, strict=False).fill_null(0).alias("hhmm"),
        pl.col("satellite").str.strip_chars().replace_strict(SAT_CODE, default=255, return_dtype=pl.UInt8).alias("sat"),
        conf_code.cast(pl.UInt8).alias("conf"),
        pl.col("frp").cast(pl.Float32, strict=False).fill_null(0).alias("frp"),
        pl.col(bt).cast(pl.Float32, strict=False).alias("bt"),
        pl.col(bt2).cast(pl.Float32, strict=False).alias("bt2"),
        pl.col("scan").cast(pl.Float32, strict=False).alias("scan"),
        pl.col("track").cast(pl.Float32, strict=False).alias("track"),
        (pl.col("daynight").str.strip_chars() == "N").cast(pl.UInt8).alias("night"),
        pl.col("type").cast(pl.Float32, strict=False).fill_null(0).cast(pl.UInt8).alias("type"),
        pl.lit(_country_index(country), dtype=pl.UInt16).alias("country"),
    ).filter(pl.col("day").is_not_null())


def ingest_zip(zip_file: Path) -> Path:
    out = parquet_path(zip_file)
    if out.exists():
        return out
    t0 = time.time()
    viirs = zip_file.name.startswith("viirs")
    frames = []
    with zipfile.ZipFile(zip_file) as z:
        for name in z.namelist():
            if name.endswith(".csv"):
                df = _read_member(z, name, viirs)
                if df is not None:
                    frames.append(df)
    df = pl.concat(frames, how="vertical")
    cells = h3v.coordinates_to_cells(df["lat"].to_numpy().astype(np.float64), df["lon"].to_numpy().astype(np.float64), 8)
    df = df.with_columns(pl.Series("h3", np.asarray(cells.to_numpy()), dtype=pl.UInt64)).sort("h3")
    DET_DIR.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    df.write_parquet(tmp, compression="zstd", compression_level=3, row_group_size=1_000_000, statistics=True)
    tmp.replace(out)
    log.info("%s → %s: %d точек, %.0f МБ, %.0f с", zip_file.name, out.name, df.height, out.stat().st_size / 2**20,
             time.time() - t0)
    return out


def pending() -> list[Path]:
    return [z for z in sorted(GLOBAL_DIR.glob("*_all_countries.zip")) if not parquet_path(z).exists()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--watch", action="store_true", help="ждать новые zip, пока работает загрузчик")
    ap.add_argument("--delete-zip", action="store_true", help="удалять zip после конвертации")
    args = ap.parse_args()
    idle = 0
    while True:
        todo = pending()
        for z in todo:
            try:
                ingest_zip(z)
                if args.delete_zip:
                    z.unlink()
            except Exception as e:
                log.exception("ошибка %s: %s", z.name, e)
        if not args.watch:
            break
        busy = any(GLOBAL_DIR.glob("*.part"))
        idle = 0 if (todo or busy) else idle + 1
        if idle > 20:  # 10 минут без новых файлов и без активной загрузки
            break
        time.sleep(30)
    log.info("конвертация завершена: %d файлов Parquet", len(list(DET_DIR.glob("*.parquet"))))


if __name__ == "__main__":
    main()
