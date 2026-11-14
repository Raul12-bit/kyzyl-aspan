"""Регионы мира (admin-1, Natural Earth 1:10m, общественное достояние).

* `build_regions()` — индекс регионов (id, страна, названия на 7 языках, рамка, площадь) и упрощённая
  геометрия по странам для карты: `data/processed/world/regions/<ISO2>.geojson`.
* `assign_points(lat, lon)` — к какому региону относится точка (центр гексагона): «внутри полигона»,
  а для прибрежных пикселей — ближайший регион не дальше ~25 км.
"""

from __future__ import annotations

import json
from functools import lru_cache

import numpy as np
import shapely
from shapely.geometry import mapping, shape

from ..config import RAW
from ..utils import get_logger
from .ingest import WORLD

log = get_logger("helios.world.regions")

NE_ADM1 = RAW / "boundaries" / "ne_10m_admin_1_states_provinces.geojson"
NE_ADM0 = RAW / "boundaries" / "ne_10m_admin_0_countries.geojson"
REGIONS_DIR = WORLD / "regions"
INDEX_JSON = REGIONS_DIR / "index.json"
LANGS = ("en", "ru", "zh", "de", "es", "fr", "pt")


def download_boundaries() -> None:
    """Natural Earth 1:10m (общественное достояние): страны и регионы admin-1."""
    import requests

    base = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
    for path in (NE_ADM1, NE_ADM0):
        if path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(f"{base}/{path.name}", timeout=600)
        r.raise_for_status()
        path.write_bytes(r.content)


def _iso2_fix() -> dict[str, str]:
    """adm0_a3 → ISO2 (у Natural Earth для Франции, Норвегии, Косово и др. iso_a2 = -99)."""
    d = json.loads(NE_ADM0.read_text(encoding="utf-8"))
    out = {}
    for f in d["features"]:
        p = f["properties"]
        code = p.get("ISO_A2_EH") or p.get("ISO_A2")
        if code and len(code) == 2 and code.isalpha():
            for k in ("ADM0_A3", "SOV_A3", "GU_A3", "ADM0_A3_US"):
                if p.get(k):
                    out.setdefault(p[k], code)
    return out


def area_km2(g) -> float:
    """Площадь по синусоидальной (равновеликой) проекции: x = lon·cos(lat), y = lat."""
    def f(xy):
        out = xy.copy()
        out[:, 0] = xy[:, 0] * np.cos(np.radians(xy[:, 1])) * 111.32
        out[:, 1] = xy[:, 1] * 110.95
        return out
    return float(shapely.area(shapely.transform(g, f)))


def _round_coords(geom: dict, nd: int = 4) -> dict:
    def r(c):
        if isinstance(c[0], (float, int)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]

    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}


def build_regions() -> list[dict]:
    """Индекс + геометрия по странам. Возвращает индекс (список регионов)."""
    download_boundaries()
    fix = _iso2_fix()
    d = json.loads(NE_ADM1.read_text(encoding="utf-8"))
    REGIONS_DIR.mkdir(parents=True, exist_ok=True)
    index, by_country = [], {}
    for i, f in enumerate(d["features"]):
        p = f["properties"]
        iso2 = p.get("iso_a2") if (p.get("iso_a2") or "").isalpha() else fix.get(p.get("adm0_a3"), "")
        if not iso2:
            continue
        g = shape(f["geometry"])
        if g.is_empty:
            continue
        g = shapely.make_valid(g)
        w, s, e, n = g.bounds
        names = {lang: (p.get(f"name_{lang}") or "").strip() for lang in LANGS}
        names["en"] = names["en"] or (p.get("name") or "").strip()
        rid = p.get("adm1_code") or f"{iso2}-{i}"
        rec = {
            "idx": len(index), "id": rid, "iso2": iso2.upper(), "name": names["en"] or rid,
            "names": {k: v for k, v in names.items() if v}, "type": p.get("type_en") or p.get("type") or "",
            "bbox": [round(w, 3), round(s, 3), round(e, 3), round(n, 3)],
            "area_km2": round(area_km2(g), 1),
            "center": [round(float(p.get("longitude") or (w + e) / 2), 3), round(float(p.get("latitude") or (s + n) / 2), 3)],
        }
        index.append(rec)
        # для карты: упрощение с допуском по размеру региона (≈1–2 км у мелких, до ~5 км у огромных)
        tol = float(np.clip(max(e - w, n - s) / 400, 0.004, 0.05))
        gs = shapely.simplify(g, tol, preserve_topology=True)
        by_country.setdefault(rec["iso2"], []).append({
            "type": "Feature", "id": rec["idx"],
            "properties": {"id": rid, "idx": rec["idx"], "name": rec["name"], "names": rec["names"], "type": rec["type"]},
            "geometry": _round_coords(mapping(gs)),
        })
        _geoms_cache.append(g)
    for iso2, feats in by_country.items():
        (REGIONS_DIR / f"{iso2}.geojson").write_text(
            json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
    INDEX_JSON.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log.info("регионы: %d в %d странах", len(index), len(by_country))
    return index


_geoms_cache: list = []


@lru_cache(maxsize=1)
def region_index() -> list[dict]:
    if not INDEX_JSON.exists():
        return build_regions()
    return json.loads(INDEX_JSON.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _tree() -> tuple[shapely.STRtree, list]:
    idx = region_index()
    fix = _iso2_fix()
    d = json.loads(NE_ADM1.read_text(encoding="utf-8"))
    by_id = {r["id"]: r["idx"] for r in idx}
    geoms: list = [None] * len(idx)
    for i, f in enumerate(d["features"]):
        p = f["properties"]
        iso2 = p.get("iso_a2") if (p.get("iso_a2") or "").isalpha() else fix.get(p.get("adm0_a3"), "")
        rid = p.get("adm1_code") or f"{iso2}-{i}"
        if rid in by_id:
            geoms[by_id[rid]] = shapely.make_valid(shape(f["geometry"]))
    return shapely.STRtree(geoms), geoms


def assign_points(lat: np.ndarray, lon: np.ndarray, max_dist_deg: float = 0.25) -> np.ndarray:
    """Индекс региона (region_index()[i]['idx']) для каждой точки, -1 — океан / вне регионов."""
    tree, _ = _tree()
    pts = shapely.points(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float))
    out = np.full(len(pts), -1, dtype=np.int32)
    inp, hit = tree.query(pts, predicate="within")
    out[inp[::-1]] = hit[::-1]  # при пересечениях берём первый
    miss = np.flatnonzero(out < 0)
    if len(miss):
        mi, mh = tree.query_nearest(pts[miss], max_distance=max_dist_deg, all_matches=False)
        out[miss[mi]] = mh
    return out


if __name__ == "__main__":
    build_regions()
