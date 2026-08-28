# Nepal Water & Slope Hazard Heatmap

Interactive map of landslides, floods, flash floods, GLOFs, debris flows and
avalanches that have affected Nepal over time — from small local incidents to
catastrophic events.

## Views

1. **Geographic density heatmap** — event concentration, weighted by a severity index.
2. **District choropleth** — event count / deaths per 100k population, by district.
3. **Year–month calendar heatmap** — seasonality (monsoon signal) and long-term trend.
4. **Time-animated hexbin** — spatial clustering played through the years.

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
python fetch_nasa_glc.py     # NASA GLC (optional; exits clean if endpoint down)
python clean_merge.py        # -> events.geojson (normalise, scope-filter, light dedup)
python aggregate.py          # -> events.geojson (coords+dedup), districts.geojson,
                             #    district_index.json, calendar.json

# current output: ~13,000 events, 1971-2026, from BIPAD + DesInventar.
# NASA GLC and HDX boundaries/population are optional add-ons (see DATA_SOURCES.md).
```

Then serve **from the repo root** (so `web/` can reach `data/`):

```bash
python -m http.server 8000
# open http://localhost:8000/web/
```

For GitHub Pages: push the repo, enable Pages on the root, visit `/web/`
(or move `web/` contents to root and point the data paths at `data/`).
