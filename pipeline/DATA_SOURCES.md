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

## Manual (3 files, one-time)

### 3. DesInventar Sentinel — Nepal
- Go to <https://www.desinventar.net/DesInventar/download_base.jsp>
- Country: **Nepal** (database code `npl`). Download the **XML** package
  (`DI_export_npl.xml`) — contains every recorded disaster since 1971 with
  district (`level1`), event type, deaths, missing, houses destroyed/damaged,
  affected.
- Save as `data/raw/desinventar_npl.xml`.
- Alternative: the online query tool → export to Excel; save as
  `data/raw/desinventar_npl.xlsx`.

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
