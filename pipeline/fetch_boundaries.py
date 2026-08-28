"""Download Nepal admin boundaries (COD-AB) and district population (COD-PS)
from HDX and stage the files aggregate.py needs.

Output: data/raw/npl_adm2_districts.geojson   (77 districts, adm2)
        data/raw/npl_adm3_palikas.geojson     (775 local units, adm3)
        data/raw/npl_adm/                      (full COD-AB extract)
        data/raw/npl_pop_adm2.csv             (COD-PS 2023, T_TL per district)

No key. HDX CKAN API is reachable from most networks.
"""
from __future__ import annotations

import io
import zipfile

import requests

from config import RAW

PKG = "https://data.humdata.org/api/3/action/package_show?id=cod-ab-npl"
PS_PKG = "https://data.humdata.org/api/3/action/package_show?id=cod-ps-npl"


def main():
    meta = requests.get(PKG, timeout=60).json()
    if not meta.get("success"):
        raise SystemExit("HDX package_show failed")
    url = next(r["url"] for r in meta["result"]["resources"]
              if r.get("format", "").upper() == "GEOJSON")
    print(f"downloading {url}")
    zf = zipfile.ZipFile(io.BytesIO(requests.get(url, timeout=300).content))

    outdir = RAW / "npl_adm"
    outdir.mkdir(parents=True, exist_ok=True)
    zf.extractall(outdir)
    print("  extracted:", ", ".join(zf.namelist()))

    (RAW / "npl_adm2_districts.geojson").write_bytes((outdir / "npl_admin2.geojson").read_bytes())
    (RAW / "npl_adm3_palikas.geojson").write_bytes((outdir / "npl_admin3.geojson").read_bytes())
    print("  -> npl_adm2_districts.geojson (77 districts)")
    print("  -> npl_adm3_palikas.geojson (775 municipalities)")

    # COD-PS: district population (latest adm2 CSV)
    try:
        ps = requests.get(PS_PKG, timeout=60).json()["result"]["resources"]
        url = sorted(
            (r for r in ps if r.get("format", "").upper() == "CSV"
             and "adm2" in r.get("name", "").lower()),
            key=lambda r: r.get("name", ""))[-1]["url"]
        RAW.joinpath("npl_pop_adm2.csv").write_bytes(requests.get(url, timeout=120).content)
        print(f"  -> npl_pop_adm2.csv  (from {url.rsplit('/', 1)[-1]})")
    except Exception as e:  # noqa: BLE001
        print(f"  ! population fetch failed ({e}) — deaths-per-100k will be disabled")


if __name__ == "__main__":
    main()
