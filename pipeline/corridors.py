"""Trace a downstream impact corridor for each significant event.

For every event with recorded deaths or a moderate-or-worse severity class we
snap the point to the nearest HydroRIVERS reach and walk downstream along the
NEXT_DOWN topology, spending a distance budget scaled by the event's severity.
The result is a MODELLED potential corridor — the reach water and debris would
follow — not an observed inundation footprint. The web page labels it as such.

For major documented events, data/raw/curated_reaches.json supplies the
downstream distance reported in the literature. That overrides the severity
estimate, so the LENGTH is sourced while the COURSE still follows the mapped
river network — we never hand-draw a river. Those are flagged
`documented_reach: true` and carry their citation.

Each corridor also carries the municipalities it passes through and other
recorded events along the same reach. Elevation profiles are added afterwards
by corridor_elevation.py, which is rate-limited and therefore resumable.

Inputs : data/raw/hydrorivers_nepal.gpkg   (fetch_rivers.py)
         data/processed/events.geojson, palikas.geojson, palika_index.json
         data/raw/curated_paths.geojson    (optional, hand-authored)
Outputs: data/processed/corridors/<event id>.json
         data/processed/corridors_index.json
"""
from __future__ import annotations

import json
from collections import defaultdict

import geopandas as gpd
import pandas as pd
from shapely.geometry import LineString, Point, shape
from shapely.ops import linemerge, substring
from shapely.strtree import STRtree
from pyproj import Transformer

from config import RAW, PROCESSED

METRIC = 32645                      # UTM 45N — metres, good for Nepal
# one reusable transformer: building a GeoSeries per corridor was the
# single biggest cost in this script
TO_WGS = Transformer.from_crs(METRIC, 4326, always_xy=True)
SNAP_MAX_M = 4000                   # give up if no river within 4 km
OUT = PROCESSED / "corridors"


# --------------------------------------------------------------- budget ----
def budget_km(p) -> float:
    """How far downstream to trace, from the severity score.

    A minor slip barely reaches the next bend; a catastrophic outburst runs the
    length of a river system. Square-root so the scale compresses at the top.
    """
    s = float(p.get("severity_score") or 0)
    return max(3.0, min(120.0, 2.6 * (s ** 0.5)))


# ------------------------------------------------------------ river graph --
def load_rivers():
    g = gpd.read_file(RAW / "hydrorivers_nepal.gpkg").to_crs(METRIC)
    g = g[~g.geometry.isna()]
    geom = {int(r.HYRIV_ID): r.geometry for r in g.itertuples()}
    nxt = {int(r.HYRIV_ID): int(r.NEXT_DOWN) for r in g.itertuples()}
    order = {int(r.HYRIV_ID): int(r.ORD_STRA) for r in g.itertuples()}
    return g, geom, nxt, order


def trace_downstream(start_id, geom, nxt, budget_m, start_pt=None):
    """Walk NEXT_DOWN collecting reach geometry until the budget is spent."""
    parts, seen, used = [], set(), 0.0
    rid = start_id
    while rid and rid in geom and rid not in seen and used < budget_m:
        seen.add(rid)
        line = geom[rid]
        if start_pt is not None and rid == start_id:
            # begin at the snapped point, not the top of the reach
            d = line.project(start_pt)
            if d < line.length - 1:
                line = substring(line, d, line.length)
            start_pt = None
        remaining = budget_m - used
        if line.length > remaining:
            line = substring(line, 0, remaining)
        if line.length > 0:
            parts.append(line)
            used += line.length
        rid = nxt.get(rid, 0)
    if not parts:
        return None, 0.0
    merged = linemerge(parts) if len(parts) > 1 else parts[0]
    if merged.geom_type == "MultiLineString":
        merged = max(merged.geoms, key=lambda l: l.length)
    return merged, used / 1000.0


