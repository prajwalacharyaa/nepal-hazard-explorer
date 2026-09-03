/* Shared constants + helpers for all pages. Loaded as a plain script; exposes
   globals under window.NHM. */
(function () {
  const DATA = "data/processed";

  /* Hazard colours. Categorical, so they only have to be told apart from each
     other — but each also clears 4.5:1 on the bone background because they are
     used as label text as often as map fill. Ordered by how often they appear.

     Keys must match config.py's HAZARD_MAP output. */
  const HAZARD_COLORS = {
    landslide: "#a8453a",     // rust
    flood: "#2f6d94",         // steel blue
    flash_flood: "#157f85",   // cyan-teal, deliberately far from flood
    glof: "#7a55a3",          // violet reads as ice
    debris_flow: "#a06a25",   // ochre
    avalanche: "#6a7d94",     // cold grey-blue
    other: "#7b7466",
  };
  const HAZARD_LABELS = {
    landslide: "Landslide", flood: "Flood", flash_flood: "Flash flood",
    glof: "GLOF", debris_flow: "Debris flow", avalanche: "Avalanche", other: "Other",
  };
  /* Severity is ordinal, so this one IS a ramp: neutral -> blue -> warm -> red. */
  const SEV_COLORS = {
    minor: "#a79f90", small: "#2f6d94", moderate: "#bd8526",
    major: "#c05f2b", catastrophic: "#9b2a24",
  };

  /* Anything a chart or map layer needs, so no module hardcodes a theme value.
     Mirrors the CSS custom properties in style.css — keep the two in step. */
  const THEME = {
    ink: "#23201b",
    inkDim: "#544e42",
    inkFaint: "#7b7466",
    hair: "#ded8ca",
    surface: "#fdfcf9",
    surface2: "#eae5da",
    accent: "#1d6a66",
    bar: "#2f6d94",
    barMuted: "#a9c3d6",
    // sequential ramp for the choropleth and the calendar
    ramp: ["#f8f1e2", "#f2ddb9", "#ebc188", "#e0a15f", "#d07a44", "#b45134", "#8c2b25"],
    // Heat layer. Front-loaded on purpose: one isolated event produces very low
    // density, so the ramp has to be clearly visible by ~0.04 or sparse areas
    // vanish. Above that it climbs slowly so dense clusters still separate
    // instead of flooding to one solid red.
    heat: [
      0.00, "rgba(248,241,226,0)",
      0.04, "rgba(243,213,152,0.55)",
      0.14, "rgba(236,183,118,0.68)",
      0.32, "rgba(224,145,90,0.76)",
      0.54, "rgba(205,101,64,0.83)",
      0.78, "rgba(170,55,42,0.89)",
      1.00, "rgba(124,24,26,0.94)",
    ],
    // deck.gl wants RGB triples, not CSS strings
    hex: [[248, 241, 226], [242, 221, 185], [235, 193, 136],
          [224, 161, 95], [208, 122, 68], [180, 81, 52], [140, 43, 37]],
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

  /* Fetch JSON. Failures are reported by fatalError() with a fix, because the
     usual cause is opening the files over file:// instead of serving them. */
  async function loadJSON(url) {
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      throw new Error(`network|${url}|${e.message}`);
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
  // Full de-clutter: everything that competes with the hazard layers at the
  // country/region zooms the analysis pages use.
  const CLUTTER = /road|street|bridge|tunnel|motorway|highway|transit|railway|rail|aeroway|airport|poi|place_of|building|housenum|ferry|pier|path|track|cycle/i;
  // Light de-clutter for the main map, where roads, buildings and paths are
  // wanted for orientation. Only pure noise goes.
  const CLUTTER_MIN = /transit|aeroway|airport|poi|place_of|housenum|ferry|pier/i;
  // settlement labels worth keeping, even though they match nothing above
  const KEEP_LABEL = /country|state|continent|city|town|village|place|water_name|waterway_name/i;

  /* Settlement label layers, with the zoom the default style first shows them.
     Villages at z9 and minor places at z8 means a map framed on a 100 km river
     corridor carries almost no names at all — which is exactly when knowing
     the settlements matters most. `denseLabels` pulls those thresholds down to
     where the vector tiles actually start carrying the data, and tightens
     label padding so fewer get culled for collision. */
  const PLACE_LABELS = {
    label_other: 7, label_village: 7, label_town: 5, label_city: 3,
    label_city_capital: 3, label_state: 5,
  };

  function denseLabels(map) {
    for (const [id, minz] of Object.entries(PLACE_LABELS)) {
      if (!map.getLayer(id)) continue;
      try {
        map.setLayerZoomRange(id, minz, 24);
        map.setLayoutProperty(id, "text-padding", 1);
        map.setLayoutProperty(id, "text-optional", false);
      } catch (e) { /* layer not ours; skip */ }
    }
    // river and stream names orient you along a corridor
    for (const id of ["water_name_point_label", "water_name_line_label",
                      "waterway_line_label"]) {
      if (!map.getLayer(id)) continue;
      try { map.setLayerZoomRange(id, 7, 24); } catch (e) { /* skip */ }
    }
  }

  /* opts:
       detail        keep roads/buildings/paths, only strip pure noise, and
                     always turn on the dense settlement labels
       denseLabels   lower the label zoom thresholds (implied by detail)
       roadNames     keep road name / shield layers (implied by detail)
       mask          fade the world outside Nepal (default on)
       foreignLabels leave neighbouring names visible (default off) */
  function simplifyBasemap(map, opts = {}) {
    const noise = opts.detail ? CLUTTER_MIN : CLUTTER;
    const keepRoadNames = opts.roadNames || opts.detail;
    const layers = (map.getStyle() && map.getStyle().layers) || [];
    for (const l of layers) {
      const id = l.id || "";
      if (KEEP_LABEL.test(id)) continue;
      if (keepRoadNames && /^highway-name|road_shield|highway-shield/.test(id)) continue;
      if (noise.test(id)) {
        try { map.setLayoutProperty(id, "visibility", "none"); } catch (e) { /* not ours */ }
      }
    }
    if (opts.denseLabels || opts.detail) denseLabels(map);
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
          paint: { "fill-color": "#f2efe8", "fill-opacity": 0.55 } });
        return fetch(`${DATA}/nepal_outline.geojson`).then((r) => r.json());
      })
      .then((outline) => {
        if (!outline || map.getSource("nepal-outline")) return;
        map.addSource("nepal-outline", { type: "geojson", data: outline });
        map.addLayer({ id: "nepal-outline", type: "line", source: "nepal-outline",
          paint: { "line-color": "#a79f90", "line-width": 1.1, "line-opacity": 0.9 } });
      })
      .catch(() => { /* mask is cosmetic; never block the map on it */ });
  }

  /* Non-blocking confirmation. Use instead of alert(). */
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

  /* Back-to-top pill. Auto-wired on any <body class="doc">, no per-page code. */
  function initBackToTop() {
    var b = document.body;
    if (!b || !b.classList.contains("doc")) return;
    var btn = document.createElement("button");
    btn.id = "to-top";
    btn.type = "button";
    btn.setAttribute("aria-label", "Back to top");
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
    var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    btn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    });
    b.appendChild(btn);
    var show = function () { btn.classList.toggle("show", window.scrollY > 460); };
    addEventListener("scroll", show, { passive: true });
    show();
  }
  if (document.readyState !== "loading") initBackToTop();
  else addEventListener("DOMContentLoaded", initBackToTop);

  window.NHM = {
    DATA, HAZARD_COLORS, HAZARD_LABELS, SEV_COLORS, THEME, MAP_STYLE,
    simplifyBasemap, paths,
    slugify, loadJSON, fmt, hazardName, readableDate, eventsToCSV, download,
    stampMeta, toast, fatalError,
  };
})();
