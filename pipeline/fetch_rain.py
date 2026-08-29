"""Approach C (rev): recent rainfall from NASA GPM IMERG — the strongest live
predictor of landslides and flash floods.

The daily LHASA landslide nowcast was retired (GES DISC archive ends Feb 2021),
so instead we pull IMERG Late daily precipitation, which is genuinely current
(≈1 day latency), sum the last few days, and summarise it per district.

Needs an Earthdata login token in EARTHDATA_TOKEN, and a one-time click to
accept the "NASA GESDISC DATA ARCHIVE" EULA at
https://urs.earthdata.nasa.gov/profile → Applications.

Output: data/processed/rain.json
Exits 0 (never breaks the build) if the token is missing or the service refuses.
"""
from __future__ import annotations

import io
import json
import os
import sys
from datetime import date, timedelta

import numpy as np
import requests

from config import PROCESSED

TOKEN = os.environ.get("EARTHDATA_TOKEN", "").strip()
BASE = ("https://data.gesdisc.earthdata.nasa.gov/data/GPM_L3/GPM_3IMERGDL.07/"
        "{y}/{m:02d}/3B-DAY-L.MS.MRG.3IMERG.{y}{m:02d}{d:02d}-S000000-E235959.V07{rev}.nc4")
REVS = ("C", "B", "A")            # revision letter varies; try newest first
WINDOW_DAYS = 3
LOOKBACK = 7                      # how far back to hunt for the latest available day
NEPAL = dict(w=79.5, e=88.5, s=26.0, n=30.7)


class EarthdataSession(requests.Session):
    """requests drops the Authorization header on a cross-host redirect; GES DISC
    bounces through urs.earthdata.nasa.gov, so keep it for the NASA domains."""
    def rebuild_auth(self, prepared, response):
        super().rebuild_auth(prepared, response)
        host = requests.utils.urlparse(prepared.url).hostname or ""
        if host.endswith("earthdata.nasa.gov") or host.endswith("gesdisc.eosdis.nasa.gov"):
            prepared.headers["Authorization"] = f"Bearer {TOKEN}"


def fetch_day(sess, d):
    for rev in REVS:
        url = BASE.format(y=d.year, m=d.month, d=d.day, rev=rev)
        try:
            r = sess.get(url, timeout=180, allow_redirects=True)
        except requests.RequestException as e:
            print(f"  ! {d} {e.__class__.__name__}", file=sys.stderr)
            return None
        if r.status_code == 200 and r.content[:8]:
            return r.content
        if r.status_code == 403 and b"EULA" in r.content:
            print("  ! 403 EULA — accept 'NASA GESDISC DATA ARCHIVE' at "
                  "https://urs.earthdata.nasa.gov/profile", file=sys.stderr)
            raise SystemExit(0)
        if r.status_code not in (404,):
            print(f"  ! {d} rev {rev}: HTTP {r.status_code}", file=sys.stderr)
    return None


def read_precip(nc_bytes):
    """IMERG daily V07: variable 'precipitation' on a 0.1° lon/lat grid, mm/day."""
    import xarray as xr
    ds = xr.open_dataset(io.BytesIO(nc_bytes), engine="h5netcdf")
    var = "precipitation" if "precipitation" in ds else list(ds.data_vars)[0]
    da = ds[var].squeeze()
    # normalise dim order to (lat, lon)
    latn = "lat" if "lat" in da.dims else [d for d in da.dims if "lat" in d.lower()][0]
    lonn = "lon" if "lon" in da.dims else [d for d in da.dims if "lon" in d.lower()][0]
    da = da.transpose(latn, lonn)
    return da[latn].values, da[lonn].values, np.asarray(da.values, float)


