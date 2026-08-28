/* Main map: 4 views + "find your area" (near-me / dropdown / click). */
const { HAZARD_COLORS, HAZARD_LABELS, SEV_COLORS, paths, slugify,
        loadJSON, fmt, hazardName, readableDate, eventsToCSV, download } = window.NHM;

const state = {
  view: "heatmap",
  hazards: new Set(Object.keys(HAZARD_COLORS)),
  yearMin: 1971, yearMax: new Date().getFullYear(),
  metric: "events", preciseOnly: false,
  data: { events: null, districts: null, calendar: null, index: null, palikaIndex: null },
  anim: null, hexYear: null, palikaLoaded: false,
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [84.1, 28.3], zoom: 6.2,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "bottom-right");

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
  loadJSON(paths.palikaIndex).then((v) => (state.data.palikaIndex = v)).catch(() => {});

  if (!state.data.events) {
    document.getElementById("stats").innerHTML =
      "<b>No data.</b> Run the pipeline (README) to build data/processed/.";
    return;
  }
  const yrs = state.data.events.features.map((f) => f.properties.year).filter(Boolean);
  state.yearMin = Math.min(...yrs);
  state.yearMax = Math.max(...yrs);
  buildHazardChips();
  initYearSliders();
  buildDistrictPicker();
  if (map.loaded()) setView("heatmap");
  else map.once("load", () => setView("heatmap"));
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
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 5, 1, 12, 3],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 12, 12, 30],
      "heatmap-opacity": 0.85,
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(0,0,0,0)", 0.2, "#2c7fb8", 0.4, "#7fcdbb",
        0.6, "#fed976", 0.8, "#fd8d3c", 1, "#bd0026"],
    },
  });
  const hazColor = ["match", ["get", "hazard"],
    ...Object.entries(HAZARD_COLORS).flat(), "#888"];
  const isExact = ["==", ["get", "geo_precision"], "exact"];
  map.addLayer({
    id: "heat-points", type: "circle", source: "events", minzoom: 8,
    paint: {
      "circle-radius": ["*", ["interpolate", ["linear"], ["zoom"], 8, 2, 14, 6],
        ["case", isExact, 1, 0.8]],
      // exact = filled; centroid = hollow ring
      "circle-color": ["case", isExact, hazColor, "rgba(0,0,0,0)"],
      "circle-opacity": 0.8,
      "circle-stroke-width": ["case", isExact, 0.5, 1.2],
      "circle-stroke-color": ["case", isExact, "#0b0d10", hazColor],
    },
  });
}

function addChoroplethLayer() {
  if (!state.data.districts) return;
  if (!map.getSource("districts"))
    map.addSource("districts", { type: "geojson", data: state.data.districts });
  if (!map.getLayer("choro")) {
    map.addLayer({ id: "choro", type: "fill", source: "districts",
      paint: { "fill-color": "#333", "fill-opacity": 0.72 } });
    map.addLayer({ id: "choro-line", type: "line", source: "districts",
      paint: { "line-color": "#0b0d10", "line-width": 0.6 } });
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
  const stops = [[0, "#20242b"], [q(0.2), "#3b5a6b"], [q(0.4), "#4e79a7"],
    [q(0.6), "#f6c85f"], [q(0.8), "#f28e2b"], [q(0.95), "#bd0026"]];
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
    colorRange: [[44, 127, 184], [127, 205, 187], [199, 233, 180],
      [254, 217, 118], [253, 141, 60], [189, 0, 38]],
  });
  if (!deckOverlay) { deckOverlay = new deck.MapboxOverlay({ layers: [layer] }); map.addControl(deckOverlay); }
  else deckOverlay.setProps({ layers: [layer] });
}
function clearHexbin() { if (deckOverlay) deckOverlay.setProps({ layers: [] }); }

