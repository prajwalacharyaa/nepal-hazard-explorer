"""Approach B (v1) — GLOF what-if from a curated dangerous-lake inventory.

Full physical inundation modelling (DEM flow-routing) is out of scope here; this
version pairs each potentially dangerous glacial lake (PDGL) with its named
downstream river corridor and cross-references the historical record for
water-driven events already logged in those downstream districts.

Input:  data/raw/dangerous_lakes.csv   (curated; see the file header for columns)
        data/processed/events.geojson  (for the historical cross-reference)
Output: data/processed/glof.json
"""
from __future__ import annotations

import csv
import json
from collections import defaultdict

from config import RAW, PROCESSED

LAKES = RAW / "dangerous_lakes.csv"
CORRIDOR_HAZARDS = {"glof", "flash_flood", "debris_flow", "flood"}


def main():
    if not LAKES.exists():
        raise SystemExit("no data/raw/dangerous_lakes.csv")

    events = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))["features"]
    by_district = defaultdict(list)
    for f in events:
        p = f["properties"]
        if p.get("hazard") in CORRIDOR_HAZARDS and p.get("district"):
            by_district[p["district"]].append(p)

    lakes = []
    with LAKES.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            ds = [d.strip().title() for d in (row.get("downstream_districts") or "").split(";") if d.strip()]
            hist = []
            for d in ds:
                for p in by_district.get(d, []):
                    hist.append({"id": p["id"], "date": p["date"], "hazard": p["hazard"],
                                 "district": d, "deaths": p.get("deaths") or 0,
                                 "severity_score": p.get("severity_score") or 0})
            hist.sort(key=lambda e: e["severity_score"], reverse=True)
            lakes.append({
                "id": row["id"],
                "lake": row["lake"],
                "district": row["district"],
                "lon": float(row["lon"]), "lat": float(row["lat"]),
                "basin": row.get("basin"),
                "downstream_river": row.get("downstream_river"),
                "downstream_districts": ds,
                "area_km2": float(row["area_km2"]) if row.get("area_km2") else None,
                "trend": row.get("trend"),
                "past_glof": row.get("past_glof"),
                "notes": row.get("notes"),
                "references": row.get("references"),
                "corridor_events_total": len(hist),
                "corridor_events_top": hist[:8],
            })

    out = {
        "meta": {
            "note": ("Curated inventory of potentially dangerous glacial lakes "
                     "(PDGLs) and their named downstream corridors. 'Corridor "
                     "events' are historical water-driven disasters already "
                     "recorded in the downstream districts — context, not a "
                     "modelled flood path. Coordinates approximate."),
            "sources": "ICIMOD/UNDP 2020 PDGL inventory; Bajracharya et al.; "
                       "Mool et al. 2001; event-specific refs per row.",
        },
        "lakes": lakes,
    }
    (PROCESSED / "glof.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"wrote glof.json  ({len(lakes)} lakes)")
    for L in lakes:
        print(f"  {L['lake']:28s} {L['downstream_river']:32s} "
              f"corridor events: {L['corridor_events_total']}")


if __name__ == "__main__":
    main()
