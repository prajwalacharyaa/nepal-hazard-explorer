"""Fetch the NASA Global Landslide Catalog (COOLR) and clip to Nepal.

The catalog is served as a public ArcGIS FeatureServer (no key). We page through
it with a bbox query for Nepal and dump raw GeoJSON.

Output: data/raw/nasa_glc_nepal.geojson

If NASA changes the service URL, set GLC_URL below. A CSV fallback (Kaggle / HDX
mirror) can be dropped in manually as data/raw/nasa_glc_nepal.csv — clean_merge.py
accepts either.
"""
from __future__ import annotations

import json
import sys
import time

import requests

from config import RAW, NEPAL_BBOX

# NASA Maps ArcGIS FeatureServer for the Global Landslide Catalog point layer.
GLC_URL = (
    "https://maps.nccs.nasa.gov/server/rest/services/"
    "global_landslide_catalog/global_landslide_catalog/MapServer/0/query"
)
PAGE = 1000
TIMEOUT = 60


def q(offset: int) -> dict:
    params = {
        "where": "1=1",
        "geometry": f"{NEPAL_BBOX['min_lon']},{NEPAL_BBOX['min_lat']},"
                    f"{NEPAL_BBOX['max_lon']},{NEPAL_BBOX['max_lat']}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "outSR": "4326",
        "f": "geojson",
        "resultOffset": offset,
        "resultRecordCount": PAGE,
    }
    for attempt in range(4):
        try:
            r = requests.get(GLC_URL, params=params, timeout=TIMEOUT)
            r.raise_for_status()
            return r.json()
        except (requests.RequestException, ValueError) as e:
            wait = 2 ** attempt
            print(f"  ! {e} — retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit("giving up on NASA GLC service")


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    feats: list[dict] = []
    offset = 0
    while True:
        fc = q(offset)
        batch = fc.get("features", [])
        feats.extend(batch)
        print(f"  fetched {len(feats)} landslide points")
        if len(batch) < PAGE:
            break
        offset += PAGE

    out = RAW / "nasa_glc_nepal.geojson"
    out.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, indent=1),
        encoding="utf-8",
    )
    print(f"wrote {out}  ({len(feats)} features)")
    if feats:
        print("  sample properties:", sorted(feats[0]["properties"].keys()))


if __name__ == "__main__":
    main()
