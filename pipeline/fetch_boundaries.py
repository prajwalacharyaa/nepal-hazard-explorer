"""Download Nepal admin boundaries (COD-AB) from HDX and stage the layers
aggregate.py needs.

Output: data/raw/npl_adm2_districts.geojson   (77 districts, adm2)
        data/raw/npl_adm3_palikas.geojson     (775 local units, adm3)
        data/raw/npl_adm/                      (full extract, all levels)

No key. HDX CKAN API is reachable from most networks.
"""
from __future__ import annotations

import io
import zipfile

import requests

from config import RAW

PKG = "https://data.humdata.org/api/3/action/package_show?id=cod-ab-npl"


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


if __name__ == "__main__":
    main()
