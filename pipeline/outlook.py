"""Approach D — seasonal statistical outlook.

NOT A FORECAST. This is descriptive climatology: how many events a district has
*historically* recorded in each calendar month over a recent, reasonably
complete reporting window, plus the linear trend in annual counts. It says
nothing about whether a specific event will happen.

Input:  data/processed/events.geojson
Output: data/processed/outlook.json
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import date

import numpy as np

from config import PROCESSED

RW_START, RW_END = 2011, 2025          # recent window (BIPAD era, ~complete)
HIST_START, HIST_END = 1971, 2010      # older era, shape only (under-reported)
LOW_CONF, MED_CONF = 20, 60            # n events in window -> confidence bands


def pois_q(lmbda: float, q: float) -> int:
    """Quantile of a Poisson(lmbda) annual count."""
    if lmbda <= 0:
        return 0
    if lmbda > 30:
        z = -1.645 if q < 0.5 else 1.645
        return max(0, round(lmbda + z * math.sqrt(lmbda)))
    cum, p, k = 0.0, math.exp(-lmbda), 0
    while cum + p < q and k < 2000:
        cum += p
        k += 1
        p *= lmbda / k
    return k


def main():
    fc = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))
    feats = fc["features"]

    # district -> month -> year -> count   (recent window)
    rw = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    # district -> year -> total            (recent window, for trend)
    rw_year = defaultdict(lambda: defaultdict(int))
    # district -> month -> count           (historic window, shape only)
    hist = defaultdict(lambda: defaultdict(int))
    # district -> month -> [deaths_total, worst_single]
    losses = defaultdict(lambda: defaultdict(lambda: [0, 0]))

    for f in feats:
        p = f["properties"]
        d, y, m = p.get("district"), p.get("year"), p.get("month")
        if not d or not y or not m:
            continue
        dd = int(p.get("deaths") or 0)
        if RW_START <= y <= RW_END:
            rw[d][m][y] += 1
            rw_year[d][y] += 1
            L = losses[d][m]
            L[0] += dd
            L[1] = max(L[1], dd)
        elif HIST_START <= y <= HIST_END:
            hist[d][m] += 1

    n_years = RW_END - RW_START + 1
    years = np.arange(RW_START, RW_END + 1)
    districts = {}

    for d in sorted(set(list(rw) + list(hist))):
        by_month = []
        for m in range(1, 13):
            counts = [rw[d][m].get(y, 0) for y in years]
            lam = sum(counts) / n_years
            L = losses[d][m]
            by_month.append({
                "m": m,
                "mean": round(lam, 2),
                "lo": pois_q(lam, 0.05),
                "hi": pois_q(lam, 0.95),
                "deaths_total": L[0],
                "worst_deaths": L[1],
            })

        totals = np.array([rw_year[d].get(int(y), 0) for y in years], float)
        n_recent = int(totals.sum())
        slope = float(np.polyfit(years, totals, 1)[0]) if n_recent else 0.0
        mean_annual = totals.mean() if n_recent else 0.0

        hist_total = sum(hist[d].values())
        hist_share = [round(hist[d].get(m, 0) / hist_total, 3) if hist_total else None
                      for m in range(1, 13)]

        peak = max(range(12), key=lambda i: by_month[i]["mean"]) + 1 if n_recent else None
        conf = ("low" if n_recent < LOW_CONF else
                "medium" if n_recent < MED_CONF else "high")

        districts[d] = {
            "n_recent": n_recent,
            "n_hist": hist_total,
            "confidence": conf,
            "trend_per_year": round(slope, 2),
            "trend_pct": round(slope / mean_annual * 100, 1) if mean_annual else None,
            "peak_month": peak,
            "by_month": by_month,
            "hist_month_share": hist_share,
        }

    # national aggregate
    nat_month = []
    for m in range(1, 13):
        lam = sum(dd["by_month"][m - 1]["mean"] for dd in districts.values())
        nat_month.append({"m": m, "mean": round(lam, 1)})
    nat_year = defaultdict(int)
    for d in rw_year:
        for y, c in rw_year[d].items():
            nat_year[y] += c
    nty = np.array([nat_year.get(int(y), 0) for y in years], float)
    nat_slope = float(np.polyfit(years, nty, 1)[0])

    out = {
        "meta": {
            "recent_window": [RW_START, RW_END],
            "hist_window": [HIST_START, HIST_END],
            "generated": date.today().isoformat(),
            "method": ("Monthly mean of recorded events per district over the "
                       "recent window; 5th/95th percentiles from a Poisson model "
                       "of the annual count; trend = OLS slope of annual totals. "
                       "Descriptive climatology, not a forecast."),
        },
        "national": {"by_month": nat_month, "trend_per_year": round(nat_slope, 1)},
        "districts": districts,
    }
    (PROCESSED / "outlook.json").write_text(json.dumps(out, ensure_ascii=False),
                                            encoding="utf-8")
    kb = (PROCESSED / "outlook.json").stat().st_size / 1024
    print(f"wrote outlook.json ({len(districts)} districts, {kb:.0f} KB)")

    # quick sanity print
    for name in ("Rasuwa", "Sindhupalchoke", "Kaski"):
        dd = districts.get(name)
        if not dd:
            continue
        pk = dd["peak_month"]
        bm = dd["by_month"][pk - 1] if pk else None
        print(f"  {name}: n={dd['n_recent']} conf={dd['confidence']} "
              f"trend={dd['trend_per_year']:+}/yr peak=month {pk} "
              f"(mean {bm['mean']}, 5-95% {bm['lo']}-{bm['hi']})" if bm else f"  {name}: no recent data")


if __name__ == "__main__":
    main()
