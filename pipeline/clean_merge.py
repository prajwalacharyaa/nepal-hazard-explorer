"""Normalise every raw source into the unified schema, dedupe, score severity.

Inputs  (whatever exists in data/raw/):
    bipad_incidents.json
    nasa_glc_nepal.geojson  OR  nasa_glc_nepal.csv
    desinventar_npl.xml     OR  desinventar_npl.xlsx
    emdat_npl.csv
    npl_adm2_districts.geojson   (for district-centroid fallback + district match)

Output:
    data/processed/events.geojson
    data/processed/unmapped_hazards.txt   (labels that fell through HAZARD_MAP)
"""
from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from datetime import datetime

import pandas as pd

from config import (
    RAW, PROCESSED, NEPAL_BBOX, HAZARD_MAP, KEEP_HAZARDS, SEVERITY_WEIGHTS,
    severity_class,
)

UNMAPPED: set[str] = set()


# ---------------------------------------------------------------- helpers ----
def norm_hazard(raw: str | None) -> str:
    if not raw:
        return "other"
    key = str(raw).strip().lower()
    if key in HAZARD_MAP:
        return HAZARD_MAP[key]
    # loose contains-match
    for k, v in HAZARD_MAP.items():
        if k in key:
            return v
    UNMAPPED.add(str(raw))
    return "other"


def in_nepal(lon, lat) -> bool:
    try:
        lon, lat = float(lon), float(lat)
    except (TypeError, ValueError):
        return False
    b = NEPAL_BBOX
    return b["min_lon"] <= lon <= b["max_lon"] and b["min_lat"] <= lat <= b["max_lat"]


def to_int(x):
    try:
        if x is None or (isinstance(x, float) and math.isnan(x)):
            return None
        return int(round(float(x)))
    except (TypeError, ValueError):
        return None


def parse_date(s):
    """Return (iso_date, precision, year, month)."""
    if not s:
        return None, None, None, None
    s = str(s)[:10]
    for fmt, prec in (("%Y-%m-%d", "day"), ("%Y-%m", "month"), ("%Y", "year")):
        try:
            d = datetime.strptime(s[: len(fmt.replace("%Y", "2000"))], fmt)
            return (
                d.strftime("%Y-%m-%d"),
                prec,
                d.year,
                d.month if prec != "year" else None,
            )
        except ValueError:
            continue
    return None, None, None, None


def blank_row() -> dict:
    return dict(
        id=None, source=None, date=None, date_precision=None, year=None, month=None,
        hazard=None, hazard_raw=None, district=None, lon=None, lat=None,
        geo_precision=None, deaths=None, missing=None, injured=None,
        people_affected=None, houses_destroyed=None, houses_damaged=None,
        title=None, source_url=None,
    )


# ---------------------------------------------------------------- BIPAD ------
def load_bipad() -> list[dict]:
    f = RAW / "bipad_incidents.jsonl"
    if not f.exists():
        print("  (skip) no bipad_incidents.jsonl")
        return []
    raw, seen = [], set()
    with f.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("id") in seen:          # resume overlap
                continue
            seen.add(rec.get("id"))
            raw.append(rec)
    rows = []
    for r in raw:
        pt = (r.get("point") or {}).get("coordinates") or [None, None]
        lon, lat = pt[0], pt[1]
        if not in_nepal(lon, lat):
            continue
        hz = r.get("hazard")
        hz_label = hz.get("title") if isinstance(hz, dict) else hz
        loss = r.get("loss") or {}
        iso, prec, yr, mo = parse_date(r.get("incidentOn") or r.get("reportedOn"))
        if iso is None:
            continue
        row = blank_row()
        row.update(
            id=f"bipad-{r.get('id')}",
            source="bipad",
            date=iso, date_precision=prec, year=yr, month=mo,
            hazard=norm_hazard(hz_label), hazard_raw=hz_label,
            lon=float(lon), lat=float(lat), geo_precision="exact",
            deaths=to_int(loss.get("peopleDeathCount")),
            missing=to_int(loss.get("peopleMissingCount")),
            injured=to_int(loss.get("peopleInjuredCount")),
            people_affected=to_int(loss.get("peopleAffectedCount")),
            houses_destroyed=to_int(loss.get("privateHouseFullyDamagedCount")),
            houses_damaged=to_int(loss.get("privateHousePartiallyDamagedCount")),
            title=r.get("title"),
            source_url=f"https://bipadportal.gov.np/incidents/{r.get('id')}",
        )
        rows.append(row)
    print(f"  bipad: {len(rows)} rows in Nepal bbox")
    return rows


