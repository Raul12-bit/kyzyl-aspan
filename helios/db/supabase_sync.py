"""Выгрузка результатов в Supabase (PostgREST).

Запись идёт одним из двух способов:
1. SUPABASE_SERVICE_ROLE_KEY задан — обычный upsert через REST (обходит RLS);
2. иначе — RPC helios_ingest(token, table, rows) с HELIOS_INGEST_TOKEN из .env
   (функция SECURITY DEFINER проверяет sha256-хэш токена и пишет только в разрешённые таблицы).
Чтение для фронтенда — ключом SUPABASE_PUBLISHABLE_KEY (RLS: всем можно читать).
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ..config import MODELS_DIR, PROCESSED, REPORTS_DIR, env, settings
from ..utils import get_logger, http

log = get_logger("helios.supabase")


def _records(df: pd.DataFrame) -> list[dict]:
    """DataFrame → JSON-записи (NaN → null, даты → ISO, numpy → python)."""
    return json.loads(df.to_json(orient="records", date_format="iso", default_handler=str))


class SupabaseClient:
    def __init__(self):
        self.url = (env("SUPABASE_URL") or "").rstrip("/")
        self.service_key = env("SUPABASE_SERVICE_ROLE_KEY")
        self.public_key = env("SUPABASE_PUBLISHABLE_KEY") or env("SUPABASE_ANON_KEY")
        self.token = env("HELIOS_INGEST_TOKEN")
        if not self.url or not (self.service_key or self.public_key):
            raise RuntimeError("SUPABASE_URL и ключ не заданы в .env")

    def _headers(self, write: bool = False) -> dict:
        key = self.service_key if (write and self.service_key) else self.public_key or self.service_key
        h = {"apikey": key, "Content-Type": "application/json"}
        if key and not key.startswith("sb_"):
            h["Authorization"] = f"Bearer {key}"
        return h

    def ping(self) -> str:
        r = http().get(f"{self.url}/rest/v1/regions", params={"select": "id,name", "limit": 5}, headers=self._headers(), timeout=30)
        r.raise_for_status()
        mode = "service_role" if self.service_key else ("ingest-token" if self.token else "read-only")
        return f"{len(r.json())} регион(ов), запись: {mode}"

    def select(self, table: str, params: dict | None = None) -> list[dict]:
        r = http().get(f"{self.url}/rest/v1/{table}", params=params or {"select": "*"}, headers=self._headers(), timeout=60)
        r.raise_for_status()
        return r.json()

    def upsert(self, table: str, rows: list[dict], chunk: int = 500, mode: str = "upsert") -> int:
        total = 0
        for i in range(0, max(len(rows), 1), chunk):
            part = rows[i:i + chunk]
            if not part and mode != "replace":
                break
            m = mode if i == 0 else "upsert"
            if self.service_key:
                if m == "replace":
                    http().delete(f"{self.url}/rest/v1/{table}", params={"select": "*"}, headers=self._headers(True), timeout=120)
                h = {**self._headers(True), "Prefer": "resolution=merge-duplicates,return=minimal"}
                r = http().post(f"{self.url}/rest/v1/{table}", headers=h, data=json.dumps(part), timeout=120)
                r.raise_for_status()
                total += len(part)
            else:
                if not self.token:
                    raise RuntimeError("нужен HELIOS_INGEST_TOKEN или SUPABASE_SERVICE_ROLE_KEY для записи")
                r = http().post(f"{self.url}/rest/v1/rpc/helios_ingest", headers=self._headers(),
                                data=json.dumps({"p_token": self.token, "p_table": table, "p_rows": part, "p_mode": m}),
                                timeout=120)
                if r.status_code >= 400:
                    raise RuntimeError(f"{table}: {r.status_code} {r.text[:300]}")
                total += int(r.json() or 0)
        return total


# ----------------------------------------------------------------------------- таблицы
def _tbl_reference() -> dict[str, list[dict]]:
    from ..apis.celestrak import SATELLITES, STREAM_TO_SAT
    from ..comms.stations import STATIONS

    sat_rows = []
    for stream, name in STREAM_TO_SAT.items():
        norad, role, sensor = SATELLITES[name]
        sat_rows.append({"id": stream, "name": name, "norad": norad, "sensor": sensor, "role": role,
                         "active": stream != "VIIRS_SNPP",
                         "note": "Suomi-NPP: NRT-данные прекратились 2026-11-02" if stream == "VIIRS_SNPP" else None})
    for name, (norad, role, sensor) in SATELLITES.items():
        if role.startswith("relay"):
            sat_rows.append({"id": name, "name": name, "norad": norad, "sensor": sensor, "role": role, "active": True, "note": None})
    st_rows = [{"id": s["id"], "name": s["name"], "lat": s["lat"], "lon": s["lon"], "alt_m": s["alt_m"], "kind": s["kind"],
                "bands": s.get("bands"), "dish_m": s.get("dish_m"), "aperture_m": s.get("aperture_m"),
                "geomag_lat": s["geomag_lat"], "is_real": s["real"]} for s in STATIONS]
    reg = settings()["region"]
    return {"regions": [{"id": reg["id"], "name": reg["name"], "bbox": reg["bbox"]}],
            "satellites": sat_rows, "ground_stations": st_rows}


def _tbl_history() -> dict[str, pd.DataFrame]:
    out = {}
    reg = settings()["region"]["id"]
    if (PROCESSED / "calendar_monthly.parquet").exists():
        c = pd.read_parquet(PROCESSED / "calendar_monthly.parquet")
        c = c.rename(columns={k: k.lower() for k in c.columns if k.startswith("celldays_")})
        c["month"] = pd.to_datetime(c["month"]).dt.strftime("%Y-%m-01")
        c["region_id"] = reg
        cols = ["region_id", "month", "year", "mon", "harmonized", "harmonized_day", "harmonized_night", "lo95", "hi95",
                "raw_detections", "raw_union_celldays", "celldays_modis_a", "celldays_modis_t", "celldays_viirs_snpp",
                "celldays_viirs_noaa20", "anomaly_z", "pct_rank", "streams"]
        out["burning_calendar"] = c.reindex(columns=cols)
    if (PROCESSED / "calibration.parquet").exists():
        out["calibration"] = pd.read_parquet(PROCESSED / "calibration.parquet")
    if (PROCESSED / "static_registry.parquet").exists():
        r = pd.read_parquet(PROCESSED / "static_registry.parquet")
        out["static_sources"] = r[r["is_static"]][["h3_r8", "lat", "lon", "n", "static_score", "static_type_share",
                                                   "max_months_in_year", "years_with_6m", "night_share", "frp_median",
                                                   "first_year", "last_year", "ev_type", "ev_temporal", "ev_hdbscan"]]
    if (PROCESSED / "fire_dna_r7.parquet").exists():
        d = pd.read_parquet(PROCESSED / "fire_dna_r7.parquet")
        d = d[d["n_det"] >= 5]
        out["fire_dna"] = d[["h3_r7", "lat", "lon", "dna_class", "label_ru", "confidence", "p_industrial", "p_agricultural",
                             "p_wildfire", "p_sporadic", "n_det", "n_years", "first_year", "last_year", "peak_doy",
                             "night_share", "frp_median"]].round(4)
    if (PROCESSED / "cell_weekly_r5.parquet").exists():
        w = pd.read_parquet(PROCESSED / "cell_weekly_r5.parquet")
        w["month"] = pd.to_datetime(w["week"]).dt.strftime("%Y-%m-01")
        m = w.groupby(["h3_r5", "month"]).agg(union_celldays=("union_celldays", "sum"),
                                              harmonized_celldays=("harmonized_celldays", "sum"),
                                              frp_sum=("frp_sum", "sum")).reset_index().round(3)
        out["cell_activity_monthly"] = m
    if (PROCESSED / "season_shift_r4.parquet").exists():
        out["season_shift_cells"] = pd.read_parquet(PROCESSED / "season_shift_r4.parquet")
    return out


def _tbl_ai() -> dict[str, pd.DataFrame]:
    out = {}
    if (PROCESSED / "time_machine.parquet").exists():
        t = pd.read_parquet(PROCESSED / "time_machine.parquet")
        t = t.rename(columns={"horizon_weeks": "horizon_weeks"})
        t["as_of"] = pd.to_datetime(t["as_of"]).dt.strftime("%Y-%m-%d")
        t["target_week"] = pd.to_datetime(t["target_week"]).dt.strftime("%Y-%m-%d")
        out["time_machine"] = t[["as_of", "horizon_weeks", "h3_r5", "target_week", "lat", "lon", "p_fire", "p_climatology", "actual"]]
    if (PROCESSED / "risk_latest.parquet").exists():
        r = pd.read_parquet(PROCESSED / "risk_latest.parquet")
        for c in ("as_of_week", "target_week"):
            r[c] = pd.to_datetime(r[c]).dt.strftime("%Y-%m-%d")
        out["risk_forecast"] = r
    if (PROCESSED / "blind_spots_hist.parquet").exists():
        import h3

        b = pd.read_parquet(PROCESSED / "blind_spots_hist.parquet")
        b = b[pd.to_datetime(b["week"]) >= "2024-01-01"]
        if len(b):
            ll = np.array([h3.cell_to_latlng(c) for c in b["h3_r5"]])
            b = b.assign(h3=b["h3_r5"], week=pd.to_datetime(b["week"]).dt.strftime("%Y-%m-%d"), source="history",
                         message="Облачно в часы пролётов при высоком ожидаемом риске — возможны пропущенные очаги",
                         lat=ll[:, 0].round(4), lon=ll[:, 1].round(4))
            out["blind_spots"] = b[["h3", "week", "source", "expected_fire_p", "cloud_frac", "blind_score",
                                    "fire_next_week", "message", "lat", "lon"]].round(4)
    if (PROCESSED / "delivery_alerts.parquet").exists():
        a = pd.read_parquet(PROCESSED / "delivery_alerts.parquet")
        a.columns = [c.lower() for c in a.columns]
        a = a.assign(source="replay")
        keep = ["alert_id", "source", "stream", "acq_dt", "lat", "lon", "priority", "p_real", "p_escalation", "frp_sum",
                "cluster_n", "packet_hex", "latency_a_nrt_min", "latency_b_storeforward_min", "latency_c_kz_station_min",
                "latency_d1_real_relay_min", "latency_d2_relay_76e_min", "station_b", "relay_d1", "confirmed",
                "confirm_stream", "confirm_delay_min", "next_look_sat", "next_look_min"]
        out["alerts_replay"] = a.reindex(columns=keep)
    return out


def _tbl_nrt() -> dict[str, pd.DataFrame]:
    out = {}
    if (PROCESSED / "nrt_scored.parquet").exists():
        s = pd.read_parquet(PROCESSED / "nrt_scored.parquet")
        s["id"] = (s["stream"].astype(str) + "_" + s["acq_dt"].dt.strftime("%Y%m%d%H%M") + "_" +
                   s["lat"].round(4).astype(str) + "_" + s["lon"].round(4).astype(str))
        out["fire_detections_nrt"] = s.drop_duplicates("id")[[
            "id", "acq_dt", "lat", "lon", "stream", "sensor", "frp", "conf_cat", "p_fire", "keep_veg", "is_static",
            "noise_reason", "h3_r7", "h3_r5", "p_real", "p_escalation", "priority"]].astype({"stream": str, "sensor": str,
                                                                                          "conf_cat": str, "noise_reason": str,
                                                                                          "priority": str})
    if (PROCESSED / "nrt_alerts.parquet").exists():
        a = pd.read_parquet(PROCESSED / "nrt_alerts.parquet")
        if len(a):
            a = a.assign(source="nrt", stream=a["stream"].astype(str))
            out["alerts_nrt"] = a.reindex(columns=["alert_id", "source", "stream", "acq_dt", "lat", "lon", "h3_r7",
                                                   "priority", "p_real", "p_escalation", "frp_sum", "cluster_n", "packet_hex"])
    for name in ("comm_passes", "comm_blackouts", "satellite_delays", "spread_forecasts", "space_weather", "blind_spots_nrt"):
        if (PROCESSED / f"{name}.parquet").exists():
            df = pd.read_parquet(PROCESSED / f"{name}.parquet")
            df.columns = [c.lower() for c in df.columns]  # имена колонок Postgres — в нижнем регистре
            out[name] = df
    return out


def _model_registry() -> list[dict]:
    rows = []
    for name, kind, report, artifact in (
        ("ai1_edge_detector", "onboard MLP (ONNX int8)", "ai1_edge_detector_metrics.json", "edge_detector_int8.onnx"),
        ("ai2_link_predictor", "onboard MLP (ONNX)", "ai2_link_metrics.json", "link_ai.onnx"),
        ("ai3_ground_forecast", "HistGradientBoosting x4 horizons", "ai3_ground_forecast_metrics.json", "ground_forecast_h1..h4.joblib"),
    ):
        path = REPORTS_DIR / report
        if path.exists():
            rows.append({"name": name, "kind": kind, "version": "0.1.0", "metrics": json.loads(path.read_text(encoding="utf-8")),
                         "artifact": f"artifacts/models/{artifact}",
                         "trained_at": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()})
    return rows


def _reports() -> list[dict]:
    rows = []
    for path in sorted(REPORTS_DIR.glob("*.json")):
        try:
            rows.append({"key": path.stem, "payload": json.loads(path.read_text(encoding="utf-8")),
                         "updated_at": datetime.now(timezone.utc).isoformat()})
        except Exception:
            continue
    return rows


def _tbl_world() -> dict[str, pd.DataFrame]:
    """Мировой контур: регионы, страны по месяцам, регионы по годам, текущий прогноз ИИ №3 (p ≥ 0,05)."""
    import h3
    import polars as pl

    from ..world.aggregate import AGG
    from ..world.regions import region_index

    out: dict[str, pd.DataFrame] = {}
    idx = region_index()
    out["world_regions"] = pd.DataFrame([{"region_id": r["id"], "iso2": r["iso2"], "name": r["name"],
                                          "name_ru": r["names"].get("ru"), "kind": r["type"], "bbox": r["bbox"],
                                          "area_km2": r["area_km2"]} for r in idx])
    am = pl.read_parquet(AGG / "area_month.parquet")
    month_date = (pl.date(2000 + pl.col("month") // 12, pl.col("month") % 12 + 1, 1)).alias("month")
    c = am.filter(pl.col("level") == "country").select(
        pl.col("area").alias("iso2"), month_date, pl.col("hex_any").alias("hexdays"), pl.col("hex_m").alias("hex_modis"),
        pl.col("hex_v").alias("hex_viirs"), (pl.col("n_mc") + pl.col("n_vc")).alias("detections"),
        pl.col("n_r").alias("detections_raw"), pl.col("n_low").alias("low_conf"), pl.col("n_static").alias("static_src"),
        pl.col("frp_sum").round(1))
    out["world_country_month"] = c.to_pandas()
    iso = {r["id"]: r["iso2"] for r in idx}
    r = (am.filter(pl.col("level") == "region").with_columns((2000 + pl.col("month") // 12).alias("year"))
         .group_by("area", "year").agg(pl.col("hex_any").sum().alias("hexdays"), pl.col("hex_m").sum().alias("hex_modis"),
                                        pl.col("hex_v").sum().alias("hex_viirs"),
                                        (pl.col("n_mc") + pl.col("n_vc")).sum().alias("detections"),
                                        pl.col("frp_sum").sum().round(1).alias("frp_sum")))
    r = r.with_columns(pl.col("area").replace_strict(iso, default="").alias("iso2")).rename({"area": "region_id"})
    out["world_region_year"] = r.to_pandas()
    risk = AGG.parent / "forecast" / "risk_latest.parquet"
    if risk.exists():
        k = pl.read_parquet(risk).filter(pl.col("p") >= 0.05)
        cells = [h3.int_to_str(int(x)) for x in k["h3"].to_list()]
        ll = [h3.cell_to_latlng(x) for x in cells]
        out["world_risk_latest"] = pd.DataFrame({
            "h3": cells, "horizon_weeks": k["horizon"].to_numpy().astype(int), "p_fire": k["p"].round(4).to_numpy(),
            "p_climatology": k["clim"].round(4).to_numpy(), "lat": [round(a, 3) for a, _ in ll],
            "lon": [round(b, 3) for _, b in ll], "as_of": k["as_of"].to_list()})
    return out


TABLE_OF = {"alerts_replay": "alerts", "alerts_nrt": "alerts", "blind_spots_nrt": "blind_spots"}
# группа -> (ключи выгрузки, функция-построитель); строим только то, что нужно (ежечасный refresh — лёгкий)
GROUPS = {
    "reference": (["regions", "satellites", "ground_stations"], _tbl_reference),
    "history": (["burning_calendar", "calibration", "static_sources", "fire_dna", "cell_activity_monthly",
                 "season_shift_cells"], _tbl_history),
    "ai": (["time_machine", "risk_forecast", "blind_spots", "alerts_replay"], _tbl_ai),
    "nrt": (["fire_detections_nrt", "alerts_nrt", "comm_passes", "comm_blackouts", "satellite_delays",
             "spread_forecasts", "space_weather", "blind_spots_nrt"], _tbl_nrt),
    "model_registry": (["model_registry"], lambda: {"model_registry": _model_registry()}),
    "reports": (["reports"], lambda: {"reports": _reports()}),
    "world": (["world_regions", "world_country_month", "world_region_year", "world_risk_latest"], _tbl_world),
}
REPLACE_TABLES = {"world_risk_latest"}  # прогноз — целиком заменяется свежим


def _wanted(key: str, only: list[str] | None) -> bool:
    return not only or key in only or TABLE_OF.get(key, key) in only


def sync_all(only: list[str] | None = None) -> dict:
    client = SupabaseClient()
    log.info("Supabase: %s", client.ping())
    plan: dict[str, list[dict]] = {}
    for keys, builder in GROUPS.values():
        if not any(_wanted(k, only) for k in keys):
            continue
        for k, v in builder().items():
            plan[k] = v if isinstance(v, list) else _records(v)
    order = [k for keys, _ in GROUPS.values() for k in keys if k in plan]
    result = {}
    for key in order:
        table = TABLE_OF.get(key, key)
        if not _wanted(key, only):
            continue
        rows = plan[key]
        if not rows:
            continue
        try:
            n = client.upsert(table, rows, mode="replace" if table in REPLACE_TABLES else "upsert")
            result[key] = n
            log.info("Supabase %-24s %6d rows", key, n)
        except Exception as exc:
            result[key] = f"ERROR: {exc}"
            log.warning("Supabase %s: %s", key, exc)
    return result
