"""Approach C — daily landslide nowcast from NASA LHASA.

Downloads the most recent Global Landslide Nowcast GeoTIFF from GES DISC, clips
to Nepal, and summarises it per district into a small JSON. Meant to run daily
in CI (.github/workflows/nowcast.yml) and commit the result.

LHASA v1.1: categorical raster — 1 = moderate hazard, 2 = high hazard, 0/nodata
otherwise. Rainfall-driven, ~1 km, coverage 60N-60S, daily.
Docs: https://disc.gsfc.nasa.gov/datasets/Global_Landslide_Nowcast_1.1/summary

Auth: an Earthdata login bearer token in env var EARTHDATA_TOKEN
(create at https://urs.earthdata.nasa.gov/profile -> Generate Token).

Output: data/processed/nowcast.json
Exits 0 (no error) if the token is missing or the service is unreachable, so a
missing nowcast never breaks the rest of the build.
"""
from __future__ import annotations

import io
import json
import os
import sys
from datetime import date, timedelta

import numpy as np
import requests

from config import RAW, PROCESSED, NEPAL_BBOX

TOKEN = os.environ.get("EARTHDATA_TOKEN", "").strip()
# GES DISC archive layout for LHASA v1.1 daily nowcast GeoTIFFs.
BASE = ("https://data.gesdisc.earthdata.nasa.gov/data/LHASA/"
        "Global_Landslide_Nowcast.1.1/{y}/")
FNAME = "Global_Landslide_Nowcast_v1.1_{ymd}.tif"
LOOKBACK_DAYS = 6


def candidate_urls():
    for i in range(LOOKBACK_DAYS):
        d = date.today() - timedelta(days=i)
        yield d, BASE.format(y=d.year) + FNAME.format(ymd=d.strftime("%Y%m%d"))


def fetch_tif():
    if not TOKEN:
        print("EARTHDATA_TOKEN not set — skipping nowcast (see DATA_SOURCES.md §8).",
              file=sys.stderr)
        return None, None
    sess = requests.Session()
    sess.headers["Authorization"] = f"Bearer {TOKEN}"
    for d, url in candidate_urls():
        try:
            r = sess.get(url, timeout=120, allow_redirects=True)
            if r.status_code == 200 and r.content[:2] in (b"II", b"MM"):
                print(f"  got nowcast for {d.isoformat()}")
                return d, r.content
            print(f"  {r.status_code} {url}", file=sys.stderr)
        except requests.RequestException as e:
            print(f"  ! {e}", file=sys.stderr)
    return None, None


def summarise(tif_bytes):
    import geopandas as gpd
    import rasterio
    from rasterio.mask import mask
    from shapely.geometry import box

    shp = RAW / "desinventar_shapes" / "district.shp"
    hdx = RAW / "npl_adm2_districts.geojson"
    gdf = (gpd.read_file(hdx).to_crs(4326) if hdx.exists()
           else gpd.read_file(shp).set_crs(4326, allow_override=True))
    name_col = next((c for c in ("DIST_EN", "ADM2_EN", "NAME", "district")
                     if c in gdf.columns), None)
    gdf = gdf.rename(columns={name_col: "district"})
    gdf["district"] = gdf["district"].astype(str).str.strip().str.title()

    out = {}
    with rasterio.open(io.BytesIO(tif_bytes)) as src:
        for row in gdf.itertuples():
            try:
                arr, _ = mask(src, [row.geometry.__geo_interface__], crop=True,
                              nodata=0, filled=True)
            except ValueError:
                continue
            a = arr[0]
            cells = int(np.count_nonzero(~np.isnan(a)))
            if not cells:
                continue
            mod = int(np.count_nonzero(a >= 1))
            high = int(np.count_nonzero(a >= 2))
            if mod == 0:
                continue
            out[row.district] = {
                "level": "high" if high else "moderate",
                "moderate_plus_pct": round(mod / cells * 100, 1),
                "high_pct": round(high / cells * 100, 1),
            }
    return out


def main():
    d, tif = fetch_tif()
    if tif is None:
        # keep any previous file; just note staleness
        prev = PROCESSED / "nowcast.json"
        if prev.exists():
            print("  keeping existing nowcast.json")
        else:
            (PROCESSED / "nowcast.json").write_text(
                json.dumps({"as_of": None, "unavailable": True,
                            "note": "No Earthdata token or service unreachable."}),
                encoding="utf-8")
        raise SystemExit(0)

    districts = summarise(tif)
    elevated = sorted(
        (k for k, v in districts.items()), key=lambda k: (
            districts[k]["level"] != "high", -districts[k]["high_pct"]))
    out = {
        "as_of": d.isoformat(),
        "generated": date.today().isoformat(),
        "source": "NASA LHASA Global Landslide Nowcast v1.1 (GES DISC)",
        "model": ("Rainfall-driven landslide hazard nowcast, ~1 km, daily, "
                  "60N-60S. Categorical: moderate / high. Not a ground observation "
                  "and not a warning; use official DHM/NDRRMA alerts."),
        "n_flagged": len(districts),
        "elevated": elevated,
        "districts": districts,
    }
    (PROCESSED / "nowcast.json").write_text(json.dumps(out, ensure_ascii=False),
                                            encoding="utf-8")
    print(f"wrote nowcast.json  (as of {d}, {len(districts)} districts flagged)")


if __name__ == "__main__":
    main()
