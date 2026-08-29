"""Every glacial lake in Nepal, and how each one changed between 2016 and 2022.

The risk check previously knew about ten hand-curated lakes. That is enough to
demonstrate the mechanism and far too few to answer "is there a lake above me?"
anywhere outside those ten valleys.

This reads the open High Mountain Asia inventory (Zenodo 17948783, CC-BY-4.0),
which publishes median lake extents for 2016-2017 and 2022-2024. Clipping both
epochs to Nepal and matching them spatially gives, for every lake, a measured
area change — the warming signal as observation rather than inference.

Lakes are matched between epochs by overlap, not by id: the published ids are
derived from each epoch's own centroid, so they shift as a lake grows.

Inputs : data/raw/hma_lakes/Glacial_lakes_{2016_2017,2022_2024}_median.shp
         data/raw/npl_adm/npl_admin0.geojson
         data/raw/dangerous_lakes.csv        (curated notes, merged in)
Output : data/processed/glacial_lakes.json
"""
from __future__ import annotations

import csv
import json
from datetime import date

import geopandas as gpd
import numpy as np

from config import RAW, PROCESSED

SRC = RAW / "hma_lakes"
NEW = SRC / "Glacial_lakes_2022_2024_median.shp"
OLD = SRC / "Glacial_lakes_2016_2017_median.shp"
BBOX = (79.9, 26.2, 88.4, 30.7)          # Nepal, generously

# What counts as capable of a damaging outburst. Below ~0.05 km2 a moraine-
# dammed lake simply does not hold enough water to matter far downstream, and
# below 3500 m we are out of the glacial zone entirely.
MIN_KM2 = 0.05
MIN_ELEV = 3500

# Routed separately in surge_paths.py; this file only decides which lakes are
# worth routing at all.
ROUTE_MIN_KM2 = 0.1

METRIC = 32645                            # UTM 45N, for areas in m2


def load_epoch(path):
    g = gpd.read_file(path, bbox=BBOX)
    return g.to_crs(4326)


def main():
    if not NEW.exists() or not OLD.exists():
        raise SystemExit(f"missing HMA inventory under {SRC} — see module docstring")

    print("loading inventory…")
    new = load_epoch(NEW)
    old = load_epoch(OLD)

    npl = gpd.read_file(RAW / "npl_adm" / "npl_admin0.geojson").to_crs(4326)
    poly = npl.union_all() if hasattr(npl, "union_all") else npl.unary_union
    new = new[new.intersects(poly)].copy()
    old = old[old.intersects(poly)].copy()
    print(f"  inside Nepal: {len(new)} lakes (2022-24), {len(old)} (2016-17)")

    # areas recomputed in a metric CRS rather than trusting the shipped column
    new["km2"] = new.to_crs(METRIC).area / 1e6
    old["km2"] = old.to_crs(METRIC).area / 1e6

    # match epochs by overlap; ids are centroid-derived and shift as lakes grow
    print("matching epochs spatially…")
    pairs = gpd.sjoin(new[["geometry", "km2"]], old[["geometry", "km2"]],
                      how="left", predicate="intersects",
                      lsuffix="new", rsuffix="old")
    # a lake can split or merge between epochs; take the total 2016 area that
    # overlaps each 2022 polygon
    prev = pairs.groupby(pairs.index)["km2_old"].sum(min_count=1)
    new["km2_2016"] = prev

    keep = (new.km2 >= MIN_KM2) & (new.Lake_Elev >= MIN_ELEV)
    sel = new[keep].copy()
    sel["growth_pct"] = np.where(
        sel.km2_2016.notna() & (sel.km2_2016 > 0),
        (sel.km2 - sel.km2_2016) / sel.km2_2016 * 100.0, np.nan)

    # curated notes, joined by proximity to the published coordinates
    curated = []
    with open(RAW / "dangerous_lakes.csv", encoding="utf-8") as fh:
        curated = list(csv.DictReader(fh))

    def curated_for(lon, lat):
        best, bestd = None, 0.05          # ~5 km in degrees
        for c in curated:
            d = ((float(c["lon"]) - lon) ** 2 + (float(c["lat"]) - lat) ** 2) ** 0.5
            if d < bestd:
                best, bestd = c, d
        return best

    rows = []
    for r in sel.itertuples():
        lon, lat = float(r.Longitude), float(r.Latitude)
        cur = curated_for(lon, lat)
        g = float(r.growth_pct) if np.isfinite(r.growth_pct) else None
        rows.append({
            "id": str(r.ID),
            "lon": round(lon, 4), "lat": round(lat, 4),
            "elev_m": int(r.Lake_Elev),
            "km2": round(float(r.km2), 3),
            "km2_2016": round(float(r.km2_2016), 3) if np.isfinite(r.km2_2016) else None,
            "growth_pct": round(g, 1) if g is not None else None,
            "route": bool(r.km2 >= ROUTE_MIN_KM2),
            **({"name": cur["lake"], "curated": True,
                "river": cur.get("downstream_river", ""),
                "notes": cur.get("notes", ""),
                "references": cur.get("references", "")} if cur else {}),
        })
    rows.sort(key=lambda x: (-x["km2"], x["id"]))

    grown = [r for r in rows if r["growth_pct"] is not None and r["growth_pct"] > 10]
    shrunk = [r for r in rows if r["growth_pct"] is not None and r["growth_pct"] < -10]
    measured = [r for r in rows if r["growth_pct"] is not None]

    out = {
        "generated": date.today().isoformat(),
        "source": ("Inventory of Glacial Lakes in High Mountain Asia, median "
                   "extents for 2016-2017 and 2022-2024 (Zenodo 17948783, CC-BY-4.0)"),
        "note": ("Every mapped glacial lake in Nepal at or above "
                 f"{MIN_KM2} km2 and {MIN_ELEV} m. Growth is the measured change "
                 "in mapped area between the two published epochs; it is a real "
                 "observation, but a six-year window is short and cloud, snow "
                 "and shadow all affect what a satellite maps as water."),
        "thresholds": {"min_km2": MIN_KM2, "min_elev_m": MIN_ELEV,
                       "route_min_km2": ROUTE_MIN_KM2},
        "counts": {
            "total": len(rows),
            "routed": sum(1 for r in rows if r["route"]),
            "with_growth_measured": len(measured),
            "grown_over_10pct": len(grown),
            "shrunk_over_10pct": len(shrunk),
        },
        "median_growth_pct": (round(float(np.median([r["growth_pct"] for r in measured])), 1)
                              if measured else None),
        "lakes": rows,
    }
    dst = PROCESSED / "glacial_lakes.json"
    dst.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"wrote glacial_lakes.json — {len(rows)} lakes, "
          f"{dst.stat().st_size / 1024:.0f} KB")
    c = out["counts"]
    print(f"    routed (>= {ROUTE_MIN_KM2} km2): {c['routed']}")
    print(f"    growth measured for {c['with_growth_measured']}: "
          f"{c['grown_over_10pct']} grew >10%, {c['shrunk_over_10pct']} shrank >10%, "
          f"median {out['median_growth_pct']}%")


if __name__ == "__main__":
    main()
