"""Trace a downstream impact corridor for each significant event.

For every event with recorded deaths or a moderate-or-worse severity class we
snap the point to the nearest HydroRIVERS reach and walk downstream along the
NEXT_DOWN topology, spending a distance budget scaled by the event's severity.
The result is a MODELLED potential corridor — the reach water and debris would
follow — not an observed inundation footprint. The web page labels it as such.

Where a hand-authored path exists in data/raw/curated_paths.geojson (sourced
from the literature for major documented events) that observed path is used
instead and flagged `observed: true`.

Each corridor also carries the municipalities it passes through, other recorded
events along the same reach, and (for the most severe events) an elevation
profile from the free OpenTopoData SRTM API.

Inputs : data/raw/hydrorivers_nepal.gpkg   (fetch_rivers.py)
         data/processed/events.geojson, palikas.geojson, palika_index.json
         data/raw/curated_paths.geojson    (optional, hand-authored)
Outputs: data/processed/corridors/<event id>.json
         data/processed/corridors_index.json
"""
from __future__ import annotations

import json
import time
from collections import defaultdict

import geopandas as gpd
import pandas as pd
import requests
from shapely.geometry import LineString, Point, shape
from shapely.ops import linemerge, substring
from shapely.strtree import STRtree

from config import RAW, PROCESSED

METRIC = 32645                      # UTM 45N — metres, good for Nepal
SNAP_MAX_M = 4000                   # give up if no river within 4 km
OUT = PROCESSED / "corridors"
ELEV_CACHE = RAW / "elev_cache.json"
ELEV_CLASSES = {"major", "catastrophic"}   # profile only for the worst events
ELEV_SAMPLES = 24


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


# ------------------------------------------------------------- elevation ---
def load_cache():
    if ELEV_CACHE.exists():
        return json.loads(ELEV_CACHE.read_text(encoding="utf-8"))
    return {}


def elevation_profile(coords, cache):
    """Sample elevation along the path via OpenTopoData (free, no key)."""
    key = f"{coords[0][0]:.4f},{coords[0][1]:.4f}|{len(coords)}|{coords[-1][0]:.4f}"
    if key in cache:
        return cache[key]
    step = max(1, len(coords) // ELEV_SAMPLES)
    pts = coords[::step][:ELEV_SAMPLES]
    locs = "|".join(f"{lat:.5f},{lon:.5f}" for lon, lat in pts)
    try:
        r = requests.get(f"https://api.opentopodata.org/v1/srtm30m?locations={locs}",
                         timeout=45)
        if r.status_code != 200:
            return None
        vals = [x.get("elevation") for x in r.json().get("results", [])]
        prof = [round(v) for v in vals if v is not None]
        cache[key] = prof
        time.sleep(1.1)          # be polite: the free tier allows ~1 req/sec
        return prof
    except requests.RequestException:
        return None


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

    # curated observed paths, if any
    curated = {}
    cp = RAW / "curated_paths.geojson"
    if cp.exists():
        for f in json.loads(cp.read_text(encoding="utf-8"))["features"]:
            curated[f["properties"]["event_id"]] = f
        print(f"  {len(curated)} curated observed path(s)")

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

    cache = load_cache()
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()

    index, made, elev_done = {}, 0, 0
    for row, feat in zip(snapped.itertuples(), sig):
        p = feat["properties"]
        eid = p["id"]
        observed = False

        if eid in curated:
            line_ll = shape(curated[eid]["geometry"])
            line = gpd.GeoSeries([line_ll], crs=4326).to_crs(METRIC).iloc[0]
            length_km = line.length / 1000.0
            observed = True
        else:
            if pd.isna(getattr(row, "HYRIV_ID", None)):
                continue
            line, length_km = trace_downstream(
                int(row.HYRIV_ID), geom, nxt, budget_km(p) * 1000.0, row.geometry)
            if line is None or length_km < 0.5:
                continue

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
                         "severity_score": q.get("severity_score") or 0})
        near.sort(key=lambda e: e["severity_score"], reverse=True)

        coords = [[round(x, 5), round(y, 5)] for x, y in
                  gpd.GeoSeries([line], crs=METRIC).to_crs(4326).iloc[0]
                  .simplify(0.0006, preserve_topology=True).coords]

        rec = {
            "event_id": eid,
            "observed": observed,
            "source_note": (curated[eid]["properties"].get("note") if observed
                            else "Modelled: traced along the HydroRIVERS network from the "
                                 "event location, for a distance scaled by the event's "
                                 "severity. Not an observed inundation extent."),
            "reference": curated[eid]["properties"].get("reference") if observed else None,
            "length_km": round(length_km, 1),
            "path": coords,
            "palikas": hit[:24],
            "nearby_events": near[:25],
            "nearby_total": len(near),
        }

        if p.get("severity_class") in ELEV_CLASSES:
            prof = elevation_profile(coords, cache)
            if prof:
                rec["elevation"] = prof
                rec["drop_m"] = max(prof) - min(prof)
                elev_done += 1

        (OUT / f"{eid}.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
        index[eid] = {"length_km": rec["length_km"], "observed": observed,
                      "palikas": len(hit), "nearby": len(near)}
        made += 1
        if made % 500 == 0:
            print(f"  {made:,} corridors…")
            ELEV_CACHE.write_text(json.dumps(cache), encoding="utf-8")

    (PROCESSED / "corridors_index.json").write_text(json.dumps(index), encoding="utf-8")
    ELEV_CACHE.write_text(json.dumps(cache), encoding="utf-8")
    print(f"wrote {made:,} corridors ({elev_done:,} with an elevation profile)")


if __name__ == "__main__":
    main()
