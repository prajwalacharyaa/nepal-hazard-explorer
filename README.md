# Nepal Water & Slope Hazard Explorer

Every landslide, flood and avalanche recorded in Nepal since 1971 on one map,
plus a terrain-aware check that answers a narrower question: **is the specific
spot I'm standing on exposed?**

12,987 events. 10,847 dead, 3,886 missing. No API keys, no build step, no
server — the whole thing is static files on GitHub Pages.

**Not a warning system.** For official alerts use Nepal's
[DHM](https://www.dhm.gov.np/) and NDRRMA.

---

## Why this exists

Nepal's hazard record is public but scattered across two portals with different
schemas, different geographies and a fifteen-year overlap nobody de-duplicated.
Once it's merged you can ask better questions than "how many events" — which is
what the second half of this project is about.

The risk check is the part I'd point at. Most hazard maps colour a district and
stop. A district figure tells someone on a Kathmandu ridge exactly what it tells
someone on the Bagmati bank 3 km away, which is useless. This reads the actual
terrain under a point and asks whether each hazard can physically happen there:

| you are | flood risk | why |
|---|---|---|
| Bagmati bank, 12 m above the river | 26% | water only has to rise 12 m |
| Budhanilkantha ridge, 95 m above | **7%** | it doesn't reach you |

Same district. Same rainfall. Same records within 5 km.

---

## What's in the data

| | |
|---|---|
| Events | 12,987 (1971 – present) |
| Deaths / missing | 10,847 / 3,886 |
| Sources | BIPAD 6,683 · DesInventar 6,333 · curated 1 |
| Exactly located | 6,683 (51%) — the rest sit on a village or district centroid |
| Districts / municipalities | 77 / 753 |
| Downstream corridors traced | 4,617 |
| Routed release paths | 613 (164 glacial lakes, 449 dams/weirs/hydropower) |
| Glacial lakes with measured growth | 290 |

### Findings worth knowing before you use it

**The record only contains three hazard types.** The schema has seven. BIPAD and
DesInventar between them emit `landslide` (7,340), `flood` (5,490) and
`avalanche` (156) and nothing else — every GLOF, debris flow and flash flood in
Nepal's history is filed under "flood" or "landslide". The one `flash_flood` row
is a curated entry for the 2026 Langtang cascade. The UI now only shows filters
for what's actually present, but be aware the taxonomy is aspirational.

**Reporting coverage, not hazard, drives the trend.** Recorded events per year
roughly triples after 2011 when BIPAD came online. Any "hazards are increasing"
read of the raw counts is measuring the reporting system.

**Half the dataset can't be mapped precisely.** Every DesInventar record —
essentially everything before 2011 — is placed on a village or district
centroid. They render as hollow rings and carry half weight in the heat layer.
"Precise locations only" hides them.

**Melt-linked hazards are a *falling* share of the record** (4.0% in the 1970s,
0.6% in the 2020s) while the mountains warm 0.35 °C/decade and 51 of 290
measured glacial lakes grew >10% in six years. Both are true. The share falls
because flood and landslide reporting exploded while remote high-altitude events
stayed under-reported. The record cannot answer this question; the physics is
the better guide.

**The terrain gates hold up against the record, mostly.** Back-testing against
exactly-located events gives AUC 0.783 for landslide, 0.729 for flood. At
recorded flood sites the median height above nearest low ground is 172 m against
404 m at random points — which is what the gate assumes. `flash_flood` and
`debris_flow` can't be tested at all: zero exact records.

---

## Stack

Deliberately boring. Nothing here needs a bundler, a framework or a paid tier.

**Frontend** — vanilla ES2020, no build step. Open the files, they run.

| Library | Version | Used for |
|---|---|---|
| [MapLibre GL JS](https://maplibre.org/) | 4.7.1 | every map: heat, choropleth, corridors, the analysis mini-map |
| [deck.gl](https://deck.gl/) | 9.0.38 | the hexbin view only (`HexagonLayer`) |
| [D3](https://d3js.org/) | 7.9.0 | calendar heatmap, bar charts, elevation profiles. Scales and shapes, not the DOM |
| [Turf.js](https://turfjs.org/) | 7.1.0 | point-in-polygon, bbox, circle |
| [OpenFreeMap](https://openfreemap.org/) | positron | basemap tiles. Free, no key, no rate limit |
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | terrarium | SRTM elevation, read in the browser. Free, no key, CORS-enabled |

**Pipeline** — Python 3.12.

| Library | Used for |
|---|---|
| pandas / numpy | merge, de-duplicate, aggregate |
| GeoPandas / Shapely | spatial joins, clipping, centroids, river routing |
| pyproj | UTM 45N for anything measured in metres |
| xarray + netCDF4 / h5netcdf | IMERG rainfall and GISTEMP temperature grids |
| Pillow | decoding terrarium elevation PNGs |
| scikit-learn | the risk-model back-test (optional) |
| requests | every fetch |

**Hosting** — GitHub Pages, GitHub Actions for the daily and weekly refresh.

### Data sources

| Source | What | Licence |
|---|---|---|
| [BIPAD](https://bipadportal.gov.np) (Nepal DRR Portal) | incidents ~2011– with coordinates and losses | Government of Nepal, open |
| [DesInventar Sentinel](https://www.desinventar.net) (UNDRR) | national inventory 1971–2013 | UNDRR, open |
| [OCHA HDX](https://data.humdata.org/) | admin boundaries, 2023 population | CC-BY-IGO |
| [HydroRIVERS](https://www.hydrosheds.org/products/hydrorivers) | river network + flow topology | CC-BY 4.0 |
| [NASA GPM IMERG](https://disc.gsfc.nasa.gov/) | daily rainfall | Public domain (Earthdata login) |
| [NASA GISTEMP](https://data.giss.nasa.gov/gistemp/) | observed warming | Public domain |
| [HMA Glacial Lake Inventory](https://zenodo.org/records/17948783) | lake extents 2016–17 and 2022–24 | CC-BY 4.0 |
| [OpenStreetMap](https://www.openstreetmap.org/) | dams, weirs, hydropower | ODbL |
| AWS Terrain Tiles | SRTM elevation | Public domain |

Full attribution: [DATA_LICENSE.md](DATA_LICENSE.md).

---

## How the risk check works

Four things, in order:

1. **Terrain.** Sample SRTM over a 4 km box around the point. Compute height
   above nearest low ground (HAND), slope, steepest ground within 600 m, and
   relief above. A second coarse sample over 18 km asks whether there's snow or
   ice in the catchment at all.

2. **Gate each hazard on that terrain.** Flooding falls off past ~20 m of HAND
   and is near zero past 55 m. Landslides need slope. Debris flows need both a
   channel position and relief above. Avalanches need altitude. Nearby recorded
   events only count *after* their hazard clears the gate — otherwise a Kathmandu
   ridge inherits the whole valley's flood history.

3. **Route sudden releases instead of buffering them.** A radius around a glacial
   lake can't tell you anything: water follows channels. `surge_paths.py` walks
   HydroRIVERS downstream from every lake, dam, weir and hydropower plant and
   stores the actual path plus a travel-time estimate. The check then asks how
   far you are from that *route* and how high above that *channel* — both must
   pass. Front speeds come out at 4–8 m/s in the steep upper reaches, which
   matches documented GLOF fronts.

4. **Modifiers.** Recent IMERG rainfall multiplies what's already plausible
   rather than counting as risk on its own. Warming lifts only melt-driven
   mechanisms, and only where there's ice above. An active post-event alert
   raises a floor for a few weeks, then decays and expires by itself.

Every number shown says where it came from. Details and limitations:
[methodology.html](methodology.html).

---

## Repo layout

```
pipeline/          Python. Each script does one thing and writes JSON/GeoJSON.
  config.py          hazard mapping, severity model, paths
  fetch_*.py         one per source
  clean_merge.py     normalise, scope-filter, de-duplicate
  aggregate.py       roll up to districts, municipalities, calendar
  corridors.py       downstream corridor per significant event
  surge_paths.py     routes a lake/dam release would take
  glacial_lakes.py   HMA inventory -> lakes with measured growth
  climate_context.py GISTEMP warming, freezing-level shift
  active_alerts.py   decaying post-event alerts (run daily)
  terrain.py         SRTM tiles, same maths as the browser
  calibrate.py       back-tests the terrain gates
  checks.py          data sanity assertions, runs in CI

*.html *.js        Static frontend at the repo root, so the site is served
style.css          from / with no redirect. No build step.
  index.html/app.js    the map, filters, area cards, risk analysis
  common.js            design tokens, shared helpers, window.NHM
  impact.html/.js      one event: corridor, flow animation, downstream units
  district.html/.js    one district
  event.html/.js       one record
  experimental.html    modelled layers, walled off behind a disclaimer
  methodology.html     how everything is built, and what it can't do

data/raw/          Gitignored. Re-fetchable downloads + caches.
data/processed/    Committed. This is what the site loads, and it doubles as
                   the API — every file is a plain static JSON/GeoJSON.
```

---

## Running it

```bash
git clone https://github.com/<you>/nepal-hazard-explorer.git
cd nepal-hazard-explorer
python serve.py            # http://localhost:8000/
```

`data/processed/` is committed, so this works immediately with no pipeline run.

It has to be served over HTTP. Opening `index.html` from the filesystem gives a
blank map, because the browser blocks a `file://` page from reading `data/`
alongside it.

### Rebuilding the data

```bash
pip install -r pipeline/requirements.txt
cd pipeline

python fetch_bipad.py            # ~5 min, paginated API
python fetch_desinventar.py      # static zip
python fetch_boundaries.py       # HDX admin boundaries + population
python clean_merge.py            # -> events.geojson
python aggregate.py              # -> districts, municipalities, calendar, meta

# optional, in dependency order
python fetch_rivers.py           # HydroRIVERS Asia, ~79 MB, once
python corridors.py              # per-event downstream corridors
python glacial_lakes.py          # needs the HMA inventory, see DATA_SOURCES §9
python surge_paths.py            # release routes (--refresh refetches OSM dams)
python climate_context.py        # GISTEMP warming
python active_alerts.py          # decaying alerts (the daily Action runs this)
python calibrate.py              # risk-model back-test, needs scikit-learn
python outlook.py glof.py        # experimental layers
```

Everything is deterministic — stable sort keys, fixed seeds, rounded
coordinates — so a rebuild on unchanged inputs is byte-identical. `checks.py`
asserts the invariants and runs in CI.

Two stages need credentials or a manual download:

- `fetch_rain.py` needs a free [Earthdata](https://urs.earthdata.nasa.gov/)
  token in `EARTHDATA_TOKEN` **and** a one-time click accepting the "NASA GESDISC
  DATA ARCHIVE" EULA on your profile page. Copy `.env.example` to `.env` and put
  the token there.

  It's the only credential in the project, and it feeds exactly one file,
  `rain.json`. Without it you lose the rainfall section of the alerts panel, the
  "Rain now" chip, the rain term in the risk score, and experimental section C.
  Everything else — map, districts, corridors, impact views, terrain analysis,
  GLOF and dam routing, alerts, climate — works with no credentials.

  A committed `rain.json` older than 5 days is dropped rather than shown, so a
  deploy without the token (or a job that quietly stops) degrades to "not
  configured" instead of presenting last month's rain as today's.
- `glacial_lakes.py` needs the HMA inventory shapefiles downloaded once
  (~300 MB). See [pipeline/DATA_SOURCES.md](pipeline/DATA_SOURCES.md) §9.

---

## Deploying

See **[DEPLOY.md](DEPLOY.md)** for the full walkthrough: repo settings, Pages,
secrets, and the Actions permissions the scheduled jobs need.

Short version: push it, turn on Pages from `main` / root, done. The site is
static and `.nojekyll` is committed so `data/` is served as-is.

---

## Using the data

Everything under `data/processed/` is a plain static file with CORS from Pages,
so it works as a read-only API:

```
events.geojson                     every event, one Point each
districts.geojson                  district polygons + rollups
events_by_district/<slug>.json     one district's events
district_index.json                per-district totals
calendar.json                      year-month counts
surge_paths.json                   routed release paths
glacial_lakes.json                 lakes + measured 2016->2022 growth
climate_context.json               warming, freezing level, lake trend
active_alerts.json                 currently-active alerts (self-expiring)
risk_model.json                    terrain-gate back-test
meta.json                          build date, counts, span
```

The map's download button exports the current filter as CSV + GeoJSON.

---

## Known limitations

- **SRTM is 30 m and from 2000.** It cannot see embankments, flood walls, river
  training or anything built since. A spot the model calls low may be protected.
- **Absence of a record is not absence of hazard.** Reporting is denser near
  roads and since 2011.
- **Corridors show a route, not a width.** No open dataset records the true
  inundation extent of Nepal's historical events.
- **Travel times estimate the front, not the peak,** and ignore storage, breach
  growth and real channel roughness. Read them as "tens of minutes".
- **The dedup is a heuristic** (same hazard within 2 days and 5 km). It will
  occasionally merge two genuinely distinct events.
- **No ward-level geography exists** as open data, so municipality is as fine
  as it gets.
- **Casualty figures for recent events move for weeks.**

---

## Contributing

Useful things, roughly in order:

- A landslide susceptibility raster (slope + lithology + rainfall) would replace
  the hand-set slope thresholds with something calibrated.
- Better hazard labels. Re-classifying the "flood" pile into flash flood / GLOF /
  debris flow using event titles and dates would unlock three empty categories.
- DEM-based inundation routing to give corridors a real width.
- Nepali-language UI.

Run `python pipeline/checks.py` before opening a PR.

---

## Licence

Code MIT ([LICENSE](LICENSE)). Data belongs to the original providers, listed in
[DATA_LICENSE.md](DATA_LICENSE.md) — attribution requirements vary by source.

### Citation

```
Nepal Water & Slope Hazard Explorer (2026). Compiled hazard-event dataset for
Nepal, 1971–present, from Nepal DRR/BIPAD and UNDRR DesInventar Sentinel, with
administrative and population data from OCHA HDX. Accessed <date>. <URL>
```
