/* Main map: 4 views + "find your area" (near-me / search / click). */
const { HAZARD_COLORS, HAZARD_LABELS, SEV_COLORS, THEME, MAP_STYLE, paths,
        slugify, loadJSON, fmt, hazardName, readableDate, eventsToCSV, download,
        toast, fatalError, simplifyBasemap } = window.NHM;

if (location.protocol === "file:") {
  fatalError(
    "This page must be served over HTTP",
    "It was opened straight from the file system, so the browser blocks it from " +
    "reading the hazard data and the map tiles.",
    "From the project folder run <code>python -m http.server 8000</code> " +
    "then open <code>http://localhost:8000/web/</code>",
  );
}

const state = {
  view: "heatmap",
  hazards: new Set(Object.keys(HAZARD_COLORS)),
  yearMin: 1971, yearMax: new Date().getFullYear(),
  metric: "events", preciseOnly: false, calMetric: "count", heatBoost: 1,
  data: { events: null, districts: null, calendar: null, index: null, palikaIndex: null },
  anim: null, hexYear: null, palikaLoaded: false,
};

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: [84.1, 28.3], zoom: 6.2,
  attributionControl: false,
});
const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true, timeout: 10000 },
  fitBoundsOptions: { maxZoom: 14 },
  trackUserLocation: false,
  showUserLocation: true,
  showAccuracyCircle: true,
});

// Desktop keeps everything bottom-right. On phones the bottom-right corner is
// where the thumb and the bottom sheet live, so put the info ("i") and the
// locate button top-right instead. The OpenStreetMap "i" goes top-left, clear
// of both the alert button (top-right) and the thumb zone.
if (matchMedia("(max-width: 899px)").matches) {
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-left");
  map.addControl(geolocate, "top-right");
  map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), "bottom-right");
} else {
  // desktop bottom-right, top -> bottom: zoom, locate, info "i"
  // (MapLibre renders the last-added control at the top of a bottom corner)
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  map.addControl(geolocate, "bottom-right");
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
}
window.__map = map;                       // handy when debugging in the console

// MapLibre 4.7 renders the compact attribution expanded ("maplibregl-compact-show")
// on load. Collapse it to just the "i"; it stays collapsed until the user taps it.
function collapseAttribution() {
  document.querySelectorAll(".maplibregl-ctrl-attrib.maplibregl-compact-show")
    .forEach((el) => el.classList.remove("maplibregl-compact-show"));
}
map.on("load", collapseAttribution);
map.on("idle", collapseAttribution);
[300, 1200].forEach((t) => setTimeout(collapseAttribution, t));

/* A blank basemap should say why — but individual tile requests fail or abort
   routinely while panning, so never warn on those. Only speak up if the map
   genuinely never finishes loading. */
let mapReady = false;
const markReady = () => { mapReady = true; };
map.on("load", () => { markReady(); simplifyBasemap(map); });
map.on("idle", markReady);
map.on("sourcedata", (e) => { if (e.isSourceLoaded) markReady(); });
map.on("error", (e) => {
  console.error("[map]", (e && e.error && e.error.message) || e);
});
setTimeout(() => {
  // only complain if nothing at all arrived and the style never parsed
  if (!mapReady && !map.isStyleLoaded()) {
    toast("The basemap did not load — check the network connection. Hazard data is unaffected.", 7000);
  }
}, 20000);

let deckOverlay = null;

/* ---------------------------------------------------------------- load ---- */
async function loadAll() {
  const results = await Promise.allSettled([
    loadJSON(paths.events), loadJSON(paths.districts),
    loadJSON(paths.calendar), loadJSON(paths.districtIndex),
  ]);
  const [ev, di, ca, ix] = results;
  if (ev.status === "fulfilled") state.data.events = ev.value;
  if (di.status === "fulfilled") state.data.districts = di.value;
  if (ca.status === "fulfilled") state.data.calendar = ca.value;
  if (ix.status === "fulfilled") state.data.index = ix.value;
  loadJSON(paths.palikaIndex)
    .then((v) => { state.data.palikaIndex = v; buildPlaceIndex(); })
    .catch(() => buildPlaceIndex());

  if (!state.data.events) {
    const why = String((ev.reason && ev.reason.message) || ev.reason || "");
    const missing = why.startsWith("http 404");
    document.getElementById("stats").innerHTML =
      "<b>No hazard data loaded.</b><span class='sub'>See the message on screen.</span>";
    fatalError(
      missing ? "Hazard data not found" : "Could not load the hazard data",
      missing
        ? "The page loaded, but <code>data/processed/events.geojson</code> could not be fetched."
        : `The request for the data failed (${(why.split("|")[0] || "network error").trim()}).`,
      "Serve the <b>project root</b> — not the <code>web/</code> folder — then open <code>/web/</code>:" +
      "<br><code>cd landslide_flood_heatmap</code><br><code>python -m http.server 8000</code>" +
      "<br>then visit <code>http://localhost:8000/web/</code>" +
      "<br><br>If you have not built the data yet, run the pipeline first (see README).",
    );
    return;
  }
  const yrs = state.data.events.features.map((f) => f.properties.year).filter(Boolean);
  state.absMin = Math.min(...yrs);
  state.absMax = Math.max(...yrs);
  state.yearMin = state.absMin;
  state.yearMax = state.absMax;
  const initialView = applyHash();
  buildHazardChips();
  initYearSliders();
  buildPlaceIndex();
  document.getElementById("precise-only").checked = state.preciseOnly;
  document.getElementById("metric").value = state.metric;
  document.getElementById("heat-boost").value = state.heatBoost;
  document.getElementById("heat-label").textContent = `${state.heatBoost.toFixed(1)}×`;
  updateStats();                       // panel is useful before the map paints
  initAlerts();                        // needs state.data.events
  const go = () => setView(initialView || "heatmap");
  map.loaded() ? go() : map.once("load", go);
}

/* ---- shareable URL state (location.hash) ---- */
function applyHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("h")) {
    const set = new Set(p.get("h").split(",").filter((x) => x in HAZARD_COLORS));
    if (set.size) state.hazards = set;
  }
  if (p.has("y")) {
    const [a, b] = p.get("y").split("-").map(Number);
    if (a && b) { state.yearMin = Math.max(state.absMin, Math.min(a, b)); state.yearMax = Math.min(state.absMax, Math.max(a, b)); }
  }
  if (p.get("p") === "1") state.preciseOnly = true;
  if (p.has("m")) state.metric = p.get("m");
  if (p.has("cm")) state.calMetric = p.get("cm");
  if (p.has("hb")) {
    const b = parseFloat(p.get("hb"));
    if (b >= 0.5 && b <= 3) state.heatBoost = b;
  }
  return p.get("v");
}
function syncHash() {
  const all = Object.keys(HAZARD_COLORS).length;
  const p = new URLSearchParams();
  if (state.view !== "heatmap") p.set("v", state.view);
  if (state.hazards.size !== all) p.set("h", [...state.hazards].join(","));
  if (state.yearMin !== state.absMin || state.yearMax !== state.absMax) p.set("y", `${state.yearMin}-${state.yearMax}`);
  if (state.preciseOnly) p.set("p", "1");
  if (state.metric !== "events") p.set("m", state.metric);
  if (state.calMetric !== "count") p.set("cm", state.calMetric);
  if (state.heatBoost !== 1) p.set("hb", String(state.heatBoost));
  const q = p.toString();
  history.replaceState(null, "", q ? "#" + q : location.pathname + location.search);
}

function filteredEvents() {
  if (!state.data.events) return [];
  return state.data.events.features.filter((f) => {
    const p = f.properties;
    return f.geometry &&
      state.hazards.has(p.hazard || "other") &&
      p.year >= state.yearMin && p.year <= state.yearMax &&
      (!state.preciseOnly || p.geo_precision === "exact");
  });
}

