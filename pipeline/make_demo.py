"""Generate SYNTHETIC events.geojson so the web UI can be developed offline.

NOT REAL DATA. Delete data/processed/events.geojson and run the real pipeline
(fetch_bipad -> clean_merge -> aggregate) to replace it.

~1800 fabricated events, 1971-2026, monsoon-weighted, clustered along the
mid-hills and major river corridors, 6 hazard types.
"""
from __future__ import annotations

import json
import math
import random

from config import PROCESSED, HAZARDS, SEVERITY_WEIGHTS, severity_class

random.seed(42)
N = 1800

# rough cluster centres (lon, lat): mid-hill landslide belt + river/flood zones
CLUSTERS = [
    (85.32, 27.72, "landslide"),   # Kathmandu rim
    (83.98, 28.21, "landslide"),   # Kaski / Pokhara
    (86.73, 27.80, "landslide"),   # Solukhumbu
    (81.62, 29.30, "landslide"),   # Bajhang far-west
    (85.90, 26.90, "flood"),       # Bagmati terai
    (84.02, 27.55, "flood"),       # Narayani
    (87.28, 26.65, "flood"),       # Koshi
    (80.60, 28.80, "flood"),       # Karnali / Mohana
    (85.56, 28.20, "flash_flood"), # Melamchi / Helambu
    (83.62, 28.75, "flash_flood"), # Myagdi / Kali Gandaki
    (85.88, 28.28, "glof"),        # Langtang
    (86.55, 27.95, "glof"),        # Everest region lakes
    (85.30, 28.05, "debris_flow"),
    (82.30, 29.55, "avalanche"),   # Dolpo
    (86.70, 27.98, "avalanche"),   # Khumbu
]

HAZARD_W = {  # relative frequency
    "landslide": 0.42, "flood": 0.30, "flash_flood": 0.13,
    "debris_flow": 0.08, "glof": 0.015, "avalanche": 0.055,
}

MONTH_W = [0.02, 0.02, 0.03, 0.04, 0.06, 0.13, 0.24, 0.22, 0.14, 0.04, 0.02, 0.02]


def pick_hazard() -> str:
    r, acc = random.random(), 0.0
    for h, w in HAZARD_W.items():
        acc += w
        if r <= acc:
            return h
    return "landslide"


def pick_month() -> int:
    r, acc = random.random(), 0.0
    for i, w in enumerate(MONTH_W, 1):
        acc += w
        if r <= acc:
            return i
    return 7


def losses(hazard: str):
    base = {"landslide": 3, "flood": 6, "flash_flood": 9, "glof": 40,
            "debris_flow": 5, "avalanche": 4}[hazard]
    heavy = random.random() < 0.06          # rare catastrophe
    scale = random.lognormvariate(0, 1.1) * (12 if heavy else 1)
    deaths = int(max(0, random.gauss(base, base) * scale * 0.15))
    missing = int(deaths * random.uniform(0, 0.4))
    injured = int(deaths * random.uniform(0.3, 2.0))
    hd = int(max(0, random.gauss(base, base) * scale))
    hdmg = int(hd * random.uniform(1, 4))
    aff = int(hd * random.uniform(3, 20))
    return deaths, missing, injured, aff, hd, hdmg


def main():
    feats = []
    for i in range(N):
        clon, clat, chz = random.choice(CLUSTERS)
        hazard = chz if random.random() < 0.6 else pick_hazard()
        lon = clon + random.gauss(0, 0.28)
        lat = clat + random.gauss(0, 0.16)
        lon = min(88.1, max(80.2, lon))
        lat = min(30.3, max(26.4, lat))
        year = random.randint(1971, 2026)
        # more records in recent decades (reporting bias, realistic)
        if year < 2000 and random.random() < 0.6:
            year = random.randint(2000, 2026)
        month = pick_month()
        day = random.randint(1, 28)
        d, m, inj, aff, hd, hdmg = losses(hazard)
        row = dict(
            id=f"demo-{i}", source="demo",
            date=f"{year}-{month:02d}-{day:02d}", date_precision="day",
            year=year, month=month,
            hazard=hazard, hazard_raw=hazard, district=None,
            lon=round(lon, 4), lat=round(lat, 4),
            geo_precision="exact",
            deaths=d, missing=m, injured=inj, people_affected=aff,
            houses_destroyed=hd, houses_damaged=hdmg,
            title=f"(demo) {hazard} event",
            source_url="",
        )
        score = sum(SEVERITY_WEIGHTS[k] * row[k] for k in SEVERITY_WEIGHTS)
        row["severity_score"] = round(score, 2)
        row["severity_class"] = severity_class(score)
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
                      "properties": row})

    PROCESSED.mkdir(parents=True, exist_ok=True)
    (PROCESSED / "events.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")

    # calendar.json from the same synthetic set
    from collections import defaultdict
    cal = defaultdict(lambda: {"count": 0, "score": 0.0, "by_hazard": defaultdict(int)})
    for f in feats:
        p = f["properties"]
        k = f'{p["year"]}-{p["month"]:02d}'
        cal[k]["count"] += 1
        cal[k]["score"] += p["severity_score"]
        cal[k]["by_hazard"][p["hazard"]] += 1
    (PROCESSED / "calendar.json").write_text(json.dumps(
        {k: {"count": v["count"], "score": round(v["score"], 1),
             "by_hazard": dict(v["by_hazard"])} for k, v in sorted(cal.items())}),
        encoding="utf-8")

    print(f"wrote {N} SYNTHETIC events -> {PROCESSED/'events.geojson'}")
    print("     (+ calendar.json)  — replace with real pipeline output")


if __name__ == "__main__":
    main()
