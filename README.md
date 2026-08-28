# Nepal Water & Slope Hazard Heatmap

Interactive map of landslides, floods, flash floods, GLOFs, debris flows and
avalanches that have affected Nepal over time — from small local incidents to
catastrophic events.

## Views

1. **Geographic density heatmap** — event concentration, weighted by a severity index.
2. **District choropleth** — event count / deaths per 100k population, by district.
3. **Year–month calendar heatmap** — seasonality (monsoon signal) and long-term trend.
4. **Time-animated hexbin** — spatial clustering played through the years.

Plus **find-your-area** tools (geolocation / district picker / map click), per-district
pages (`district.html?d=<slug>`), per-event permalinks (`event.html?id=<id>`), and an
**Experimental / research** section (`experimental.html`) — currently the seasonal
statistical outlook (Approach D); susceptibility (A), daily nowcast (C) and GLOF
what-if scenarios (B) are planned. The experimental layers are descriptive/modelled
context, **not** an operational warning system.

Full method, biases and citation: [`web/methodology.html`](web/methodology.html).
Licensing: code MIT ([`LICENSE`](LICENSE)), data per source
([`DATA_LICENSE.md`](DATA_LICENSE.md)).

## Stack

- **Pipeline:** Python (pandas, geopandas) — produces static GeoJSON/JSON.
- **Frontend:** MapLibre GL JS + deck.gl overlay, vanilla JS, no build step.
- **Basemap:** OpenFreeMap (free, no API key).
- **Hosting:** GitHub Pages (static).

No paid APIs, no access tokens.

## Data sources

| Source | Licence | Role |
|---|---|---|
| Nepal DRR Portal / BIPAD API | Open (GoN) | Geocoded incidents 2011–present |
| NASA Global Landslide Catalog (COOLR) | Public domain (NASA) | Landslide points 2007–2016, size class |
| DesInventar Sentinel — Nepal | CC BY (UNDRR) | District-level inventory 1971–present |
| Nepal admin boundaries (HDX COD-AB) | Open | District/province geometry |
| Nepal population (HDX COD-PS) | Open | Per-capita normalisation |

See `pipeline/schema.md` for the unified event schema and
`pipeline/DATA_SOURCES.md` for exact download steps.

## Build

```bash
cd pipeline
pip install -r requirements.txt

# quick look with fake data (no network needed):
python make_demo.py          # -> data/processed/events.geojson (SYNTHETIC)

# real build:
python fetch_bipad.py        # Nepal DRR/BIPAD API  -> bipad_incidents.jsonl (resumable)
python fetch_desinventar.py  # DesInventar Sentinel  -> desinventar_npl.xml + shapefiles
python fetch_boundaries.py   # HDX COD-AB -> npl_adm2_districts.geojson + npl_adm3_palikas.geojson
python fetch_nasa_glc.py     # NASA GLC (optional; exits clean if endpoint down)
python clean_merge.py        # -> events.geojson (normalise, scope-filter, light dedup)
python aggregate.py          # -> events.geojson (coords+dedup), districts.geojson,
                             #    district_index.json, palika_index.json, palikas.geojson,
                             #    calendar.json, events_by_district/, meta.json
python outlook.py            # -> outlook.json  (seasonal climatology for the
                             #    Experimental section — descriptive, not a forecast)
# impact corridors (downstream trace per significant event):
python fetch_rivers.py       # HydroRIVERS Asia -> hydrorivers_nepal.gpkg (~79 MB once)
python corridors.py          # -> corridors/<event id>.json + corridors_index.json

# experimental layers:
python glof.py               # -> glof.json            (curated dangerous_lakes.csv, §7)
python susceptibility.py     # -> susceptibility.json  (needs hazard rasters, §6)
python fetch_nowcast.py      # -> nowcast.json         (needs EARTHDATA_TOKEN, §8)

# current output: ~13,000 events, 1971-2026, from BIPAD + DesInventar.
# NASA GLC and HDX boundaries/population are optional add-ons (see DATA_SOURCES.md).
```

### Run it locally

```bash
python serve.py          # serves the repo root and opens the map for you
```

Or by hand — note it must be served **from the repo root**, so `web/` can reach
`data/`, and it must be over HTTP (opening `web/index.html` by double-clicking
gives a blank map, because the browser blocks a `file://` page from reading the
data):

```bash
python -m http.server 8000
# open http://localhost:8000/web/     <- not /  and not from inside web/
```

### Deploy to GitHub Pages

1. Push the repo to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, branch `main`, folder `/ (root)`.
3. Wait for the build, then open `https://<user>.github.io/<repo>/` — the root
   `index.html` redirects to `web/`, which loads data from `data/processed/`.

`.nojekyll` is committed so the static files are served as-is.
`data/raw/` (raw downloads, ~200 MB) is git-ignored and not deployed;
`data/processed/` (~10 MB, the site's data) is committed.

The footer of every page shows the data build date, event count, span and the
most recent recorded event (`data/processed/meta.json`).