/* ---- heat layer tuning -------------------------------------------------
   ~13k points over a small country saturate easily, so the baseline is
   conservative. state.heatBoost (0.5–3) scales it, letting you dial the
   overlay up when a narrow filter leaves only a handful of events. */
function heatIntensity() {
  const b = state.heatBoost;
  return ["interpolate", ["linear"], ["zoom"],
    4, 0.45 * b, 7, 0.7 * b, 10, 1.05 * b, 14, 1.5 * b];
}
function heatRadius() {
  // a slightly wider kernel at high boost keeps lone events from being a
  // single hard pixel
  const g = 1 + (state.heatBoost - 1) * 0.35;
  return ["interpolate", ["linear"], ["zoom"],
    4, 7 * g, 7, 12 * g, 10, 19 * g, 14, 30 * g];
}
function applyHeatBoost() {
  if (!map.getLayer("heat")) return;
  map.setPaintProperty("heat", "heatmap-intensity", heatIntensity());
  map.setPaintProperty("heat", "heatmap-radius", heatRadius());
}

/* ------------------------------------------------------------ map layers -- */
function ensureEventSource() {
  const fc = { type: "FeatureCollection", features: filteredEvents() };
  if (map.getSource("events")) map.getSource("events").setData(fc);
  else map.addSource("events", { type: "geojson", data: fc });
}

function addHeatmapLayer() {
  ensureEventSource();
  if (map.getLayer("heat")) return;
  map.addLayer({
    id: "heat", type: "heatmap", source: "events",
    paint: {
      // severity-weighted, and down-weighted where the point is a centroid
      "heatmap-weight": ["*",
        ["case", ["==", ["get", "geo_precision"], "exact"], 1.0, 0.5],
        ["interpolate", ["linear"],
          ["ln", ["+", 1, ["get", "severity_score"]]], 0, 0.15, 8, 1]],
      "heatmap-intensity": heatIntensity(),
      "heatmap-radius": heatRadius(),
      // fade out as the individual points take over
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.85, 11, 0.55, 14, 0.3],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], ...THEME.heat],
    },
  });
  const hazColor = ["match", ["get", "hazard"],
    ...Object.entries(HAZARD_COLORS).flat(), THEME.inkFaint];
  const isExact = ["==", ["get", "geo_precision"], "exact"];
  map.addLayer({
    id: "heat-points", type: "circle", source: "events", minzoom: 8,
    paint: {
      "circle-radius": ["*", ["interpolate", ["linear"], ["zoom"], 8, 2.4, 14, 6.5],
        ["case", isExact, 1, 0.85]],
      // exact = filled dot; centroid = hollow ring
      "circle-color": ["case", isExact, hazColor, "rgba(255,255,255,0.85)"],
      "circle-opacity": 0.9,
      "circle-stroke-width": ["case", isExact, 1, 1.4],
      "circle-stroke-color": ["case", isExact, "#ffffff", hazColor],
    },
  });
}

function addChoroplethLayer() {
  if (!state.data.districts) return;
  if (!map.getSource("districts"))
    map.addSource("districts", { type: "geojson", data: state.data.districts });
  if (!map.getLayer("choro")) {
    map.addLayer({ id: "choro", type: "fill", source: "districts",
      paint: { "fill-color": THEME.surface2, "fill-opacity": 0.82 } });
    map.addLayer({ id: "choro-line", type: "line", source: "districts",
      paint: { "line-color": "#ffffff", "line-width": 1 } });
    map.on("click", "choro", (e) => {
      if (map.getZoom() >= 8) return;   // palika layer handles clicks when zoomed in
      openAreaCard(e.features[0].properties.district, e.lngLat);
    });
    map.on("mouseenter", "choro", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "choro", () => (map.getCanvas().style.cursor = ""));
  }
  paintChoropleth();
}

function paintChoropleth() {
  const m = state.metric;
  const vals = state.data.districts.features
    .map((f) => f.properties[m] || 0).filter((v) => v > 0).sort((a, b) => a - b);
  if (!vals.length) return;
  const q = (p) => vals[Math.floor(p * (vals.length - 1))];
  const R = THEME.ramp;
  const stops = [[0, R[0]], [q(0.2), R[1]], [q(0.4), R[2]],
    [q(0.6), R[3]], [q(0.8), R[4]], [q(0.93), R[5]], [q(0.99), R[6]]];
  map.setPaintProperty("choro", "fill-color",
    ["interpolate", ["linear"], ["coalesce", ["get", m], 0], ...stops.flat()]);
  legendGradient(stops, m);
}

/* ----------------------------------------------------------- deck hexbin -- */
function showHexbin() {
  const upTo = state.hexYear ?? state.yearMax;
  const rows = filteredEvents()
    .filter((f) => f.properties.year <= upTo)
    .map((f) => ({ position: f.geometry.coordinates,
                   score: (f.properties.severity_score || 0) + 1 }));
  const layer = new deck.HexagonLayer({
    id: "hex", data: rows, getPosition: (d) => d.position,
    getElevationWeight: (d) => d.score, getColorWeight: (d) => d.score,
    elevationScale: 40, extruded: true, radius: 6000, coverage: 0.85, pickable: true,
    colorRange: THEME.hex,
  });
  if (!deckOverlay) { deckOverlay = new deck.MapboxOverlay({ layers: [layer] }); map.addControl(deckOverlay); }
  else deckOverlay.setProps({ layers: [layer] });
}
function clearHexbin() { if (deckOverlay) deckOverlay.setProps({ layers: [] }); }

/* -------------------------------------------------------------- calendar -- */
const REPORTING_ERA = 2011;   // BIPAD coverage begins; pre-this is sparser

function drawCalendar() {
  const el = document.getElementById("calendar-panel");
  const metricName = state.calMetric === "score" ? "summed severity score" : "recorded events";
  el.innerHTML =
    "<h2>By year &amp; month</h2>" +
    `<div class="cal-toggle" role="group" aria-label="Calendar metric">
       <button data-cm="count" class="${state.calMetric !== "score" ? "active" : ""}">Events</button>
       <button data-cm="score" class="${state.calMetric === "score" ? "active" : ""}">Severity</button>
     </div>` +
    `<p class='cap'>Cell = ${metricName} that month. Monsoon (Jun–Sep) carries most of the load. ` +
    `Years before ${REPORTING_ERA} (dimmed) are under-reported — the jump is mostly coverage, not hazard.</p>`;
  el.querySelectorAll(".cal-toggle button").forEach((b) => {
    b.onclick = () => { state.calMetric = b.dataset.cm; drawCalendar(); syncHash(); };
  });

  const cal = state.data.calendar;
  if (!cal) { el.innerHTML += "<p>No calendar.json.</p>"; return; }
  const useScore = state.calMetric === "score";
  const rows = [];
  for (const [k, v] of Object.entries(cal)) {
    const [y, mo] = k.split("-").map(Number);
    let val;
    if (useScore) val = v.score || 0;
    else val = v.by_hazard
      ? Object.entries(v.by_hazard).filter(([h]) => state.hazards.has(h)).reduce((s, [, n]) => s + n, 0)
      : v.count;
    rows.push({ y, mo, val });
  }
  const years = [...new Set(rows.map((r) => r.y))].sort((a, b) => a - b);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const cw = 34, ch = 16, padL = 46, padT = 22;
  const w = padL + months.length * cw + 10, h = padT + years.length * ch + 10;
  const max = d3.max(rows, (r) => r.val) || 1;
  const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, Math.sqrt(max)]);
  const svg = d3.create("svg").attr("width", w).attr("height", h)
    .attr("font-size", 10).attr("role", "img")
    .attr("aria-label", `Calendar heatmap of ${metricName} by year and month, ${years[0]}–${years.at(-1)}`);
  svg.append("g").attr("fill", THEME.inkFaint).attr("font-weight", 600)
    .selectAll("text").data(months).join("text")
    .attr("x", (_, i) => padL + i * cw + cw / 2).attr("y", 14).attr("text-anchor", "middle").text((d) => d);
  svg.append("g").selectAll("text").data(years).join("text")
    .attr("x", padL - 8).attr("y", (_, i) => padT + i * ch + ch / 2 + 3).attr("text-anchor", "end")
    .attr("fill", (d) => (d < REPORTING_ERA ? "#a8b1bd" : THEME.inkFaint)).text((d) => d);
  const yi = new Map(years.map((y, i) => [y, i]));
  svg.append("g").selectAll("rect").data(rows).join("rect")
    .attr("x", (d) => padL + (d.mo - 1) * cw).attr("y", (d) => padT + yi.get(d.y) * ch)
    .attr("width", cw - 1.5).attr("height", ch - 1.5).attr("rx", 2.5)
    .attr("opacity", (d) => (d.y < REPORTING_ERA ? 0.6 : 1))
    .attr("fill", (d) => (d.val ? color(Math.sqrt(d.val)) : THEME.surface2))
    .append("title").text((d) =>
      `${d.y}-${String(d.mo).padStart(2, "0")}: ${useScore ? Math.round(d.val) + " severity" : d.val + " events"}`);
  el.append(svg.node());
}

