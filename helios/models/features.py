"""Панель признаков «ячейка H3 res-5 × неделя» для ИИ №3 (прогноз риска) и Time Machine.

Все признаки недели t используют ТОЛЬКО данные до конца недели t (без заглядывания вперёд):
* активность: cell-days за t, t-1, t-2, t-3, суммы за 4 и 8 недель, FRP;
* соседи: активность в кольцах k=1 и k=2 (распространение, общая «пожарная погода»);
* климатология: доля ПРОШЛЫХ лет, когда в эту неделю года (±1) ячейка горела;
* давность: недель с последнего пожара;
* погода NASA POWER (родительская ячейка res-3): t° макс, влажность, ветер, осадки 7/28 сут,
  влажность почвы GWETTOP, облачность + аномалии к климатологии;
* сезон (sin/cos недели года), координаты, число работающих VIIRS (усилие наблюдения).
"""

from __future__ import annotations

from functools import cached_property

import h3
import numpy as np
import pandas as pd
import scipy.sparse as sp

from ..config import PROCESSED, settings
from ..utils import get_logger

log = get_logger("helios.features")

FEATURES = [
    "a_t", "a_t1", "a_t2", "a_t3", "sum4", "sum8", "frp4_log", "nb1_2w", "nb2_2w", "nb1_8w",
    "weeks_since_fire", "clim_woy", "clim_woy_next", "years_burned_share",
    "t2m_max", "rh2m", "ws10m_max", "precip_7d", "precip_28d", "gwet", "cloud",
    "t2m_anom", "precip28_anom", "gwet_anom",
    "woy_sin", "woy_cos", "lat", "lon", "n_viirs",
]

VIIRS_START = {"VIIRS_SNPP": "2012-01-19", "VIIRS_NOAA20": "2018-01-05", "VIIRS_NOAA21": "2023-03-01"}
VIIRS_END = {"VIIRS_SNPP": "2026-11-02"}


