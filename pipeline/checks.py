"""Sanity checks on the committed data/processed/ artifacts.

Run by .github/workflows/checks.yml on every push, and useful locally after a
rebuild:  python pipeline/checks.py
Exits non-zero on the first failed assertion.
"""
from __future__ import annotations

import json
import sys

from config import PROCESSED, HAZARDS, KEEP_HAZARDS

FAILS = []


def check(cond, msg):
    if cond:
        print(f"  ok   {msg}")
    else:
        print(f"  FAIL {msg}")
        FAILS.append(msg)


def main():
    ev = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))["features"]
    di = json.loads((PROCESSED / "district_index.json").read_text(encoding="utf-8"))
    pi = json.loads((PROCESSED / "palika_index.json").read_text(encoding="utf-8"))
    meta = json.loads((PROCESSED / "meta.json").read_text(encoding="utf-8"))
    cal = json.loads((PROCESSED / "calendar.json").read_text(encoding="utf-8"))

    check(5000 < len(ev) < 40000, f"event count sane ({len(ev)})")
    check(all(f["geometry"] and f["geometry"]["type"] == "Point" for f in ev),
          "every event has a Point geometry")
    check(all(f["properties"]["hazard"] in KEEP_HAZARDS for f in ev),
          "every event hazard is in scope")
    check(all(80 <= f["geometry"]["coordinates"][0] <= 89 and
              26 <= f["geometry"]["coordinates"][1] <= 31 for f in ev),
          "every point falls inside Nepal's bounding box")
    ids = [f["properties"]["id"] for f in ev]
    check(len(ids) == len(set(ids)), "event ids are unique")
    check(ids == sorted(ids, key=str), "events.geojson is id-sorted (reproducible)")

    yrs = [f["properties"]["year"] for f in ev if f["properties"].get("year")]
    check(min(yrs) <= 1975 and max(yrs) >= 2024, f"year span {min(yrs)}-{max(yrs)}")
    check(meta["n_events"] == len(ev), "meta.json event count matches")
    check(meta["latest_event"] == max(f["properties"]["date"] for f in ev),
          "meta.json latest_event matches")

    check(len(di) == 77, f"district_index has 77 districts ({len(di)})")
    check(sum(1 for v in di.values() if v.get("population")) >= 70,
          "most districts have population")
    check(sum(1 for v in di.values() if v.get("deaths_per_100k") is not None) >= 70,
          "most districts have deaths_per_100k")
    check(all(set(v["by_hazard"]) <= set(HAZARDS) for v in di.values()),
          "district by_hazard keys are valid hazards")

    check(500 < len(pi) < 800, f"palika_index size sane ({len(pi)})")
    check(all(v.get("district") for v in pi.values()), "every palika row has a district")

    monsoon = sum(v["count"] for k, v in cal.items() if int(k[5:7]) in (6, 7, 8, 9))
    total = sum(v["count"] for v in cal.values())
    check(monsoon / total > 0.6, f"monsoon Jun-Sep dominates ({monsoon/total:.0%})")

    if FAILS:
        print(f"\n{len(FAILS)} check(s) failed")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