/* --------------------------------------------------------- palika layer -- */
async function ensurePalikaLayer() {
  if (state.palikaLoaded) return;
  state.palikaLoaded = true;
  let gj;
  try { gj = await loadJSON(paths.palikas); } catch (e) { return; }
  map.addSource("palikas", { type: "geojson", data: gj });
  map.addLayer({
    id: "palika-fill", type: "fill", source: "palikas", minzoom: 8,
    paint: { "fill-color": THEME.accent, "fill-opacity": 0.03 },
  });
  map.addLayer({
    id: "palika-line", type: "line", source: "palikas", minzoom: 8,
    paint: { "line-color": THEME.accent, "line-opacity": 0.35, "line-width": 0.7 },
  });
  map.on("click", "palika-fill", (e) => {
    openPalikaCard(e.features[0].properties.adm3_pcode,
                   e.features[0].properties.adm3_name, e.lngLat);
  });
  map.on("mouseenter", "palika-fill", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "palika-fill", () => (map.getCanvas().style.cursor = ""));
}
map.on("zoomend", () => { if (map.getZoom() >= 7.8) ensurePalikaLayer(); });

function openPalikaCard(pcode, name, lngLat) {
  state.openArea = { kind: "palika", pcode, name };
  renderOpenArea();
}

/* ------------------------------------------------------------ area card --- */
function openAreaCard(district, lngLat) {
  state.openArea = { kind: "district", district };
  renderOpenArea();
}

/* Rebuild whatever area card is open against the CURRENT filters. Called both
   when an area is first clicked and on every filter change, so the card never
   shows figures that disagree with the map. */
function renderOpenArea() {
  const a = state.openArea;
  if (!a) return;
  if (a.kind === "palika") {
    const ix = state.data.palikaIndex && state.data.palikaIndex[a.pcode];
    renderAreaCard({
      title: ix ? ix.palika : a.name,
      subtitle: `${ix ? ix.district + " district · " : ""}municipality`,
      slug: ix ? slugify(ix.district) : slugify(a.name),
      feats: filteredEvents().filter((f) => f.properties.palika_pcode === a.pcode),
      allTime: ix,
    });
  } else {
    const ix = state.data.index && state.data.index[a.district];
    renderAreaCard({
      title: a.district, subtitle: "district", slug: slugify(a.district),
      feats: filteredEvents().filter((f) => f.properties.district === a.district),
      allTime: ix,
    });
  }
}

function closeAreaCard() {
  state.openArea = null;
  document.getElementById("area-card").hidden = true;
}

/* stats for whatever is currently filtered, plus an all-time context line */
function renderAreaCard({ title, subtitle, slug, feats, allTime }) {
  const card = document.getElementById("area-card");
  const rangeTxt = `${state.yearMin}–${state.yearMax}`;
  const isFull = state.yearMin === state.absMin && state.yearMax === state.absMax
    && state.hazards.size === Object.keys(HAZARD_COLORS).length && !state.preciseOnly;

  const deaths = feats.reduce((s, f) => s + (f.properties.deaths || 0), 0);
  const byHaz = {};
  let worst = null;
  for (const f of feats) {
    const p = f.properties;
    byHaz[p.hazard] = (byHaz[p.hazard] || 0) + 1;
    if (!worst || (p.severity_score || 0) > (worst.severity_score || 0)) worst = p;
  }
  const hzChips = Object.entries(byHaz).sort((a, b) => b[1] - a[1])
    .map(([h, n]) => `<span class="tag" style="color:${HAZARD_COLORS[h]}">${hazardName(h)} ${n}</span>`).join(" ");

  const q = filterQuery();
  let body;
  if (!feats.length) {
    body = `<p class="muted">No recorded events for ${isFull ? "this area" : "the current filter"}.</p>` +
      (allTime ? `<p class="muted">All-time: ${fmt(allTime.events)} events, ${allTime.first_year}–${allTime.last_year}.</p>` : "");
  } else {
    body =
      `<p class="big">${fmt(feats.length)} events · ${fmt(deaths)} deaths</p>
       <p class="muted">${rangeTxt}${isFull ? "" : " · current filter"}</p>
       <p>${hzChips}</p>
       ${worst ? `<p class="muted">Worst in range: ${hazardName(worst.hazard)}, ${readableDate(worst.date)} —
         ${fmt(worst.deaths || 0)} dead <a href="event.html?id=${encodeURIComponent(worst.id)}&d=${slug}">details</a></p>` : ""}
       ${!isFull && allTime ? `<p class="muted">All-time: ${fmt(allTime.events)} events, ${allTime.deaths} deaths, ${allTime.first_year}–${allTime.last_year}.</p>` : ""}`;
  }

  // "Full view" opens the worst event in the current selection in its own tab,
  // with the downstream corridor drawn
  const fullView = worst
    ? `<a class="cta ghost" target="_blank" rel="noopener"
          href="impact.html?id=${encodeURIComponent(worst.id)}&d=${slug}"
          title="Open the impact view for the most severe event here">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M15 3h6v6M21 3l-8 8M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>
         </svg>Full view</a>`
    : "";

  const firstOpen = card.hidden;
  card.innerHTML = `<button class="x" aria-label="Close">×</button>
    <h3>${title}</h3>
    <p class="muted">${subtitle}</p>
    ${body}
    <div class="cta-row">
      <a class="cta" href="district.html?d=${encodeURIComponent(slug)}${q}">District page →</a>
      ${fullView}
    </div>`;
  card.hidden = false;
  // only steal focus / collapse the sheet when the card first appears, not on
  // every filter-driven refresh
  if (firstOpen && typeof collapsePanel === "function") collapsePanel();
  card.querySelector(".x").onclick = closeAreaCard;
}

/* year + hazard filter as a URL suffix, so a click-through stays consistent */
function filterQuery() {
  const p = new URLSearchParams();
  if (state.yearMin !== state.absMin || state.yearMax !== state.absMax)
    p.set("y", `${state.yearMin}-${state.yearMax}`);
  if (state.hazards.size !== Object.keys(HAZARD_COLORS).length)
    p.set("h", [...state.hazards].join(","));
  const s = p.toString();
  return s ? "&" + s : "";
}

