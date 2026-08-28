# Unified event schema

Every source is normalised into rows with these fields, then written as
`data/processed/events.geojson` (one Point feature per event).

| field | type | notes |
|---|---|---|
| `id` | string | `<source>-<native id>`, stable across rebuilds |
| `source` | string | `bipad` \| `nasa_glc` \| `desinventar` \| `emdat` |
| `date` | ISO date | `YYYY-MM-DD`; if only year/month known, day = 01 and `date_precision` says so |
| `date_precision` | string | `day` \| `month` \| `year` |
| `year` | int | convenience for filtering / calendar |
| `month` | int | 1–12 |
| `hazard` | string | normalised: `landslide` \| `flood` \| `flash_flood` \| `glof` \| `debris_flow` \| `avalanche` \| `other` |
| `hazard_raw` | string | original label from the source (audit trail) |
| `district` | string | matched to COD-AB district name; null if unmatched |
| `lon` `lat` | float | WGS84. If only district known → district centroid |
| `geo_precision` | string | `exact` \| `settlement` \| `district_centroid` |
| `deaths` | int | 0 if reported absent, null if unknown |
| `missing` | int | |
| `injured` | int | |
| `people_affected` | int | affected / displaced where available |
| `houses_destroyed` | int | |
| `houses_damaged` | int | |
| `severity_score` | float | see `config.py` — `SEVERITY_WEIGHTS` |
| `severity_class` | string | `minor` \| `small` \| `moderate` \| `major` \| `catastrophic` |
| `title` | string | short human description if the source gives one |
| `source_url` | string | link back to the record where possible |

## Dedup rule

Two rows are the same event when: same `hazard`, dates within 2 days, and
either same district or points within 5 km. Keep the row with the richer
casualty data (most non-null numeric fields); merge `source` into a list.
