# Deploying

Everything from an empty GitHub account to a live site with the scheduled jobs
running. Should take about ten minutes.

---

## 1. Create the repository

**Suggested name:** `nepal-hazard-explorer`

Short, says what it is, and reads well in the Pages URL
(`<you>.github.io/nepal-hazard-explorer/`). Alternatives if it's taken:
`nepal-hazard-map`, `npl-hazard-explorer`.

**Description** (paste into the About box):

> Every landslide, flood and avalanche recorded in Nepal since 1971, mapped —
> with a terrain-aware risk check for any location. Static site, no API keys.

**Topics** (helps people find it):

```
nepal  disaster-risk-reduction  landslides  floods  glof  hazard-mapping
open-data  maplibre  geospatial  gis  python  data-journalism  static-site
```

**Settings when creating:**

- Public
- Do **not** add a README, .gitignore or licence — they're already in the repo

---

## 2. Push

The repo has no remote yet. From the project root:

```bash
git remote add origin https://github.com/<you>/nepal-hazard-explorer.git
git branch -M main
git push -u origin main
```

### Before you push, check

`data/raw/` is gitignored and should stay that way — it holds ~500 MB of
re-fetchable downloads (HydroRIVERS, the HMA lake shapefiles, GISTEMP, cached
terrain tiles). Confirm nothing large slipped through:

```bash
git count-objects -vH | grep size-pack        # expect well under 100 MB
git ls-files -s | awk '{print $4}' | xargs -I{} du -k "{}" 2>/dev/null \
  | sort -rn | head -5                        # largest tracked files
```

`data/processed/` **is** committed on purpose — about 39 MB across 4,700 files,
mostly per-event corridor JSON. That's what makes the site work with no server
and no pipeline run. It's within GitHub's limits but it does make the first
clone slow; that's the trade.

Also confirm your `.env` is not tracked. It holds a real Earthdata token:

```bash
git check-ignore .env && echo "ignored, good"
```

---

## 3. Turn on Pages

**Settings → Pages**

- Source: **Deploy from a branch**
- Branch: `main`, folder: **`/ (root)`**
- Save

Wait a minute, then open:

```
https://<you>.github.io/nepal-hazard-explorer/
```

The frontend lives at the repo root, so that URL *is* the site — no `/web/`, no
redirect. `.nojekyll` is already committed, which is what stops Jekyll from
skipping the data directory.

---

## 4. Actions permissions

The scheduled jobs commit refreshed data back to the repo, so they need write
access.

**Settings → Actions → General → Workflow permissions**

- Select **Read and write permissions**
- Save

Without this the daily job runs, produces the right files, and fails on `git
push` with a 403.

---

## 5. Secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Value | Needed for |
|---|---|---|
| `EARTHDATA_TOKEN` | your NASA Earthdata bearer token | the rainfall layer only |

Get a token at <https://urs.earthdata.nasa.gov/profile> → *Generate Token*.

**You must also accept the EULA** on that same profile page: *Applications* →
approve **"NASA GESDISC DATA ARCHIVE"**. Without it the download returns 403 and
the rainfall panel stays on "not configured". Everything else still works.

No other secrets. Nothing else in the project needs a key.

---

## 6. What runs, and when

| Workflow | Schedule | Does |
|---|---|---|
| `checks.yml` | every push / PR | data sanity assertions |
| `daily.yml` | 07:40 UTC daily | IMERG rainfall + refresh active alerts |
| `refresh.yml` | Mondays 05:00 UTC | re-fetch BIPAD, rebuild the dataset |

`active_alerts.json` needs the daily run: alerts step down high → elevated →
watch and then expire, so they go stale by the clock even when nothing new
happens. The rainfall step is `continue-on-error`, so a missing token can't
freeze the alerts — you get a workflow warning instead.

Kick one off by hand to check it works: **Actions → Daily refresh → Run
workflow**.

---

## 7. Verify

```bash
curl -sI https://<you>.github.io/nepal-hazard-explorer/ | head -1
curl -s  https://<you>.github.io/nepal-hazard-explorer/data/processed/meta.json
```

In the browser:

- Map draws, heat layer visible
- Hazard pills show counts (Landslide 7,377 / Flood 5,506 / Avalanche 156)
- Click a district → area card with an **Analyse** button
- Analyse → allow location → the risk modal runs and the mini-map draws

Geolocation needs HTTPS, which Pages gives you. It won't work over plain HTTP.

---

## Deploying somewhere else

Nothing is GitHub-specific except the workflows. It's static files.

**Netlify / Vercel / Cloudflare Pages** — point at the repo, no build command,
publish directory `.` (the repo root). You lose the scheduled jobs
unless you recreate them as scheduled functions.

**Any web server:**

```nginx
root /srv/nepal-hazard-explorer;
location / { try_files $uri $uri/ =404; }
```

Then run the pipeline from cron:

```cron
40 7 * * *  cd /srv/nepal-hazard-explorer/pipeline && python active_alerts.py
50 7 * * *  cd /srv/nepal-hazard-explorer/pipeline && python fetch_rain.py
0  5 * * 1  cd /srv/nepal-hazard-explorer/pipeline && ./weekly.sh
```

The only hard requirements are that `index.html` and `data/processed/` are
served from the same origin, and HTTPS if you want the location features.

---

## Troubleshooting

**Blank map, console shows 404s for `data/processed/…`**
Pages is serving a subdirectory. The folder setting must be `/ (root)`.

**Data files 404 but HTML loads**
`.nojekyll` missing — Jekyll skips directories it doesn't recognise. It's
committed at the repo root; confirm it survived the push.

**Daily job fails on push with 403**
Workflow permissions are still read-only. Step 4.

**Rainfall says "not configured" after adding the token**
The EULA is a separate click from generating the token. Step 5.

**"Analyse" does nothing**
Geolocation is blocked on non-HTTPS origins and needs an explicit permission
grant. Check the browser's site settings.
