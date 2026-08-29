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
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
const geolocate = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true, timeout: 10000 },
  fitBoundsOptions: { maxZoom: 14 },
  trackUserLocation: false,
  showUserLocation: true,
  showAccuracyCircle: true,
});
map.addControl(geolocate, "bottom-right");
window.__map = map;                       // handy when debugging in the console

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

/* mobile bottom-sheet handle */
const panelEl = document.getElementById("panel");
function collapsePanel() {
  if (matchMedia("(max-width: 899px)").matches) panelEl.dataset.state = "peek";
}
document.getElementById("panel-handle").onclick = () => {
  panelEl.dataset.state = panelEl.dataset.state === "open" ? "peek" : "open";
};
map.on("dragstart", collapsePanel);

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
  document.getElementById("stats").innerHTML =
    `<div class="stat-row"><span class="big-num">${fmt(f.length)}</span> events` +
    `<span>· <b>${fmt(deaths)}</b> deaths</span>` +
    (missing ? `<span>· <b>${fmt(missing)}</b> missing</span>` : "") +
    `</div><span class="sub">${state.yearMin}–${state.yearMax} · ${pct}% precisely located</span>`;

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