/* ------------------------------------------------------------- view swap -- */
function setView(v) {
  state.view = v;
  document.querySelectorAll("#view-tabs button").forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.getElementById("metric-group").hidden = v !== "choropleth";
  document.getElementById("heat-group").hidden = v !== "heatmap";
  document.getElementById("calendar-panel").hidden = v !== "calendar";
  document.getElementById("timeline").hidden = v !== "hexbin";
  document.getElementById("year-group").hidden = v === "calendar";
  ["heat", "heat-points", "choro", "choro-line"].forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  });
  clearHexbin(); stopAnim();
  if (v === "heatmap") { addHeatmapLayer(); ["heat", "heat-points"].forEach((id) => map.setLayoutProperty(id, "visibility", "visible")); hazardLegend(); }
  else if (v === "choropleth") { addChoroplethLayer(); ["choro", "choro-line"].forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", "visible")); }
  else if (v === "hexbin") { initTimeline(); showHexbin(); hazardLegend(); }
  else if (v === "calendar") { drawCalendar(); document.getElementById("legend").innerHTML = ""; }
  updateStats();
  syncHash();
}

function hazardLegend() {
  const l = document.getElementById("legend");
  l.innerHTML = '<span class="field-label">Hazard</span>' +
    Object.keys(HAZARD_COLORS).map((h) =>
      `<div class="row"><span class="sw" style="background:${HAZARD_COLORS[h]}"></span>${HAZARD_LABELS[h]}</div>`
    ).join("") +
    `<div class="row" style="margin-top:8px"><span class="sw" style="border:1.5px solid ${THEME.inkGhost || "#94a3b8"};background:#fff"></span>approximate location (centroid)</div>`;
}
function refresh() {
  if (state.view === "heatmap") ensureEventSource();
  else if (state.view === "choropleth") paintChoropleth();
  else if (state.view === "hexbin") showHexbin();
  else if (state.view === "calendar") drawCalendar();
  updateStats();
  renderOpenArea();      // keep the open area card in step with the filters
  syncHash();
}

/* -------------------------------------------------------------- controls -- */
function buildHazardChips() {
  const box = document.getElementById("hazard-filter");
  box.innerHTML = "";
  for (const h of Object.keys(HAZARD_COLORS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill";
    b.style.color = HAZARD_COLORS[h];
    b.setAttribute("aria-pressed", String(state.hazards.has(h)));
    b.innerHTML = `<span class="dot"></span>${HAZARD_LABELS[h]}`;
    b.onclick = () => {
      const on = !state.hazards.has(h);
      on ? state.hazards.add(h) : state.hazards.delete(h);
      b.setAttribute("aria-pressed", String(on));
      refresh();
    };
    box.appendChild(b);
  }
}
function initYearSliders() {
  const mn = document.getElementById("year-min"), mx = document.getElementById("year-max");
  for (const s of [mn, mx]) { s.min = state.absMin; s.max = state.absMax; }
  mn.value = state.yearMin; mx.value = state.yearMax;
  const sync = () => {
    let a = +mn.value, b = +mx.value; if (a > b) [a, b] = [b, a];
    state.yearMin = a; state.yearMax = b;
    document.getElementById("year-label").textContent = `${a}–${b}`; refresh();
  };
  mn.oninput = sync; mx.oninput = sync;
  document.getElementById("year-label").textContent = `${state.yearMin}–${state.yearMax}`;
}
/* ---- place search: districts + municipalities, fuzzy-ish prefix match ---- */
let PLACES = [];
function buildPlaceIndex() {
  const seen = new Set();
  const out = [];
  const dNames = state.data.index ? Object.keys(state.data.index)
    : (state.data.districts?.features || []).map((f) => f.properties.district);
  for (const n of dNames) {
    if (!n || seen.has("d:" + n)) continue;
    seen.add("d:" + n);
    out.push({ name: n, kind: "District", district: n, events: state.data.index?.[n]?.events || 0 });
  }
  for (const p of Object.values(state.data.palikaIndex || {})) {
    if (!p.palika || seen.has("p:" + p.palika + p.district)) continue;
    seen.add("p:" + p.palika + p.district);
    out.push({ name: p.palika, kind: p.district, district: p.district, events: p.events || 0 });
  }
  PLACES = out;
}

function searchPlaces(q) {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const scored = [];
  for (const p of PLACES) {
    const n = p.name.toLowerCase();
    let score;
    if (n === s) score = 0;
    else if (n.startsWith(s)) score = 1;
    else if (n.includes(s)) score = 2;
    else continue;
    // districts first at equal score, then more-affected places
    scored.push([score, p.kind === "District" ? 0 : 1, -p.events, p]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return scored.slice(0, 12).map((x) => x[3]);
}

function initPlaceSearch() {
  const input = document.getElementById("place-search");
  const list = document.getElementById("place-results");
  if (!input) return;
  let results = [], active = -1;

  const close = () => {
    list.hidden = true; list.innerHTML = ""; active = -1;
    input.setAttribute("aria-expanded", "false");
  };
  const go = (p) => {
    close();
    location.href = `district.html?d=${encodeURIComponent(slugify(p.district))}${filterQuery()}`;
  };
  const paint = () => {
    list.innerHTML = results.length
      ? results.map((p, i) =>
          `<button type="button" role="option" aria-selected="${i === active}" data-i="${i}">
             <span>${p.name}</span><span class="kind">${p.kind}</span>
           </button>`).join("")
      : '<div class="none">No matching district or municipality.</div>';
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    list.querySelectorAll("button").forEach((b) => {
      b.onclick = () => go(results[+b.dataset.i]);
    });
  };

  input.oninput = () => {
    results = searchPlaces(input.value);
    active = -1;
    if (!input.value.trim()) return close();
    paint();
  };
  input.onkeydown = (e) => {
    if (e.key === "Escape") return close();
    if (!results.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      paint();
      list.children[active]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active >= 0 ? active : 0]);
    }
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".combo")) close();
  });
}
initPlaceSearch();
function initTimeline() {
  const s = document.getElementById("time-slider");
  s.min = state.yearMin; s.max = state.yearMax; s.value = state.hexYear ?? state.yearMax;
  document.getElementById("time-label").textContent = s.value;
  s.oninput = () => { state.hexYear = +s.value; document.getElementById("time-label").textContent = s.value; showHexbin(); };
}
document.getElementById("play").onclick = () => {
  if (state.anim) return stopAnim();
  const s = document.getElementById("time-slider");
  document.getElementById("play").textContent = "⏸";
  const step = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1600 : 700;
  state.anim = setInterval(() => {
    let y = +s.value + 1; if (y > +s.max) y = +s.min;
    s.value = y; state.hexYear = y;
    document.getElementById("time-label").textContent = y; showHexbin();
  }, step);
};
function stopAnim() {
  if (state.anim) { clearInterval(state.anim); state.anim = null; }
  const p = document.getElementById("play"); if (p) p.textContent = "▶";
}

