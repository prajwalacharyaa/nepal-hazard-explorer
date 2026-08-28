"""Add SRTM elevation profiles to the corridors built by corridors.py.

Kept separate because the free OpenTopoData API allows roughly one call per
second, so this is the slow part of the build. It is fully resumable: every
run skips corridors that already have a profile, and the raw samples are
cached, so you can stop it at any time and pick up later.

    python corridor_elevation.py                # the default tier
    python corridor_elevation.py --all          # every corridor
    python corridor_elevation.py --limit 200    # stop after 200 new profiles

Elevation is not fetched in the browser because OpenTopoData sends no CORS
header, so the request has to happen here at build time.

Patches: data/processed/corridors/<id>.json   (adds `elevation` and `drop_m`)
Cache  : data/raw/elev_cache.json
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import requests

from config import RAW, PROCESSED

CORRIDORS = PROCESSED / "corridors"
CACHE_FILE = RAW / "elev_cache.json"
SAMPLES = 24
PAUSE = 1.05                     # the public API allows ~1 request/second
DEFAULT_CLASSES = {"major", "catastrophic"}


def cache_key(coords):
    a, b = coords[0], coords[-1]
    return f"{a[0]:.4f},{a[1]:.4f}|{b[0]:.4f},{b[1]:.4f}|{len(coords)}"


def fetch_profile(coords, session):
    step = max(1, len(coords) // SAMPLES)
    pts = coords[::step][:SAMPLES]
    locs = "|".join(f"{lat:.5f},{lon:.5f}" for lon, lat in pts)
    try:
        r = session.get(f"https://api.opentopodata.org/v1/srtm30m?locations={locs}",
                        timeout=45)
        if r.status_code == 429:
            print("  rate limited — pausing 30s", file=sys.stderr)
            time.sleep(30)
            return None
        if r.status_code != 200:
            return None
        vals = [x.get("elevation") for x in r.json().get("results", [])]
        prof = [round(v) for v in vals if v is not None]
        return prof if len(prof) >= 3 else None
    except (requests.RequestException, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true",
                    help="every corridor, not just major/catastrophic events")
    ap.add_argument("--limit", type=int, default=0, help="stop after N new profiles")
    args = ap.parse_args()

    if not CORRIDORS.exists():
        raise SystemExit("no corridors yet — run corridors.py first")

    events = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))["features"]
    sev = {f["properties"]["id"]: f["properties"].get("severity_class") for f in events}

    cache = json.loads(CACHE_FILE.read_text(encoding="utf-8")) if CACHE_FILE.exists() else {}
    files = sorted(CORRIDORS.glob("*.json"))
    todo = []
    for f in files:
        rec = json.loads(f.read_text(encoding="utf-8"))
        if rec.get("elevation"):
            continue
        if not args.all and sev.get(rec["event_id"]) not in DEFAULT_CLASSES:
            continue
        todo.append((f, rec))

    print(f"{len(files):,} corridors, {len(todo):,} still need a profile"
          f"{'' if args.all else ' (major/catastrophic tier)'}")
    if not todo:
        return

    session = requests.Session()
    done = hits = 0
    try:
        for f, rec in todo:
            if args.limit and done >= args.limit:
                break
            key = cache_key(rec["path"])
            prof = cache.get(key)
            if prof is None:
                prof = fetch_profile(rec["path"], session)
                if prof:
                    cache[key] = prof
                time.sleep(PAUSE)
            else:
                hits += 1
            if not prof:
                continue
            rec["elevation"] = prof
            rec["drop_m"] = max(prof) - min(prof)
            f.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
            done += 1
            if done % 25 == 0:
                CACHE_FILE.write_text(json.dumps(cache), encoding="utf-8")
                print(f"  {done:,}/{len(todo):,} profiles ({hits} from cache)")
    except KeyboardInterrupt:
        print("\ninterrupted — progress is saved, re-run to continue")
    finally:
        CACHE_FILE.write_text(json.dumps(cache), encoding="utf-8")

    print(f"added {done:,} elevation profiles ({hits} served from cache)")


if __name__ == "__main__":
    main()
