# Data sources and licensing

The compiled dataset in `data/processed/` is derived from the sources below.
Each retains its own licence and terms. When you reuse the compiled data,
attribute the original providers and cite this project as the compilation.

| Source | Used for | Licence / terms |
|---|---|---|
| **Nepal Disaster Risk Reduction Portal / BIPAD** (Government of Nepal) — <https://bipadportal.gov.np> | Incident records 2011–present (points, casualties, losses) | Open government data. Attribute "Government of Nepal, BIPAD Portal". |
| **DesInventar Sentinel — Nepal** (UNDRR) — <https://www.desinventar.net> | Disaster inventory 1971–2013 (district / village level); bundled village & district shapefiles | CC BY 3.0 IGO. Attribute "UNDRR DesInventar Sentinel". |
| **OCHA Humanitarian Data Exchange — Nepal COD-AB & COD-PS** — <https://data.humdata.org> | Modern admin boundaries (77 districts, 775 municipalities); 2023 district population | CC BY 3.0 / CC BY-IGO (per dataset page). Attribute "OCHA / Survey Department of Nepal". |
| **NASA Global Landslide Susceptibility** (Stanley & Kirschbaum 2017) — via Resource Watch | Experimental layer A (landslide susceptibility) | Public domain (US Government work). Cite the paper: doi:10.1007/s11069-017-2757-y. |
| **OpenStreetMap** (dams, weirs, hydropower; via Overpass) | Surge-path sources in `surge_paths.py` | ODbL 1.0. © OpenStreetMap contributors. |
| **NASA SRTM via AWS Terrain Tiles** | Client-side elevation for the risk check | Public domain (NASA/USGS); tiles courtesy of the AWS Open Data registry. |
| **NASA GPM IMERG Late daily precipitation** (GES DISC) | Experimental layer C + Alerts panel (recent rainfall) | Public domain (NASA). Cite Huffman et al., GPM IMERG V07. Earthdata login + GES DISC EULA required to download. |
| **JRC Global Flood Hazard** / **WRI Aqueduct Floods** | Experimental layer A (flood exposure) | JRC: CC BY 4.0. Aqueduct: CC BY 4.0. |
| **ICIMOD / UNDP** — Potentially Dangerous Glacial Lakes inventory 2020; Bajracharya et al.; Mool et al. 2001 | Experimental layer B (`dangerous_lakes.csv`) | ICIMOD data terms (attribution, non-commercial research use). Coordinates in `dangerous_lakes.csv` are approximate and hand-compiled from the literature. |
| **Curated major events** (`data/raw/manual_events.csv`) | Filling reporting lag for headline disasters (e.g. 2026-08-26 Langtang) | Compiled by this project from USGS, UN OCHA and news reporting; figures provisional. |
| Basemap tiles — **OpenFreeMap / OpenMapTiles / OpenStreetMap** | Web map background | ODbL (OpenStreetMap). |

## How to cite

> Nepal Water & Slope Hazard Explorer (2026). Compiled hazard-event dataset for
> Nepal, 1971–present, from Nepal DRR/BIPAD and UNDRR DesInventar Sentinel, with
> administrative and population data from OCHA HDX. Accessed <date>. <URL>

For a single event use the citation string shown on its `event.html` page.

## Not authoritative

These figures are as recorded by the original sources and are **not**
independently verified. Location precision varies (see `methodology.html`).
For official hazard information and warnings use Nepal's Department of
Hydrology and Meteorology (DHM) and the National Disaster Risk Reduction and
Management Authority (NDRRMA).