document.querySelectorAll("#view-tabs button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
document.getElementById("metric").onchange = (e) => { state.metric = e.target.value; paintChoropleth(); syncHash(); };
document.getElementById("heat-boost").oninput = (e) => {
  state.heatBoost = +e.target.value;
  document.getElementById("heat-label").textContent = `${state.heatBoost.toFixed(1)}×`;
  applyHeatBoost();
  syncHash();
};
document.getElementById("precise-only").onchange = (e) => { state.preciseOnly = e.target.checked; refresh(); };

const nearBtn = document.getElementById("near-me");
const nearHTML = nearBtn.innerHTML;
function resetNear() { nearBtn.disabled = false; nearBtn.innerHTML = nearHTML; }
nearBtn.onclick = () => {
  if (!navigator.geolocation) { toast("Geolocation isn't available in this browser."); return; }
  nearBtn.disabled = true;
  nearBtn.innerHTML = nearHTML.replace("My location", "Locating…");
  // same code path as the crosshair control bottom-right: it prompts for
  // permission when needed, flies to the real position and shows the dot
  const fired = geolocate.trigger();
  if (!fired) resetNear();
};
geolocate.on("geolocate", () => { resetNear(); collapsePanel(); });
geolocate.on("error", (e) => {
  resetNear();
  toast(e && e.code === 1
    ? "Location is blocked for this site. Enable it in your browser's site settings, then try again."
    : "Could not get your location. Try again, or search for a place instead.");
});
geolocate.on("outofmaxbounds", () => {
  resetNear();
  toast("You appear to be outside Nepal — search for a district or municipality instead.");
});

/* =========================================================================
   Mobile bottom sheet: starts at "peek" so the map is usable on open, and
   can be dragged smoothly between peek and open (or tapped on the handle).
   ========================================================================= */
const panelEl = document.getElementById("panel");
const panelBodyEl = panelEl.querySelector(".panel-body");
const panelHeadEl = panelEl.querySelector(".panel-head");
const isMobile = () => matchMedia("(max-width: 899px)").matches;
const PEEK_REVEAL = 248;               // keep in sync with style.css

function setSheet(stateName) { panelEl.dataset.state = stateName; }
function collapsePanel() { if (isMobile()) setSheet("peek"); }

// open on the map: don't cover it — start peeked
if (isMobile()) setSheet("peek");
addEventListener("resize", () => {
  if (!isMobile()) setSheet("open");            // desktop has no sheet states
  else if (!panelEl.dataset.state) setSheet("peek");
});

// tap the grab handle to toggle
document.getElementById("panel-handle").addEventListener("click", (e) => {
  if (panelEl.dataset.dragMoved) { delete panelEl.dataset.dragMoved; return; }
  setSheet(panelEl.dataset.state === "open" ? "peek" : "open");
});

map.on("dragstart", collapsePanel);

/* ---- drag ---- */
(function sheetDrag() {
  let startY = 0, startTranslate = 0, dragging = false, lastY = 0, lastT = 0, vy = 0;

  const peekPx = () => Math.max(0, panelEl.offsetHeight - PEEK_REVEAL);
  const currentTranslate = () =>
    panelEl.dataset.state === "open" ? 0 : peekPx();

  function down(e) {
    if (!isMobile()) return;
    // a downward drag that begins inside a scrolled body should scroll, not drag
    if (e.target.closest(".panel-body") && panelBodyEl.scrollTop > 0) return;
    dragging = true;
    startY = lastY = e.clientY;
    lastT = performance.now();
    vy = 0;
    startTranslate = currentTranslate();
    panelEl.dataset.dragging = "1";
    delete panelEl.dataset.dragMoved;
    panelEl.style.setProperty("--drag-y", startTranslate + "px");
    panelEl.setPointerCapture?.(e.pointerId);
  }

  function move(e) {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) panelEl.dataset.dragMoved = "1";
    let y = startTranslate + dy;
    y = Math.max(-24, Math.min(peekPx() + 24, y));   // a little rubber-band
    panelEl.style.setProperty("--drag-y", y + "px");
    const now = performance.now();
    vy = (e.clientY - lastY) / Math.max(1, now - lastT);   // px per ms
    lastY = e.clientY; lastT = now;
    e.preventDefault();
  }

  function up() {
    if (!dragging) return;
    dragging = false;
    delete panelEl.dataset.dragging;
    const y = parseFloat(getComputedStyle(panelEl).getPropertyValue("--drag-y")) || 0;
    const mid = peekPx() / 2;
    // strong flick wins over position
    let open;
    if (vy < -0.45) open = true;
    else if (vy > 0.45) open = false;
    else open = y < mid;
    panelEl.style.removeProperty("--drag-y");
    setSheet(open ? "open" : "peek");
    // let any synthesized click read dragMoved first, then clear it
    setTimeout(() => { delete panelEl.dataset.dragMoved; }, 400);
  }

  for (const el of [panelHeadEl, document.getElementById("panel-handle")]) {
    el.addEventListener("pointerdown", down);
  }
  addEventListener("pointermove", move, { passive: false });
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
})();

/* desktop: slide the whole panel off-screen for a full-width map */
const collapseBtn = document.getElementById("panel-collapse");
const restoreBtn = document.getElementById("panel-restore");
function setPanelHidden(hidden) {
  panelEl.dataset.collapsed = String(hidden);
  document.body.classList.toggle("panel-collapsed", hidden);
  collapseBtn.setAttribute("aria-expanded", String(!hidden));
  restoreBtn.hidden = !hidden;
  // let MapLibre pick up the new viewport once the slide finishes
  setTimeout(() => map.resize(), 320);
  if (hidden) restoreBtn.focus();
  else collapseBtn.focus();
}
collapseBtn.onclick = () => setPanelHidden(true);
restoreBtn.onclick = () => setPanelHidden(false);
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panelEl.dataset.collapsed !== "true"
      && matchMedia("(min-width: 900px)").matches
      && !e.target.closest("input, select, textarea")) {
    setPanelHidden(true);
  }
});
function districtAt(pt) {
  if (!state.data.districts) return null;
  const p = turf.point(pt);
  for (const f of state.data.districts.features) {
    try { if (turf.booleanPointInPolygon(p, f)) return f.properties.district; } catch (e) {}
  }
  return null;
}

document.getElementById("copy-link").onclick = async () => {
  syncHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied — it reopens this exact view.");
  } catch (e) {
    toast("Copy failed. The address bar already holds this view's link.");
  }
};

document.getElementById("download-view").onclick = () => {
  const f = filteredEvents();
  if (!f.length) return toast("Nothing to download — no events match the current filters.");
  const tag = `nepal-hazards_${state.yearMin}-${state.yearMax}`;
  download(`${tag}.csv`, eventsToCSV(f), "text/csv");
  download(`${tag}.geojson`,
    JSON.stringify({ type: "FeatureCollection", features: f }), "application/geo+json");
  toast(`Downloading ${fmt(f.length)} events as CSV and GeoJSON.`);
};

document.getElementById("reset-filters").onclick = () => {
  state.hazards = new Set(Object.keys(HAZARD_COLORS));
  state.yearMin = state.absMin; state.yearMax = state.absMax;
  state.preciseOnly = false;
  document.getElementById("precise-only").checked = false;
  document.getElementById("year-min").value = state.absMin;
  document.getElementById("year-max").value = state.absMax;
  document.getElementById("year-label").textContent = `${state.absMin}–${state.absMax}`;
  state.heatBoost = 1;
  document.getElementById("heat-boost").value = 1;
  document.getElementById("heat-label").textContent = "1.0×";
  applyHeatBoost();
  document.querySelectorAll("#hazard-filter .pill").forEach((b) => b.setAttribute("aria-pressed", "true"));
  refresh();      // the open area card refreshes with everything else
};

/* ------------------------------------------------------------------ misc -- */
function legendGradient(stops, metric) {
  const l = document.getElementById("legend");
  l.innerHTML = `<span class="field-label">${metric.replace(/_/g, " ")}</span>`;
  for (const [val, col] of stops)
    l.insertAdjacentHTML("beforeend",
      `<div class="row"><span class="sw" style="background:${col}"></span>≥ ${Math.round(val)}</div>`);
}
function updateStats() {
  const f = filteredEvents();
  const deaths = f.reduce((s, x) => s + (x.properties.deaths || 0), 0);
  const missing = f.reduce((s, x) => s + (x.properties.missing || 0), 0);
  const exact = f.reduce((s, x) => s + (x.properties.geo_precision === "exact" ? 1 : 0), 0);
  const pct = f.length ? Math.round((exact / f.length) * 100) : 0;
  const cell = (n, label, kind) =>
    `<div class="stat ${kind}"><span class="stat-n">${fmt(n)}</span>` +
    `<span class="stat-l">${label}</span></div>`;
  document.getElementById("stats").innerHTML =
    `<div class="stat-grid">` +
      cell(f.length, "events", "is-events") +
      cell(deaths, "deaths", "is-deaths") +
      cell(missing, "missing", "is-missing") +
    `</div>` +
    `<div class="stat-foot">` +
      `<span>${state.yearMin}–${state.yearMax}</span>` +
      `<span class="dot-sep"></span>` +
      `<span>${pct}% precisely located</span>` +
    `</div>`;

  // surface the reset affordance only when something is actually filtered
  const filtered = state.hazards.size !== Object.keys(HAZARD_COLORS).length ||
    state.yearMin !== state.absMin || state.yearMax !== state.absMax || state.preciseOnly;
  const btn = document.getElementById("reset-filters");
  if (btn) btn.hidden = !filtered;
}

