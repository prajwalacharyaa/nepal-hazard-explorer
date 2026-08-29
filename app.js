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
  anLoadAlerts();                      // so area cards can badge at once
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
  state.data.palikas = gj;                  // also used to place alerts
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
  state.openArea = { kind: "palika", pcode, name, at: anLngLat(lngLat) };
  renderOpenArea();
}

/* normalise whatever the caller had: a MapLibre LngLat, a pair, or nothing */
function anLngLat(l) {
  if (!l) return null;
  if (Array.isArray(l)) return [l[0], l[1]];
  if (typeof l.lng === "number") return [l.lng, l.lat];
  return null;
}

/* ------------------------------------------------------------ area card --- */
function openAreaCard(district, lngLat) {
  state.openArea = { kind: "district", district, at: anLngLat(lngLat) };
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
      at: a.at,
      title: ix ? ix.palika : a.name,
      subtitle: `${ix ? ix.district + " district · " : ""}municipality`,
      slug: ix ? slugify(ix.district) : slugify(a.name),
      feats: filteredEvents().filter((f) => f.properties.palika_pcode === a.pcode),
      allTime: ix,
    });
  } else {
    const ix = state.data.index && state.data.index[a.district];
    renderAreaCard({
      at: a.at,
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
function renderAreaCard({ title, subtitle, slug, feats, allTime, at }) {
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

  // analysing a place the user tapped uses that exact point; the area's own
  // centre keeps the button useful when the card was opened from a search
  const spot = at || areaCentre(slug, feats);
  const analyseBtn = spot
    ? `<button class="ac-analyse" type="button" title="Analyse hazard risk at this spot">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>
         </svg>Analyse</button>`
    : "";

  // an alert badge sits above the name so it reads before anything else
  const al = alertFor(a2District(subtitle, title), title);
  const alertChip = al
    ? `<div class="ac-alert lvl-${al.level}">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
           <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
         </svg>${al.label.toUpperCase()}</div>`
    : "";

  const firstOpen = card.hidden;
  card.innerHTML = `<button class="x" aria-label="Close">×</button>
    ${alertChip}
    <div class="ac-title"><h3>${title}</h3>${analyseBtn}</div>
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
  const ab = card.querySelector(".ac-analyse");
  if (ab && spot) ab.onclick = () => runAnalysis(spot[0], spot[1], title);
}

/* The card knows its title and subtitle but not always its district — for a
   municipality the subtitle carries it ("Rasuwa district · municipality"). */
function a2District(subtitle, title) {
  const m = /^(.+?)\s+district/.exec(subtitle || "");
  return m ? m[1].trim() : title;
}

/* Representative point for an area: mean of its events, else the polygon
   centroid. */
function areaCentre(slug, feats) {
  if (feats && feats.length) {
    let x = 0, y = 0, n = 0;
    for (const f of feats) {
      if (!f.geometry) continue;
      x += f.geometry.coordinates[0]; y += f.geometry.coordinates[1]; n++;
    }
    if (n) return [x / n, y / n];
  }
  const d = (state.data.districts && state.data.districts.features || [])
    .find((f) => slugify(f.properties.district) === slug);
  if (d) { try { return turf.centroid(d).geometry.coordinates; } catch (e) {} }
  return null;
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
    `<div class="row" style="margin-top:8px"><span class="sw" style="border:1.5px solid ${THEME.inkGhost || "#a79f90"};background:#fff"></span>approximate location (centroid)</div>`;
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

  // Only offer hazards the loaded data actually contains. The taxonomy has
  // seven, but BIPAD and DesInventar between them only ever emit landslide,
  // flood and avalanche — so GLOF/debris-flow pills would filter to nothing.
  const present = new Map();
  for (const f of (state.data.events ? state.data.events.features : [])) {
    const h = f.properties.hazard;
    present.set(h, (present.get(h) || 0) + 1);
  }
  const shown = Object.keys(HAZARD_COLORS).filter((h) => present.has(h));
  for (const h of shown) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill";
    b.style.color = HAZARD_COLORS[h];
    b.title = `${fmt(present.get(h))} recorded`;
    b.setAttribute("aria-pressed", String(state.hazards.has(h)));
    b.innerHTML = `<span class="dot"></span>${HAZARD_LABELS[h]}` +
      `<em class="pill-n">${fmt(present.get(h))}</em>`;
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
/* Municipality containing a point. Alerts are finer than districts, so use
   this where the layer is loaded and fall back to district where it is not. */
function palikaAt(pt) {
  const src = state.data.palikas;
  if (!src) return null;
  const p = turf.point(pt);
  for (const f of src.features) {
    try {
      if (turf.booleanPointInPolygon(p, f)) return f.properties.adm3_name;
    } catch (e) { /* skip bad geometry */ }
  }
  return null;
}

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
const RAIN_STOPS = [[0, "#eef3f7"], [15, "#e6eff2"], [50, "#c3dbe4"],
                    [100, "#93c0d0"], [150, "#5a9fb8"], [220, "#2b7793"]];
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
let RAIN_STALE = null;          // set when we had data but it is too old to use

// IMERG Late lands ~1 day behind and we sum a 3-day window, so anything past
// this is either a failed refresh or an unconfigured deploy. Either way it
// must not be presented as current, and must not feed the score.
const RAIN_MAX_AGE_DAYS = 5;

/* rain.json, rejected if it is too old to describe today. */
async function loadRain() {
  RAIN = null; RAIN_STALE = null;
  let n;
  try { n = await loadJSON(`${window.NHM.DATA}/rain.json`); }
  catch (e) { return; }
  if (!n || n.unavailable || !n.as_of) return;
  const age = Math.floor((Date.now() - Date.parse(n.as_of)) / 86400000);
  if (age > RAIN_MAX_AGE_DAYS) { RAIN_STALE = { as_of: n.as_of, age }; return; }
  RAIN = n;
}

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
  await loadRain();

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
    rainSec = RAIN_STALE
      ? `<h4>Recent rainfall</h4>
         <p class="ac-note">The rainfall feed has not refreshed since
         ${RAIN_STALE.as_of} (${RAIN_STALE.age} days ago), so it is not being
         shown or counted — stale rain is worse than none. The daily job that
         updates it has probably stopped; see
         <a href="methodology.html">methodology</a>.</p>`
      : `<h4>Recent rainfall</h4>
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
    15, "#e6eff2", 50, "#c3dbe4", 100, "#93c0d0", 150, "#5a9fb8", 220, "#2b7793"];
  map.addSource("rain", { type: "geojson", data: state.data.districts });
  map.addLayer({ id: "rain-fill", type: "fill", source: "rain",
    paint: { "fill-color": fillColor, "fill-opacity": 0.45 } });
  map.addLayer({ id: "rain-line", type: "line", source: "rain",
    filter: ["in", ["get", "district"], ["literal", wetDistricts()]],
    paint: { "line-color": "#1f5f78", "line-width": 1.2, "line-opacity": 0.7 } });
  btn.textContent = "Hide on map";
}


/* ---------------------------------------------------------------------------
   Analysis of Risk: "is this spot OK to stay tonight?"

   Counting nearby incidents on its own is useless — a flood 600 m away means
   nothing if you are 40 m above the river, and a landslide record means
   nothing on flat ground. So read the terrain under the point and gate each
   hazard on whether it can physically happen there:

     hand (height above nearest low ground)  can water reach me?
     slope + relief above                    can a slope fail onto me?
     elevation                               is there snow/ice at all?

   Only what survives the gate scores. Heuristic, not a forecast.
   ------------------------------------------------------------------------ */
const AN = {
  el: document.getElementById("analysis-modal"),
  body: null,
  open: false,
  mini: null,        // the modal's own MapLibre instance
  glof: undefined,   // cached glof.json (null once fetched-and-missing)
  corr: undefined,   // cached corridors_index.json
  surge: undefined,  // cached surge_paths.json (routed release paths)
  climate: undefined, // cached climate_context.json
  alerts: undefined,  // cached active_alerts.json
};
AN.body = AN.el.querySelector(".an-body");

function anKillMini() {
  if (AN.mini) { try { AN.mini.remove(); } catch (e) {} AN.mini = null; }
}
function anClose() {
  anKillMini();
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

/* Expiry is re-checked here against the viewer's clock: if the daily job
   stops running we show nothing rather than a stale alert. */
async function anLoadPalikas() {
  if (state.data.palikas) return state.data.palikas;
  try { state.data.palikas = await loadJSON(paths.palikas); }
  catch (e) { state.data.palikas = null; }
  return state.data.palikas;
}

async function anLoadAlerts() {
  if (AN.alerts !== undefined) return AN.alerts;
  try {
    const d = await loadJSON(`${window.NHM.DATA}/active_alerts.json`);
    const today = new Date().toISOString().slice(0, 10);
    if (d && d.alerts) {
      d.alerts = d.alerts.filter((a) => !a.expires || a.expires >= today);
      AN.alerts = d;
    } else { AN.alerts = null; }
  } catch (e) { AN.alerts = null; }
  return AN.alerts;
}

/* The alert covering a place, if any. Municipality match outranks district. */
function alertFor(district, palika) {
  if (!AN.alerts || !AN.alerts.alerts) return null;
  let best = null;
  for (const a of AN.alerts.alerts) {
    if (a.district !== district) continue;
    const inPalika = palika && (a.palikas || []).indexOf(palika) !== -1;
    const rec = Object.assign({}, a, { scope: inPalika ? "palika" : "district" });
    if (!best || (inPalika && best.scope !== "palika")) best = rec;
  }
  return best;
}

async function anLoadClimate() {
  if (AN.climate !== undefined) return AN.climate;
  try { AN.climate = await loadJSON(`${window.NHM.DATA}/climate_context.json`); }
  catch (e) { AN.climate = null; }
  return AN.climate;
}

async function anLoadSurge() {
  if (AN.surge !== undefined) return AN.surge;
  try {
    const d = await loadJSON(`${window.NHM.DATA}/surge_paths.json`);
    AN.surge = d && d.paths ? d : null;
    // a cheap bbox per route so the proximity scan can reject most of them
    if (AN.surge) {
      for (const r of AN.surge.paths) {
        let w = 180, s2 = 90, e = -180, n = -90;
        for (const c of r.path) {
          if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
          if (c[1] < s2) s2 = c[1]; if (c[1] > n) n = c[1];
        }
        r._bb = [w, s2, e, n];
      }
    }
  } catch (err) { AN.surge = null; }
  return AN.surge;
}

/* Nearest routed release path, per source kind. What matters is distance to
   the route the water would take and height above it, not distance to the
   lake — see pipeline/surge_paths.py. */
function nearestSurge(lon, lat, kinds) {
  if (!AN.surge) return null;
  const degPad = 0.09;                    // ~10 km, the widest we care about
  let best = null;
  for (const r of AN.surge.paths) {
    if (kinds.indexOf(r.kind) === -1) continue;
    const b = r._bb;
    if (lon < b[0] - degPad || lon > b[2] + degPad ||
        lat < b[1] - degPad || lat > b[3] + degPad) continue;
    // walk the vertices, tracking distance along the route as we go
    let along = 0;
    for (let i = 0; i < r.path.length; i++) {
      if (i) along += kmBetween(r.path[i - 1], r.path[i]);
      const d = kmBetween([lon, lat], r.path[i]);
      if (!best || d < best.km) {
        best = { km: d, alongKm: along, src: r, idx: i,
                 travelMin: r.travel_min ? r.travel_min[i] : null };
      }
    }
  }
  return best;
}

async function anLoadCorridors() {
  if (AN.corr !== undefined) return AN.corr;
  try { AN.corr = await loadJSON(`${window.NHM.DATA}/corridors_index.json`); }
  catch (e) { AN.corr = null; }
  return AN.corr;
}

async function anLoadGlof() {
  if (AN.glof !== undefined) return AN.glof;
  try {
    const g = await loadJSON(`${window.NHM.DATA}/glof.json`);
    AN.glof = g && g.lakes ? g : null;
  } catch (e) { AN.glof = null; }
  return AN.glof;
}

/* SRTM elevation from AWS terrarium tiles. Free, no key, CORS enabled.
   metres = (R*256 + G + B/256) - 32768. Mirrored in pipeline/terrain.py. */
const TERRAIN_Z = 12;                    // ~33 m/px at Nepal's latitude
const TERRAIN_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const lon2tile = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
const lat2tile = (lat, z) => {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
};

const anTileCache = new Map();
function anLoadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (anTileCache.has(key)) return anTileCache.get(key);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, 256, 256).data);
      } catch (e) { resolve(null); }        // tainted or decode failure
    };
    img.onerror = () => resolve(null);
    img.src = TERRAIN_URL(z, x, y);
  });
  anTileCache.set(key, p);
  return p;
}

/* Sample a square of terrain centred on (lon,lat).
   halfKm = half the box width. Returns { grid, mPerCell, n } or null. */
async function anSampleTerrain(lon, lat, halfKm, zoom) {
  const z = zoom || TERRAIN_Z;
  const scale = Math.pow(2, z);
  const mPerPx = 156543.03392 * Math.cos(lat * Math.PI / 180) / scale;
  const halfPx = Math.round((halfKm * 1000) / mPerPx);
  const cx = lon2tile(lon, z) * 256, cy = lat2tile(lat, z) * 256;

  // which tiles does the box touch?
  const x0 = Math.floor((cx - halfPx) / 256), x1 = Math.floor((cx + halfPx) / 256);
  const y0 = Math.floor((cy - halfPx) / 256), y1 = Math.floor((cy + halfPx) / 256);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 9) return null;      // sanity guard

  const tiles = new Map();
  const jobs = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      jobs.push(anLoadTile(z, tx, ty).then((d) => tiles.set(`${tx}/${ty}`, d)));
    }
  }
  await Promise.all(jobs);
  if ([...tiles.values()].every((v) => !v)) return null;

  const at = (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const d = tiles.get(`${tx}/${ty}`);
    if (!d) return null;
    const ix = ((py - ty * 256) | 0) * 256 + ((px - tx * 256) | 0);
    const o = ix * 4;
    return d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
  };

  const N = 41;                                   // 41x41 samples across the box
  const step = (halfPx * 2) / (N - 1);
  const grid = [];
  let miss = 0;
  for (let j = 0; j < N; j++) {
    const row = [];
    for (let i = 0; i < N; i++) {
      const v = at(cx - halfPx + i * step, cy - halfPx + j * step);
      if (v === null) miss++;
      row.push(v);
    }
    grid.push(row);
  }
  if (miss > N * N * 0.5) return null;
  return { grid, n: N, mPerCell: step * mPerPx, halfKm };
}

/* Turn the sampled grid into the few numbers that actually matter. */
function anTerrainStats(t) {
  const { grid, n, mPerCell } = t;
  const c = (n - 1) / 2;
  const elev = grid[c][c];
  if (elev == null) return null;

  const ring = (radiusCells) => {
    const out = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(i - c, j - c);
        if (d <= radiusCells && grid[j][i] != null) out.push({ v: grid[j][i], d });
      }
    }
    return out;
  };

  // nearest low ground within ~1.5 km — stands in for the local river/drain
  const nearCells = Math.min(c, Math.round(1500 / mPerCell));
  const near = ring(nearCells);
  const localMin = near.reduce((m, p) => Math.min(m, p.v), Infinity);
  const hand = Math.max(0, elev - localMin);        // height above nearest drainage

  // how much ground rises above you within ~1.2 km (a slide/debris source)
  const upCells = Math.min(c, Math.round(1200 / mPerCell));
  const up = ring(upCells);
  const localMax = up.reduce((m, p) => Math.max(m, p.v), -Infinity);
  const reliefUp = Math.max(0, localMax - elev);

  // slope right where you stand, from the 8 neighbours
  let maxG = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const v = grid[c + dj] && grid[c + dj][c + di];
      if (v == null) continue;
      const run = Math.hypot(di, dj) * mPerCell;
      maxG = Math.max(maxG, Math.abs(v - elev) / run);
    }
  }
  const slopeDeg = Math.atan(maxG) * 180 / Math.PI;

  // steepest ground anywhere within ~600 m (could fail *onto* you)
  const closeCells = Math.min(c, Math.round(600 / mPerCell));
  let steepNear = 0;
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      if (Math.hypot(i - c, j - c) > closeCells) continue;
      const v = grid[j][i];
      const a = grid[j][i - 1], b = grid[j][i + 1];
      const u = grid[j - 1][i], w = grid[j + 1][i];
      if (v == null || a == null || b == null || u == null || w == null) continue;
      const g = Math.hypot((b - a) / (2 * mPerCell), (w - u) / (2 * mPerCell));
      steepNear = Math.max(steepNear, Math.atan(g) * 180 / Math.PI);
    }
  }

  return {
    elev: Math.round(elev),
    hand: Math.round(hand),
    reliefUp: Math.round(reliefUp),
    slopeDeg: Math.round(slopeDeg * 10) / 10,
    steepNear: Math.round(steepNear * 10) / 10,
  };
}

/* Is there snow and ice in the ground above this point?

   Decides whether the warming numbers apply here or are just true in general.
   Coarse sample over ~18 km, because melt arrives from the catchment, not from
   the 4 km box the main terrain read uses. */
const ICE_M = 5000;        // roughly permanent snow/ice in the Nepal Himalaya
const SNOW_M = 4000;       // seasonal snow, and where thawing ground matters

function anCryosphere(t) {
  if (!t) return null;
  const { grid, n } = t;
  let peak = -Infinity, ice = 0, snow = 0, count = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = grid[j][i];
      if (v == null) continue;
      count++;
      if (v > peak) peak = v;
      if (v >= ICE_M) ice++;
      if (v >= SNOW_M) snow++;
    }
  }
  if (!count) return null;
  return {
    peak: Math.round(peak),
    iceFrac: ice / count,
    snowFrac: snow / count,
    radiusKm: t.halfKm,
  };
}

/* Each hazard gets its own radius (the physics differs) plus a 0-1 terrain
   gate. Recorded history only counts after it clears the gate. */
const HAZ_RADIUS_KM = {          // how far away a record still says something
  landslide: 2.0,
  debris_flow: 2.5,
  flash_flood: 3.0,
  flood: 2.5,
  glof: 6.0,
  avalanche: 3.0,
  other: 2.5,
};
const CONTEXT_KM = 8;            // what the mini-map shows

/* Per hazard:
     p     0..1 plausibility, gates whether nearby history counts
     base  0..1 from the landform alone, so a 30 deg slope is flagged even
           where nobody filed a report
     why   the sentence shown in the panel */
function anGate(hz, T) {
  if (!T) return { p: 0.65, base: 0, why: "terrain unknown" };

  const { hand, slopeDeg, steepNear, reliefUp, elev } = T;

  switch (hz) {
    case "flood": {
      // water has to climb to you. HAND is the whole story.
      const p = hand <= 4 ? 1 : hand <= 10 ? 0.8 : hand <= 20 ? 0.45 :
                hand <= 35 ? 0.18 : hand <= 55 ? 0.06 : 0.02;
      const base = hand <= 3 ? 0.32 : hand <= 8 ? 0.18 : 0;
      return { p, base, why: hand <= 10
        ? `you are only ${hand} m above the nearest low ground`
        : `you are ${hand} m above the nearest low ground` };
    }
    case "flash_flood":
    case "debris_flow": {
      // needs a steep catchment above AND you low enough to be in its path
      const pH = hand <= 8 ? 1 : hand <= 20 ? 0.7 : hand <= 40 ? 0.3 : 0.07;
      const pR = reliefUp >= 400 ? 1 : reliefUp >= 150 ? 0.7 : reliefUp >= 60 ? 0.3 : 0.08;
      const p = pH * pR;
      const base = p >= 0.6 ? 0.3 : p >= 0.3 ? 0.16 : 0;
      return { p, base, why: reliefUp < 60
        ? "no steep ground rises above you"
        : `${fmt(reliefUp)} m of ground rises above you, and you sit ${hand} m above the channel` };
    }
    case "landslide": {
      const pS = slopeDeg >= 20 ? 1 : slopeDeg >= 12 ? 0.75 : slopeDeg >= 6 ? 0.35 : 0.08;
      const pN = steepNear >= 25 ? 1 : steepNear >= 15 ? 0.65 : steepNear >= 8 ? 0.3 : 0.07;
      const p = Math.max(pS, pN * 0.85);
      // steep ground is dangerous whether or not a report was ever filed
      const worst = Math.max(slopeDeg, steepNear * 0.8);
      const base = worst >= 32 ? 0.5 : worst >= 25 ? 0.36 : worst >= 18 ? 0.22 :
                   worst >= 12 ? 0.1 : 0;
      return { p, base, why: Math.max(slopeDeg, steepNear) < 8
        ? "the ground here is flat, with nothing steep close by"
        : `slope ${slopeDeg}° here, up to ${steepNear}° within 600 m` };
    }
    case "glof": {
      // Two independent conditions, both required: the surge has to come past
      // you at all (are you near the route it would take?), and it has to be
      // able to climb to you (how high above that channel are you?).
      const S = T.surge;
      const pNear = !S ? 0.25              // no routing data: stay neutral
        : S.km <= 0.7 ? 1 : S.km <= 1.5 ? 0.75 : S.km <= 3 ? 0.35
        : S.km <= 6 ? 0.1 : 0.02;
      const pHigh = hand <= 10 ? 1 : hand <= 25 ? 0.65 : hand <= 45 ? 0.25
        : hand <= 80 ? 0.06 : 0.01;
      const why = !S
        ? `you are ${hand} m above the valley floor`
        : S.km > 3
          ? `the nearest routed outburst path runs ${S.km.toFixed(1)} km away`
          : `you are ${hand} m above a channel that carries the ` +
            `${S.src.name} outburst route`;
      return { p: pNear * pHigh, base: 0, why };
    }
    case "avalanche": {
      const p = elev >= 3500 ? 1 : elev >= 2800 ? 0.5 : elev >= 2200 ? 0.12 : 0.01;
      const base = elev >= 3500 && steepNear >= 25 ? 0.3 : 0;
      return { p, base, why: `you are at ${fmt(elev)} m` };
    }
    default:
      return { p: 0.5, base: 0, why: "" };
  }
}

function analysePoint(lon, lat, T) {
  const here = [lon, lat];
  const dName = districtAt(here);
  if (!dName) return { outside: true };
  const nowYear = new Date().getFullYear();

  // everything within the context radius, tagged with distance
  const near = [];
  for (const f of (state.data.events ? state.data.events.features : [])) {
    if (!f.geometry) continue;
    const km = kmBetween(here, f.geometry.coordinates);
    if (km <= CONTEXT_KM) near.push({ f, km, p: f.properties });
  }
  near.sort((a, b) => a.km - b.km);

  const rain = (RAIN && RAIN.districts && RAIN.districts[dName]) || null;
  const rainMM = rain ? rain.mm_win_max : null;

  // routed release paths: which one passes closest, and how far downstream
  const surgeGlof = nearestSurge(lon, lat, ["glacial_lake"]);
  const surgeDam = nearestSurge(lon, lat, ["dam", "weir", "hydropower"]);
  if (T) T.surge = surgeGlof;

  const lakes = (AN.glof && AN.glof.lakes || []).filter(
    (l) => (l.downstream_districts || []).indexOf(dName) !== -1);
  const glofActive = lakes.some(
    (l) => l.trend === "growing" || (l.past_glof && l.past_glof !== "none recorded"));

  // ---- per hazard: history in ITS radius, then gated by terrain ---------
  const hazards = [];
  for (const hz of ["landslide", "flash_flood", "debris_flow", "flood", "glof", "avalanche"]) {
    const R = HAZ_RADIUS_KM[hz] || 2.5;
    const hits = near.filter((n) => n.p.hazard === hz && n.km <= R);
    const gate = anGate(hz, T);
    if (hz === "glof" && !lakes.length && !hits.length) continue;

    // recency- and proximity-weighted history, 0..1
    let hist = 0;
    for (const n of hits) {
      const age = nowYear - (n.p.year || nowYear);
      const wAge = age <= 3 ? 1 : age <= 10 ? 0.6 : age <= 25 ? 0.3 : 0.15;
      const wDist = 1 - clamp01(n.km / R) * 0.65;
      const wSev = 1 + clamp01((n.p.severity_score || 0) / 150) * 0.8;
      hist += wAge * wDist * wSev;
    }
    hist = clamp01(hist / 5);

    // A lake upstream is a hazard SOURCE, not a reach. Whether its surge can
    // get to you is still a terrain question, so this must be gated too —
    // ungated it told someone 649 m up a valley side that a GLOF was likely.
    let base = gate.base || 0;
    if (hz === "glof" && (lakes.length || surgeGlof)) {
      base = Math.max(base, (glofActive ? 0.55 : 0.3) * gate.p);
    }

    // history is gated by terrain; the landform score already came from it
    const score = clamp01(Math.max(hist * gate.p, base));
    if (score < 0.02 && !hits.length && !base) continue;
    hazards.push({
      hz, score, gate: gate.p, base, why: gate.why, n: hits.length, radiusKm: R,
      // only landform-derived hazards may claim "the ground itself is the
      // concern"; a GLOF score comes from an inventory, not from your slope
      terrainLed: (gate.base || 0) > 0 && (gate.base || 0) >= hist * gate.p,
      nearest: hits[0] || null,
      lake: hz === "glof" && lakes.length ? lakes[0] : null,
    });
  }
  // A structure upstream is a separate mechanism from a glacial lake: it can
  // fail, and it can also release a surge under operation. This is never a
  // prediction that it will — only that one sits on the reach above you.
  if (surgeDam && T) {
    const pNear = surgeDam.km <= 0.7 ? 1 : surgeDam.km <= 1.5 ? 0.7
      : surgeDam.km <= 3 ? 0.3 : surgeDam.km <= 6 ? 0.08 : 0.02;
    const pHigh = T.hand <= 10 ? 1 : T.hand <= 25 ? 0.6 : T.hand <= 45 ? 0.2 : 0.03;
    const score = clamp01(pNear * pHigh * 0.55);
    if (score >= 0.04) {
      hazards.push({
        hz: "dam_release", score, gate: pNear * pHigh, base: 0, n: 0,
        radiusKm: 6, terrainLed: false, nearest: null, lake: null,
        surge: surgeDam,
        why: `${/^unnamed/i.test(surgeDam.src.name) ? "an " : ""}${surgeDam.src.name} ` +
             `sits about ${surgeDam.alongKm.toFixed(0)} km upstream on this ` +
             `channel; you are ${T.hand} m above it`,
      });
    }
  }

  // A warming climate does not make flat ground steep or lift you out of a
  // valley — it loads the melt-driven mechanisms specifically, and only where
  // there is snow and ice above you to melt in the first place.
  const cryo = T && T.cryo;
  const meltUplift = cryo && cryo.iceFrac > 0.01
    ? Math.min(0.28, cryo.iceFrac * 1.6)
    : cryo && cryo.snowFrac > 0.05 ? Math.min(0.12, cryo.snowFrac * 0.5) : 0;
  for (const h of hazards) {
    if (h.gate < 0.1) continue;                 // still cannot reach you
    let uplift = 0;
    if (h.hz === "glof") {
      // A GLOF's melt driver sits at the lake, not under your feet — you can
      // be 100 km downstream in a warm valley and still be on its route. Use
      // the source lake's own trend.
      const src = surgeGlof && surgeGlof.src;
      uplift = src && src.trend === "growing" ? 0.25
        : src ? 0.12 : meltUplift;
    } else if (["flash_flood", "debris_flow", "avalanche"].indexOf(h.hz) !== -1) {
      uplift = meltUplift;
    }
    if (uplift <= 0) continue;
    const before = h.score;
    h.score = clamp01(h.score * (1 + uplift));
    h.meltUplift = h.score - before;
  }

  hazards.sort((a, b) => b.score - a.score);
  const live = hazards.filter((h) => h.score >= 0.12);

  // ---- rain multiplies what is already plausible, it is not risk alone --
  const rainF = rainMM == null ? 0 : clamp01((rainMM - 20) / 130);
  const topScore = hazards.length ? hazards[0].score : 0;
  const secondary = hazards.slice(1).reduce((s, h) => s + h.score, 0);
  const combined = clamp01(topScore + secondary * 0.35);
  const risk = Math.max(2, Math.min(98,
    Math.round(combined * 74 + combined * rainF * 22 + rainF * 4)));

  // An area still recovering from a serious hit is at raised risk for reasons
  // terrain cannot see: saturated ground, a blocked or re-routed channel,
  // debris perched upslope, damaged infrastructure. The alert decays and
  // expires on its own, so this lifts and then lets go by itself.
  const palikaHere = palikaAt(here);
  const alert = alertFor(dName, palikaHere);
  if (alert) {
    const eff = (AN.alerts.effects || {})[alert.level] || { floor: 0, boost: 0 };
    const scope = alert.scope === "palika" ? 1 : 0.7;   // district-wide is broader
    for (const h of hazards) {
      if (h.gate < 0.08) continue;                      // still cannot reach you
      const same = alert.hazard && h.hz === alert.hazard;
      const b = eff.boost * scope * (same ? 1 : 0.55);
      const before = h.score;
      h.score = clamp01(h.score + b * (1 - h.score));
      h.alertBoost = h.score - before;
    }
    hazards.sort((a, b) => b.score - a.score);
  }

  // ground that is intrinsically hazardous cannot read as "mostly fine",
  // however quiet the reporting record happens to be
  const terrainLed = hazards.some((h) => h.terrainLed && h.score >= 0.45);
  const alertFloor = alert
    ? Math.round((((AN.alerts.effects || {})[alert.level] || {}).floor || 0) *
                 (alert.scope === "palika" ? 1 : 0.85))
    : 0;
  const floor = Math.max(terrainLed ? 40 : 0, alertFloor);
  const shown = Math.max(risk, floor);

  const band =
    shown < 18 ? { k: "low", label: "Looks safe", col: "#3f7d55" } :
    shown < 40 ? { k: "watch", label: "Mostly fine", col: "#65a30d" } :
    shown < 62 ? { k: "care", label: "Take care", col: "#c05f2b" } :
                 { k: "high", label: "High concern", col: "#9b2a24" };

  // ---- one-line verdict, written from the terrain -----------------------
  let verdict;
  const top = live[0] || null;
  const topName = top ? anHazLabel(top.hz).toLowerCase() : null;
  if (!top) {
    verdict = T
      ? `Nothing here can realistically reach you: ${T.hand} m above the nearest low ground, ` +
        `on ${T.slopeDeg}° ground. Nearby records are for terrain unlike yours.`
      : `No plausible local hazard stands out.`;
  } else if (top.terrainLed) {
    // flagged by the landform itself, not by anyone's report
    verdict = `The ground itself is the concern: ${top.why}. That is ${topName} terrain, ` +
      `whether or not anything was ever reported here` +
      (rainMM >= 60 ? `, and rain is falling now` : ``) + `.`;
  } else if (band.k === "low") {
    verdict = `Low exposure. Some ${topName} history nearby, but the ground you are on makes it unlikely.`;
  } else if (band.k === "watch") {
    verdict = `Mostly fine. ${topName[0].toUpperCase() + topName.slice(1)} is the one worth knowing about here.`;
  } else if (band.k === "care") {
    verdict = `The terrain here does support ${topName}` +
      (rainMM >= 60 ? `, and rain is falling now` : ``) + `. Know your way to higher ground.`;
  } else {
    verdict = `Real ${topName} exposure at this spot` +
      (rainMM >= 60 ? ` with active heavy rain` : ``) +
      `. Reconsider staying if conditions worsen.`;
  }

  // ---- three chips ------------------------------------------------------
  const rainLvl = rainMM == null ? "n/a" : rainMM >= 90 ? "high" : rainMM >= 40 ? "med" : "low";
  const groundLvl = !T ? "n/a" : T.hand >= 30 && T.slopeDeg < 8 ? "low"
    : T.hand >= 12 || T.slopeDeg < 15 ? "med" : "high";
  const histLvl = !live.length ? "low" : live[0].score >= 0.5 ? "high"
    : live[0].score >= 0.25 ? "med" : "low";
  const factors = [
    { key: "Your ground", lvl: groundLvl,
      text: T ? `${fmt(T.elev)} m · +${T.hand} m over low · ${T.slopeDeg}°` : "elevation unavailable" },
    { key: "Rain now", lvl: rainLvl,
      text: rainMM != null ? `${Math.round(rainMM)} mm / ${RAIN.window_days}d`
        : RAIN_STALE ? `feed stale, not counted` : "not configured" },
    { key: "Plausible here", lvl: histLvl,
      text: live.length ? live.map((h) => anHazLabel(h.hz)).slice(0, 2).join(", ") : "nothing significant" },
  ];

  return {
    outside: false, here, dName, palika: palikaHere, slug: slugify(dName), T,
    alert, cryo, meltUplift, climate: AN.climate,
    risk: shown, band, verdict, factors,
    hazards, live, rainMM, lakes,
    nearList: near.slice(0, 40),
    recentList: near.filter((n) => {
      const h = hazards.find((x) => x.hz === n.p.hazard);
      return n.p.year >= nowYear - 15 && h && h.gate >= 0.25 && n.km <= (h.radiusKm + 1);
    }).slice(0, 3),
    anyRecent: near.filter((n) => n.p.year >= nowYear - 15).slice(0, 3),
  };
}

/* ---- staged progress, then result ------------------------------------ */
async function runAnalysis(lon, lat, placeLabel) {
  anShow();
  AN.place = placeLabel || null;
  AN.body.innerHTML =
    '<p class="an-note">Checking the ground you are standing on — elevation, ' +
    'slope, rain and what has actually happened nearby.</p>' +
    '<div class="an-prog"><span id="an-bar"></span></div>' +
    '<p class="an-step" id="an-step">Locating you…</p>';
  const bar = document.getElementById("an-bar");
  const step = document.getElementById("an-step");
  const set = (msg, pct) => { if (step) step.textContent = msg; if (bar) bar.style.width = pct + "%"; };

  set("Finding your exact spot…", 14);
  await new Promise((r) => setTimeout(r, 260));

  set("Reading the terrain under you (SRTM)…", 30);
  let T = null;
  try {
    const sampled = await anSampleTerrain(lon, lat, 2.0);
    if (sampled) T = anTerrainStats(sampled);
  } catch (e) { T = null; }

  set("Looking for snow and ice in the ground above…", 46);
  try {
    // coarse, wide sample: is there a cryosphere upstream of this spot?
    const wide = await anSampleTerrain(lon, lat, 18, 10);
    if (T && wide) T.cryo = anCryosphere(wide);
  } catch (e) { /* optional */ }

  set("Reading rain over the last few days…", 58);
  await Promise.all([anLoadGlof(), anLoadCorridors(), anLoadSurge(),
                     anLoadClimate(), anLoadAlerts(), anLoadPalikas()]);
  await new Promise((r) => setTimeout(r, 240));

  set("Matching hazards to your slope and height…", 82);
  await new Promise((r) => setTimeout(r, 300));

  set("Scoring…", 100);
  setTimeout(() => renderAnalysis(analysePoint(lon, lat, T)), 260);
}

/* dam_release is ours, not a hazard type from the data, so it needs its own
   label and colour */
/* Deliberately vague wording — this must not read as a countdown. */
function anWarning(min) {
  if (min == null) return "";
  if (min < 10) return "under 10 minutes";
  if (min < 90) return `roughly ${Math.round(min / 5) * 5} minutes`;
  const h = min / 60;
  return h < 10 ? `roughly ${h.toFixed(1)} hours` : `many hours`;
}

const anHazLabel = (hz) => hz === "dam_release" ? "Dam or weir release" : hazardName(hz);
const anHazColor = (hz) => hz === "dam_release" ? "#5c5fa8" : (HAZARD_COLORS[hz] || "#888");

/* The chain of events by name — not just how likely, but by what route. */
function anMechanism(h, d) {
  const T = d.T;
  switch (h.hz) {
    case "glof": {
      const S = h.surge || (T && T.surge);
      if (!S) return "A moraine- or ice-dammed lake fails upstream and the surge travels down the valley.";
      const w = anWarning(S.travelMin);
      const grew = S.src.growth_pct != null && S.src.growth_pct > 5
        ? ` It grew <b>${S.src.growth_pct.toFixed(0)}%</b> in mapped area between ` +
          `2016 and 2022${S.src.km2 ? `, and now covers ${S.src.km2} km²` : ""}.`
        : S.src.km2 ? ` It covers about ${S.src.km2} km².` : "";
      return `${S.src.name} sits about ${S.alongKm.toFixed(0)} km upstream along ` +
        `this channel. If its dam failed — overtopped by an ice or rock fall into ` +
        `the lake, or eroded through the moraine — the surge would route down ` +
        (S.src.river ? S.src.river : "this river") +
        (w ? `, reaching here in <b>${w}</b>` : "") +
        `, arriving as a wall of water and debris rather than a rising river.` + grew;
    }
    case "dam_release": {
      const S = h.surge;
      const who = /^unnamed/i.test(S.src.name)
        ? `An ${S.src.detail}` : `${S.src.name} (${S.src.detail})`;
      const w2 = anWarning(S.travelMin);
      return `${who} sits about ${S.alongKm.toFixed(0)} km ` +
        `upstream${w2 ? ` — a release would reach here in <b>${w2}</b>` : ""}. ` +
        `A structure can release suddenly — a gate opening, an overtopping ` +
        `during a flood peak, or a failure — and anything arriving from further ` +
        `upstream, including an outburst, hits the impoundment first. Being ` +
        `${T ? T.hand : "?"} m above the channel is what decides whether that ` +
        `reaches you.`;
    }
    case "landslide":
      return `Prolonged or intense rain saturates the slope until it fails. ` +
        `On ${T ? T.slopeDeg : "steep"}° ground the failure arrives in seconds, ` +
        `and cut slopes, road benches and terraced ground fail first.`;
    case "debris_flow":
      return `Rain mobilises loose material in a steep side channel, which ` +
        `picks up boulders and water as it descends and arrives as a fast slurry, ` +
        `not as clear water.`;
    case "flash_flood":
      return `A cloudburst over the catchment above concentrates into the ` +
        `nearest channel. The rain need not fall on you — the water arrives ` +
        `from upstream, often within minutes and under a clear sky.`;
    case "flood":
      return `Sustained rain raises the river until it leaves its channel and ` +
        `spreads across the low ground you are on.`;
    case "avalanche":
      return `New snow or a warming slope releases above you and runs out into ` +
        `the valley below.`;
    default:
      return "";
  }
}

function facChip(f) {
  const dot = { low: "#3f7d55", med: "#bd8526", high: "#9b2a24", "n/a": "#a79f90" }[f.lvl];
  return '<div class="an-fac"><span class="an-fac-dot" style="background:' + dot + '"></span>' +
    '<span class="an-fac-k">' + f.key + '</span>' +
    '<span class="an-fac-t">' + f.text + '</span></div>';
}

/* Warming context, shown only where it is relevant to this spot. */
function anClimateSection(d) {
  const C = d.climate;
  if (!C || !C.warming) return "";
  const w = C.warming;
  const cryo = d.cryo;
  const melt = d.hazards.filter((h) => h.meltUplift > 0.01);

  const hasIce = cryo && cryo.iceFrac > 0.01;
  const hasSnow = cryo && cryo.snowFrac > 0.05;
  const srcLake = d.T && d.T.surge && d.T.surge.src;
  const growingSource = srcLake && srcLake.trend === "growing";

  let local;
  if (hasIce) {
    local = `Ground above ${fmt(ICE_M)} m — permanent snow and ice — covers about ` +
      `<b>${Math.round(cryo.iceFrac * 100)}%</b> of the catchment within ` +
      `${cryo.radiusKm} km of you, topping out at <b>${fmt(cryo.peak)} m</b>. ` +
      `That is the meltwater and the moraine-dammed lakes that feed the ` +
      `mechanisms above.`;
  } else if (hasSnow) {
    local = `No permanent ice above you, but about ` +
      `<b>${Math.round(cryo.snowFrac * 100)}%</b> of the surrounding ground is ` +
      `over ${fmt(SNOW_M)} m and takes seasonal snow, peaking at ` +
      `<b>${fmt(cryo.peak)} m</b>. Warming shifts that from snow to rain, which ` +
      `runs off immediately instead of being held until spring.`;
  } else if (growingSource) {
    local = `No snow or ice in the ground immediately above you — but you sit on ` +
      `the routed path of <b>${srcLake.name}</b>, a glacial lake that is ` +
      `<b>growing</b>. The melt driving that growth is ${Math.round(d.T.surge.alongKm)} km ` +
      `upstream, and the water would arrive here regardless.`;
  } else {
    local = `There is no snow or ice in the ground above you ` +
      `(it peaks at <b>${fmt(cryo ? cryo.peak : 0)} m</b>) and no growing lake ` +
      `upstream, so melt-driven hazards are not part of this spot's picture — ` +
      `the warming below is context for the country, not for this location.`;
  }

  const lk = C.glacial_lakes || {};
  const inv = C.inventory;
  const growing = inv ? inv.grown_over_10pct : ((lk.by_trend && lk.by_trend.growing) || 0);
  const lakeTotal = inv ? inv.with_growth_measured : (lk.total || 0);

  const upliftLine = melt.length
    ? `<p class="an-sub">This is why <b>${melt.map((h) => anHazLabel(h.hz).toLowerCase())
        .join("</b> and <b>")}</b> above ${melt.length === 1 ? "is" : "are"} scored ` +
      `higher here than the historical record alone would suggest.</p>`
    : "";

  return '<div class="an-sec"><h3>Why this is changing</h3>' +
    '<div class="an-climate">' +
      '<div class="an-cl-stat"><b>' + (w.anomaly_c > 0 ? "+" : "") + w.anomaly_c +
        '&thinsp;°C</b><span>vs ' + w.baseline + '</span></div>' +
      '<div class="an-cl-stat"><b>+' + w.freezing_level_shift_m +
        '&thinsp;m</b><span>freezing level</span></div>' +
      '<div class="an-cl-stat"><b>' + growing + '/' + lakeTotal +
        '</b><span>lakes grown &gt;10%</span></div>' +
    '</div>' +
    '<p class="an-sub">' + local + '</p>' +
    upliftLine +
    '<p class="an-note">Nepal has warmed <b>' + w.anomaly_c + '&thinsp;°C</b> against its ' +
      w.baseline + ' baseline and is warming <b>' +
      w.trend_c_per_decade.since_1995 + '&thinsp;°C per decade</b> since 1995 — faster ' +
      'than the ' + w.trend_c_per_decade.since_1951 + ' of the second half of the ' +
      'last century. At a standard lapse rate that lifts the freezing level about ' +
      w.freezing_level_shift_m + '&thinsp;m, so slopes that used to collect snow now ' +
      'shed rain, and glacial lakes grow behind moraine dams nobody engineered. ' +
      'Source: ' + w.source + '.</p>' +
    '<p class="an-note">Our own record cannot confirm a rising trend in these ' +
      'hazards: melt-linked events are a <i>falling</i> share of all recorded ' +
      'events, but that is because flood and landslide reporting grew enormously ' +
      'after 2011 while remote high-altitude events stayed under-reported. Small ' +
      'numbers, uneven coverage — the physics above is the better guide than the ' +
      'count.</p>' +
  '</div>';
}

function renderAnalysis(d) {
  if (d.outside) {
    AN.body.innerHTML = '<p class="an-note">That location is outside Nepal. ' +
      'This check only covers Nepal.</p>';
    return;
  }

  // --- what could happen, ranked, each with its terrain reason ----------
  const hazRows = d.hazards.slice(0, 5).map((h) => {
    const col = anHazColor(h.hz);
    const pct = Math.round(h.score * 100);
    const lvl = h.score >= 0.5 ? "Likely enough to plan for"
      : h.score >= 0.25 ? "Possible here"
      : h.score >= 0.12 ? "Low but not zero"
      : "Very unlikely here";
    const hist = h.n
      ? `${h.n} recorded within ${h.radiusKm} km`
      : h.surge ? `routed along the real river network`
      : h.terrainLed ? "flagged by the landform, not by a report"
      : "nothing recorded nearby";
    // the mechanism is worth the space on anything actually plausible
    const mech = h.score >= 0.12
      ? '<span class="an-hz-mech">' + anMechanism(h, d) +
        (h.alertBoost > 0.02
          ? ' <b>Raised while this area is under alert.</b>' : "") +
        '</span>' : "";
    return '<div class="an-hz">' +
      '<span class="an-hz-bar"><i style="height:' + Math.max(5, pct) + '%;background:' + col + '"></i></span>' +
      '<span class="an-hz-txt">' +
        '<span class="an-hz-top"><b style="color:' + col + '">' + anHazLabel(h.hz) + '</b>' +
        '<em>' + lvl + '</em></span>' +
        '<span class="an-hz-why">' + h.why + ' · ' + hist + '</span>' +
        mech +
      '</span></div>';
  }).join("") ||
    '<p class="an-note">No water- or slope-hazard record within range of this spot.</p>';

  const recentSrc = d.recentList.length ? d.recentList : d.anyRecent;
  const recentHead = d.recentList.length ? "Recently near here"
    : "Nearby records (different terrain to yours)";
  const recent = recentSrc.length
    ? recentSrc.map((n) => {
        const p = n.p;
        const col = HAZARD_COLORS[p.hazard] || "#888";
        // the impact view is the richer destination — zoomed map, downstream
        // corridor and flow animation — so prefer it wherever one was traced
        const hasCorr = AN.corr && AN.corr[p.id];
        const page = hasCorr ? 'impact.html' : 'event.html';
        const href = page + '?id=' + encodeURIComponent(p.id) +
          '&d=' + slugify(p.district || "");
        const tip = hasCorr
          ? 'Open the full view: map, ' + AN.corr[p.id].length_km + ' km corridor and flow animation'
          : 'Open this record';
        return '<li><a href="' + href + '" target="_blank" rel="noopener" title="' + tip + '">' +
          '<span class="anr-dot" style="background:' + col + '"></span>' +
          '<span class="anr-main">' +
            '<span class="anr-haz" style="color:' + col + '">' + hazardName(p.hazard) + '</span>' +
            '<span class="anr-meta">' + readableDate(p.date) +
            (p.deaths ? ' · ' + fmt(p.deaths) + ' dead' : "") + '</span>' +
          '</span>' +
          '<span class="anr-km">' + n.km.toFixed(1) + '<i>km</i></span>' +
          '<span class="anr-go" title="' + tip + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>' +
        '</a></li>';
      }).join("")
    : '<li class="anr-none">Nothing recorded within ' + CONTEXT_KM +
      ' km in the last 15 years. Pre-2011 records are sparse, so stay alert anyway.</li>';

  const terrainLine = d.T
    ? `You are at <b>${fmt(d.T.elev)} m</b>, <b>${d.T.hand} m</b> above the nearest low ground, ` +
      `on a <b>${d.T.slopeDeg}°</b> slope` +
      (d.T.reliefUp >= 60 ? `, with ${fmt(d.T.reliefUp)} m of ground rising above you.` : `, with nothing steep above you.`)
    : `Elevation data could not be loaded, so hazards could not be gated on terrain — ` +
      `the score below leans on nearby records alone and will overstate risk on high, flat ground.`;

  const alertBanner = d.alert ? (function () {
    const a = d.alert;
    const until = a.expires;
    const where = a.scope === "palika" && d.palika
      ? `${d.palika}, ${a.district} district` : `${a.district} district`;
    const what = a.hazard
      ? `${hazardName(a.hazard).toLowerCase()} on ${readableDate(a.event_date)}`
      : `an event on ${readableDate(a.event_date)}`;
    const toll = a.deaths || a.missing
      ? ` (${[a.deaths ? fmt(a.deaths) + " dead" : "",
              a.missing ? fmt(a.missing) + " missing" : ""]
             .filter(Boolean).join(", ")})` : "";
    return '<div class="an-alert lvl-' + a.level + '">' +
      '<span class="an-alert-ico" aria-hidden="true">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
        '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
      '</span>' +
      '<span class="an-alert-txt"><b>' + a.label.toUpperCase() + '</b>' +
        '<span>' + where + ' — after ' + what + toll + ', ' + a.days_since +
        ' day' + (a.days_since === 1 ? "" : "s") + ' ago. Ground stays unstable ' +
        'and channels stay blocked while an area recovers. Steps down and clears ' +
        'by ' + until + ' unless something new happens.</span></span>' +
    '</div>';
  }()) : "";

  AN.body.innerHTML = alertBanner +
    '<div class="an-verdict an-b-' + d.band.k + '">' +
      '<div class="an-dial" style="--c:' + d.band.col + ';--p:' + d.risk + '">' +
        '<span class="an-pct">' + d.risk + '<i>%</i></span></div>' +
      '<div class="an-verdict-txt">' +
        '<span class="an-band" style="background:' + d.band.col + '">' + d.band.label + '</span>' +
        '<p>' + d.verdict + '</p>' +
        '<p class="an-note">' + (AN.place && AN.place !== d.dName
          ? AN.place + ' · ' + d.dName + ' district'
          : d.dName + ' district') + '</p>' +
      '</div>' +
    '</div>' +

    '<div class="an-facs">' + d.factors.map(facChip).join("") + '</div>' +

    '<p class="an-terrain">' + terrainLine + '</p>' +

    '<div class="an-sec"><h3>What could actually happen here</h3>' + hazRows +
      '<p class="an-note">Ranked by how possible each is <em>at your spot</em> — a record ' +
      'nearby only counts if the terrain under you could produce the same thing.</p></div>' +

    anClimateSection(d) +

    '<div class="an-sec"><h3>Affected area around you</h3>' +
      '<div class="an-map-box" id="an-map-box"></div>' +
      '<p class="an-maplegend">Heat = concentration of past incidents. Dots are the ' +
        'individual records, coloured by type, bigger = worse. ' +
        'Ring = 2 km around you.' +
        (d.hazards.some((h) => (h.surge || (h.hz === "glof" && d.T && d.T.surge)) && h.score >= 0.1)
          ? ' The dashed line is the route a sudden release would take down the river network.'
          : '') + '</p>' +
    '</div>' +

    '<div class="an-sec"><h3>' + recentHead + '</h3><ul class="an-recent">' + recent + '</ul></div>' +

    '<a class="btn btn-primary an-full" href="district.html?d=' +
      encodeURIComponent(d.slug) + filterQuery() + '">Open the full history for this area →</a>' +
    '<p class="an-foot">A terrain-aware heuristic, not an operational warning. Elevation is ' +
    'SRTM 30 m, so it misses embankments, walls and anything built since 2000. ' +
    'For official alerts use Nepal’s DHM and NDRRMA. ' +
    '<a href="methodology.html">How this is built →</a></p>';

  buildAnMiniMap(d);
}

/* the small heat/hazard map inside the modal */
function buildAnMiniMap(d) {
  anKillMini();
  const box = document.getElementById("an-map-box");
  if (!box || typeof maplibregl === "undefined") return;

  const feats = d.nearList.map((n) => ({
    type: "Feature",
    geometry: n.f.geometry,
    properties: { hazard: n.f.properties.hazard, sev: n.f.properties.severity_score || 1 },
  }));
  const ring = turf.circle(d.here, 2, { steps: 64, units: "kilometers" });
  const bb = turf.bbox(turf.circle(d.here, 2.6, { units: "kilometers" }));

  const m = new maplibregl.Map({
    container: box, style: MAP_STYLE, attributionControl: false,
    bounds: [[bb[0], bb[1]], [bb[2], bb[3]]], fitBoundsOptions: { padding: 12 },
    dragRotate: false, pitchWithRotate: false,
  });
  AN.mini = m;
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  m.addControl(new maplibregl.ScaleControl({ maxWidth: 80, unit: "metric" }), "bottom-left");

  let done = false;
  const add = () => {
    if (done || !m.isStyleLoaded()) return;
    done = true;
    // Deliberately NOT simplified: at 2-4 km across, the street names, place
    // labels and footpaths are the whole point — they are how you recognise
    // where you actually are. Hazard layers go underneath the label layers so
    // the names stay readable on top.
    const firstLabel = (m.getStyle().layers || [])
      .find((l) => l.type === "symbol" && l.layout && l.layout["text-field"]);
    const under = firstLabel ? firstLabel.id : undefined;

    m.addSource("an-ring", { type: "geojson", data: ring });
    m.addLayer({ id: "an-ring-f", type: "fill", source: "an-ring",
      paint: { "fill-color": "#1d6a66", "fill-opacity": 0.06 } }, under);
    m.addLayer({ id: "an-ring-l", type: "line", source: "an-ring",
      paint: { "line-color": "#1d6a66", "line-opacity": 0.5, "line-width": 1.4,
        "line-dasharray": [2, 2] } }, under);

    // the routed release paths, so "it could come from up there" is shown
    // rather than only asserted
    const routes = [];
    for (const h of (d.hazards || [])) {
      const S = h.surge || (h.hz === "glof" && d.T && d.T.surge);
      if (!S || h.score < 0.1) continue;
      if (routes.some((r) => r.id === S.src.id)) continue;
      routes.push({ id: S.src.id, name: S.src.name, kind: S.src.kind, path: S.src.path });
    }
    if (routes.length) {
      const routeCol = ["match", ["get", "kind"], "glacial_lake", "#7a55a3", "#5c5fa8"];
      m.addSource("an-surge", { type: "geojson", data: {
        type: "FeatureCollection",
        features: routes.map((r) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: r.path },
          properties: { name: r.name, kind: r.kind },
        })),
      } });
      m.addLayer({ id: "an-surge-glow", type: "line", source: "an-surge",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": routeCol, "line-width": 9,
          "line-opacity": 0.16, "line-blur": 4 } }, under);
      m.addLayer({ id: "an-surge-line", type: "line", source: "an-surge",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": routeCol, "line-width": 2.2,
          "line-opacity": 0.85, "line-dasharray": [2, 1.5] } }, under);
      m.addLayer({ id: "an-surge-label", type: "symbol", source: "an-surge",
        layout: { "symbol-placement": "line-center",
          "text-field": ["concat", ["get", "name"], " route"],
          "text-size": 10.5, "text-font": ["Noto Sans Medium"] },
        paint: { "text-color": "#4a3d80", "text-halo-color": "#ffffff",
          "text-halo-width": 1.8 } });
    }

    m.addSource("an-ev", { type: "geojson",
      data: { type: "FeatureCollection", features: feats } });
    m.addLayer({ id: "an-ev-heat", type: "heatmap", source: "an-ev",
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["get", "sev"], 0, 0.4, 200, 1],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 2.4],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 22, 14, 60],
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], ...THEME.heat],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 15, 0.55],
      } }, under);
    const hzColor = ["match", ["get", "hazard"]];
    Object.entries(HAZARD_COLORS).forEach(([h, c]) => hzColor.push(h, c));
    hzColor.push("#888");
    m.addLayer({ id: "an-ev-dot", type: "circle", source: "an-ev",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "sev"], 0, 3, 50, 5.5, 400, 10],
        "circle-color": hzColor, "circle-opacity": 0.9,
        "circle-stroke-width": 1.2, "circle-stroke-color": "#fff",
      } }, under);

    m.addSource("an-me", { type: "geojson",
      data: { type: "Feature", geometry: { type: "Point", coordinates: d.here } } });
    m.addLayer({ id: "an-me-h", type: "circle", source: "an-me",
      paint: { "circle-radius": 13, "circle-color": "#23201b", "circle-opacity": 0.14 } });
    m.addLayer({ id: "an-me", type: "circle", source: "an-me",
      paint: { "circle-radius": 6, "circle-color": "#23201b",
        "circle-stroke-width": 3, "circle-stroke-color": "#fff" } });

    setTimeout(() => { try { m.resize(); } catch (e) {} }, 60);
  };
  m.on("load", add);
  const iv = setInterval(() => { if (done) return clearInterval(iv); add(); }, 600);
  setTimeout(() => clearInterval(iv), 12000);
}

document.getElementById("analysis-btn").onclick = () => {
  if (!state.data.events || !state.data.index) {
    return toast("Still loading the dataset — try again in a moment.");
  }
  if (!navigator.geolocation) {
    return toast("This browser can’t share a location, so the area check is unavailable.");
  }
  anShow();
  AN.body.innerHTML =
    '<p class="an-note">Waiting for your location. Allow the permission prompt ' +
    'to run the check.</p>' +
    '<div class="an-prog"><span id="an-bar" style="width:6%"></span></div>' +
    '<p class="an-step">Requesting location permission…</p>';
  navigator.geolocation.getCurrentPosition(
    (pos) => runAnalysis(pos.coords.longitude, pos.coords.latitude, "Your location"),
    (err) => {
      const msg = err && err.code === 1
        ? "Location permission is required for the area check. Enable it for this site and try again."
        : err && err.code === 3
        ? "Location timed out. Try again with a clearer view of the sky."
        : "Couldn’t get your location, so the area check can’t run.";
      anClose();
      toast(msg, 6000);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  );
};
