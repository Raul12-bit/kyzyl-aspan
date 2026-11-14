"""Мировые агрегаты HELIOS (DuckDB, вне памяти) из Parquet-архива обнаружений.

Что строится (data/processed/world/agg/):
    static_r8.parquet       реестр постоянных источников тепла (факелы, заводы, вулканы) — res 8
    cellday_r{7..3}.parquet «горящие гексагоно-сутки»: битовая маска потоков (спутник × день/ночь),
                            чистые / все обнаружения, шум, FRP
    cellmonth_r{7..3}.parquet то же помесячно + центр ячейки — для карты гексагонов любого масштаба
    cells_r6.parquet        ячейки res 6 → регион (admin-1) и страна
    area_month.parquet      помесячно по регионам, странам и миру: cell-days по потокам × день/ночь
    coverage.parquet        доля суток месяца, когда поток вообще работал (глобально)

Сутки — местные солнечные (UTC + долгота/15 ч): ночной пролёт в 01:30 относится к своим суткам.
Чистое обнаружение = не low-confidence, поле FIRMS type = 0 и не в буфере постоянного источника.
"""

from __future__ import annotations

import json
import time

import duckdb
import h3
import numpy as np
import polars as pl
from h3ronpy import vector as h3v

from ..config import CACHE
from ..utils import get_logger
from .ingest import DET_DIR, WORLD
from .regions import assign_points, region_index

log = get_logger("helios.world.aggregate")

AGG = WORLD / "agg"
RES_LIST = (7, 6, 5, 4, 3, 2)
STREAM_OF_SAT = {0: "MODIS_T", 1: "MODIS_A", 2: "VIIRS_SNPP", 3: "VIIRS_NOAA20", 4: "VIIRS_NOAA21"}
MODIS_MASK = 0b0000001111  # биты (sat*2 + night) для sat 0,1
VIIRS_MASK = 0b1111110000  # sat 2,3,4
EPOCH = "DATE '2000-01-01'"


def con(memory_gb: int = 9) -> duckdb.DuckDBPyConnection:
    tmp = CACHE / "duckdb_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    c = duckdb.connect()
    c.execute(f"SET memory_limit='{memory_gb}GB'; SET threads=8; SET preserve_insertion_order=false; "
              f"SET temp_directory='{tmp.as_posix()}'; SET max_temp_directory_size='60GiB'")
    return c


def parent(col: str, r: int) -> str:
    """Родитель ячейки H3 на разрешении r битовыми операциями (без расширений)."""
    return (f"(({col} & ~(15::UBIGINT << 52)) | ({r}::UBIGINT << 52) | "
            f"((1::UBIGINT << {45 - 3 * r}) - 1::UBIGINT))")


def det_glob() -> str:
    return (DET_DIR / "*.parquet").as_posix()


LDAY = "(day::INTEGER + floor(((hhmm // 100) + (hhmm % 100) / 60.0 + lon / 15.0) / 24.0))::INTEGER"
MONTH_OF = f"((year({EPOCH} + {{d}}) - 2000) * 12 + month({EPOCH} + {{d}}) - 1)"


def _copy(c, sql: str, out) -> None:
    tmp = out.with_suffix(".tmp.parquet")
    c.execute(f"COPY ({sql}) TO '{tmp.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 500000)")
    tmp.replace(out)


