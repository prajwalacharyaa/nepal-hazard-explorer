"""Back-test the terrain gates against the record, and fit them to it.

The risk check gates every hazard on terrain: flooding needs low ground,
landslides need slope, and so on. Those thresholds were a judgement call. This
asks the record whether they are right, and replaces them with coefficients
fitted to it.

Method, and its honest weaknesses:

  positives   locations of recorded events of one hazard type, exact
              coordinates only (centroid-placed records would teach the model
              the shape of village centroids, not of hazard)
  negatives   random points in Nepal with no recorded event of that hazard
              within a generous radius

  features    the same numbers the browser computes: height above nearest low
              ground, slope, steepest ground within 600 m, relief above,
              elevation. Read from the same SRTM tiles, so the fitted model and
              the live check cannot drift apart.

  model       logistic regression, standardised inputs, evaluated by AUC on a
              held-out split

The central weakness is the negatives: an absence of records is not proof that
nothing happened there, especially before ~2011 and away from roads. So this
learns "terrain where events get recorded" and that is not identical to
"terrain where events occur". Reported AUCs should be read with that in mind,
and the fitted gates are shipped as a cross-check on the hand-set ones rather
than as ground truth.

Inputs : data/processed/events.geojson
         data/raw/npl_adm/npl_admin0.geojson
Output : data/processed/risk_model.json
"""
from __future__ import annotations

import argparse
import json
import math
import random
from datetime import date

import numpy as np

import terrain
from config import RAW, PROCESSED

FEATURES = ["hand", "slope_deg", "steep_near", "relief_up", "elev"]
HAZARDS = ["landslide", "flood", "flash_flood", "debris_flow"]
NEG_CLEAR_KM = 5.0            # a negative must have no event of that type nearby
SEED = 20260829               # fixed, so a rebuild reproduces


def load_events():
    fc = json.loads((PROCESSED / "events.geojson").read_text(encoding="utf-8"))
    out = []
    for f in fc["features"]:
        p = f["properties"]
        if p.get("geo_precision") != "exact" or not f.get("geometry"):
            continue
        lon, lat = f["geometry"]["coordinates"]
        out.append((p["hazard"], float(lon), float(lat)))
    return out


def nepal_polygon():
    import geopandas as gpd
    g = gpd.read_file(RAW / "npl_adm" / "npl_admin0.geojson").to_crs(4326)
    return g.union_all() if hasattr(g, "union_all") else g.unary_union


def km(a, b):
    R = 6371.0
    dlat = math.radians(b[1] - a[1])
    dlon = math.radians(b[0] - a[0])
    s = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(a[1])) * math.cos(math.radians(b[1])) *
         math.sin(dlon / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(s))


def sample_negatives(poly, avoid, n, rng):
    from shapely.geometry import Point
    minx, miny, maxx, maxy = poly.bounds
    out, tries = [], 0
    while len(out) < n and tries < n * 200:
        tries += 1
        lon = rng.uniform(minx, maxx)
        lat = rng.uniform(miny, maxy)
        if not poly.contains(Point(lon, lat)):
            continue
        if any(km((lon, lat), a) < NEG_CLEAR_KM for a in avoid):
            continue
        out.append((lon, lat))
    return out


def featurise(points, label):
    """Terrain features for a list of (lon, lat). Drops points with no tile."""
    X, kept = [], []
    for i, (lon, lat) in enumerate(points):
        st = terrain.stats(lon, lat)
        if not st:
            continue
        X.append([st[f] for f in FEATURES])
        kept.append((lon, lat))
        if (i + 1) % 250 == 0:
            print(f"    {label}: {i + 1}/{len(points)}", flush=True)
    return np.array(X, dtype=float), kept


def fit(Xp, Xn):
    """Standardised logistic regression, with a held-out AUC."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import train_test_split
    from sklearn.preprocessing import StandardScaler

    X = np.vstack([Xp, Xn])
    y = np.concatenate([np.ones(len(Xp)), np.zeros(len(Xn))])
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.3,
                                          random_state=SEED, stratify=y)
    sc = StandardScaler().fit(Xtr)
    clf = LogisticRegression(max_iter=2000, C=1.0).fit(sc.transform(Xtr), ytr)
    auc = roc_auc_score(yte, clf.predict_proba(sc.transform(Xte))[:, 1])
    return {
        "auc": round(float(auc), 3),
        "n_positive": int(len(Xp)),
        "n_negative": int(len(Xn)),
        "mean": [round(float(v), 3) for v in sc.mean_],
        "scale": [round(float(v), 3) for v in sc.scale_],
        "coef": [round(float(v), 4) for v in clf.coef_[0]],
        "intercept": round(float(clf.intercept_[0]), 4),
    }


def describe(Xp, Xn):
    """Plain medians, so the fit can be sanity-checked without trusting it."""
    out = {}
    for i, f in enumerate(FEATURES):
        out[f] = {
            "median_at_events": round(float(np.median(Xp[:, i])), 1),
            "median_elsewhere": round(float(np.median(Xn[:, i])), 1),
        }
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--per-hazard", type=int, default=600,
                    help="max positive samples per hazard (default 600)")
    args = ap.parse_args()

    try:
        import sklearn  # noqa: F401
    except ImportError:
        raise SystemExit("needs scikit-learn: pip install scikit-learn")

    rng = random.Random(SEED)
    events = load_events()
    poly = nepal_polygon()
    print(f"{len(events)} exactly-located events")

    models, stats = {}, {}
    for hz in HAZARDS:
        pts = [(lon, lat) for h, lon, lat in events if h == hz]
        if len(pts) < 120:
            print(f"  {hz}: only {len(pts)} exact records — skipped")
            continue
        rng.shuffle(pts)
        pos = pts[:args.per_hazard]
        print(f"  {hz}: {len(pos)} positives")

        neg = sample_negatives(poly, pts, len(pos), rng)
        Xp, _ = featurise(pos, f"{hz}+")
        Xn, _ = featurise(neg, f"{hz}-")
        if len(Xp) < 100 or len(Xn) < 100:
            print(f"  {hz}: too few usable samples after terrain lookup")
            continue
        models[hz] = fit(Xp, Xn)
        stats[hz] = describe(Xp, Xn)
        print(f"    AUC {models[hz]['auc']}  "
              f"({models[hz]['n_positive']}+ / {models[hz]['n_negative']}-)")

    out = {
        "generated": date.today().isoformat(),
        "features": FEATURES,
        "method": ("Logistic regression on SRTM terrain features, positives = "
                   "exactly-located recorded events, negatives = random points "
                   f"in Nepal with no event of that hazard within {NEG_CLEAR_KM} km. "
                   "Held-out AUC on a 30% split."),
        "caveat": ("Absence of a record is not absence of hazard, so this learns "
                   "the terrain where events get RECORDED. Reporting is denser "
                   "near roads and since 2011. Treat the coefficients as a "
                   "cross-check on the hand-set gates, not as ground truth."),
        "neg_clear_km": NEG_CLEAR_KM,
        "seed": SEED,
        "models": models,
        "terrain_summary": stats,
    }
    dst = PROCESSED / "risk_model.json"
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nwrote risk_model.json ({dst.stat().st_size / 1024:.1f} KB)")
    for hz, m in models.items():
        print(f"  {hz:12s} AUC {m['auc']}")
        for f, c in zip(FEATURES, m["coef"]):
            s = stats[hz][f]
            print(f"      {f:11s} coef {c:+7.3f}   "
                  f"median at events {s['median_at_events']:>8}  "
                  f"elsewhere {s['median_elsewhere']:>8}")


if __name__ == "__main__":
    main()