/* -------------------------------------------------------------- calendar -- */
function drawCalendar() {
  const el = document.getElementById("calendar-panel");
  el.innerHTML = "<h2>Events by year &amp; month</h2>" +
    "<p class='cap'>Cell = recorded events. Monsoon (Jun–Sep) carries most of the load. " +
    "Recent years have far more records — reporting improved, not necessarily hazard.</p>";
  const cal = state.data.calendar;
  if (!cal) { el.innerHTML += "<p>No calendar.json.</p>"; return; }
  const rows = [];
  for (const [k, v] of Object.entries(cal)) {
    const [y, mo] = k.split("-").map(Number);
    const c = v.by_hazard
      ? Object.entries(v.by_hazard).filter(([h]) => state.hazards.has(h)).reduce((s, [, n]) => s + n, 0)
      : v.count;
    rows.push({ y, mo, count: c });
  }
  const years = [...new Set(rows.map((r) => r.y))].sort((a, b) => a - b);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const cw = 34, ch = 16, padL = 46, padT = 22;
  const w = padL + months.length * cw + 10, h = padT + years.length * ch + 10;
  const max = d3.max(rows, (r) => r.count) || 1;
  const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, Math.sqrt(max)]);
  const svg = d3.create("svg").attr("width", w).attr("height", h).attr("font-size", 10);
  svg.append("g").attr("fill", "#9aa3ad").selectAll("text").data(months).join("text")
    .attr("x", (_, i) => padL + i * cw + cw / 2).attr("y", 14).attr("text-anchor", "middle").text((d) => d);
  svg.append("g").attr("fill", "#9aa3ad").selectAll("text").data(years).join("text")
    .attr("x", padL - 6).attr("y", (_, i) => padT + i * ch + ch / 2 + 3).attr("text-anchor", "end").text((d) => d);
  const yi = new Map(years.map((y, i) => [y, i]));
  svg.append("g").selectAll("rect").data(rows).join("rect")
    .attr("x", (d) => padL + (d.mo - 1) * cw).attr("y", (d) => padT + yi.get(d.y) * ch)
    .attr("width", cw - 1.5).attr("height", ch - 1.5).attr("rx", 2)
    .attr("fill", (d) => (d.count ? color(Math.sqrt(d.count)) : "#20242b"))
    .append("title").text((d) => `${d.y}-${String(d.mo).padStart(2, "0")}: ${d.count} events`);
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
    paint: { "fill-color": "#ff7a45", "fill-opacity": 0.04 },
  });
  map.addLayer({
    id: "palika-line", type: "line", source: "palikas", minzoom: 8,
    paint: { "line-color": "#7a5a44", "line-width": 0.5 },
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
  const card = document.getElementById("area-card");
  const ix = state.data.palikaIndex && state.data.palikaIndex[pcode];
  const dslug = ix ? slugify(ix.district) : "";
  if (!ix) {
    card.innerHTML = `<button class="x">×</button><h3>${name}</h3>
      <p class="muted">municipality</p><p>No recorded events in this dataset.</p>`;
  } else {
    const hz = Object.entries(ix.by_hazard).filter(([, n]) => n)
      .sort((a, b) => b[1] - a[1])
      .map(([h, n]) => `<span class="tag" style="color:${HAZARD_COLORS[h]}">${hazardName(h)} ${n}</span>`).join(" ");
    const w = ix.worst;
    card.innerHTML = `<button class="x">×</button>
      <h3>${ix.palika}</h3>
      <p class="muted">${ix.district} district · municipality</p>
      <p class="big">${fmt(ix.events)} events · ${fmt(ix.deaths)} deaths</p>
      <p class="muted">${ix.first_year}–${ix.last_year}</p>
      <p>${hz}</p>
      ${w ? `<p class="muted">Worst: ${hazardName(w.hazard)}, ${readableDate(w.date)} —
        ${fmt(w.deaths)} dead <a href="event.html?id=${encodeURIComponent(w.id)}&d=${dslug}">details</a></p>` : ""}
      <a class="cta" href="district.html?d=${encodeURIComponent(dslug)}">Open ${ix.district} district page →</a>`;
  }
  card.hidden = false;
  if (typeof collapsePanel === "function") collapsePanel();
  card.querySelector(".x").onclick = () => (card.hidden = true);
}

/* ------------------------------------------------------------ area card --- */
function openAreaCard(district, lngLat) {
  const card = document.getElementById("area-card");
  const ix = state.data.index && state.data.index[district];
  const slug = slugify(district);
  if (!ix) {
    card.innerHTML = `<button class="x">×</button><h3>${district}</h3>
      <p>No recorded events in this dataset.</p>
      <a class="cta" href="district.html?d=${encodeURIComponent(slug)}">Open district page →</a>`;
  } else {
    const hz = Object.entries(ix.by_hazard).filter(([, n]) => n)
      .sort((a, b) => b[1] - a[1])
      .map(([h, n]) => `<span class="tag" style="color:${HAZARD_COLORS[h]}">${hazardName(h)} ${n}</span>`).join(" ");
    const w = ix.worst;
    card.innerHTML = `<button class="x">×</button>
      <h3>${district}</h3>
      <p class="big">${fmt(ix.events)} events · ${fmt(ix.deaths)} deaths</p>
      <p class="muted">${ix.first_year}–${ix.last_year}</p>
      <p>${hz}</p>
      ${w ? `<p class="muted">Worst: ${hazardName(w.hazard)}, ${readableDate(w.date)} —
        ${fmt(w.deaths)} dead <a href="event.html?id=${encodeURIComponent(w.id)}&d=${slug}">details</a></p>` : ""}
      <a class="cta" href="district.html?d=${encodeURIComponent(slug)}">Open full district page →</a>`;
  }
  card.hidden = false;
  if (typeof collapsePanel === "function") collapsePanel();
  card.querySelector(".x").onclick = () => (card.hidden = true);
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
}

function hazardLegend() {
  const l = document.getElementById("legend");
  l.innerHTML = '<span class="field-label">Hazard</span>' +
    Object.keys(HAZARD_COLORS).map((h) =>
      `<div class="row"><span class="sw" style="background:${HAZARD_COLORS[h]}"></span>${HAZARD_LABELS[h]}</div>`
    ).join("") +
    '<div class="row" style="margin-top:6px"><span class="sw" style="border:1.5px solid #888;background:transparent"></span>approx. location (centroid)</div>';
}
function refresh() {
  if (state.view === "heatmap") ensureEventSource();
  else if (state.view === "choropleth") paintChoropleth();
  else if (state.view === "hexbin") showHexbin();
  else if (state.view === "calendar") drawCalendar();
  updateStats();
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
  for (const s of [mn, mx]) { s.min = state.yearMin; s.max = state.yearMax; }
  mn.value = state.yearMin; mx.value = state.yearMax;
  const sync = () => {
    let a = +mn.value, b = +mx.value; if (a > b) [a, b] = [b, a];
    state.yearMin = a; state.yearMax = b;
    document.getElementById("year-label").textContent = `${a}–${b}`; refresh();
  };
  mn.oninput = sync; mx.oninput = sync;
  document.getElementById("year-label").textContent = `${state.yearMin}–${state.yearMax}`;
}
function buildDistrictPicker() {
  const sel = document.getElementById("district-pick");
  const names = state.data.index ? Object.keys(state.data.index).sort()
    : [...new Set(state.data.districts.features.map((f) => f.properties.district))].sort();
  for (const n of names) {
    const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o);
  }
  sel.onchange = () => { if (sel.value) location.href = `district.html?d=${encodeURIComponent(slugify(sel.value))}`; };
}
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
document.getElementById("metric").onchange = (e) => { state.metric = e.target.value; paintChoropleth(); };
document.getElementById("precise-only").onchange = (e) => { state.preciseOnly = e.target.checked; refresh(); };

