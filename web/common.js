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
    // Heat layer on a light basemap. Front-loaded: a single isolated event has
    // very low density, so the ramp must already be clearly visible by ~0.04 —
    // otherwise sparse areas disappear. The upper half then climbs slowly so
    // dense clusters still differentiate instead of flooding to solid red.
    heat: [
      0.00, "rgba(255,241,222,0)",
      0.04, "rgba(253,206,145,0.55)",
      0.14, "rgba(252,180,116,0.68)",
      0.32, "rgba(249,146,90,0.76)",
      0.54, "rgba(238,105,62,0.83)",
      0.78, "rgba(209,55,35,0.89)",
      1.00, "rgba(155,10,10,0.94)",
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

  /* ---------------------------------------------------------------------
     Basemap de-clutter.

     The default style carries street names, road casings, POIs and transit —
     detail that competes with the hazard data at the zooms this tool is used
     at. We hide those, keep water, terrain, boundaries and settlement names,
     and fade everything outside Nepal behind a mask so the country reads as
     the subject rather than one country among several.
     Call once, after the style has loaded.
     --------------------------------------------------------------------- */
  const CLUTTER = /road|street|bridge|tunnel|motorway|highway|transit|railway|rail|aeroway|airport|poi|place_of|building|housenum|ferry|pier|path|track|cycle/i;
  // settlement labels worth keeping, even though they match nothing above
  const KEEP_LABEL = /country|state|continent|city|town|village|place|water_name|waterway_name/i;

  function simplifyBasemap(map, opts = {}) {
    const layers = (map.getStyle() && map.getStyle().layers) || [];
    for (const l of layers) {
      const id = l.id || "";
      if (KEEP_LABEL.test(id)) continue;
      if (CLUTTER.test(id)) {
        try { map.setLayoutProperty(id, "visibility", "none"); } catch (e) { /* not ours */ }
      }
    }
    if (opts.mask !== false) addNepalMask(map);
    if (opts.foreignLabels !== true) hideForeignLabels(map);
  }

  /* Drop place and water names outside Nepal.

     The vector tiles carry no country field on city labels, so filter each
     label layer geometrically with MapLibre's `within` expression against a
     coarse national hull (95 vertices, cheap to evaluate). This removes
     neighbouring names precisely while leaving the surrounding terrain
     visible — unlike simply fading everything out. */
  const LABEL_LAYERS = [
    "label_other", "label_city", "label_city_capital", "label_town",
    "label_village", "label_state", "label_country_1", "label_country_2",
    "label_country_3", "water_name_point_label", "water_name_line_label",
    "waterway_line_label",
  ];

  function hideForeignLabels(map) {
    fetch(`${DATA}/nepal_hull.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((hull) => {
        for (const id of LABEL_LAYERS) {
          if (!map.getLayer(id)) continue;
          try {
            const prev = map.getFilter(id);
            const within = ["within", hull];
            map.setFilter(id, prev ? ["all", prev, within] : within);
          } catch (e) { /* layer not filterable; leave it alone */ }
        }
      })
      .catch(() => { /* cosmetic only */ });
  }

  /* Fade the world outside Nepal. The mask is the world with the country
     punched out, so nothing inside the border is touched. */
  function addNepalMask(map) {
    if (map.getSource("nepal-mask")) return;
    fetch(`${DATA}/nepal_mask.geojson`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((mask) => {
        if (map.getSource("nepal-mask")) return;
        map.addSource("nepal-mask", { type: "geojson", data: mask });
        map.addLayer({ id: "nepal-mask", type: "fill", source: "nepal-mask",
          paint: { "fill-color": "#f5f7fa", "fill-opacity": 0.55 } });
        return fetch(`${DATA}/nepal_outline.geojson`).then((r) => r.json());
      })
      .then((outline) => {
        if (!outline || map.getSource("nepal-outline")) return;
        map.addSource("nepal-outline", { type: "geojson", data: outline });
        map.addLayer({ id: "nepal-outline", type: "line", source: "nepal-outline",
          paint: { "line-color": "#94a3b8", "line-width": 1.1, "line-opacity": 0.9 } });
      })
      .catch(() => { /* mask is cosmetic; never block the map on it */ });
  }

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
    DATA, HAZARD_COLORS, HAZARD_LABELS, SEV_COLORS, THEME, MAP_STYLE,
    simplifyBasemap, paths,
    slugify, loadJSON, fmt, hazardName, readableDate, eventsToCSV, download,
    stampMeta, toast, fatalError,
  };
})();
