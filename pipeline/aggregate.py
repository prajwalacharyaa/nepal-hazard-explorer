"""Build district + calendar aggregates from processed/events.geojson.

Needs:
    data/processed/events.geojson              (from clean_merge.py)
    data/raw/npl_adm2_districts.geojson        (HDX COD-AB, adm2)
    data/raw/npl_pop_adm2.csv                  (HDX COD-PS, optional)

Writes:
    data/processed/districts.geojson           (geometry + per-district stats)
    data/processed/calendar.json               (year x month x hazard counts+score)
    data/processed/events.geojson              (rewritten: district-only rows get
                                                district-centroid coordinates)
"""
from __future__ import annotations

import json
from collections import defaultdict

import geopandas as gpd
import pandas as pd
from shapely.geometry import shape

from config import RAW, PROCESSED, HAZARDS

# adjust if the HDX file uses different attribute names
DISTRICT_NAME_FIELDS = ["DIST_EN", "ADM2_EN", "DISTRICT", "district"]
POP_NAME_COL_CANDIDATES = ["ADM2_EN", "district", "District", "DIST_EN"]
POP_VALUE_COL_CANDIDATES = ["T_TL", "total", "Total", "population", "POP"]


def pick(cols, candidates, what):
    for c in candidates:
        if c in cols:
            return c
    raise SystemExit(f"could not find {what} column; have {list(cols)}")


def load_districts() -> gpd.GeoDataFrame:
    f = RAW / "npl_adm2_districts.geojson"
    if not f.exists():
        raise SystemExit(f"missing {f} — see pipeline/DATA_SOURCES.md step 4")
    gdf = gpd.read_file(f).to_crs(4326)
    name_field = pick(gdf.columns, DISTRICT_NAME_FIELDS, "district name")
    gdf = gdf.rename(columns={name_field: "district"})
    gdf["district"] = gdf["district"].str.strip()
    return gdf[["district", "geometry"]]


def load_pop() -> dict[str, int]:
    f = RAW / "npl_pop_adm2.csv"
    if not f.exists():
        print("  (no population file — choropleth per-capita disabled)")
        return {}
    df = pd.read_csv(f)
    nc = pick(df.columns, POP_NAME_COL_CANDIDATES, "population district name")
    vc = pick(df.columns, POP_VALUE_COL_CANDIDATES, "population total")
    return {str(k).strip(): int(v) for k, v in zip(df[nc], df[vc]) if pd.notna(v)}


def main():
    events = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))
    districts = load_districts()
    pop = load_pop()

    centroids = {
        row.district: (row.geometry.centroid.x, row.geometry.centroid.y)
        for row in districts.itertuples()
    }
    dvals = list(districts["district"])

    # spatial join: give every point-geometry event its district;
    # give every district-only event a centroid.
    pts = []
    for feat in events["features"]:
        p = feat["properties"]
        if feat["geometry"] is None:
            c = centroids.get(p.get("district"))
            if c:
                feat["geometry"] = {"type": "Point", "coordinates": [c[0], c[1]]}
                p["lon"], p["lat"] = c
        pts.append(feat)

    gpts = gpd.GeoDataFrame(
        [f["properties"] for f in pts if f["geometry"]],
        geometry=[shape(f["geometry"]) for f in pts if f["geometry"]],
        crs=4326,
    )
    joined = gpd.sjoin(gpts, districts, how="left", predicate="within")
    joined["district"] = joined["district_right"].fillna(joined["district_left"])

    # ---- per-district stats ----
    agg = defaultdict(lambda: dict(
        events=0, deaths=0, missing=0, injured=0, houses_destroyed=0,
        severity_score=0.0, by_hazard={h: 0 for h in HAZARDS},
    ))
    for r in joined.itertuples():
        d = r.district
        if not d or d not in centroids:
            continue
        a = agg[d]
        a["events"] += 1
        for k in ("deaths", "missing", "injured", "houses_destroyed"):
            a[k] += int(getattr(r, k) or 0)
        a["severity_score"] += float(getattr(r, "severity_score") or 0)
        hz = getattr(r, "hazard") or "other"
        a["by_hazard"][hz] = a["by_hazard"].get(hz, 0) + 1

    out_feats = []
    for row in districts.itertuples():
        d = row.district
        a = agg.get(d, None)
        props = dict(district=d, population=pop.get(d))
        if a:
            props.update(a)
            if pop.get(d):
                props["deaths_per_100k"] = round(a["deaths"] / pop[d] * 1e5, 2)
        else:
            props.update(events=0, deaths=0, missing=0, injured=0,
                         houses_destroyed=0, severity_score=0.0,
                         by_hazard={h: 0 for h in HAZARDS})
        out_feats.append({
            "type": "Feature",
            "geometry": row.geometry.__geo_interface__,
            "properties": props,
        })
    (PROCESSED / "districts.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": out_feats}), encoding="utf-8"
    )
    print(f"wrote districts.geojson  ({len(out_feats)} districts)")

    # ---- calendar: year x month ----
    cal = defaultdict(lambda: dict(count=0, score=0.0, by_hazard=defaultdict(int)))
    for f in pts:
        p = f["properties"]
        if not p.get("year") or not p.get("month"):
            continue
        key = f'{p["year"]}-{p["month"]:02d}'
        cal[key]["count"] += 1
        cal[key]["score"] += float(p.get("severity_score") or 0)
        cal[key]["by_hazard"][p.get("hazard") or "other"] += 1
    cal_out = {
        k: {"count": v["count"], "score": round(v["score"], 1),
            "by_hazard": dict(v["by_hazard"])}
        for k, v in sorted(cal.items())
    }
    (PROCESSED / "calendar.json").write_text(json.dumps(cal_out), encoding="utf-8")
    print(f"wrote calendar.json  ({len(cal_out)} year-months)")

    # rewrite events with filled centroids
    (PROCESSED / "events.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": pts}, ensure_ascii=False),
        encoding="utf-8",
    )
    print("rewrote events.geojson with district centroids filled")


if __name__ == "__main__":
    main()