class Panel:
    """Матрицы неделя × ячейка + быстрая сборка строк признаков."""

    def __init__(self, cell_weekly: pd.DataFrame | None = None, weather: pd.DataFrame | None = None):
        cw = cell_weekly if cell_weekly is not None else pd.read_parquet(PROCESSED / "cell_weekly_r5.parquet")
        self.weather_daily = weather if weather is not None else (
            pd.read_parquet(PROCESSED / "weather_daily_r3.parquet")
            if (PROCESSED / "weather_daily_r3.parquet").exists() else None
        )
        cw = cw.copy()
        cw["week"] = pd.to_datetime(cw["week"]).dt.normalize()
        self.cells = np.array(sorted(cw["h3_r5"].unique()))
        start = pd.Timestamp("2001-01-01")  # понедельник
        end = max(cw["week"].max(), pd.Timestamp(f"{settings()['history']['end_year']}-12-29"))
        self.weeks = pd.date_range(start, end, freq="W-MON")
        self.cidx = {c: i for i, c in enumerate(self.cells)}
        W, C = len(self.weeks), len(self.cells)
        widx = pd.Index(self.weeks)
        cw = cw[cw["week"] >= start]
        wi = widx.get_indexer(cw["week"])
        ok = wi >= 0
        ci = cw["h3_r5"].map(self.cidx).to_numpy()
        self.A = np.zeros((W, C), dtype=np.float32)
        self.F = np.zeros((W, C), dtype=np.float32)
        np.add.at(self.A, (wi[ok], ci[ok]), cw["union_celldays"].to_numpy(np.float32)[ok])
        np.add.at(self.F, (wi[ok], ci[ok]), cw["frp_sum"].to_numpy(np.float32)[ok])
        self.B = self.A > 0
        latlon = np.array([h3.cell_to_latlng(c) for c in self.cells], dtype=np.float32)
        self.lat, self.lon = latlon[:, 0], latlon[:, 1]
        log.info("panel: %d weeks x %d cells, positives %.2f%%", W, C, 100 * self.B.mean())

    # ------------------------------------------------------------------ вспомогательные матрицы
    def _adjacency(self, k: int) -> sp.csr_matrix:
        rows, cols = [], []
        for i, c in enumerate(self.cells):
            for nb in h3.grid_ring(c, k) if k > 0 else []:
                j = self.cidx.get(nb)
                if j is not None:
                    rows.append(i)
                    cols.append(j)
        C = len(self.cells)
        return sp.csr_matrix((np.ones(len(rows), np.float32), (rows, cols)), shape=(C, C))

    @cached_property
    def nb1(self) -> sp.csr_matrix:
        return self._adjacency(1)

    @cached_property
    def nb2(self) -> sp.csr_matrix:
        return self._adjacency(2)

    @cached_property
    def weeks_since(self) -> np.ndarray:
        W, C = self.A.shape
        out = np.zeros((W, C), dtype=np.float32)
        last = np.full(C, -10_000, dtype=np.int64)
        for w in range(W):
            last = np.where(self.B[w], w, last)
            out[w] = np.minimum(w - last, 520)
        return out

    @cached_property
    def iso(self) -> tuple[np.ndarray, np.ndarray]:
        cal = pd.DatetimeIndex(self.weeks).isocalendar()
        return cal["year"].to_numpy(int), np.minimum(cal["week"].to_numpy(int), 52)

    @cached_property
    def clim(self) -> dict[int, np.ndarray]:
        """clim[Y][woy-1, cell] — доля лет ДО Y с пожаром в неделю woy (±1)."""
        years, woys = self.iso
        uniq = np.unique(years)
        P = np.zeros((len(uniq), 52, len(self.cells)), dtype=np.float32)
        yi = {y: i for i, y in enumerate(uniq)}
        for w in range(len(self.weeks)):
            P[yi[years[w]], woys[w] - 1] = np.maximum(P[yi[years[w]], woys[w] - 1], self.B[w])
        P = np.maximum.reduce([P, np.roll(P, 1, axis=1), np.roll(P, -1, axis=1)])  # окно ±1 неделя
        out, cum, n = {}, np.zeros((52, len(self.cells)), np.float32), 0
        for y in uniq:
            out[int(y)] = cum / max(n, 1)
            cum = cum + P[yi[y]]
            n += 1
        out[int(uniq[-1]) + 1] = cum / max(n, 1)
        return out

    @cached_property
    def years_burned(self) -> dict[int, np.ndarray]:
        years, _ = self.iso
        uniq = np.unique(years)
        out, cum, n = {}, np.zeros(len(self.cells), np.float32), 0
        for y in uniq:
            out[int(y)] = cum / max(n, 1)
            cum = cum + self.B[years == y].any(axis=0)
            n += 1
        out[int(uniq[-1]) + 1] = cum / max(n, 1)
        return out

    @cached_property
    def weather_weekly(self) -> dict[str, np.ndarray] | None:
        """Погода по неделям для каждой res-5 ячейки (берём родительскую res-3)."""
        if self.weather_daily is None or self.weather_daily.empty:
            return None
        res_w = settings()["h3"]["res_weather"]
        wd = self.weather_daily.copy()
        wd["date"] = pd.to_datetime(wd["date"])
        wd = wd.sort_values(["cell", "date"])
        g = wd.groupby("cell")
        wd["precip_7d"] = g["PRECTOTCORR"].transform(lambda s: s.rolling(7, min_periods=1).sum())
        wd["precip_28d"] = g["PRECTOTCORR"].transform(lambda s: s.rolling(28, min_periods=1).sum())
        wd["week"] = wd["date"] - pd.to_timedelta(wd["date"].dt.weekday, unit="D")
        # значение на конец недели (воскресенье) + средние за неделю
        agg = wd.groupby(["cell", "week"]).agg(
            t2m_max=("T2M_MAX", "mean"), rh2m=("RH2M", "mean"), ws10m_max=("WS10M", "max"),
            precip_7d=("precip_7d", "last"), precip_28d=("precip_28d", "last"),
            gwet=("GWETTOP", "mean"), cloud=("CLOUD_AMT", "mean"),
        ).reset_index()
        agg["woy"] = np.minimum(agg["week"].dt.isocalendar().week.astype(int), 52)
        for col, name in (("t2m_max", "t2m_anom"), ("precip_28d", "precip28_anom"), ("gwet", "gwet_anom")):
            agg[name] = agg[col] - agg.groupby(["cell", "woy"])[col].transform("mean")
        wcells = sorted(agg["cell"].unique())
        wci = {c: i for i, c in enumerate(wcells)}
        parent = np.array([wci.get(h3.cell_to_parent(c, res_w), -1) for c in self.cells])
        # ячейки без своей res-3 точки (на границе) — ближайшая точка погоды
        if (parent < 0).any():
            wl = np.array([h3.cell_to_latlng(c) for c in wcells])
            for i in np.flatnonzero(parent < 0):
                parent[i] = int(np.argmin((wl[:, 0] - self.lat[i]) ** 2 + (wl[:, 1] - self.lon[i]) ** 2))
        widx = pd.Index(self.weeks)
        out = {}
        cols = ["t2m_max", "rh2m", "ws10m_max", "precip_7d", "precip_28d", "gwet", "cloud",
                "t2m_anom", "precip28_anom", "gwet_anom"]
        wi = widx.get_indexer(agg["week"])
        ok = wi >= 0
        ci = agg["cell"].map(wci).to_numpy()
        for col in cols:
            M = np.full((len(self.weeks), len(wcells)), np.nan, dtype=np.float32)
            M[wi[ok], ci[ok]] = agg[col].to_numpy(np.float32)[ok]
            out[col] = M[:, parent]
        return out

    @cached_property
    def n_viirs(self) -> np.ndarray:
        """Сколько VIIRS реально есть в ДАННЫХ этой недели (по coverage), а не по датам запуска."""
        w = pd.DatetimeIndex(self.weeks)
        n = np.zeros(len(w), dtype=np.float32)
        for s, start in VIIRS_START.items():  # запасной вариант для будущих недель (NRT)
            end = pd.Timestamp(VIIRS_END.get(s, "2100-01-01"))
            n += ((w >= pd.Timestamp(start)) & (w < end)).astype(np.float32)
        path = PROCESSED / "stream_coverage.parquet"
        if path.exists():
            cov = pd.read_parquet(path)
            cov = cov[cov["stream"].astype(str).str.startswith("VIIRS") & (cov["coverage"] >= 0.5)]
            per_month = cov.groupby(cov["month"].astype(str)).size()
            months = w.to_period("M").astype(str)
            known = months.isin(per_month.index)
            n = np.where(known, per_month.reindex(months).fillna(0).to_numpy(np.float32), n)
        return n.astype(np.float32)

    # ------------------------------------------------------------------ строки признаков
    def rows(self, week_idx: np.ndarray, horizon: int = 1, neg_rate: float | None = None,
             seed: int = 0, allow_future: bool = False) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
        """Признаки для недель week_idx (все ячейки). Возвращает (X, y, weight).
        allow_future=True — для прогноза вперёд: целевая неделя ещё не наступила (y = 0)."""
        A, F = self.A, self.F
        years, woys = self.iso
        C = len(self.cells)
        rng = np.random.default_rng(seed)
        frames, ys, ws = [], [], []
        ww = self.weather_weekly
        for w in week_idx:
            future = w + horizon >= len(self.weeks)
            if w < 8 or (future and not allow_future):
                continue
            y = np.zeros(C, dtype=np.int8) if future else self.B[w + horizon].astype(np.int8)
            keep = np.ones(C, dtype=bool)
            weight = np.ones(C, dtype=np.float32)
            if neg_rate is not None:
                keep = (y == 1) | (rng.random(C) < neg_rate)
                weight = np.where(y == 1, 1.0, 1.0 / neg_rate).astype(np.float32)
            two = A[w] + A[w - 1]
            yr = int(years[w])
            woy_next = min(int((pd.Timestamp(self.weeks[w]) + pd.Timedelta(weeks=horizon)).isocalendar().week), 52)
            yr = min(yr, max(self.clim))
            d = {
                "a_t": A[w], "a_t1": A[w - 1], "a_t2": A[w - 2], "a_t3": A[w - 3],
                "sum4": A[w - 3:w + 1].sum(0), "sum8": A[w - 7:w + 1].sum(0),
                "frp4_log": np.log1p(F[w - 3:w + 1].sum(0)),
                "nb1_2w": self.nb1 @ two, "nb2_2w": self.nb2 @ two,
                "nb1_8w": self.nb1 @ A[w - 7:w + 1].sum(0),
                "weeks_since_fire": self.weeks_since[w],
                "clim_woy": self.clim[yr][int(woys[w]) - 1],
                "clim_woy_next": self.clim[yr][woy_next - 1],
                "years_burned_share": self.years_burned[yr],
                "woy_sin": np.full(C, np.sin(2 * np.pi * woy_next / 52), np.float32),
                "woy_cos": np.full(C, np.cos(2 * np.pi * woy_next / 52), np.float32),
                "lat": self.lat, "lon": self.lon,
                "n_viirs": np.full(C, self.n_viirs[w], np.float32),
            }
            for col in ("t2m_max", "rh2m", "ws10m_max", "precip_7d", "precip_28d", "gwet", "cloud",
                        "t2m_anom", "precip28_anom", "gwet_anom"):
                d[col] = ww[col][w] if ww is not None else np.full(C, np.nan, np.float32)
            df = pd.DataFrame({k: np.asarray(v, dtype=np.float32)[keep] for k, v in d.items()})[FEATURES]
            df["week_idx"] = w
            df["cell_idx"] = np.flatnonzero(keep)
            frames.append(df)
            ys.append(y[keep])
            ws.append(weight[keep])
        X = pd.concat(frames, ignore_index=True)
        return X, np.concatenate(ys), np.concatenate(ws)

    def week_index(self, start: str, end: str) -> np.ndarray:
        w = pd.DatetimeIndex(self.weeks)
        return np.flatnonzero((w >= pd.Timestamp(start)) & (w <= pd.Timestamp(end)))
