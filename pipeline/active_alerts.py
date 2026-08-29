"""Post-event alerts that expire on their own.

For a while after a bad event the area stays riskier than its terrain implies:
saturated ground, blocked channels, debris still perched upslope, damaged
roads. Real, and temporary.

Alerts are derived from the event feed rather than hand-maintained, so run this
daily and they show up wherever the next serious event lands and clear on their
own. data/raw/manual_alerts.csv can add one the feed has not caught yet; those
expire too.

Inputs : data/processed/events.geojson
         data/raw/manual_alerts.csv          (optional)
Output : data/processed/active_alerts.json

The frontend re-checks expiry against the viewer's own clock, so a stale build
degrades safely: an alert past its date is ignored even if this never runs again.
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import date, datetime, timedelta

from config import RAW, PROCESSED

# Severity at or above which an event raises an alert at all. The severity
# index is 5*deaths + 5*missing + injured + ... so 25 is roughly "several
# dead, or widespread destruction".
MIN_SEVERITY = 25.0

# How the alert decays. Days are counted from the event date.
STAGES = [
    (7, "high", "Area in high alert"),
    (21, "elevated", "Area under an elevated alert"),
    (45, "watch", "Recently affected area"),
]

# What each stage does to the risk score in the frontend: a floor, and a
# multiplier on every hazard the event type implies.
STAGE_EFFECT = {
    "high": {"floor": 78, "boost": 0.55},
    "elevated": {"floor": 55, "boost": 0.3},
    "watch": {"floor": 35, "boost": 0.15},
}


def stage_for(days: int):
    for limit, key, label in STAGES:
        if days <= limit:
            return key, label, limit
    return None, None, None


def load_manual():
    """Optional hand-written alerts. Columns:
    district,palika,hazard,level,headline,started,days,source"""
    src = RAW / "manual_alerts.csv"
    if not src.exists():
        return []
    out = []
    with open(src, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if not r.get("district"):
                continue
            out.append(r)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--today", help="pretend it is this date (YYYY-MM-DD)")
    args = ap.parse_args()
    today = (datetime.strptime(args.today, "%Y-%m-%d").date()
             if args.today else date.today())

    fc = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))

    # The dataset's own latest record, so a build against a frozen snapshot
    # still behaves sensibly rather than declaring everything expired.
    latest = max((f["properties"]["date"] for f in fc["features"]
                  if f["properties"].get("date")), default=None)
    ref = today
    if latest:
        ld = datetime.strptime(latest, "%Y-%m-%d").date()
        if ld > today:                      # dataset runs ahead of the clock
            ref = ld

    horizon = STAGES[-1][0]
    by_area = {}
    for f in fc["features"]:
        p = f["properties"]
        if (p.get("severity_score") or 0) < MIN_SEVERITY:
            continue
        try:
            d = datetime.strptime(p["date"], "%Y-%m-%d").date()
        except (KeyError, ValueError, TypeError):
            continue
        days = (ref - d).days
        if days < 0 or days > horizon:
            continue
        key, label, limit = stage_for(days)
        if not key:
            continue

        area = (p.get("district") or "").strip()
        if not area:
            continue
        rec = by_area.get(area)
        # the most severe, most recent event wins the area
        if rec and (rec["_days"] < days or
                    (rec["_days"] == days and rec["_sev"] >= p["severity_score"])):
            continue
        by_area[area] = {
            "district": area,
            "palikas": [p["palika"]] if p.get("palika") else [],
            "level": key,
            "label": label,
            "hazard": p.get("hazard"),
            "event_id": p.get("id"),
            "event_date": p["date"],
            "deaths": p.get("deaths") or 0,
            "missing": p.get("missing") or 0,
            "days_since": days,
            "expires": (d + timedelta(days=horizon)).isoformat(),
            "stage_ends": (d + timedelta(days=limit)).isoformat(),
            "source": "derived from the recorded event feed",
            "_days": days, "_sev": p.get("severity_score") or 0,
        }

    # every municipality touched by a qualifying event in the same window
    extra = defaultdict(set)
    for f in fc["features"]:
        p = f["properties"]
        if (p.get("severity_score") or 0) < MIN_SEVERITY or not p.get("palika"):
            continue
        d0 = p.get("date")
        if not d0 or d0 not in ("",) and p.get("district") not in by_area:
            continue
        try:
            d = datetime.strptime(d0, "%Y-%m-%d").date()
        except ValueError:
            continue
        if 0 <= (ref - d).days <= horizon:
            extra[p["district"]].add(p["palika"])
    for k, v in extra.items():
        if k in by_area:
            by_area[k]["palikas"] = sorted(set(by_area[k]["palikas"]) | v)

    for m in load_manual():
        area = m["district"].strip()
        try:
            started = datetime.strptime(m.get("started") or "", "%Y-%m-%d").date()
        except ValueError:
            started = ref
        days = int(m.get("days") or horizon)
        if (ref - started).days > days:
            continue                                   # already lapsed
        lvl = (m.get("level") or "high").strip()
        by_area[area] = {
            "district": area,
            "palikas": [x.strip() for x in (m.get("palika") or "").split(";") if x.strip()],
            "level": lvl,
            "label": dict((k, l) for _, k, l in STAGES).get(lvl, "Area under alert"),
            "hazard": m.get("hazard") or None,
            "event_id": None,
            "event_date": started.isoformat(),
            "deaths": 0, "missing": 0,
            "days_since": (ref - started).days,
            "expires": (started + timedelta(days=days)).isoformat(),
            "stage_ends": (started + timedelta(days=days)).isoformat(),
            "headline": m.get("headline") or "",
            "source": m.get("source") or "manually entered",
            "_days": 0, "_sev": 0,
        }

    alerts = sorted(by_area.values(),
                    key=lambda a: (a["days_since"], -a["_sev"]))
    for a in alerts:
        a.pop("_days", None)
        a.pop("_sev", None)

    out = {
        "generated": today.isoformat(),
        "reference_date": ref.isoformat(),
        "note": ("Areas recently hit hard enough to stay at raised risk while "
                 "they recover: saturated ground, blocked or re-routed channels, "
                 "debris still perched upslope, damaged infrastructure. Derived "
                 "from the recorded event feed and self-expiring — the frontend "
                 "re-checks every alert against the viewer's own clock, so a "
                 "stale build simply shows nothing rather than something wrong."),
        "min_severity": MIN_SEVERITY,
        "stages": [{"through_days": d, "level": k, "label": l} for d, k, l in STAGES],
        "effects": STAGE_EFFECT,
        "counts": {k: sum(1 for a in alerts if a["level"] == k)
                   for _, k, _ in STAGES},
        "alerts": alerts,
    }
    dst = PROCESSED / "active_alerts.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote active_alerts.json — {len(alerts)} active "
          f"(reference date {ref})")
    for a in alerts[:12]:
        pal = f" [{', '.join(a['palikas'][:3])}]" if a["palikas"] else ""
        print(f"    {a['level']:8s} {a['district']:16s}{pal}  "
              f"{a['hazard'] or '-':12s} {a['days_since']:>3}d ago, "
              f"expires {a['expires']}")


if __name__ == "__main__":
    main()