def zonal(lats, lons, grid):
    """Mean & max mm over each district polygon (cell-centre test — 0.1° ≈ 11 km,
    fine for a rainfall readout)."""
    import geopandas as gpd
    from shapely.geometry import Point
    from shapely.prepared import prep

    src = PROCESSED / "districts_boundary.geojson"
    if not src.exists():
        src = PROCESSED / "districts.geojson"
    gdf = gpd.read_file(src).to_crs(4326)
    name_col = next((c for c in ("adm2_name", "district", "DIST_EN") if c in gdf.columns), None)

    # clip grid to Nepal
    la = (lats >= NEPAL["s"] - 0.2) & (lats <= NEPAL["n"] + 0.2)
    lo = (lons >= NEPAL["w"] - 0.2) & (lons <= NEPAL["e"] + 0.2)
    sub = grid[np.ix_(la, lo)]
    slat, slon = lats[la], lons[lo]
    pts = [(Point(x, y), sub[i, j])
           for i, y in enumerate(slat) for j, x in enumerate(slon)
           if np.isfinite(sub[i, j])]

    out = {}
    for row in gdf.itertuples():
        pg = prep(row.geometry)
        vals = [v for p, v in pts if pg.contains(p)]
        if not vals:
            # nearest cell as a fallback
            c = row.geometry.centroid
            k = min(range(len(pts)), key=lambda i: pts[i][0].distance(c))
            vals = [pts[k][1]]
        nm = str(getattr(row, name_col)).strip().title()
        out[nm] = (round(float(np.mean(vals)), 1), round(float(np.max(vals)), 1))
    return out


def main():
    if not TOKEN:
        print("EARTHDATA_TOKEN not set — skipping rainfall layer.", file=sys.stderr)
        _stub("No Earthdata token.")
        raise SystemExit(0)

    sess = EarthdataSession()
    sess.headers["Authorization"] = f"Bearer {TOKEN}"

    # find the most recent available day, then take the WINDOW_DAYS ending there
    latest = None
    for i in range(LOOKBACK):
        d = date.today() - timedelta(days=1 + i)
        b = fetch_day(sess, d)
        if b is not None:
            latest, first_bytes = d, b
            break
    if latest is None:
        print("no IMERG granule found in the lookback window", file=sys.stderr)
        _stub("IMERG service unreachable.")
        raise SystemExit(0)

    days = [latest - timedelta(days=k) for k in range(WINDOW_DAYS)]
    total = None
    lats = lons = None
    got = 0
    for d in days:
        nc = first_bytes if d == latest else fetch_day(sess, d)
        if nc is None:
            continue
        lats, lons, g = read_precip(nc)
        g = np.where(np.isfinite(g), g, 0.0)
        total = g if total is None else total + g
        got += 1
    if total is None:
        _stub("Could not read any IMERG file.")
        raise SystemExit(0)

    # 24h = latest day only; window = sum of the days we actually got
    _, _, g1 = read_precip(first_bytes)
    z24 = zonal(lats, lons, np.where(np.isfinite(g1), g1, 0.0))
    zwin = zonal(lats, lons, total)

    districts = {}
    for nm in zwin:
        districts[nm] = {"mm_24h": z24.get(nm, (0, 0))[0],
                         "mm_24h_max": z24.get(nm, (0, 0))[1],
                         "mm_win": zwin[nm][0],
                         "mm_win_max": zwin[nm][1]}
    wettest = sorted(districts, key=lambda k: districts[k]["mm_win_max"], reverse=True)

    out = {
        "as_of": latest.isoformat(),
        "generated": date.today().isoformat(),
        "window_days": got,
        "source": "NASA GPM IMERG Late daily precipitation (GES DISC)",
        "note": ("Recent rainfall, the main trigger for landslides and flash "
                 "floods. Not a hazard forecast — heavy rain does not always "
                 "produce an impact, and impacts occur without it."),
        "districts": districts,
        "wettest": wettest[:15],
        "max_mm_win": max((v["mm_win_max"] for v in districts.values()), default=0),
    }
    (PROCESSED / "rain.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"wrote rain.json  (as of {latest}, {got} day window, "
          f"wettest: {wettest[0]} {districts[wettest[0]]['mm_win_max']} mm)")


def _stub(why):
    (PROCESSED / "rain.json").write_text(
        json.dumps({"as_of": None, "unavailable": True, "note": why}), encoding="utf-8")


if __name__ == "__main__":
    main()
