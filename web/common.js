/* Shared constants + helpers for all pages. Loaded as a plain script; exposes
   globals under window.NHM. */
(function () {
  const DATA = "../data/processed";

  /* Hazard palette — tuned for a LIGHT background: each colour clears 4.5:1
     against white so it works as body text as well as a map fill. */
  const HAZARD_COLORS = {
    landslide: "#c0392b", flood: "#2c6ca0", flash_flood: "#0f766e",
    glof: "#8a4f7d", debris_flow: "#b45309", avalanche: "#64748b", other: "#52525b",
  };
  const HAZARD_LABELS = {
    landslide: "Landslide", flood: "Flood", flash_flood: "Flash flood",
    glof: "GLOF", debris_flow: "Debris flow", avalanche: "Avalanche", other: "Other",
  };
  const SEV_COLORS = {
    minor: "#94a3b8", small: "#2c6ca0", moderate: "#d97706",
    major: "#ea580c", catastrophic: "#b91c1c",
  };

  /* Chart / map colours, so no module hardcodes a theme value. */
  const THEME = {
    ink: "#0f172a",
    inkDim: "#475569",
    inkFaint: "#64748b",
    hair: "#e2e8f0",
    surface: "#ffffff",
    surface2: "#f1f5f9",
    accent: "#c2410c",
    bar: "#2c6ca0",
    barMuted: "#a8c3da",
    // sequential ramp for choropleth / calendar on a light ground (YlOrRd)
    ramp: ["#fff7ec", "#fee8c8", "#fdd49e", "#fdbb84", "#fc8d59", "#e34a33", "#b30000"],
    // heat layer on a light basemap. Deliberately translucent at the low end so
    // place names stay readable; only genuine clusters reach the deep reds.
    heat: [
      0.00, "rgba(255,247,236,0)",
      0.12, "rgba(254,224,182,0.28)",
      0.28, "rgba(253,204,138,0.52)",
      0.48, "rgba(252,166,105,0.68)",
      0.68, "rgba(246,120,72,0.80)",
      0.86, "rgba(214,64,40,0.88)",
      1.00, "rgba(160,10,10,0.94)",
    ],
    // deck.gl hexbin (RGB triples)
    hex: [[254, 232, 200], [253, 212, 158], [253, 187, 132],
          [252, 141, 89], [227, 74, 51], [179, 0, 0]],
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

  /* Fetch JSON. The pages live in web/ and the data in ../data/processed, but
     people also serve the repo with web/ as the document root — so if the
     relative path 404s, retry once against a root-relative path before giving
     up. Any real failure is reported by fatalError() with a fix. */
  async function loadJSON(url) {
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      throw new Error(`network|${url}|${e.message}`);
    }
    if (!r.ok && url.startsWith("../")) {
      const alt = url.replace(/^\.\.\//, "");
      try {
        const r2 = await fetch(alt);
        if (r2.ok) return r2.json();
      } catch (e) { /* fall through to the original failure */ }
    }
    if (!r.ok) throw new Error(`http ${r.status}|${url}`);
    return r.json();
  }

  /* Full-screen, plain-language failure notice — a blank page should always
     explain itself. */
  function fatalError(title, detail, hint) {
    if (document.getElementById("nhm-fatal")) return;
    const el = document.createElement("div");
    el.id = "nhm-fatal";
    el.setAttribute("role", "alert");
    el.innerHTML =
      `<div class="fatal-card">
         <h2>${title}</h2>
         <p>${detail}</p>
         ${hint ? `<div class="fatal-hint">${hint}</div>` : ""}
       </div>`;
    document.body.appendChild(el);
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

  /* Basemap style — light, matches the UI. */
  const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

  /* Toast: brief, non-blocking confirmation (replaces alert()). */
  function toast(msg, ms = 3200) {
    let t = document.getElementById("nhm-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "nhm-toast";
      t.setAttribute("role", "status");
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), ms);
  }

  window.NHM = {
    DATA, HAZARD_COLORS, HAZARD_LABELS, SEV_COLORS, THEME, MAP_STYLE, paths,
    slugify, loadJSON, fmt, hazardName, readableDate, eventsToCSV, download,
    stampMeta, toast, fatalError,
  };
})();
