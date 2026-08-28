"""Shared constants for the pipeline: hazard normalisation, severity model, paths."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"

# --- Nepal bounding box (rough, for sanity-filtering points) -----------------
NEPAL_BBOX = dict(min_lon=80.0, min_lat=26.3, max_lon=88.3, max_lat=30.5)

# --- Hazard label -> normalised category ------------------------------------
# Keys are lowercased, stripped source labels. Extend as new labels appear;
# unknown labels fall through to "other" and are logged by clean_merge.py.
HAZARD_MAP = {
    # landslide family
    "landslide": "landslide",
    "land slide": "landslide",
    "landslip": "landslide",
    "rockfall": "landslide",
    "rock fall": "landslide",
    "slope failure": "landslide",
    "mudslide": "debris_flow",
    "debris flow": "debris_flow",
    "debris flood": "debris_flow",
    # flood family
    "flood": "flood",
    "riverine flood": "flood",
    "inundation": "flood",
    "flash flood": "flash_flood",
    "flashflood": "flash_flood",
    "flash-flood": "flash_flood",
    "glof": "glof",
    "glacial lake outburst flood": "glof",
    "glacial lake outburst": "glof",
    # snow / ice
    "avalanche": "avalanche",
    "snow avalanche": "avalanche",
    "ice avalanche": "avalanche",
}

HAZARDS = ["landslide", "flood", "flash_flood", "glof", "debris_flow", "avalanche", "other"]

# --- Severity model --------------------------------------------------------
# severity_score = sum(weight * count) over the fields below.
SEVERITY_WEIGHTS = {
    "deaths": 5.0,
    "missing": 5.0,
    "injured": 1.0,
    "houses_destroyed": 0.2,
    "houses_damaged": 0.05,
    "people_affected": 0.002,
}

# score -> class (upper-exclusive breaks)
SEVERITY_BREAKS = [
    (0.0001, "minor"),      # score ~0: recorded incident, no measured loss
    (5, "small"),
    (25, "moderate"),
    (100, "major"),
    (float("inf"), "catastrophic"),
]


def severity_class(score: float) -> str:
    for upper, label in SEVERITY_BREAKS:
        if score < upper:
            return label
    return "catastrophic"