loadAll();
window.NHM.stampMeta("#meta-stamp");
map.on("click", "heat-points", (e) => {
  const p = e.features[0].properties;
  const loss = [
    p.deaths ? `${fmt(p.deaths)} dead` : null,
    p.missing ? `${fmt(p.missing)} missing` : null,
  ].filter(Boolean).join(" · ") || "no casualties recorded";
  new maplibregl.Popup({ maxWidth: "280px" }).setLngLat(e.lngLat).setHTML(
    `<b style="color:${HAZARD_COLORS[p.hazard] || THEME.ink}">${hazardName(p.hazard)}</b>` +
    `<span style="color:${THEME.inkFaint}"> · ${readableDate(p.date, p.date_precision)}</span><br>` +
    `${p.title ? `<span style="color:${THEME.inkDim}">${p.title}</span><br>` : ""}` +
    `<span style="color:${THEME.inkDim}">${loss}</span><br>` +
    `<a href="event.html?id=${encodeURIComponent(p.id)}&d=${slugify(p.district || "")}">Full record →</a>`,
  ).addTo(map);
});
map.on("mouseenter", "heat-points", () => (map.getCanvas().style.cursor = "pointer"));
map.on("mouseleave", "heat-points", () => (map.getCanvas().style.cursor = ""));

/* =========================================================================
   ALERTS — recent recorded disasters + (if configured) recent rainfall from
   NASA GPM IMERG, the main trigger for landslides and flash floods. There is
   no minute-by-minute hazard feed for Nepal; "recent" means the newest BIPAD
   records, rainfall is IMERG Late daily (~1 day behind).
   ========================================================================= */
const RECENT_DAYS = 14;
const RAIN_WET_MM = 100;               // window max mm that counts as "wet" for the badge
const RAIN_STOPS = [[0, "#eef3f7"], [15, "#e0f2fe"], [50, "#bae6fd"],
                    [100, "#7dd3fc"], [150, "#38bdf8"], [220, "#0284c7"]];
function rainColor(mm) {
  let c = RAIN_STOPS[0][1];
  for (const [t, col] of RAIN_STOPS) if (mm >= t) c = col;
  return c;
}
function flyToDistrict(name) {
  const f = (state.data.districts?.features || [])
    .find((x) => x.properties.district === name);
  if (!f) return;
  try {
    const [w, s, e, n] = turf.bbox(f);
    map.fitBounds([[w, s], [e, n]], { padding: 56, maxZoom: 10, duration: 900 });
  } catch (err) { return; }
  collapsePanel();
  openAreaCard(name);
}
let RAIN = null;
let alertBuilt = false;

function daysAgo(iso, ref) {
  return Math.round((Date.parse(ref) - Date.parse(iso)) / 86400000);
}

function recentEvents() {
  if (!state.data.events) return [];
  const latest = state.data.events.features
    .reduce((m, f) => (f.properties.date > m ? f.properties.date : m), "0000");
  return state.data.events.features
    .filter((f) => f.geometry && daysAgo(f.properties.date, latest) <= RECENT_DAYS)
    .sort((a, b) =>
      b.properties.date.localeCompare(a.properties.date) ||
      (b.properties.severity_score || 0) - (a.properties.severity_score || 0));
}

function wetDistricts() {
  if (!RAIN || !RAIN.districts) return [];
  return (RAIN.wettest || Object.keys(RAIN.districts))
    .filter((n) => RAIN.districts[n] && RAIN.districts[n].mm_win_max >= RAIN_WET_MM);
}

async function initAlerts() {
  try {
    const n = await loadJSON(`${window.NHM.DATA}/rain.json`);
    RAIN = n && !n.unavailable && n.as_of ? n : null;
  } catch (e) { RAIN = null; }

  const rec = recentEvents();
  const worst = rec.find((f) =>
    ["major", "catastrophic"].includes(f.properties.severity_class)) || rec[0];

  const badge = document.getElementById("alert-badge");
  const btn = document.getElementById("alert-btn");
  const latest = rec[0] && rec[0].properties.date;
  const bigRecent = worst && ["major", "catastrophic"].includes(worst.properties.severity_class) &&
    daysAgo(worst.properties.date, latest) <= 10;
  const wet = wetDistricts();
  if (wet.length) {
    badge.textContent = String(wet.length);
    badge.hidden = false; btn.classList.add("has-alert");
  } else if (bigRecent) {
    badge.textContent = "!"; badge.hidden = false; btn.classList.add("has-alert");
  }

  btn.onclick = () => toggleAlertCard(rec, worst);
}