# ----------------------------------------------------------------------------- постоянные источники
def build_static(c) -> pl.DataFrame:
    """Res-8 ячейки: поле type∈{1,2,3} у половины точек ИЛИ тепло ≥10 месяцев в году / ≥6 месяцев 3+ лет."""
    t0 = time.time()
    g = det_glob()
    # 1) простые счётчики по ячейке (без медиан и count DISTINCT — они держат все значения группы)
    c.execute(f"""
        CREATE OR REPLACE TEMP TABLE r8 AS
        SELECT h3, count(*)::INTEGER AS n, avg((type IN (1,2,3))::DOUBLE) AS st_share,
               avg(night::DOUBLE) AS night_share, avg(frp)::FLOAT AS frp_mean,
               year({EPOCH} + min(day)::INTEGER) AS first_year, year({EPOCH} + max(day)::INTEGER) AS last_year
        FROM read_parquet('{g}') GROUP BY h3 HAVING count(*) >= 4""")
    # 2) уникальные (год, месяц) только для кандидатов: GROUP BY без агрегатов = DISTINCT, потом счётчики
    c.execute(f"""
        CREATE OR REPLACE TEMP TABLE r8ym AS
        SELECT h3, y, count(*)::INTEGER AS months FROM (
            SELECT p.h3, year({EPOCH} + p.day::INTEGER) AS y, month({EPOCH} + p.day::INTEGER) AS m
            FROM read_parquet('{g}') p SEMI JOIN (SELECT h3 FROM r8 WHERE n >= 6) k ON p.h3 = k.h3
            GROUP BY 1, 2, 3
        ) GROUP BY 1, 2""")
    c.execute("""
        CREATE OR REPLACE TEMP TABLE r8m AS
        SELECT h3, count(*)::INTEGER AS n_years, max(months) AS max_months, sum((months >= 6)::INTEGER) AS years_6m
        FROM r8ym GROUP BY h3""")
    reg = c.sql("""
        SELECT r8.*, coalesce(n_years, 1) AS n_years, coalesce(max_months, 0) AS max_months,
               coalesce(years_6m, 0) AS years_6m, (st_share >= 0.5) AS ev_type,
               ((coalesce(max_months, 0) >= 10) OR (coalesce(years_6m, 0) >= 3)) AND coalesce(n_years, 1) >= 3 AS ev_temporal
        FROM r8 LEFT JOIN r8m USING (h3)""").pl()
    reg = reg.with_columns((pl.col("ev_type") | pl.col("ev_temporal")).alias("is_static"))
    st = reg.filter(pl.col("is_static"))
    coords = h3v.cells_to_coordinates(st["h3"].to_numpy())
    st = st.with_columns(pl.Series("lat", np.asarray(coords.column("lat")), dtype=pl.Float32),
                         pl.Series("lon", np.asarray(coords.column("lng")), dtype=pl.Float32))
    AGG.mkdir(parents=True, exist_ok=True)
    st.write_parquet(AGG / "static_r8.parquet", compression="zstd")
    log.info("постоянные источники: %d из %d кандидатов (type=%d, временные=%d), %.0f с", st.height, reg.height,
             int(reg["ev_type"].sum()), int(reg["ev_temporal"].sum()), time.time() - t0)
    return st


def _static_buffer(c, st: pl.DataFrame) -> None:
    cells: set[int] = set()
    for x in st["h3"].to_list():
        cells.update(h3.str_to_int(k) for k in h3.grid_disk(h3.int_to_str(x), 1))
    buf = pl.DataFrame({"h3": np.fromiter(cells, dtype=np.uint64)})
    c.register("static_buf_df", buf.to_arrow())
    c.execute("CREATE OR REPLACE TEMP TABLE static_buf AS SELECT h3::UBIGINT AS h3 FROM static_buf_df")
    log.info("буфер постоянных источников: %d ячеек res 8", buf.height)


# ----------------------------------------------------------------------------- гексагоно-сутки
def build_cellday(c) -> None:
    t0 = time.time()
    bit = "(1::USMALLINT << (sat::INTEGER * 2 + night::INTEGER))"
    sql = f"""
        SELECT {parent('h3', 7)} AS h3, {LDAY} AS lday,
               bit_or(CASE WHEN clean THEN {bit} ELSE 0::USMALLINT END) AS bits_c,
               bit_or({bit}) AS bits_r,
               sum((clean AND sat < 2)::INTEGER)::UINTEGER AS n_mc,
               sum((clean AND sat >= 2)::INTEGER)::UINTEGER AS n_vc,
               sum((conf = 0)::INTEGER)::UINTEGER AS n_low,
               sum((conf > 0 AND NOT clean)::INTEGER)::UINTEGER AS n_static,
               count(*)::UINTEGER AS n_r,
               max(CASE WHEN clean THEN frp END)::FLOAT AS frp_max,
               sum(CASE WHEN clean THEN frp ELSE 0 END)::FLOAT AS frp_sum
        FROM (SELECT p.h3, p.day, p.hhmm, p.lon, p.sat, p.night, p.conf, p.frp,
                     (p.conf > 0 AND p.type = 0 AND s.h3 IS NULL) AS clean
              FROM read_parquet('{det_glob()}') p LEFT JOIN static_buf s ON p.h3 = s.h3
              WHERE p.sat < 5)
        GROUP BY 1, 2"""
    _copy(c, sql, AGG / "cellday_r7.parquet")
    log.info("cellday r7: %.0f с", time.time() - t0)
    for r in RES_LIST[1:]:
        t1 = time.time()
        _copy(c, f"""
            SELECT {parent('h3', r)} AS h3, lday, bit_or(bits_c) AS bits_c, bit_or(bits_r) AS bits_r,
                   sum(n_mc)::UINTEGER AS n_mc, sum(n_vc)::UINTEGER AS n_vc, sum(n_low)::UINTEGER AS n_low,
                   sum(n_static)::UINTEGER AS n_static, sum(n_r)::UINTEGER AS n_r,
                   max(frp_max) AS frp_max, sum(frp_sum) AS frp_sum
            FROM read_parquet('{(AGG / f"cellday_r{r + 1}.parquet").as_posix()}') GROUP BY 1, 2""",
              AGG / f"cellday_r{r}.parquet")
        log.info("cellday r%d: %.0f с", r, time.time() - t1)


