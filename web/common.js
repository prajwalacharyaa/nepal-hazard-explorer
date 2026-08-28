/* Shared constants + helpers for all pages. Loaded as a plain script; exposes
   globals under window.NHM. */
(function () {
  const DATA = "../data/processed";

  const HAZARD_COLORS = {
    landslide: "#e15759", flood: "#4e79a7", flash_flood: "#76b7b2",
    glof: "#b07aa1", debris_flow: "#f28e2b", avalanche: "#bab0ac", other: "#8c8c8c",
  };
  const HAZARD_LABELS = {
    landslide: "Landslide", flood: "Flood", flash_flood: "Flash flood",
    glof: "GLOF", debris_flow: "Debris flow", avalanche: "Avalanche", other: "Other",
  };
  const SEV_COLORS = {
    minor: "#5b6472", small: "#4e79a7", moderate: "#f6c85f",
    major: "#f28e2b", catastrophic: "#bd0026",
  };

  const paths = {
    events: `${DATA}/events.geojson`,
    districts: `${DATA}/districts.geojson`,
    districtIndex: `${DATA}/district_index.json`,
    calendar: `${DATA}/calendar.json`,
    manifest: `${DATA}/events_by_district_manifest.json`,
    districtEvents: (slug) => `${DATA}/events_by_district/${slug}.json`,
    meta: `${DATA}/meta.json`,
    outlook: `${DATA}/outlook.json`,
    susceptibility: `${DATA}/susceptibility.json`,
    palikaIndex: `${DATA}/palika_index.json`,
    palikas: `${DATA}/palikas.geojson`,
    districtsBoundary: `${DATA}/districts_boundary.geojson`,
  };

  // fetch meta.json and drop a one-line freshness stamp into `sel`
  async function stampMeta(sel) {
    const el = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!el) return;
    try {
      const m = await (await fetch(`${DATA}/meta.json`)).json();
      el.textContent =
        `Data build ${m.built} · ${Number(m.n_events).toLocaleString()} events ` +
        `${m.year_min}–${m.year_max} · latest recorded ${m.latest_event}`;
    } catch (e) { /* leave blank */ }
  }

  const slugify = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  async function loadJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());

  function hazardName(h) { return HAZARD_LABELS[h] || h; }

  // "1993-07-21" + precision -> readable
  function readableDate(iso, precision) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    const M = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m];
    if (precision === "year") return y;
    if (precision === "month") return `${M} ${y}`;
    return `${+d} ${M} ${y}`;
  }

  // client-side CSV from an array of GeoJSON features
  function eventsToCSV(features) {
    const cols = ["id", "date", "date_precision", "hazard", "district",
      "lon", "lat", "geo_precision", "deaths", "missing", "injured",
      "people_affected", "houses_destroyed", "houses_damaged",
      "severity_score", "severity_class", "title", "source", "source_url",
      "report_sources", "glide"];
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const f of features) {
      const p = f.properties, [lon, lat] = f.geometry.coordinates;
      lines.push(cols.map((c) =>
        esc(c === "lon" ? lon : c === "lat" ? lat : p[c])).join(","));
    }
    return lines.join("\n");
  }

  function download(filename, text, type = "text/plain") {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.NHM = {
    DATA, HAZARD_COLORS, HAZARD_LABELS, SEV_COLORS, paths, slugify,
    loadJSON, fmt, hazardName, readableDate, eventsToCSV, download, stampMeta,
  };
})();