function toggleAlertCard(rec, worst) {
  const card = document.getElementById("alert-card");
  const btn = document.getElementById("alert-btn");
  if (!card.hidden) { card.hidden = true; btn.setAttribute("aria-expanded", "false"); return; }

  const row = (f) => {
    const p = f.properties;
    return `<button class="alert-row" data-lon="${f.geometry.coordinates[0]}" data-lat="${f.geometry.coordinates[1]}"
              data-id="${p.id}" data-d="${slugify(p.district || "")}">
      <span class="ar-date">${readableDate(p.date, p.date_precision)}</span>
      <span class="ar-haz" style="color:${HAZARD_COLORS[p.hazard] || ""}">${hazardName(p.hazard)}</span>
      <span class="ar-place">${p.district || ""}</span>
      <span class="ar-toll">${p.deaths ? p.deaths + "†" : ""}</span>
    </button>`;
  };

  let rainSec = "";
  if (RAIN) {
    const list = (RAIN.wettest || []).slice(0, 8);
    rainSec = `<h4>Rainfall, last ${RAIN.window_days} day${RAIN.window_days === 1 ? "" : "s"}
        <span class="muted">to ${RAIN.as_of}</span></h4>
      <p class="ac-note">${RAIN.source}. Recent rain is the main trigger for
        landslides and flash floods — not a hazard forecast.</p>
      <div class="rain-list">${list.map((n) => {
        const mm = Math.round(RAIN.districts[n].mm_win_max);
        return `<button class="rain-row" data-d="${n}" title="Zoom to ${n}">
          <span class="rr-sw" style="background:${rainColor(mm)}"></span>
          <span class="rr-name">${n}</span>
          <span class="rr-mm">${mm}<i>mm</i></span>
        </button>`;
      }).join("") || "<p class='ac-note'>Nothing notable.</p>"}</div>
      <div class="rain-legend">${RAIN_STOPS.slice(1).map(([t], i) => {
        const last = i === RAIN_STOPS.length - 2;
        return `<span><i style="background:${RAIN_STOPS[i + 1][1]}"></i>${t}${last ? "+" : ""}</span>`;
      }).join("")}<span class="rl-unit">mm · ${RAIN.window_days}d peak</span></div>
      <button id="rain-toggle" class="btn">Show on map</button>`;
  } else {
    rainSec = `<h4>Recent rainfall</h4>
      <p class="ac-note">Not configured. A daily rainfall layer (NASA GPM IMERG)
      can be switched on with a free Earthdata token — see
      <a href="methodology.html">methodology</a>. No live minute-by-minute feed
      exists for Nepal.</p>`;
  }

  card.innerHTML = `<button class="x" aria-label="Close">×</button>
    <h3>Alerts</h3>
    ${worst ? `<div class="ac-worst">
        <span class="ac-tag">most severe, last ${RECENT_DAYS} days</span>
        <p class="ac-worst-line"><b style="color:${HAZARD_COLORS[worst.properties.hazard]}">
          ${hazardName(worst.properties.hazard)}</b> — ${worst.properties.district}
          — ${readableDate(worst.properties.date)}${worst.properties.deaths ?
          ` — ${fmt(worst.properties.deaths)} dead` : ""}</p>
        <button class="btn ac-fly" data-lon="${worst.geometry.coordinates[0]}"
          data-lat="${worst.geometry.coordinates[1]}" data-id="${worst.properties.id}"
          data-d="${slugify(worst.properties.district || "")}">Show on map</button>
      </div>` : `<p class="ac-note">No recorded events in the last ${RECENT_DAYS} days.</p>`}
    <h4>Recorded, last ${RECENT_DAYS} days <span class="muted">(${rec.length})</span></h4>
    <div class="alert-list">${rec.slice(0, 12).map(row).join("") || "<p class='ac-note'>None.</p>"}</div>
    ${rainSec}
    <p class="ac-foot">"Latest" is the newest BIPAD record, not a real-time alert.
      Records appear hours to days after an event.</p>`;

  card.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  card.querySelector(".x").onclick = () => { card.hidden = true; btn.setAttribute("aria-expanded", "false"); };

  const fly = (el) => {
    const lon = +el.dataset.lon, lat = +el.dataset.lat;
    map.flyTo({ center: [lon, lat], zoom: 10, duration: 900 });
    collapsePanel();
    if (el.dataset.id && el.dataset.id.startsWith("desinventar")) return;
    const d = districtAt([lon, lat]);
    if (d) { openAreaCard(d); }
  };
  card.querySelectorAll(".ac-fly, .alert-row").forEach((el) => (el.onclick = () => fly(el)));
  card.querySelectorAll(".rain-row").forEach((el) => (el.onclick = () => flyToDistrict(el.dataset.d)));

  const rt = document.getElementById("rain-toggle");
  if (rt) rt.onclick = () => toggleRainLayer(rt);
}

/* rainfall overlay: tint every district by its last-window max mm (blue scale) */
function toggleRainLayer(btn) {
  if (map.getLayer("rain-fill")) {
    const vis = map.getLayoutProperty("rain-fill", "visibility") !== "none";
    map.setLayoutProperty("rain-fill", "visibility", vis ? "none" : "visible");
    map.setLayoutProperty("rain-line", "visibility", vis ? "none" : "visible");
    btn.textContent = vis ? "Show on map" : "Hide on map";
    return;
  }
  if (!state.data.districts || !RAIN) return;
  const names = [], mm = [];
  for (const [name, r] of Object.entries(RAIN.districts)) { names.push(name); mm.push(r.mm_win_max); }
  const pick = ["match", ["get", "district"]];
  names.forEach((n, i) => pick.push(n, mm[i]));
  pick.push(0);
  const fillColor = ["step", pick, "rgba(0,0,0,0)",
    15, "#e0f2fe", 50, "#bae6fd", 100, "#7dd3fc", 150, "#38bdf8", 220, "#0284c7"];
  map.addSource("rain", { type: "geojson", data: state.data.districts });
  map.addLayer({ id: "rain-fill", type: "fill", source: "rain",
    paint: { "fill-color": fillColor, "fill-opacity": 0.45 } });
  map.addLayer({ id: "rain-line", type: "line", source: "rain",
    filter: ["in", ["get", "district"], ["literal", wetDistricts()]],
    paint: { "line-color": "#0369a1", "line-width": 1.2, "line-opacity": 0.7 } });
  btn.textContent = "Hide on map";
}

/* =========================================================================
   ANALYSIS OF RISK — one-tap, location-based summary for the spot you are
   standing on. A transparent heuristic over the recorded history, recent
   IMERG rainfall and past losses. NOT a forecast.
   ========================================================================= */
const AN = {
  el: document.getElementById("analysis-modal"),
  body: null,
  open: false,
};
AN.body = AN.el.querySelector(".an-body");

function anClose() {
  AN.el.hidden = true;
  AN.open = false;
  document.getElementById("analysis-btn").setAttribute("aria-expanded", "false");
}
AN.el.querySelector(".an-x").onclick = anClose;
AN.el.querySelector(".an-scrim").onclick = anClose;
addEventListener("keydown", (e) => { if (e.key === "Escape" && AN.open) anClose(); });

function anShow() {
  AN.el.hidden = false;
  AN.open = true;
  document.getElementById("analysis-btn").setAttribute("aria-expanded", "true");
}

/* fast great-circle distance in km */
function kmBetween(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* the whole computation, given a coordinate inside Nepal */
function analysePoint(lon, lat) {
  const here = [lon, lat];
  const dName = districtAt(here);
  if (!dName) return { outside: true };

  const dix = (state.data.index && state.data.index[dName]) || null;
  const rain = (RAIN && RAIN.districts && RAIN.districts[dName]) || null;
  const nowYear = new Date().getFullYear();

  // recorded events within 20 km, any year
  const RAD = 20;
  const near = [];
  for (const f of (state.data.events ? state.data.events.features : [])) {
    if (!f.geometry) continue;
    const dist = kmBetween(here, f.geometry.coordinates);
    if (dist <= RAD) near.push({ f, km: dist });
  }
  near.sort((a, b) =>
    b.f.properties.date.localeCompare(a.f.properties.date) ||
    (b.f.properties.severity_score || 0) - (a.f.properties.severity_score || 0));
  const nNear = near.length;
  const sevSum = near.reduce((s, n) => s + (n.f.properties.severity_score || 0), 0);
  const recentNear = near.filter((n) => n.f.properties.year >= nowYear - 5).length;
  const mostRecent = near[0] ? near[0].f : null;

  // ---- composite risk score (0-100) -------------------------------------
  const cHist = clamp01(nNear / 25) * 30 + clamp01(sevSum / 400) * 8;
  const cRecent = clamp01(recentNear / 6) * 14;
  const lastYr = dix ? dix.last_year : 0;
  const cLast = lastYr >= nowYear - 1 ? 12 : lastYr >= nowYear - 3 ? 8 :
    lastYr >= nowYear - 6 ? 4 : 0;
  const cRain = rain ? clamp01(rain.mm_win_max / 180) * 26 : 0;
  const cVuln = dix ? clamp01((dix.deaths_per_100k || 0) / 300) * 14 : 0;
  let risk = Math.round(cHist + cRecent + cLast + cRain + cVuln);
  risk = Math.max(3, Math.min(97, risk));
  const band =
    risk < 20 ? { key: "low", label: "Low", col: "#16a34a" } :
    risk < 45 ? { key: "moderate", label: "Moderate", col: "#d97706" } :
    risk < 70 ? { key: "elevated", label: "Elevated", col: "#ea580c" } :
                { key: "high", label: "High", col: "#b91c1c" };

  // ---- per-hazard history in this district ------------------------------
  const bh = (dix && dix.by_hazard) || {};
  const totalD = Object.values(bh).reduce((a, b) => a + b, 0) || 1;
  const hazards = Object.entries(bh)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([h, n]) => ({ h, n, share: n / totalD }));

  // ---- "what could affect this area" -----------------------------------
  const drivers = [];
  if (rain && rain.mm_win_max >= 60) {
    drivers.push("Rain already falling — " + Math.round(rain.mm_win_max) +
      " mm in the district over the last " + RAIN.window_days +
      (RAIN.window_days === 1 ? " day." : " days."));
  }
  drivers.push("Monsoon rainfall (Jun–Sep) — the dominant trigger for every hazard below.");
  if (bh.landslide) drivers.push("Rain-triggered landslides and slope failures on steep ground.");
  if (bh.debris_flow) drivers.push("Debris flows down steep tributaries after cloudbursts.");
  if (bh.flash_flood) drivers.push("Flash flooding in small, steep catchments with little warning.");
  if (bh.flood) drivers.push("River flooding along the valley floor.");
  if (bh.glof) drivers.push("Glacial lake outburst floods (GLOF) arriving from upstream.");
  if (bh.avalanche) drivers.push("Snow and ice avalanche in the high terrain above.");
  if (drivers.length <= 2) drivers.push("Earthquake-shaken slopes staying failure-prone for years after a quake.");

  return {
    outside: false, dName, dix, rain, risk, band, hazards, drivers,
    nNear, recentNear, mostRecent, radiusKm: RAD, nowYear,
    slug: slugify(dName),
  };
}

