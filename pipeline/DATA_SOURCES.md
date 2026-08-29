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

### 4. Nepal administrative boundaries (COD-AB)  — HDX, scriptable
- Package: <https://data.humdata.org/dataset/cod-ab-npl> (CKAN API is reachable).
- Download `npl_admin_boundaries.geojson.zip`, extract:
  - `npl_admin2.geojson` (77 districts) → `data/raw/npl_adm2_districts.geojson`
  - `npl_admin3.geojson` (775 local units / palikas) → `data/raw/npl_adm3_palikas.geojson`
- `aggregate.py` prefers these over the bundled DesInventar shapefile and uses
  fields `adm2_name` / `adm3_name` / `adm3_pcode`.
- **No adm4 (ward) polygons exist in any open Nepal dataset.** Municipality
  (adm3) is the drill-down floor; BIPAD ward *numbers* live in the event titles.
- `aggregate.py` also writes simplified `data/processed/districts_boundary.geojson`
  and `palikas.geojson` for the web map.

### 5. Nepal district population (COD-PS)
- HDX: <https://data.humdata.org/dataset/cod-ps-npl> (2021 census).
- Download the district-level CSV. Save as `data/raw/npl_pop_adm2.csv`.
- Needs columns: district name + total population. Map them in `aggregate.py`.

## Optional

### EM-DAT (major-disaster cross-check)
- Free account: <https://public.emdat.be/>
- Query country = Nepal, disaster types = Flood, Landslide, Mass movement.
- Export CSV → `data/raw/emdat_npl.csv`.

## 6. Hazard-model rasters — Approach A  (`susceptibility.py`)

Both are large global grids. Download once, clip to Nepal, drop in `data/raw/`.
`susceptibility.py` then produces the small `susceptibility.json`.

### 6a. NASA Global Landslide Susceptibility (Stanley & Kirschbaum 2017)
- Resource Watch: <https://resourcewatch.org/data/explore/dis007-Landslide-Susceptibility>
  → Download → GeoTIFF. (Background: <https://gpm.nasa.gov/landslides/projects.html>)
- Classes 1–5 (very low … very high), ~1 km.
- Clip and save:
  ```
  gdalwarp -te 80 26 89 31 -t_srs EPSG:4326 \
      landslide_susceptibility_global.tif data/raw/landslide_susceptibility.tif
  ```

### 6b. 100-year river-flood hazard
Pick one:
- **JRC Global Flood Hazard, RP100**:
  <https://data.jrc.ec.europa.eu/dataset/jrc-floods-floodmapgl_rp100y-tif>
  Download the 10°×10° tiles covering Nepal (lon 80–89 E, lat 26–31 N), mosaic them:
  ```
  gdalbuildvrt fl.vrt ID*_N*_E8*.tif
  gdalwarp -te 80 26 89 31 fl.vrt data/raw/flood_hazard.tif
  ```
- **WRI Aqueduct Floods (riverine, 1/100, baseline)** — single global file, lighter:
  `http://wri-projects.s3.amazonaws.com/AqueductFloodTool/download/v2/inunriver_historical_000000000WATCH_1980_rp00100.tif`
  ```
  gdalwarp -te 80 26 89 31 inunriver_historical_..._rp00100.tif data/raw/flood_hazard.tif
  ```
- Pixel value must be water depth in metres (both of the above are).

`gdalwarp` / `gdalbuildvrt` come with the `rasterio` install (GDAL) or conda's
`gdal` package.

## 7. Curated events — `data/raw/manual_events.csv`  (tracked in git)

For major disasters that the automated sources miss or lag on (BIPAD can take
days to weeks to enter a big event). One row per event; columns:

`id, date, date_precision, hazard, district, lon, lat, geo_precision, deaths,
missing, injured, people_affected, houses_destroyed, houses_damaged, title,
source_url, report_sources, glide, notes`

`clean_merge.py` reads it automatically (`source = manual`). When the automated
source later catches up, `aggregate.py`'s spatial dedup merges the two and keeps
the richer record. Currently holds the 2026-08-26 Langtang / Rasuwa cascade
(ice-rock avalanche → river-dam breach → debris flow → flash flood).

## 8. Recent rainfall — Approach C  (`fetch_rain.py`)

NASA GPM **IMERG Late daily** precipitation, collection `GPM_3IMERGDL.07`
(GES DISC) — ~0.1°, global, mm/day, about 12–18 h latency. The script pulls the
last few available days, sums them, and writes per-district 24 h / window
totals. This replaces the NASA **LHASA** landslide nowcast, whose GES DISC
archive was retired (ends February 2021) — there is no free live successor.

1. Create an Earthdata login: <https://urs.earthdata.nasa.gov/>
2. Generate a token: profile → **Generate Token**.
3. **Accept the EULA**: same profile page → *Applications* → approve
   **"NASA GESDISC DATA ARCHIVE"**. Without this the download 403s.
4. Local run: `EARTHDATA_TOKEN=<token> python pipeline/fetch_rain.py`
   (needs `xarray` + `h5netcdf` to read the `.nc4` files).
5. CI: add the token as repo secret **`EARTHDATA_TOKEN`**. The
   `.github/workflows/rain.yml` Action then runs daily (07:40 UTC), writes
   `data/processed/rain.json`, and commits it.

Without a token (or EULA) the script exits cleanly and both the Alerts panel and
the experimental "C" section show a "not configured" message. Dataset page:
<https://disc.gsfc.nasa.gov/datasets/GPM_3IMERGDL_07/summary>
(the granule revision letter V07A/B/C varies by date; `fetch_rain.py` tries
newest first).

## 9. Glacial lake inventory — `glacial_lakes.py`

Open High Mountain Asia inventory, Zenodo record **17948783** (CC-BY-4.0),
which publishes median lake extents for **2016–2017** and **2022–2024**.
Download these eight files into `data/raw/hma_lakes/`:

```
Glacial_lakes_2016_2017_median.{shp,shx,dbf,prj}
Glacial_lakes_2022_2024_median.{shp,shx,dbf,prj}
```

from `https://zenodo.org/api/records/17948783/files/<name>/content`
(~300 MB total; `data/raw/` is gitignored, so this is a one-time local fetch).

`glacial_lakes.py` clips both epochs to Nepal, matches lakes **spatially**
(published ids are centroid-derived and shift as a lake grows), and writes
`glacial_lakes.json`: 306 lakes at or above 0.05 km² and 3500 m, of which 159
are large enough to route downstream. Growth is measured for 290 of them — 51
grew more than 10% between the epochs, 4 shrank, median +1.7%.

`surge_paths.py` picks the routable ones up automatically.

## 10. Terrain — `terrain.py`

SRTM elevation from the AWS "terrarium" tiles (public domain, no key, CORS
enabled), cached under `data/raw/terrain_tiles/`. The browser reads the same
tiles with the same encoding, so pipeline and frontend cannot drift apart —
verified: Kathmandu ridge reads 1448 m / 95 m above low ground / 5.25° in both.

## 11. Risk-model back-test — `calibrate.py`

Fits the terrain gates to the record: positives are exactly-located events,
negatives are random Nepal points with no event of that hazard within 5 km,
features are the five terrain numbers. Logistic regression, held-out AUC.
Needs `scikit-learn`. Output `risk_model.json` is a **cross-check** on the
hand-set thresholds, not a replacement — absence of a record is not absence of
hazard, so it learns where events get *recorded*.