def _centers(cells: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    xy = h3v.cells_to_coordinates(cells)
    return np.asarray(xy.column("lat"), dtype=np.float32), np.asarray(xy.column("lng"), dtype=np.float32)


def build_cellmonth(c) -> None:
    for r in RES_LIST:
        t0 = time.time()
        src = (AGG / f"cellday_r{r}.parquet").as_posix()
        cells = c.execute(f"SELECT DISTINCT h3 FROM read_parquet('{src}')").fetchnumpy()["h3"].astype(np.uint64)
        lat, lon = _centers(cells)
        c.register("centers_df", pl.DataFrame({"h3": cells, "lat": lat, "lon": lon}).to_arrow())
        mon = MONTH_OF.format(d="lday")
        _copy(c, f"""
            SELECT m.*, k.lat, k.lon FROM (
                SELECT h3, {mon}::USMALLINT AS month,
                       sum(((bits_c & {MODIS_MASK}) > 0)::INTEGER)::USMALLINT AS d_cm,
                       sum(((bits_c & {VIIRS_MASK}) > 0)::INTEGER)::USMALLINT AS d_cv,
                       sum((bits_c > 0)::INTEGER)::USMALLINT AS d_ca,
                       sum(((bits_r & {MODIS_MASK}) > 0)::INTEGER)::USMALLINT AS d_rm,
                       sum(((bits_r & {VIIRS_MASK}) > 0)::INTEGER)::USMALLINT AS d_rv,
                       sum((bits_r > 0)::INTEGER)::USMALLINT AS d_ra,
                       sum(n_mc + n_vc)::UINTEGER AS n_c, sum(n_r)::UINTEGER AS n_r,
                       max(frp_max) AS frp_max
                FROM read_parquet('{src}') GROUP BY 1, 2
            ) m JOIN centers_df k ON m.h3 = k.h3::UBIGINT ORDER BY m.h3, m.month""",
              AGG / f"cellmonth_r{r}.parquet")
        c.unregister("centers_df")
        log.info("cellmonth r%d: %d ячеек, %.0f с", r, len(cells), time.time() - t0)


# ----------------------------------------------------------------------------- регионы и ряды
def build_cells_r6(c) -> pl.DataFrame:
    t0 = time.time()
    cells = c.execute(f"SELECT DISTINCT h3 FROM read_parquet('{(AGG / 'cellday_r6.parquet').as_posix()}')"
                      ).fetchnumpy()["h3"].astype(np.uint64)
    lat, lon = _centers(cells)
    reg = assign_points(lat, lon)
    idx = region_index()
    iso = np.array([r["iso2"] for r in idx] + [""], dtype=object)
    df = pl.DataFrame({"h3": cells, "lat": lat, "lon": lon, "region": reg.astype(np.int32),
                       "iso2": iso[reg]})
    df.write_parquet(AGG / "cells_r6.parquet", compression="zstd")
    log.info("ячейки r6 → регионы: %d ячеек, вне регионов %.1f%%, %.0f с", df.height,
             100 * float((reg < 0).mean()), time.time() - t0)
    return df


def build_area_month(c) -> None:
    """Помесячно по регионам → странам → миру: cell-days каждого потока (спутник × день/ночь) на res 6."""
    t0 = time.time()
    cells = pl.read_parquet(AGG / "cells_r6.parquet")
    c.register("cells_df", cells.select("h3", "region").to_arrow())
    mon = MONTH_OF.format(d="lday")
    bits = ", ".join(f"sum(((bits_c >> {k}) & 1)::INTEGER)::UINTEGER AS c{k}" for k in range(10))
    reg = c.sql(f"""
        SELECT k.region, {mon}::USMALLINT AS month, {bits},
               sum((bits_r > 0)::INTEGER)::UINTEGER AS r_any,
               sum((bits_c > 0)::INTEGER)::UINTEGER AS hex_any,
               sum(((bits_c & {MODIS_MASK}) > 0)::INTEGER)::UINTEGER AS hex_m,
               sum(((bits_c & {VIIRS_MASK}) > 0)::INTEGER)::UINTEGER AS hex_v,
               sum(n_mc)::UBIGINT AS n_mc, sum(n_vc)::UBIGINT AS n_vc, sum(n_low)::UBIGINT AS n_low,
               sum(n_static)::UBIGINT AS n_static, sum(n_r)::UBIGINT AS n_r, sum(frp_sum)::DOUBLE AS frp_sum,
               count(DISTINCT d.h3)::UINTEGER AS cells
        FROM read_parquet('{(AGG / 'cellday_r6.parquet').as_posix()}') d JOIN cells_df k ON d.h3 = k.h3::UBIGINT
        GROUP BY 1, 2""").pl()
    c.unregister("cells_df")
    idx = region_index()
    rid = np.array([r["id"] for r in idx] + ["OCEAN"], dtype=object)
    iso = np.array([r["iso2"] for r in idx] + ["OCEAN"], dtype=object)
    r_arr = reg["region"].to_numpy()
    reg = reg.with_columns(pl.Series("area", rid[r_arr]), pl.Series("iso2", iso[r_arr])).drop("region")
    num = [x for x in reg.columns if x not in ("area", "iso2", "month")]
    country = reg.group_by("iso2", "month").agg([pl.col(x).sum() for x in num]).rename({"iso2": "area"})
    world = reg.group_by("month").agg([pl.col(x).sum() for x in num]).with_columns(pl.lit("WORLD").alias("area"))
    out = pl.concat([reg.drop("iso2").with_columns(pl.lit("region").alias("level")),
                     country.with_columns(pl.lit("country").alias("level")),
                     world.with_columns(pl.lit("world").alias("level"))], how="diagonal")
    out = out.filter(pl.col("area") != "OCEAN").sort("area", "month")
    out.write_parquet(AGG / "area_month.parquet", compression="zstd")
    log.info("area_month: %d строк (%d регионов, %d стран), %.0f с", out.height,
             out.filter(pl.col("level") == "region")["area"].n_unique(),
             out.filter(pl.col("level") == "country")["area"].n_unique(), time.time() - t0)


def build_coverage(c) -> None:
    """Глобальная доля суток месяца, когда поток что-то видел (признак работы сенсора)."""
    mon = MONTH_OF.format(d="d")
    cov = c.sql(f"""
        SELECT sat, {mon}::USMALLINT AS month, count(DISTINCT d)::INTEGER AS active_days FROM (
            SELECT DISTINCT sat, day::INTEGER AS d FROM read_parquet('{det_glob()}')
        ) GROUP BY 1, 2 ORDER BY 1, 2""").pl()
    days = cov.select(pl.col("month")).to_series().map_elements(
        lambda m: [31, 29 if (2000 + m // 12) % 4 == 0 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m % 12],
        return_dtype=pl.Int32)
    cov = cov.with_columns((pl.col("active_days") / days).clip(upper_bound=1.0).alias("coverage"),
                           pl.col("sat").replace_strict(STREAM_OF_SAT, return_dtype=pl.Utf8).alias("stream"))
    cov.write_parquet(AGG / "coverage.parquet")
    log.info("coverage: %d строк", cov.height)


def build_all(skip_static: bool = False) -> dict:
    t0 = time.time()
    c = con()
    AGG.mkdir(parents=True, exist_ok=True)
    if skip_static and (AGG / "static_r8.parquet").exists():
        st = pl.read_parquet(AGG / "static_r8.parquet")
    else:
        st = build_static(c)
    _static_buffer(c, st)
    build_cellday(c)
    build_cellmonth(c)
    build_coverage(c)
    build_cells_r6(c)
    build_area_month(c)
    files = sorted(p.name for p in DET_DIR.glob("*.parquet"))
    summary = {"det_files": files, "static_cells": st.height, "seconds": round(time.time() - t0)}
    (AGG / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    log.info("мировые агрегаты готовы за %.0f с", time.time() - t0)
    return summary


if __name__ == "__main__":
    import sys

    build_all(skip_static="--skip-static" in sys.argv)