/* staged progress bar, then the result */
function runAnalysis(lon, lat) {
  anShow();
  AN.body.innerHTML =
    '<p class="an-note">Reading your surroundings. This is a heuristic over the ' +
    'recorded history and recent rainfall — not a forecast.</p>' +
    '<div class="an-prog"><span id="an-bar"></span></div>' +
    '<p class="an-step" id="an-step">Locating you…</p>';
  const bar = document.getElementById("an-bar");
  const step = document.getElementById("an-step");
  const steps = [
    ["Pinpointing the district…", 22],
    ["Reading recent rainfall (IMERG)…", 45],
    ["Scanning recorded events within 20 km…", 72],
    ["Scoring exposure and past losses…", 92],
  ];
  let i = 0;
  requestAnimationFrame(() => (bar.style.width = "8%"));
  const tick = () => {
    if (i < steps.length) {
      step.textContent = steps[i][0];
      bar.style.width = steps[i][1] + "%";
      i++;
      setTimeout(tick, 430);
    } else {
      bar.style.width = "100%";
      setTimeout(() => {
        const data = analysePoint(lon, lat);
        renderAnalysis(data, [lon, lat]);
      }, 300);
    }
  };
  setTimeout(tick, 350);
}

function renderAnalysis(d, pt) {
  if (d.outside) {
    AN.body.innerHTML = '<p class="an-note">That location is outside Nepal. ' +
      'This analysis only covers Nepal.</p>';
    return;
  }
  const pct = d.risk;
  const hazRows = d.hazards.slice(0, 5).map((x) => {
    const w = Math.round(x.share * 100);
    return '<div class="an-haz">' +
      '<span class="an-haz-name" style="color:' + (HAZARD_COLORS[x.h] || "") + '">' + hazardName(x.h) + '</span>' +
      '<span class="an-haz-bar"><i style="width:' + Math.max(4, w) + '%;background:' + (HAZARD_COLORS[x.h] || "#888") + '"></i></span>' +
      '<span class="an-haz-n">' + fmt(x.n) + ' <em>' + w + '%</em></span>' +
      '</div>';
  }).join("") ||
    '<p class="an-note">No water- or slope-hazard events on record for this district.</p>';

  const rainLine = d.rain
    ? "Last " + RAIN.window_days + (RAIN.window_days === 1 ? " day" : " days") +
      ": <b>" + Math.round(d.rain.mm_win_max) + " mm</b> peak, " +
      Math.round(d.rain.mm_24h_max) + " mm in 24 h (district, NASA IMERG)."
    : "Rainfall layer not configured — recent-rain signal not included in the score.";

  const mr = d.mostRecent ? d.mostRecent.properties : null;
  const recentBlock = d.nNear
    ? '<p class="an-sub"><b>' + fmt(d.nNear) + "</b> recorded event" +
      (d.nNear === 1 ? "" : "s") + " within " + d.radiusKm + " km" +
      (d.recentNear ? ", " + fmt(d.recentNear) + " in the last 5 years" : "") + ". " +
      (mr ? 'Most recent: <b style="color:' + (HAZARD_COLORS[mr.hazard] || "") + '">' +
        hazardName(mr.hazard) + "</b>, " + readableDate(mr.date) +
        (mr.deaths ? " — " + fmt(mr.deaths) + " dead" : "") + "." : "") +
      "</p>"
    : '<p class="an-sub">No events recorded within ' + d.radiusKm +
      " km — but absence of a record is not absence of hazard, especially before ~2011.</p>";

  AN.body.innerHTML =
    '<div class="an-score">' +
      '<div class="an-dial" style="--c:' + d.band.col + ';--p:' + pct + '">' +
        '<span class="an-pct">' + pct + "<i>%</i></span>" +
      "</div>" +
      '<div class="an-score-txt">' +
        '<span class="an-band" style="background:' + d.band.col + '">' + d.band.label + " exposure</span>" +
        "<p><b>" + d.dName + "</b> district" +
        (d.dix ? " · " + fmt(d.dix.events) + " events on record, " + fmt(d.dix.deaths) +
          " deaths since " + d.dix.first_year : "") + ".</p>" +
        '<p class="an-note">A 0–100 blend of nearby recorded events, how recent they are, ' +
        "current rainfall and the district's past death rate. Comparative, not a probability.</p>" +
      "</div>" +
    "</div>" +

    '<div class="an-sec"><h3>Recent conditions</h3>' +
      '<p class="an-sub">' + rainLine + "</p>" + recentBlock + "</div>" +

    '<div class="an-sec"><h3>What the record shows here</h3>' + hazRows + "</div>" +

    '<div class="an-sec"><h3>What could affect this area</h3>' +
      '<ul class="an-list">' + d.drivers.map((x) => "<li>" + x + "</li>").join("") + "</ul></div>" +

    '<div class="an-cta">' +
      '<button class="btn" id="an-map">Show this spot on the map</button>' +
      '<a class="btn btn-primary" id="an-full" href="district.html?d=' +
        encodeURIComponent(d.slug) + filterQuery() + '">View full detail for ' + d.dName + " →</a>" +
    "</div>" +
    '<p class="an-foot">Heuristic research aid, not an operational warning. For official ' +
    'alerts use Nepal’s DHM and NDRRMA. <a href="methodology.html">How this is built →</a></p>';

  const mapBtn = document.getElementById("an-map");
  if (mapBtn) mapBtn.onclick = () => {
    anClose();
    map.flyTo({ center: pt, zoom: 11, duration: 900 });
    collapsePanel();
    if (d.dName) openAreaCard(d.dName);
  };
}

document.getElementById("analysis-btn").onclick = () => {
  if (!state.data.events || !state.data.index) {
    return toast("Still loading the dataset — try again in a moment.");
  }
  if (!navigator.geolocation) {
    return toast("This browser can't share a location, so the area analysis is unavailable.");
  }
  anShow();
  AN.body.innerHTML =
    '<p class="an-note">Waiting for your location. Allow the permission prompt ' +
    'to run the analysis.</p>' +
    '<div class="an-prog"><span id="an-bar" style="width:6%"></span></div>' +
    '<p class="an-step">Requesting location permission…</p>';
  navigator.geolocation.getCurrentPosition(
    (pos) => runAnalysis(pos.coords.longitude, pos.coords.latitude),
    (err) => {
      const msg = err && err.code === 1
        ? "Location permission is required for the area analysis. Enable it for this site and try again."
        : err && err.code === 3
        ? "Location timed out. Try again with a clearer view of the sky."
        : "Couldn't get your location, so the area analysis can't run.";
      anClose();
      toast(msg, 6000);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  );
};
