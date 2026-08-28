# Data sources — exact steps

## Automated (scripts)

### 1. Nepal BIPAD / DRR Portal  — `fetch_bipad.py`
- API: `https://bipadportal.gov.np/api/v1/incident/`
- No key. Paginated. Covers ~2011–present, point geometry, `loss` block with
  deaths / missing / injured / affected / houses.
- After running, read `data/raw/bipad_hazards.json` and add any unseen hazard
  labels to `HAZARD_MAP` in `config.py`.

### 2. NASA Global Landslide Catalog / COOLR  — `fetch_nasa_glc.py`  *(OPTIONAL)*
- NASA keeps moving this endpoint; the script tries an ArcGIS FeatureServer and
  exits cleanly if it 404s/503s. BIPAD already covers landslides 2011–present,
  so this source only adds ~2007–2016 depth.
- Manual route: open <https://landslides.nasa.gov/viewer> → **Download** → CSV,
  filter/clip to Nepal, save as `data/raw/nasa_glc_nepal.csv`.
- Useful fields: `landslide_category`, `landslide_trigger`, `landslide_size`
  (small…catastrophic), `fatality_count`, `injury_count`, `source_name`.
- `clean_merge.py` reads `nasa_glc_nepal.geojson` **or** `nasa_glc_nepal.csv`.

### 3. DesInventar Sentinel — Nepal  — `fetch_desinventar.py`  *(now automated)*
- Pulls the static country zip
  <https://www.desinventar.net/DesInventar/download/DI_export_npl.zip>
  (~13 MB) — no manual export, no key.
- Extracts `desinventar_npl.xml` (182 MB, every recorded disaster 1971–2013,
  district + village level: deaths, missing, injured, affected, houses
  destroyed/damaged, GLIDE, report sources) plus the bundled
  `village.shp` / `district.shp` used to turn DesInventar level codes into
  real coordinates.
- Streamed with `iterparse` in `clean_merge.py` (file is too big for `ET.parse`).

## Manual (optional — improve resolution, not required to build)

### 4. Nepal administrative boundaries (COD-AB)
- HDX: <https://data.humdata.org/dataset/cod-ab-npl>
- Download the **district** layer (`adm2`) and **province** layer (`adm1`) as
  GeoJSON (or the shapefile / gpkg).
- Save as `data/raw/npl_adm2_districts.geojson` and
  `data/raw/npl_adm1_provinces.geojson`.
- Note the district name field (usually `DIST_EN` / `ADM2_EN`) — set it in
  `aggregate.py` if it differs.

### 5. Nepal district population (COD-PS)
- HDX: <https://data.humdata.org/dataset/cod-ps-npl> (2021 census).
- Download the district-level CSV. Save as `data/raw/npl_pop_adm2.csv`.
- Needs columns: district name + total population. Map them in `aggregate.py`.

## Optional

### EM-DAT (major-disaster cross-check)
- Free account: <https://public.emdat.be/>
- Query country = Nepal, disaster types = Flood, Landslide, Mass movement.
- Export CSV → `data/raw/emdat_npl.csv`.