# ------------------------------------------------------------------ main ---
def main():
    if not (RAW / "hydrorivers_nepal.gpkg").exists():
        raise SystemExit("missing hydrorivers_nepal.gpkg — run fetch_rivers.py first")

    events = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))["features"]
    sig = [f for f in events
           if (f["properties"].get("deaths") or 0) > 0
           or f["properties"].get("severity_class") in ("moderate", "major", "catastrophic")]
    print(f"{len(sig):,} of {len(events):,} events qualify for a corridor")

    print("loading river network…")
    rivers, geom, nxt, order = load_rivers()

    # documented reach lengths, if any
    curated = {}
    cp = RAW / "curated_reaches.json"
    if cp.exists():
        curated = {k: v for k, v in json.loads(cp.read_text(encoding="utf-8")).items()
                   if not k.startswith("_")}
        print(f"  {len(curated)} documented reach length(s)")

    # snap every significant event to its nearest reach, vectorised
    pts = gpd.GeoDataFrame(
        {"eid": [f["properties"]["id"] for f in sig]},
        geometry=[Point(f["geometry"]["coordinates"]) for f in sig], crs=4326).to_crs(METRIC)
    snapped = gpd.sjoin_nearest(pts, rivers[["HYRIV_ID", "geometry"]],
                                how="left", max_distance=SNAP_MAX_M,
                                distance_col="snap_m")
    snapped = snapped[~snapped.index.duplicated(keep="first")]
    print(f"  snapped {snapped.HYRIV_ID.notna().sum():,} to a river within {SNAP_MAX_M/1000:g} km")

    # spatial indexes for the downstream lookups
    palikas = gpd.read_file(PROCESSED / "palikas.geojson").to_crs(METRIC)
    pal_rows = palikas.reset_index(drop=True)
    pal_tree = STRtree(pal_rows.geometry.values)
    pal_name = pal_rows["adm3_name"].tolist() if "adm3_name" in pal_rows else [None] * len(pal_rows)
    pal_dist = pal_rows["adm2_name"].tolist() if "adm2_name" in pal_rows else [None] * len(pal_rows)

    all_pts = gpd.GeoSeries(
        [Point(f["geometry"]["coordinates"]) for f in events], crs=4326).to_crs(METRIC)
    ev_tree = STRtree(all_pts.values)

    pal_index = {}
    pif = PROCESSED / "palika_index.json"
    if pif.exists():
        pal_index = {v["palika"]: v for v in json.loads(pif.read_text(encoding="utf-8")).values()}

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()

    index, made = {}, 0
    for row, feat in zip(snapped.itertuples(), sig):
        p = feat["properties"]
        eid = p["id"]
        cur = curated.get(eid)

        if pd.isna(getattr(row, "HYRIV_ID", None)):
            continue
        # a documented reach length overrides the severity-based estimate
        budget = (cur["trace_km"] if cur else budget_km(p)) * 1000.0
        start_id = int(row.HYRIV_ID)
        line, length_km = trace_downstream(
            start_id, geom, nxt, budget, row.geometry)
        if line is None or length_km < 0.5:
            continue

        # HydroRIVERS only maps rivers above a drainage threshold, so the event
        # can sit some way from the nearest mapped channel (median ~0.8 km).
        # Record that overland link explicitly rather than leaving a silent gap.
        snap_m = float(getattr(row, "snap_m", 0) or 0)
        start_reach = geom[start_id]
        snap_pt = start_reach.interpolate(start_reach.project(row.geometry))
        cx, cy = TO_WGS.transform([row.geometry.x, snap_pt.x],
                                  [row.geometry.y, snap_pt.y])
        connector = [[round(cx[0], 4), round(cy[0], 4)],
                     [round(cx[1], 4), round(cy[1], 4)]]

        # municipalities the corridor crosses
        hit, seen_pal = [], set()
        for idx in pal_tree.query(line, predicate="intersects"):
            nm = pal_name[idx]
            if nm and nm not in seen_pal:
                seen_pal.add(nm)
                rec = pal_index.get(nm, {})
                hit.append({"palika": nm, "district": pal_dist[idx],
                            "events": rec.get("events"), "deaths": rec.get("deaths")})

        # other recorded events within 3 km of the corridor
        near = []
        for idx in ev_tree.query(line, predicate="dwithin", distance=3000):
            q = events[idx]["properties"]
            if q["id"] == eid:
                continue
            near.append({"id": q["id"], "date": q["date"], "hazard": q["hazard"],
                         "deaths": q.get("deaths") or 0,
                         "_s": q.get("severity_score") or 0})
        near.sort(key=lambda e: e["_s"], reverse=True)
        near = [{k: v for k, v in e.items() if k != "_s"} for e in near[:12]]

        simp = line.simplify(60, preserve_topology=True)      # 60 m, metric CRS
        xs, ys = zip(*simp.coords)
        lons, lats = TO_WGS.transform(xs, ys)
        coords = [[round(a, 4), round(b, 4)] for a, b in zip(lons, lats)]  # ~11 m

        rec = {
            "event_id": eid,
            "documented_reach": bool(cur),
            "source_note": (cur["note"] if cur
                            else "Traced along the HydroRIVERS network from the event "
                                 "location, for a distance scaled by the event's severity. "
                                 "The course is the mapped river; the distance is an "
                                 "estimate, not an observed inundation extent."),
            "reference": cur.get("reference") if cur else None,
            "length_km": round(length_km, 1),
            "snap_km": round(snap_m / 1000.0, 2),
            "connector": connector,
            "path": coords,
            "palikas": hit[:20],
            "nearby_events": near,
            "nearby_total": len(near),
        }

        (OUT / f"{eid}.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
        index[eid] = {"length_km": rec["length_km"], "documented": bool(cur),
                      "palikas": len(hit), "nearby": len(near)}
        made += 1
        if made % 1000 == 0:
            print(f"  {made:,} corridors…")

    (PROCESSED / "corridors_index.json").write_text(json.dumps(index), encoding="utf-8")
    print(f"wrote {made:,} corridors")
    print("next: python corridor_elevation.py   (adds SRTM profiles, resumable)")


if __name__ == "__main__":
    main()
