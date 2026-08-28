"""Download the DesInventar Sentinel export for Nepal.

DesInventar publishes a static per-country zip. No key, no manual export needed.

Output: data/raw/desinventar_npl.xml   (the <fichas> disaster records)
        data/raw/desinventar_npl_regions.xml  (level lookup, if present)
"""
from __future__ import annotations

import io
import sys
import zipfile

import requests

from config import RAW

URL = "https://www.desinventar.net/DesInventar/download/DI_export_npl.zip"


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    print(f"downloading {URL}")
    r = requests.get(URL, timeout=120)
    r.raise_for_status()
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    print("  archive members:", zf.namelist())

    shapes = RAW / "desinventar_shapes"
    shapes.mkdir(exist_ok=True)

    for name in zf.namelist():
        low = name.lower()
        data = zf.read(name)
        if low.endswith(".xml"):
            (RAW / "desinventar_npl.xml").write_bytes(data)
            print(f"  -> desinventar_npl.xml  ({len(data):,} bytes) from {name}")
        elif low.endswith((".shp", ".dbf", ".shx", ".prj")):
            # village.shp / district.shp / regions.shp — used by aggregate.py to
            # resolve DesInventar level codes to real coordinates.
            (shapes / name.split("/")[-1]).write_bytes(data)
            print(f"  -> desinventar_shapes/{name.split('/')[-1]}  ({len(data):,} bytes)")

    if not (RAW / "desinventar_npl.xml").exists():
        print("  ! could not identify the main data XML — inspect the members above",
              file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
