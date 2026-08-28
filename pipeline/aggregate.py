"""Fill coordinates for code-only events, cross-source spatial dedup, then build
the aggregates the frontend needs.

Inputs:
    data/processed/events.geojson                 (from clean_merge.py)
    data/raw/desinventar_shapes/village.shp        (bundled in the DesInventar zip)
    data/raw/desinventar_shapes/district.shp
    data/raw/npl_adm2_districts.geojson            (HDX COD-AB adm2 — OPTIONAL,
                                                    preferred for the choropleth)
    data/raw/npl_pop_adm2.csv                      (HDX COD-PS — OPTIONAL)

Outputs:
    data/processed/events.geojson        (rewritten: every event has a point,
                                          temp fields stripped, deduped)
    data/processed/districts.geojson      (geometry + per-district stats)
    data/processed/district_index.json    (compact per-district summary, no geom)
    data/processed/calendar.json          (year x month x hazard)
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict

import geopandas as gpd
import pandas as pd
from shapely.geometry import shape

from config import RAW, PROCESSED, HAZARDS

SHAPES = RAW / "desinventar_shapes"
HDX_ADM2 = RAW / "npl_adm2_districts.geojson"
HDX_ADM3 = RAW / "npl_adm3_palikas.geojson"
POP_CSV = RAW / "npl_pop_adm2.csv"

HDX_NAME_FIELDS = ["adm2_name", "DIST_EN", "ADM2_EN", "DISTRICT", "district"]


def assign_zone(features, zone_gdf, name_col, extra_cols=()):
    """Map every event id -> {name_col: ..., **extras} by point-in-polygon, with
    a nearest-polygon fallback for points that land just outside (boundary
    datasets don't line up perfectly, and many old points are centroids)."""
    pts = gpd.GeoDataFrame(
        {"evid": [f["properties"]["id"] for f in features]},
        geometry=[shape(f["geometry"]) for f in features], crs=4326)
    cols = [name_col, *extra_cols]
    z = zone_gdf[[*cols, "geometry"]].copy()
    j = gpd.sjoin(pts, z, how="left", predicate="within")
    j = j[~j.index.duplicated(keep="first")]
    miss = j[j[name_col].isna()]
    if len(miss):
        m = 32645  # UTM 45N — metric, for a correct nearest-polygon match
        near = gpd.sjoin_nearest(pts.loc[miss.index].to_crs(m), z.to_crs(m), how="left")
        near = near[~near.index.duplicated(keep="first")]
        for c in cols:
            j.loc[miss.index, c] = near[c].values
    out = {}
    for r in j.itertuples():
        out[r.evid] = {c: getattr(r, c) for c in cols}
    return out


# ---------------------------------------------------------------- geometry ----
def _centroid_lookups():
    """Return (village_by_code, district_by_code, district_by_name, district_polys)
    where *_polys maps name -> shapely polygon for the spatial join / jitter."""
    vil = gpd.read_file(SHAPES / "village.shp").set_crs(4326, allow_override=True)
    dis = gpd.read_file(SHAPES / "district.shp").set_crs(4326, allow_override=True)

    v_code = {}
    for r in vil.itertuples():
        c = r.geometry.centroid
        v_code[str(r.VILLAGECD).strip()] = (c.x, c.y, r.geometry)

    d_code, d_name, d_poly = {}, {}, {}
    for r in dis.itertuples():
        c = r.geometry.centroid
        d_code[str(r.DTEMPDIST).strip()] = (c.x, c.y, r.geometry)
        nm = str(r.NAME).strip().title()
        d_name[nm] = (c.x, c.y, r.geometry)
        d_poly[nm] = r.geometry
    return v_code, d_code, d_name, d_poly


def _jitter(lon, lat, poly, seed: str, max_deg=0.02):
    """Deterministic small offset so many events sharing one centroid don't
    stack on a single pixel. Kept inside the polygon when possible."""
    h = int(hashlib.md5(seed.encode()).hexdigest(), 16)
    ang = (h % 360) * math.pi / 180
    mag = ((h >> 9) % 1000) / 1000 * max_deg
    nlon, nlat = lon + math.cos(ang) * mag, lat + math.sin(ang) * mag
    if poly is not None:
        from shapely.geometry import Point
        if not poly.contains(Point(nlon, nlat)):
            return lon, lat
    return nlon, nlat


def fill_coordinates(features):
    v_code, d_code, d_name, _ = _centroid_lookups()
    stats = defaultdict(int)
    for f in features:
        p = f["properties"]
        if f["geometry"] is not None:
            stats["already"] += 1
            continue
        lvl2, lvl1 = p.get("_lvl2"), p.get("_lvl1")
        dname = (p.get("district") or "").strip().title()
        hit = None
        if lvl2 and lvl2 in v_code:
            hit = v_code[lvl2]; p["geo_precision"] = "village_centroid"; stats["village"] += 1
        elif lvl1 and lvl1 in d_code:
            hit = d_code[lvl1]; p["geo_precision"] = "district_centroid"; stats["district_code"] += 1
        elif dname in d_name:
            hit = d_name[dname]; p["geo_precision"] = "district_centroid"; stats["district_name"] += 1
        if hit is None:
            stats["unplaced"] += 1
            continue
        lon, lat, poly = hit
        lon, lat = _jitter(lon, lat, poly, p["id"])
        p["lon"], p["lat"] = round(lon, 5), round(lat, 5)
        f["geometry"] = {"type": "Point", "coordinates": [p["lon"], p["lat"]]}
    print("  coordinate fill:", dict(stats))
    return [f for f in features if f["geometry"] is not None]


# ----------------------------------------------------------------- dedupe ----
def _haversine(a, b):
    (lon1, lat1), (lon2, lat2) = a, b
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _richness(p):
    return sum(1 for k in ("deaths", "missing", "injured", "people_affected",
                           "houses_destroyed", "houses_damaged") if p.get(k))


def spatial_dedupe(features, km=5.0, days=2):
    from datetime import datetime
    feats = sorted(features, key=lambda f: f["properties"]["date"])
    kept = []
    for f in feats:
        p = f["properties"]
        dt = datetime.fromisoformat(p["date"])
        match = None
        for g in reversed(kept[-400:]):
            q = g["properties"]
            if q["hazard"] != p["hazard"]:
                continue
            if abs((datetime.fromisoformat(q["date"]) - dt).days) > days:
                continue
            if _haversine(f["geometry"]["coordinates"], g["geometry"]["coordinates"]) <= km:
                match = g
                break
        if match is None:
            kept.append(f)
            continue
        q = match["properties"]
        if _richness(p) > _richness(q):
            for k in ("deaths", "missing", "injured", "people_affected",
                      "houses_destroyed", "houses_damaged", "severity_score",
                      "severity_class"):
                q[k] = p.get(k, q.get(k))
        q["source"] = "+".join(sorted(set(q["source"].split("+")) | set(p["source"].split("+"))))
    print(f"  spatial_dedupe: {len(feats)} -> {len(kept)}")
    return kept


# --------------------------------------------------------------- districts ----
def choropleth_geometry():
    """Prefer modern HDX adm2 (77 districts); fall back to the bundled
    DesInventar district shapefile (75)."""
    if HDX_ADM2.exists():
        gdf = gpd.read_file(HDX_ADM2).to_crs(4326)
        for c in HDX_NAME_FIELDS:
            if c in gdf.columns:
                gdf = gdf.rename(columns={c: "district"})
                break
        src = "HDX COD-AB adm2"
    else:
        gdf = gpd.read_file(SHAPES / "district.shp").set_crs(4326, allow_override=True)
        gdf = gdf.rename(columns={"NAME": "district"})
        gdf = gdf[["district", "geometry"]]
        src = "DesInventar bundled district.shp"
    gdf["district"] = gdf["district"].astype(str).str.strip().str.title()
    print(f"  choropleth base: {src} ({len(gdf)} polygons)")
    return gdf


def load_pop():
    if not POP_CSV.exists():
        return {}
    df = pd.read_csv(POP_CSV)
    name_c = next((c for c in df.columns if df[c].dtype == object), df.columns[0])
    val_c = next((c for c in df.columns if str(c).lower() in
                  ("t_tl", "total", "population", "pop", "totalpop")), None)
    if val_c is None:
        num = df.select_dtypes("number")
        val_c = num.columns[num.sum().argmax()] if len(num.columns) else None
    if val_c is None:
        return {}
    return {str(k).strip().title(): int(v)
            for k, v in zip(df[name_c], df[val_c]) if pd.notna(v)}


def _round_geom(o, nd=5):
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, list):
        return [_round_geom(x, nd) for x in o]
    if isinstance(o, dict):
        return {k: _round_geom(v, nd) for k, v in o.items()}
    return o


