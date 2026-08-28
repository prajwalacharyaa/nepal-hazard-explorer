"""Download HydroRIVERS (Asia) and clip it to Nepal + a downstream buffer.

HydroRIVERS carries an explicit flow topology — every reach has HYRIV_ID and
NEXT_DOWN (the id of the reach it drains into) — which is what lets us trace a
path downstream from an event point. It also carries Strahler order (ORD_STRA)
and long-term average discharge (DIS_AV_CMS), used to weight the drawn line.

Source: https://www.hydrosheds.org/products/hydrorivers  (CC BY 4.0)

Output: data/raw/hydrorivers_nepal.gpkg
        data/processed/rivers_major.geojson   (order >= 5, for map context)
"""
from __future__ import annotations

import io
import zipfile

import geopandas as gpd
import requests

from config import RAW, PROCESSED

URL = "https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_as_shp.zip"
# Nepal plus a margin so downstream reaches into India/Tibet stay traceable
BBOX = (79.5, 25.0, 89.5, 31.0)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    work = RAW / "hydrorivers_src"
    shp = next(work.glob("**/*.shp"), None) if work.exists() else None

    if shp is None:
        print(f"downloading {URL}  (~79 MB, one time)")
        r = requests.get(URL, timeout=900)
        r.raise_for_status()
        work.mkdir(parents=True, exist_ok=True)
        zipfile.ZipFile(io.BytesIO(r.content)).extractall(work)
        shp = next(work.glob("**/*.shp"))
        print(f"  extracted {shp.name}")

    print("clipping to Nepal + margin…")
    gdf = gpd.read_file(shp, bbox=BBOX)
    print(f"  {len(gdf):,} reaches in the box")

    keep = [c for c in ("HYRIV_ID", "NEXT_DOWN", "MAIN_RIV", "ORD_STRA",
                        "ORD_CLAS", "DIS_AV_CMS", "LENGTH_KM") if c in gdf.columns]
    gdf = gdf[keep + ["geometry"]].to_crs(4326)

    out = RAW / "hydrorivers_nepal.gpkg"
    gdf.to_file(out, driver="GPKG")
    print(f"wrote {out}  ({len(gdf):,} reaches)")

    # a light context layer for the web map: only the sizeable rivers
    major = gdf[gdf["ORD_STRA"] >= 5].copy()
    major["geometry"] = major.geometry.simplify(0.002, preserve_topology=True)
    major.to_file(PROCESSED / "rivers_major.geojson", driver="GeoJSON")
    kb = (PROCESSED / "rivers_major.geojson").stat().st_size / 1024
    print(f"wrote rivers_major.geojson  ({len(major):,} reaches, {kb:.0f} KB)")


if __name__ == "__main__":
    main()