# ------------------------------------------------------------- NASA GLC -----
def load_nasa() -> list[dict]:
    gj = RAW / "nasa_glc_nepal.geojson"
    csv = RAW / "nasa_glc_nepal.csv"
    rows = []
    if gj.exists():
        fc = json.loads(gj.read_text(encoding="utf-8"))
        recs = [
            {**feat.get("properties", {}),
             "_lon": feat["geometry"]["coordinates"][0],
             "_lat": feat["geometry"]["coordinates"][1]}
            for feat in fc.get("features", [])
            if feat.get("geometry")
        ]
    elif csv.exists():
        df = pd.read_csv(csv)
        df["_lon"] = df.get("longitude")
        df["_lat"] = df.get("latitude")
        recs = df.to_dict("records")
    else:
        print("  (skip) no NASA GLC file")
        return []

    for r in recs:
        lon, lat = r.get("_lon"), r.get("_lat")
        if not in_nepal(lon, lat):
            continue
        iso, prec, yr, mo = parse_date(
            r.get("event_date") or r.get("event_time") or r.get("date")
        )
        if iso is None:
            continue
        cat = r.get("landslide_category") or r.get("landslide_type") or "landslide"
        row = blank_row()
        row.update(
            id=f"nasa_glc-{r.get('event_id') or r.get('OBJECTID') or r.get('objectid')}",
            source="nasa_glc",
            date=iso, date_precision=prec, year=yr, month=mo,
            hazard=norm_hazard(cat), hazard_raw=cat,
            lon=float(lon), lat=float(lat), geo_precision="exact",
            deaths=to_int(r.get("fatality_count")),
            injured=to_int(r.get("injury_count")),
            title=r.get("event_title") or r.get("event_description"),
            source_url=r.get("source_link") or r.get("event_import_source"),
        )
        rows.append(row)
    print(f"  nasa_glc: {len(rows)} rows")
    return rows


# ---------------------------------------------------------- DesInventar -----
# DesInventar Sentinel export: <DESINVENTAR><fichas><TR>...</TR></fichas>.
# One <TR> per recorded disaster. Spanish-derived tag names. 182 MB for Nepal,
# so we stream it with iterparse. Geo is code-based (latitude/longitude are 0);
# real coordinates get filled from the bundled village/district shapefiles in
# aggregate.py.

def _desinv_date(y, m, d):
    if not y or int(y) == 0:
        return None, None, None, None
    y = int(y)
    m = int(m or 0)
    d = int(d or 0)
    if not (1 <= m <= 12):
        return f"{y:04d}-01-01", "year", y, None
    if not (0 <= d <= 31):
        d = 0
    if d == 0:
        return f"{y:04d}-{m:02d}-01", "month", y, m
    try:
        datetime(y, m, d)                       # validate real calendar date
        return f"{y:04d}-{m:02d}-{d:02d}", "day", y, m
    except ValueError:
        return f"{y:04d}-{m:02d}-01", "month", y, m


def load_desinventar() -> list[dict]:
    xml = RAW / "desinventar_npl.xml"
    if not xml.exists():
        print("  (skip) no desinventar_npl.xml — run fetch_desinventar.py")
        return []

    rows = []
    context = ET.iterparse(str(xml), events=("end",))
    for _, el in context:
        if el.tag != "TR":
            continue
        if el.find("evento") is None or el.find("fechano") is None:
            el.clear()
            continue

        def g(tag):
            t = el.findtext(tag)
            return t.strip() if t else None

        raw_evt = g("evento")
        hazard = norm_hazard(raw_evt)
        iso, prec, yr, mo = _desinv_date(g("fechano"), g("fechames"), g("fechadia"))
        if iso is None:
            el.clear()
            continue

        lvl2 = g("level2")
        district = (g("name1") or "").title() or None
        village = g("name2") or None

        row = blank_row()
        row.update(
            id=f"desinventar-{g('serial')}",
            source="desinventar",
            date=iso, date_precision=prec, year=yr, month=mo,
            hazard=hazard, hazard_raw=raw_evt,
            district=district,
            geo_precision="village_centroid" if lvl2 else "district_centroid",
            deaths=to_int(g("muertos")),
            missing=to_int(g("desaparece")),
            injured=to_int(g("heridos")),
            people_affected=to_int(g("afectados")) or to_int(g("damnificados")),
            houses_destroyed=to_int(g("vivdest")),
            houses_damaged=to_int(g("vivafec")),
            title=f"{raw_evt.title()} - {village or district or 'Nepal'}",
            source_url=f"https://www.desinventar.net/DesInventar/profiletab.jsp?countrycode=npl&serial={g('serial')}",
        )
        # geo codes for centroid resolution downstream (stripped after aggregate)
        row["_lvl1"] = g("level1")
        row["_lvl2"] = lvl2
        # research-useful extras, kept in the output
        row["place_detail"] = g("lugar")
        row["report_sources"] = g("fuentes")
        row["glide"] = g("glide")
        rows.append(row)
        el.clear()

    print(f"  desinventar: {len(rows)} rows streamed")
    return rows


