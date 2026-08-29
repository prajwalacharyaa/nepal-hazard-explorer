"""Trace where a sudden water release would actually go.

Buffering a glacial lake by N km is wrong: water follows channels. A point
600 m up a valley side is fine; a village 40 km downstream on the floodplain
is not. So walk HydroRIVERS NEXT_DOWN from each source instead.

Sources: glacial lakes (curated CSV + the HMA inventory via glacial_lakes.py),
and dams, weirs and hydropower from OSM.

Dams are reported separately and never as "this will fail" — only as "a
structure sits upstream of this reach", which is what changes the exposure.

Inputs : data/raw/hydrorivers_nepal.gpkg   (fetch_rivers.py)
         data/raw/dangerous_lakes.csv
         data/raw/osm_barriers.json        (cached Overpass reply; refetched
                                            with --refresh)
Output : data/processed/surge_paths.json

Deterministic: sources are sorted by id, coordinates rounded, so a rebuild is
byte-identical unless the inputs changed.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys

from shapely.geometry import Point
from shapely.ops import transform
from pyproj import Transformer

import numpy as np

import terrain
from config import RAW, PROCESSED
from corridors import load_rivers, trace_downstream, METRIC

TO_WGS = Transformer.from_crs(METRIC, 4326, always_xy=True)
TO_METRIC = Transformer.from_crs(4326, METRIC, always_xy=True)

# How far a release is worth following. A GLOF surge is documented to stay
# destructive for a very long way (the 1985 Dig Tsho flood scoured ~40 km; the
# 2026 Langtang cascade was reported ~100 km), so we trace far and let the
# frontend decide how much attenuation to assume with distance.
GLOF_KM = 200.0            # the ten curated lakes, documented far downstream
GLOF_AUTO_KM = 110.0       # every other mapped lake, from the HMA inventory
DAM_KM = 45.0
SIMPLIFY_M = 250.0            # path geometry tolerance; keeps the file small

# Overpass mirrors, tried in order. The public instances rate-limit hard and
# reject a default requests User-Agent, so both are handled.
# --- travel time -----------------------------------------------------------
# How fast a surge front moves is mostly a question of channel slope. A
# Manning-type relation, v = (1/n) R^(2/3) sqrt(S), with a boulder mountain
# channel (n = 0.05) and a hydraulic radius of ~3 m for a large flood wave,
# gives ~9 m/s in a steep gorge and ~1.5 m/s across the plains — the right
# order for documented GLOF fronts. It is an estimate of the FRONT, not of the
# peak, and it ignores storage, breach growth and channel roughness that
# actually varies. Treat it as "tens of minutes", never as a countdown.
MANNING_N = 0.05
HYDRAULIC_R = 3.0
V_MIN, V_MAX = 1.5, 15.0          # m/s, clamps on the relation
S_MIN = 1e-4                      # SRTM noise floor; flat is not zero-slope


def travel_minutes(path, elev):
    """Cumulative minutes from the source to each vertex along the path."""
    out = [0.0]
    for i in range(1, len(path)):
        # planar metres between the two vertices
        lon1, lat1 = path[i - 1]
        lon2, lat2 = path[i]
        mlat = math.radians((lat1 + lat2) / 2)
        dx = (lon2 - lon1) * 111320.0 * math.cos(mlat)
        dy = (lat2 - lat1) * 110540.0
        d = math.hypot(dx, dy)
        if d < 1:
            out.append(out[-1])
            continue
        e1, e2 = elev[i - 1], elev[i]
        drop = (e1 - e2) if (math.isfinite(e1) and math.isfinite(e2)) else 0.0
        slope = max(S_MIN, drop / d)          # uphill noise -> the floor
        v = (1.0 / MANNING_N) * (HYDRAULIC_R ** (2.0 / 3.0)) * math.sqrt(slope)
        v = min(V_MAX, max(V_MIN, v))
        out.append(out[-1] + (d / v) / 60.0)
    return out


OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]
UA = "nepal-hazard-explorer/1.0 (open-data research map; contact via repo)"
OVERPASS_Q = """
[out:json][timeout:90];
area["ISO3166-1"="NP"][admin_level=2]->.np;
(
  node["waterway"="dam"](area.np);
  way["waterway"="dam"](area.np);
  node["waterway"="weir"](area.np);
  way["waterway"="weir"](area.np);
  node["power"="plant"]["plant:source"="hydro"](area.np);
  way["power"="plant"]["plant:source"="hydro"](area.np);
);
out center;
"""


def fetch_osm(refresh: bool):
    """Overpass reply, cached on disk so the build works offline and repeats."""
    cache = RAW / "osm_barriers.json"
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))
    import time
    try:
        import requests
    except ImportError:
        return json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else None

    data = None
    for attempt, url in enumerate(OVERPASS * 2):
        try:
            r = requests.post(url, data={"data": OVERPASS_Q}, timeout=150,
                              headers={"User-Agent": UA})
            if r.status_code in (429, 502, 503, 504):
                wait = 5 * (attempt + 1)
                print(f"  . {r.status_code} from {url.split('/')[2]}, "
                      f"retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            r.raise_for_status()
            data = r.json()
            break
        except Exception as e:                   # network, rate limit, parse
            print(f"  . {url.split('/')[2]}: {e.__class__.__name__}", file=sys.stderr)
            time.sleep(3)

    if data is None:
        print(f"  ! Overpass unavailable; "
              f"{'using cache' if cache.exists() else 'skipping dams'}",
              file=sys.stderr)
        return json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else None
    cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"  fetched {len(data.get('elements', []))} OSM barrier elements")
    return data


def osm_sources(data):
    """One record per dam / weir / hydro plant, de-duplicated by rounded position."""
    if not data:
        return []
    out, seen = [], set()
    for el in data.get("elements", []):
        tags = el.get("tags", {}) or {}
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        if lon is None or lat is None:
            continue
        key = (round(lon, 4), round(lat, 4))
        if key in seen:
            continue
        seen.add(key)
        if tags.get("power") == "plant":
            kind, label = "hydropower", "hydropower plant"
        elif tags.get("waterway") == "weir":
            kind, label = "weir", "weir"
        else:
            kind, label = "dam", "dam"
        out.append({
            "id": f"osm-{el['type']}-{el['id']}",
            "kind": kind,
            "name": tags.get("name") or tags.get("name:en") or f"unnamed {label}",
            "lon": float(lon), "lat": float(lat),
            "detail": label,
            "source": "OpenStreetMap contributors (ODbL)",
        })
    out.sort(key=lambda r: r["id"])
    return out


def lake_sources():
    """Curated lakes first, then every routable lake from the HMA inventory.

    The curated ten carry documented reach and references; the inventory adds
    the ~150 others large enough to matter, each with its measured 2016-2022
    area change so the frontend can say whether it is growing."""
    rows, seen = [], set()
    with open(RAW / "dangerous_lakes.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            rows.append({
                "id": f"lake-{r['id']}",
                "kind": "glacial_lake",
                "name": r["lake"],
                "lon": float(r["lon"]), "lat": float(r["lat"]),
                "detail": f"glacial lake, {r['trend']}",
                "river": r.get("downstream_river", ""),
                "trend": r.get("trend", ""),
                "past_glof": r.get("past_glof", ""),
                "curated": True,
                "budget_km": GLOF_KM,
                "source": "ICIMOD/UNDP PDGL inventory (curated)",
            })
            seen.add((round(float(r["lon"]), 2), round(float(r["lat"]), 2)))

    inv = PROCESSED / "glacial_lakes.json"
    if inv.exists():
        data = json.loads(inv.read_text(encoding="utf-8"))
        for lk in data.get("lakes", []):
            if not lk.get("route"):
                continue
            key = (round(lk["lon"], 2), round(lk["lat"], 2))
            if key in seen:                     # already covered by a curated row
                continue
            seen.add(key)
            g = lk.get("growth_pct")
            trend = ("growing" if g is not None and g > 10
                     else "shrinking" if g is not None and g < -10
                     else "stable" if g is not None else "unknown")
            rows.append({
                "id": f"hma-{lk['id']}",
                "kind": "glacial_lake",
                "name": lk.get("name") or f"glacial lake at {lk['elev_m']} m",
                "lon": lk["lon"], "lat": lk["lat"],
                "detail": f"glacial lake, {lk['km2']} km2 at {lk['elev_m']} m",
                "river": lk.get("river", ""),
                "trend": trend,
                "growth_pct": g,
                "km2": lk["km2"],
                "elev_m": lk["elev_m"],
                "past_glof": "",
                "budget_km": GLOF_AUTO_KM,
                "source": "HMA glacial lake inventory 2016-2024 (Zenodo 17948783, CC-BY-4.0)",
            })
    rows.sort(key=lambda r: r["id"])
    return rows


def route(src, gdf, geom, nxt, budget_km):
    """Snap the source to the river network and walk downstream."""
    pt = Point(*TO_METRIC.transform(src["lon"], src["lat"]))
    # nearest reach, searching a generous window (a lake outlet can sit a
    # couple of km from the nearest mapped channel)
    idx = gdf.sindex.nearest(pt, return_all=False)[1]
    if len(idx) == 0:
        return None
    row = gdf.iloc[int(idx[0])]
    rid = int(row.HYRIV_ID)
    snap_m = row.geometry.distance(pt)
    if snap_m > 15000:                              # nothing plausible nearby
        return None

    line, km = trace_downstream(rid, geom, nxt, budget_km * 1000.0,
                                start_pt=row.geometry.interpolate(
                                    row.geometry.project(pt)))
    if line is None or km < 1.0:
        return None
    line = line.simplify(SIMPLIFY_M, preserve_topology=False)
    wgs = transform(TO_WGS.transform, line)
    path = [[round(x, 3), round(y, 3)] for x, y in wgs.coords]
    dedup = [path[0]]
    for c in path[1:]:
        if c != dedup[-1]:
            dedup.append(c)
    path = dedup
    if len(path) < 2:
        return None

    rec = dict(src)
    rec.pop("budget_km", None)
    rec["path"] = path
    rec["length_km"] = round(km, 1)
    rec["snap_km"] = round(snap_m / 1000.0, 2)

    # elevation along the route, then how long a front takes to run it
    try:
        elev = terrain.elevation(path)
        mins = travel_minutes(path, elev)
        rec["travel_min"] = [int(round(m)) for m in mins]
        rec["travel_total_min"] = int(round(mins[-1]))
        drop = float(np.nanmax(elev) - np.nanmin(elev)) if len(elev) else 0.0
        rec["drop_m"] = int(round(drop))
    except Exception:
        pass                                   # elevation is a bonus, not a gate
    return rec


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true",
                    help="refetch dams from Overpass instead of using the cache")
    args = ap.parse_args()

    if not (RAW / "hydrorivers_nepal.gpkg").exists():
        raise SystemExit("missing hydrorivers_nepal.gpkg — run fetch_rivers.py first")

    print("loading river network…")
    gdf, geom, nxt, _order = load_rivers()

    print("routing glacial lakes…")
    lakes = lake_sources()
    print("routing dams and hydropower…")
    dams = osm_sources(fetch_osm(args.refresh))

    out = []
    jobs = ([(s, s.get("budget_km", GLOF_KM)) for s in lakes] +
            [(s, DAM_KM) for s in dams])
    for src, budget in jobs:
        rec = route(src, gdf, geom, nxt, budget)
        if rec:
            out.append(rec)
        else:
            print(f"  - {src['name']}: no downstream reach found", file=sys.stderr)

    out.sort(key=lambda r: r["id"])
    payload = {
        "generated": __import__("datetime").date.today().isoformat(),
        "note": ("Downstream routes a sudden water release would follow, traced "
                 "along the HydroRIVERS network from each known source. A route "
                 "is not a prediction that a release will happen, and its width "
                 "is not modelled — it shows where water would go, not how far "
                 "up the banks it would reach."),
        "sources": {
            "glacial_lake": "ICIMOD/UNDP potentially-dangerous-glacial-lake inventory (curated)",
            "dam": "OpenStreetMap contributors (ODbL)",
            "weir": "OpenStreetMap contributors (ODbL)",
            "hydropower": "OpenStreetMap contributors (ODbL)",
            "network": "HydroRIVERS v1.0 (WWF HydroSHEDS)",
        },
        "budget_km": {"glacial_lake": GLOF_KM, "dam": DAM_KM,
                      "weir": DAM_KM, "hydropower": DAM_KM},
        "counts": {k: sum(1 for r in out if r["kind"] == k)
                   for k in ("glacial_lake", "dam", "weir", "hydropower")},
        "paths": out,
    }
    dst = PROCESSED / "surge_paths.json"
    dst.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    kb = dst.stat().st_size / 1024
    print(f"wrote surge_paths.json — {len(out)} routes, {kb:.0f} KB")
    for k, v in payload["counts"].items():
        print(f"    {k:14s} {v}")


if __name__ == "__main__":
    main()
