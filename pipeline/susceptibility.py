"""Approach A — published-model susceptibility, summarised per district.

Reads two global rasters (either or both optional) and computes zonal statistics
for every district polygon, so the web app ships only a small JSON instead of
the multi-GB source grids.

Inputs  (place in data/raw/ — see pipeline/DATA_SOURCES.md):
    landslide_susceptibility.tif   NASA Global Landslide Susceptibility
                                   (Stanley & Kirschbaum 2017), classes 1..5
    flood_hazard.tif               A 100-year river-flood layer, e.g. JRC Global
                                   Flood Hazard RP100 or WRI Aqueduct 1/100.
                                   Pixel value = water depth in metres (0 / nodata
                                   outside the floodplain).

Output: data/processed/susceptibility.json

Both rasters must be EPSG:4326. Clip them to Nepal first (smaller = faster):
    gdalwarp -te 80 26 89 31 -t_srs EPSG:4326 in.tif landslide_susceptibility.tif
"""
from __future__ import annotations

import json

import numpy as np

from config import RAW, PROCESSED

LS_TIF = RAW / "landslide_susceptibility.tif"
FL_TIF = RAW / "flood_hazard.tif"

# NASA GLSM class labels
LS_LABELS = {1: "very low", 2: "low", 3: "moderate", 4: "high", 5: "very high"}
FLOOD_DEPTH_MIN = 0.10   # m — ignore paper-thin fringes


def districts_gdf():
    """Same source logic as aggregate.choropleth_geometry, kept local so this
    script can run standalone."""
    import geopandas as gpd
    hdx = RAW / "npl_adm2_districts.geojson"
    if hdx.exists():
        g = gpd.read_file(hdx).to_crs(4326)
        for c in ("DIST_EN", "ADM2_EN", "DISTRICT", "district"):
            if c in g.columns:
                g = g.rename(columns={c: "district"})
                break
    else:
        g = gpd.read_file(RAW / "desinventar_shapes" / "district.shp").set_crs(
            4326, allow_override=True).rename(columns={"NAME": "district"})
    g["district"] = g["district"].astype(str).str.strip().str.title()
    return g[["district", "geometry"]]


def zonal_landslide(gdf):
    from rasterstats import zonal_stats
    stats = zonal_stats(gdf, str(LS_TIF), categorical=True, nodata=None,
                        geojson_out=False)
    out = {}
    for row, s in zip(gdf.itertuples(), stats):
        s = {int(k): v for k, v in s.items() if k is not None and not np.isnan(k)}
        total = sum(s.values())
        if not total:
            continue
        majority = max(s, key=s.get)
        high = sum(v for k, v in s.items() if k >= 4) / total
        mean_cls = sum(k * v for k, v in s.items()) / total
        out[row.district] = {
            "ls_majority_class": majority,
            "ls_majority_label": LS_LABELS.get(majority, str(majority)),
            "ls_mean_class": round(mean_cls, 2),
            "ls_high_pct": round(high * 100, 1),
        }
    return out


def zonal_flood(gdf):
    from rasterstats import zonal_stats
    # fraction of the district in the floodplain, and mean depth where flooded
    frac = zonal_stats(gdf, str(FL_TIF),
                       stats=["count"], nodata=None,
                       add_stats={"flooded": lambda a: float(
                           np.count_nonzero(np.asarray(a) >= FLOOD_DEPTH_MIN))},
                       geojson_out=False)
    depth = zonal_stats(gdf, str(FL_TIF), stats=["mean", "max"],
                        nodata=0, geojson_out=False)
    out = {}
    for row, fr, de in zip(gdf.itertuples(), frac, depth):
        cells = fr.get("count") or 0
        if not cells:
            continue
        pct = (fr.get("flooded") or 0) / cells * 100
        out[row.district] = {
            "fl_area_pct": round(pct, 1),
            "fl_mean_depth_m": round(de.get("mean") or 0, 2),
            "fl_max_depth_m": round(de.get("max") or 0, 2),
        }
    return out


def main():
    if not LS_TIF.exists() and not FL_TIF.exists():
        raise SystemExit(
            "No hazard rasters found. Place landslide_susceptibility.tif and/or "
            "flood_hazard.tif in data/raw/ — see pipeline/DATA_SOURCES.md section 6.")

    gdf = districts_gdf()
    merged = {d: {"district": d} for d in gdf["district"]}
    meta = {"generated": __import__("datetime").date.today().isoformat(),
            "note": ("Zonal summary of global published hazard models. Native "
                     "resolution ~1 km (landslide) / ~90 m (flood); values are "
                     "district aggregates and are not site-specific.")}

    if LS_TIF.exists():
        print("landslide susceptibility: zonal stats…")
        for d, v in zonal_landslide(gdf).items():
            merged[d].update(v)
        meta["landslide_source"] = ("NASA Global Landslide Susceptibility "
                                    "(Stanley & Kirschbaum 2017)")
    if FL_TIF.exists():
        print("flood hazard: zonal stats…")
        for d, v in zonal_flood(gdf).items():
            merged[d].update(v)
        meta["flood_source"] = "100-year river-flood hazard layer (see DATA_SOURCES.md)"

    out = {"meta": meta, "districts": merged}
    (PROCESSED / "susceptibility.json").write_text(
        json.dumps(out, ensure_ascii=False), encoding="utf-8")
    n_ls = sum(1 for v in merged.values() if "ls_majority_class" in v)
    n_fl = sum(1 for v in merged.values() if "fl_area_pct" in v)
    print(f"wrote susceptibility.json  (landslide: {n_ls} districts, flood: {n_fl})")


if __name__ == "__main__":
    main()