document.getElementById("near-me").onclick = () => {
  const btn = document.getElementById("near-me");
  const reset = () => (btn.textContent = "Use my location");
  btn.textContent = "Locating…";
  if (!navigator.geolocation) { reset(); alert("Geolocation not available."); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      reset();
      const pt = [pos.coords.longitude, pos.coords.latitude];
      map.flyTo({ center: pt, zoom: 9 });
      collapsePanel();
      const d = districtAt(pt);
      if (d) openAreaCard(d, { lng: pt[0], lat: pt[1] });
      else alert("Your location isn't inside a Nepal district in this dataset.");
    },
    () => { reset(); alert("Could not get your location."); },
    { enableHighAccuracy: true, timeout: 10000 },
  );
};

/* mobile bottom-sheet handle */
const panelEl = document.getElementById("panel");
function collapsePanel() {
  if (matchMedia("(max-width: 899px)").matches) panelEl.dataset.state = "peek";
}
document.getElementById("panel-handle").onclick = () => {
  panelEl.dataset.state = panelEl.dataset.state === "open" ? "peek" : "open";
};
map.on("dragstart", collapsePanel);
function districtAt(pt) {
  if (!state.data.districts) return null;
  const p = turf.point(pt);
  for (const f of state.data.districts.features) {
    try { if (turf.booleanPointInPolygon(p, f)) return f.properties.district; } catch (e) {}
  }
  return null;
}

document.getElementById("download-view").onclick = () => {
  const f = filteredEvents();
  const tag = `nepal-hazards_${state.yearMin}-${state.yearMax}`;
  download(`${tag}.csv`, eventsToCSV(f), "text/csv");
  download(`${tag}.geojson`,
    JSON.stringify({ type: "FeatureCollection", features: f }), "application/geo+json");
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
    `<b>${fmt(f.length)}</b> events · <b>${fmt(deaths)}</b> deaths` +
    (missing ? ` · <b>${fmt(missing)}</b> missing` : "") +
    `<br><span class="muted">${state.yearMin}–${state.yearMax} · ${pct}% precisely located</span>`;
}

loadAll();
window.NHM.stampMeta("#meta-stamp");
map.on("click", "heat-points", (e) => {
  const p = e.features[0].properties;
  new maplibregl.Popup().setLngLat(e.lngLat).setHTML(
    `<b>${hazardName(p.hazard)}</b> · ${readableDate(p.date, p.date_precision)}<br>` +
    `${p.title || ""}<br>deaths ${p.deaths ?? "?"} · ${p.severity_class}<br>` +
    `<a href="event.html?id=${encodeURIComponent(p.id)}&d=${slugify(p.district || "")}">full record →</a>`,
  ).addTo(map);
});
map.on("mouseenter", "heat-points", () => (map.getCanvas().style.cursor = "pointer"));
map.on("mouseleave", "heat-points", () => (map.getCanvas().style.cursor = ""));