def _i(x):
    try:
        if x is None or (isinstance(x, float) and math.isnan(x)):
            return 0
        return int(x)
    except (TypeError, ValueError):
        return 0


def _blank_agg():
    return dict(events=0, deaths=0, missing=0, injured=0, people_affected=0,
               houses_destroyed=0, severity_score=0.0,
               by_hazard={h: 0 for h in HAZARDS},
               by_decade=defaultdict(int), first_year=9999, last_year=0, worst=None)


def _add_event(a, p):
    a["events"] += 1
    for k in ("deaths", "missing", "injured", "people_affected", "houses_destroyed"):
        a[k] += _i(p.get(k))
    sc = float(p.get("severity_score") or 0)
    a["severity_score"] += sc
    hz = p.get("hazard") or "other"
    a["by_hazard"][hz] = a["by_hazard"].get(hz, 0) + 1
    yr = _i(p.get("year"))
    if yr:
        a["by_decade"][yr // 10 * 10] += 1
        a["first_year"] = min(a["first_year"], yr)
        a["last_year"] = max(a["last_year"], yr)
    if a["worst"] is None or sc > a["worst"]["severity_score"]:
        a["worst"] = dict(id=p.get("id"), date=p.get("date"), hazard=hz,
                          deaths=_i(p.get("deaths")), severity_score=round(sc, 1),
                          title=p.get("title"))


def _index_row(name, a, key, pop=None, extra=None):
    row = {key: name, "events": a["events"], "deaths": a["deaths"],
           "missing": a["missing"], "injured": a["injured"],
           "people_affected": a["people_affected"],
           "houses_destroyed": a["houses_destroyed"],
           "first_year": a["first_year"], "last_year": a["last_year"],
           "by_hazard": a["by_hazard"],
           "by_decade": dict(sorted(a["by_decade"].items())),
           "worst": a["worst"]}
    if pop:
        row["population"] = pop
        row["deaths_per_100k"] = round(a["deaths"] / pop * 1e5, 2)
    if extra:
        row.update(extra)
    return row


def build_districts(features, gdf, pop):
    dmap = assign_zone(features, gdf, "district")
    for f in features:
        r = dmap.get(f["properties"]["id"])
        if r and r["district"] and not (isinstance(r["district"], float) and math.isnan(r["district"])):
            f["properties"]["district"] = r["district"]

    agg = {}
    for f in features:
        d = f["properties"].get("district")
        if not d:
            continue
        _add_event(agg.setdefault(d, _blank_agg()), f["properties"])

    feats, index = [], {}
    for row in gdf.itertuples():
        d = row.district
        a = agg.get(d)
        props = {"district": d, "population": pop.get(d)}
        if a:
            props.update(events=a["events"], deaths=a["deaths"], missing=a["missing"],
                         injured=a["injured"], houses_destroyed=a["houses_destroyed"],
                         severity_score=round(a["severity_score"], 1),
                         by_hazard=a["by_hazard"],
                         first_year=a["first_year"], last_year=a["last_year"])
            if pop.get(d):
                props["deaths_per_100k"] = round(a["deaths"] / pop[d] * 1e5, 2)
            index[d] = _index_row(d, a, "district", pop.get(d))
        else:
            props.update(events=0, deaths=0, missing=0, injured=0, houses_destroyed=0,
                         severity_score=0.0, by_hazard={h: 0 for h in HAZARDS},
                         first_year=None, last_year=None)
        geom = row.geometry.simplify(0.002, preserve_topology=True)
        feats.append({"type": "Feature", "geometry": _round_geom(geom.__geo_interface__),
                      "properties": props})

    (PROCESSED / "districts.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
    (PROCESSED / "district_index.json").write_text(
        json.dumps(index, ensure_ascii=False), encoding="utf-8")
    print(f"  districts.geojson ({len(feats)}) + district_index.json ({len(index)})")


def build_palikas(features):
    """Municipality / rural-municipality (adm3) rollup — the drill-down floor.
    HDX COD-AB has no ward (adm4) polygons, so this is as local as clean
    geometry allows."""
    if not HDX_ADM3.exists():
        print("  (skip) no npl_adm3_palikas.geojson — palika level disabled")
        return
    g = gpd.read_file(HDX_ADM3).to_crs(4326).rename(
        columns={"adm3_name": "palika", "adm2_name": "adm2", "adm3_pcode": "pcode"})
    g["palika"] = g["palika"].astype(str).str.strip().str.title()
    g["adm2"] = g["adm2"].astype(str).str.strip().str.title()

    pmap = assign_zone(features, g, "pcode", ["palika", "adm2"])
    for f in features:
        r = pmap.get(f["properties"]["id"])
        if r and isinstance(r.get("pcode"), str):
            f["properties"]["palika"] = r["palika"]
            f["properties"]["palika_pcode"] = r["pcode"]

    agg = {}
    for f in features:
        pc = f["properties"].get("palika_pcode")
        if pc:
            _add_event(agg.setdefault(pc, _blank_agg()), f["properties"])

    index = {}
    for row in g.itertuples():
        a = agg.get(row.pcode)
        if not a:
            continue
        index[row.pcode] = _index_row(
            row.palika, a, "palika",
            extra={"pcode": row.pcode, "district": row.adm2,
                   "area_sqkm": round(float(getattr(row, "area_sqkm", 0) or 0), 1)})
    (PROCESSED / "palika_index.json").write_text(
        json.dumps(index, ensure_ascii=False), encoding="utf-8")
    print(f"  palika_index.json ({len(index)} of {len(g)} municipalities have events)")


# ---------------------------------------------------------------- calendar ----
def build_calendar(features):
    cal = defaultdict(lambda: {"count": 0, "score": 0.0, "by_hazard": defaultdict(int)})
    for f in features:
        p = f["properties"]
        if not p.get("year") or not p.get("month"):
            continue
        k = f'{p["year"]}-{p["month"]:02d}'
        cal[k]["count"] += 1
        cal[k]["score"] += float(p.get("severity_score") or 0)
        cal[k]["by_hazard"][p["hazard"]] += 1
    out = {k: {"count": v["count"], "score": round(v["score"], 1),
               "by_hazard": dict(v["by_hazard"])} for k, v in sorted(cal.items())}
    (PROCESSED / "calendar.json").write_text(json.dumps(out), encoding="utf-8")
    print(f"  wrote calendar.json ({len(out)} year-months)")


# ---------------------------------------------------------------- trimming ----
# fields always kept; count fields kept only when non-zero to shrink the file
_ALWAYS = ("id", "source", "date", "date_precision", "year", "month", "hazard",
           "district", "geo_precision", "severity_score", "severity_class",
           "title", "source_url")
_OPTIONAL = ("deaths", "missing", "injured", "people_affected",
             "houses_destroyed", "houses_damaged", "place_detail",
             "report_sources", "glide", "palika", "palika_pcode")


def slugify(name: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in str(name)).strip("-")


def trim_props(p: dict) -> dict:
    out = {k: p[k] for k in _ALWAYS if p.get(k) is not None}
    for k in _OPTIONAL:
        v = p.get(k)
        if v not in (None, 0, "", "0"):
            out[k] = v
    return out


def write_events_split(features):
    """Full trimmed events.geojson for the map, plus one small file per district
    for the district pages / downloads."""
    for f in features:
        f["properties"] = trim_props(f["properties"])
        f["geometry"]["coordinates"] = [round(c, 4) for c in f["geometry"]["coordinates"]]

    (PROCESSED / "events.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        encoding="utf-8")
    kb = (PROCESSED / "events.geojson").stat().st_size / 1024
    print(f"  events.geojson: {len(features)} events, {kb:.0f} KB")

    by_d = defaultdict(list)
    for f in features:
        by_d[f["properties"].get("district") or "unknown"].append(f)
    outdir = PROCESSED / "events_by_district"
    outdir.mkdir(exist_ok=True)
    for old in outdir.glob("*.json"):
        old.unlink()
    manifest = {}
    for d, feats in by_d.items():
        feats.sort(key=lambda f: f["properties"]["date"], reverse=True)
        slug = slugify(d)
        (outdir / f"{slug}.json").write_text(
            json.dumps({"type": "FeatureCollection", "district": d, "features": feats},
                       ensure_ascii=False), encoding="utf-8")
        manifest[d] = {"slug": slug, "count": len(feats)}
    (PROCESSED / "events_by_district_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    print(f"  events_by_district/: {len(manifest)} files")


# ------------------------------------------------------------------- main ----
def main():
    fc = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))
    features = fc["features"]
    print(f"loaded {len(features)} events")

    features = fill_coordinates(features)
    features = spatial_dedupe(features)
    for f in features:
        for k in ("_lvl1", "_lvl2"):
            f["properties"].pop(k, None)

    gdf = choropleth_geometry()
    build_districts(features, gdf, load_pop())   # uses full props, before trim
    build_palikas(features)                      # stamps palika/palika_pcode too
    build_calendar(features)
    write_meta(features)
    write_events_split(features)                 # trims props in place, writes files


def write_meta(features):
    import collections
    from datetime import datetime, timezone
    yrs = [f["properties"]["year"] for f in features if f["properties"].get("year")]
    dates = [f["properties"]["date"] for f in features if f["properties"].get("date")]
    src = collections.Counter()
    for f in features:
        for s in str(f["properties"].get("source", "")).split("+"):
            src[s] += 1
    meta = {
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "n_events": len(features),
        "year_min": min(yrs) if yrs else None,
        "year_max": max(yrs) if yrs else None,
        "latest_event": max(dates) if dates else None,
        "by_source": dict(src.most_common()),
    }
    (PROCESSED / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(f"  meta.json: {meta['n_events']} events, latest {meta['latest_event']}")


if __name__ == "__main__":
    main()
