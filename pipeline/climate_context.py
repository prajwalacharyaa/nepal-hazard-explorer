"""Why the hazard is changing: warming, melt, and what that does downstream.

A risk check that only looks at the past assumes the past is a fair guide. For
snow- and ice-driven hazards in Nepal it is not: the mountains are warming
faster than the global mean, the freezing level is climbing, glacial lakes are
growing behind moraine dams that were never engineered, and terrain that used
to shed snow now sheds water.

This produces the small, citable set of numbers the risk check needs to say so:

  * observed warming over Nepal, from NASA GISTEMP's 250 km land analysis
  * the freezing-level shift that implies, at a standard lapse rate
  * how the curated glacial-lake inventory is trending
  * how melt-linked hazards (GLOF, avalanche, flash flood, debris flow) appear
    in our own record by decade

Everything here is observational or simple arithmetic on observations. Nothing
is projected forward: no scenario, no model run, no claim about a given year.

Inputs : data/raw/gistemp250_GHCNv4.nc   (downloaded once; --refresh refetches)
         data/raw/dangerous_lakes.csv
         data/processed/events.geojson
Output : data/processed/climate_context.json
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import shutil
import sys
from collections import defaultdict
from datetime import date

import numpy as np

from config import RAW, PROCESSED

GISTEMP_URL = "https://data.giss.nasa.gov/pub/gistemp/gistemp250_GHCNv4.nc.gz"
GISTEMP_NC = RAW / "gistemp250_GHCNv4.nc"

# Nepal, generously bounded. GISTEMP is a 2 deg grid, so this is a handful of
# cells; the 250 km land-only analysis is the right variant for a landlocked
# mountain country.
BOX = dict(lat=slice(26, 31), lon=slice(80, 89))

# Environmental lapse rate. The freezing-level shift below is this arithmetic
# and nothing more — it is a way of expressing the warming in metres of
# mountain, not a modelled snowline.
LAPSE_C_PER_KM = 6.5

# Hazards whose frequency is physically tied to snow, ice and meltwater.
MELT_LINKED = ("glof", "avalanche", "flash_flood", "debris_flow")


def fetch_gistemp(refresh: bool) -> bool:
    if GISTEMP_NC.exists() and not refresh:
        return True
    try:
        import requests
        print("  downloading GISTEMP…")
        r = requests.get(GISTEMP_URL, timeout=600, stream=True)
        r.raise_for_status()
        gz = RAW / "gistemp.nc.gz"
        with open(gz, "wb") as fh:
            shutil.copyfileobj(r.raw, fh)
        with gzip.open(gz, "rb") as src, open(GISTEMP_NC, "wb") as dst:
            shutil.copyfileobj(src, dst)
        gz.unlink(missing_ok=True)
        return True
    except Exception as e:
        print(f"  ! GISTEMP unavailable ({e.__class__.__name__})", file=sys.stderr)
        return GISTEMP_NC.exists()


def warming():
    """Observed temperature anomaly over Nepal, and its trend."""
    try:
        import xarray as xr
    except ImportError:
        print("  ! xarray missing; skipping warming block", file=sys.stderr)
        return None
    ds = xr.open_dataset(GISTEMP_NC)
    da = ds["tempanomaly"].sel(**BOX)
    ann = da.mean(dim=("lat", "lon"), skipna=True).resample(time="YE").mean()
    yrs = ann.time.dt.year.values.astype(int)
    vals = np.asarray(ann.values, float)
    ok = np.isfinite(vals)

    def slope(y0):
        m = ok & (yrs >= y0)
        if m.sum() < 10:
            return None
        return round(float(np.polyfit(yrs[m], vals[m], 1)[0] * 10), 3)

    last = int(yrs[ok].max())
    recent = float(np.nanmean(vals[ok & (yrs >= last - 4)]))
    base = float(np.nanmean(vals[ok & (yrs >= 1951) & (yrs <= 1980)]))
    anomaly = round(recent - base, 2)

    return {
        "source": "NASA GISTEMP v4, 250 km land analysis (GHCNv4)",
        "baseline": "1951-1980",
        "through_year": last,
        "anomaly_c": anomaly,
        "trend_c_per_decade": {
            "since_1951": slope(1951),
            "since_1975": slope(1975),
            "since_1995": slope(1995),
        },
        "freezing_level_shift_m": int(round(anomaly / LAPSE_C_PER_KM * 1000)),
        "lapse_rate_c_per_km": LAPSE_C_PER_KM,
        "note": ("Freezing-level shift is the anomaly expressed in metres of "
                 "mountain at a standard lapse rate, not a modelled snowline."),
    }


def lakes():
    counts = defaultdict(int)
    growing = []
    with open(RAW / "dangerous_lakes.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            t = (r.get("trend") or "unknown").strip().lower()
            counts[t] += 1
            if t == "growing":
                growing.append({"lake": r["lake"], "district": r["district"],
                                "river": r.get("downstream_river", ""),
                                "area_km2": float(r["area_km2"] or 0)})
    growing.sort(key=lambda x: -x["area_km2"])
    return {
        "source": "ICIMOD/UNDP potentially-dangerous-glacial-lake inventory (curated)",
        "total": sum(counts.values()),
        "by_trend": dict(sorted(counts.items())),
        "growing": growing,
    }


def inventory_summary():
    """Measured lake change from the full HMA inventory, if it has been built."""
    src = PROCESSED / "glacial_lakes.json"
    if not src.exists():
        return None
    d = json.loads(src.read_text(encoding="utf-8"))
    c = d.get("counts", {})
    return {
        "source": d.get("source"),
        "total": c.get("total"),
        "with_growth_measured": c.get("with_growth_measured"),
        "grown_over_10pct": c.get("grown_over_10pct"),
        "shrunk_over_10pct": c.get("shrunk_over_10pct"),
        "median_growth_pct": d.get("median_growth_pct"),
    }


def melt_linked_record():
    """How melt-linked hazards appear in our own record, by decade.

    Reporting coverage grew sharply after ~2011, so these counts are NOT a
    clean trend in hazard. They are shown as a share of all recorded events in
    the same decade, which cancels most of that growth."""
    try:
        fc = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    tot = defaultdict(int)
    melt = defaultdict(int)
    by_haz = defaultdict(lambda: defaultdict(int))
    for f in fc["features"]:
        p = f["properties"]
        y = p.get("year")
        if not y:
            continue
        dec = (y // 10) * 10
        tot[dec] += 1
        if p.get("hazard") in MELT_LINKED:
            melt[dec] += 1
            by_haz[p["hazard"]][dec] += 1
    decades = sorted(tot)
    return {
        "note": ("Share of recorded events that are melt-linked, by decade. "
                 "Shown as a share because absolute counts mostly track "
                 "reporting coverage, not hazard."),
        "hazards": list(MELT_LINKED),
        "by_decade": [
            {"decade": d, "events": tot[d], "melt_linked": melt[d],
             "share_pct": round(melt[d] / tot[d] * 100, 1) if tot[d] else 0.0}
            for d in decades
        ],
        "by_hazard": {h: {str(d): by_haz[h].get(d, 0) for d in decades}
                      for h in MELT_LINKED},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--refresh", action="store_true",
                    help="re-download GISTEMP instead of using the cached file")
    args = ap.parse_args()

    print("climate context…")
    warm = warming() if fetch_gistemp(args.refresh) else None
    out = {
        "generated": date.today().isoformat(),
        "note": ("Observed climate context for Nepal. Everything here is an "
                 "observation or simple arithmetic on one. Nothing is projected "
                 "forward, and none of it predicts a specific event."),
        "warming": warm,
        "glacial_lakes": lakes(),
        "inventory": inventory_summary(),
        "record": melt_linked_record(),
    }
    dst = PROCESSED / "climate_context.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote climate_context.json ({dst.stat().st_size / 1024:.1f} KB)")
    if warm:
        print(f"    warming {warm['anomaly_c']:+.2f} C vs {warm['baseline']}, "
              f"{warm['trend_c_per_decade']['since_1995']:+.3f} C/decade since 1995")
        print(f"    freezing level ~{warm['freezing_level_shift_m']:+d} m")
    lk = out["glacial_lakes"]
    print(f"    lakes: {lk['by_trend']} of {lk['total']}")


if __name__ == "__main__":
    main()