# ---------------------------------------------------------------- dedupe ----
def haversine_km(a, b):
    (lon1, lat1), (lon2, lat2) = a, b
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def richness(row) -> int:
    return sum(
        1 for k in SEVERITY_WEIGHTS if row.get(k) not in (None, 0)
    )


def _merge_into(k, r):
    if richness(r) > richness(k):
        k.update({kk: r[kk] for kk in SEVERITY_WEIGHTS})
    k["source"] = "+".join(sorted(set(str(k["source"]).split("+")) | {r["source"]}))


def dedupe_exact(rows: list[dict]) -> list[dict]:
    """Conservative: only collapse near-certain double entries — same hazard,
    same exact date, same village/district, and identical headline losses.
    Cross-source spatial dedup happens later (aggregate.py) once every row
    has a real coordinate."""
    kept: list[dict] = []
    seen: dict[tuple, dict] = {}
    for r in rows:
        key = (
            r["hazard"], r["date"],
            r.get("_lvl2") or r.get("district") or "",
            r.get("deaths") or 0, r.get("houses_destroyed") or 0,
        )
        if key in seen and (r.get("_lvl2") or r.get("district")):
            _merge_into(seen[key], r)
            continue
        seen[key] = r
        kept.append(r)
    print(f"  dedupe_exact: {len(rows)} -> {len(kept)}")
    return kept


# ------------------------------------------------------------- severity -----
def score(row) -> float:
    s = 0.0
    for k, w in SEVERITY_WEIGHTS.items():
        v = row.get(k)
        if v:
            s += w * v
    return round(s, 3)


# ---------------------------------------------------------------- main ------
def main():
    PROCESSED.mkdir(parents=True, exist_ok=True)
    rows = load_bipad() + load_nasa() + load_desinventar()
    if not rows:
        raise SystemExit("no input rows — run the fetch scripts / add manual files first")

    before = len(rows)
    rows = [r for r in rows if r["hazard"] in KEEP_HAZARDS]
    print(f"  scope filter: {before} -> {len(rows)} (kept {sorted(KEEP_HAZARDS)})")

    rows = dedupe_exact(rows)
    for r in rows:
        r["severity_score"] = score(r)
        r["severity_class"] = severity_class(r["severity_score"])

    feats = []
    for r in rows:
        if r["lon"] is None or r["lat"] is None:
            # district-only rows get coordinates in aggregate.py; keep them but
            # mark geometry null for now
            geom = None
        else:
            geom = {"type": "Point", "coordinates": [r["lon"], r["lat"]]}
        feats.append({"type": "Feature", "geometry": geom, "properties": r})

    out = PROCESSED / "events.geojson"
    out.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"wrote {out}  ({len(feats)} events)")

    _write_calendar(rows)

    if UNMAPPED:
        (PROCESSED / "unmapped_hazards.txt").write_text(
            "\n".join(sorted(UNMAPPED)), encoding="utf-8"
        )
        print(f"  {len(UNMAPPED)} unmapped hazard labels -> unmapped_hazards.txt")


def _write_calendar(rows):
    """year-month aggregates — no geometry needed, so build it here."""
    from collections import defaultdict
    cal = defaultdict(lambda: {"count": 0, "score": 0.0, "by_hazard": defaultdict(int)})
    for r in rows:
        if not r.get("year") or not r.get("month"):
            continue
        k = f'{r["year"]}-{r["month"]:02d}'
        cal[k]["count"] += 1
        cal[k]["score"] += float(r.get("severity_score") or 0)
        cal[k]["by_hazard"][r["hazard"]] += 1
    out = {
        k: {"count": v["count"], "score": round(v["score"], 1),
            "by_hazard": dict(v["by_hazard"])}
        for k, v in sorted(cal.items())
    }
    (PROCESSED / "calendar.json").write_text(json.dumps(out), encoding="utf-8")
    print(f"wrote calendar.json  ({len(out)} year-months)")


if __name__ == "__main__":
    main()
