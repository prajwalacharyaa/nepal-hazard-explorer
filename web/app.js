// Nepal Water & Slope Hazard Heatmap — single-file frontend.
// MapLibre GL JS for basemap + heatmap + choropleth; deck.gl overlay for hexbin.

const DATA = {
  events: "../data/processed/events.geojson",
  districts: "../data/processed/districts.geojson",
  calendar: "../data/processed/calendar.json",
};

const HAZARD_COLORS = {
  landslide:   "#e15759",
  flood:       "#4e79a7",
  flash_flood: "#76b7b2",
  glof:        "#b07aa1",
  debris_flow: "#f28e2b",
  avalanche:   "#bab0ac",
  other:       "#8c8c8c",
};
const HAZARD_LABELS = {
  landslide: "Landslide", flood: "Flood", flash_flood: "Flash flood",
  glof: "GLOF", debris_flow: "Debris flow", avalanche: "Avalanche", other: "Other",
};

const state = {
  view: "heatmap",
  hazards: new Set(Object.keys(HAZARD_COLORS)),
  yearMin: 1971,
  yearMax: new Date().getFullYear(),
  metric: "events",
  data: { events: null, districts: null, calendar: null },
  anim: null,
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [84.1, 28.3],
  zoom: 6.2,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

let deckOverlay = null;

// ---------------------------------------------------------------- load ----
async function loadAll() {
  const [ev, di, ca] = await Promise.allSettled([
    fetch(DATA.events).then(r => r.ok ? r.json() : Promise.reject(r.status)),
    fetch(DATA.districts).then(r => r.ok ? r.json() : Promise.reject(r.status)),
    fetch(DATA.calendar).then(r => r.ok ? r.json() : Promise.reject(r.status)),
  ]);
  if (ev.status === "fulfilled") state.data.events = ev.value;
  if (di.status === "fulfilled") state.data.districts = di.value;
  if (ca.status === "fulfilled") state.data.calendar = ca.value;

  if (!state.data.events) {
    document.getElementById("stats").innerHTML =
      "<b>No data yet.</b> Run the pipeline (see README) to generate " +
      "<code>data/processed/events.geojson</code>.";
    return;
  }
  const yrs = state.data.events.features
    .map(f => f.properties.year).filter(Boolean);
  state.yearMin = Math.min(...yrs);
  state.yearMax = Math.max(...yrs);
  initYearSliders();
  buildHazardChips();
  setView("heatmap");
}

// filtered subset of event features honoring hazard + year range
function filteredEvents() {
  if (!state.data.events) return [];
  return state.data.events.features.filter(f => {
    const p = f.properties;
    return f.geometry &&
      state.hazards.has(p.hazard || "other") &&
      p.year >= state.yearMin && p.year <= state.yearMax;
  });
}

// ------------------------------------------------------------ map layers ----
function ensureEventSource() {
  const fc = { type: "FeatureCollection", features: filteredEvents() };
  if (map.getSource("events")) {
    map.getSource("events").setData(fc);
  } else {
    map.addSource("events", { type: "geojson", data: fc });
  }
}

function addHeatmapLayer() {
  ensureEventSource();
  if (map.getLayer("heat")) return;
  map.addLayer({
    id: "heat",
    type: "heatmap",
    source: "events",
    paint: {
      // weight by severity (log-damped so single mega-events don't wash out)
      "heatmap-weight": [
        "interpolate", ["linear"], ["ln", ["+", 1, ["get", "severity_score"]]],
        0, 0.15, 8, 1,
      ],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 5, 1, 12, 3],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 12, 12, 30],
      "heatmap-opacity": 0.85,
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(0,0,0,0)",
        0.2, "#2c7fb8",
        0.4, "#7fcdbb",
        0.6, "#fed976",
        0.8, "#fd8d3c",
        1, "#bd0026",
      ],
    },
  });
  map.addLayer({
    id: "heat-points",
    type: "circle",
    source: "events",
    minzoom: 9,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2, 14, 6],
      "circle-color": ["match", ["get", "hazard"],
        ...Object.entries(HAZARD_COLORS).flat(), "#888"],
      "circle-opacity": 0.7,
    },
  });
}

function addChoroplethLayer() {
  if (!state.data.districts) return;
  if (!map.getSource("districts")) {
    map.addSource("districts", { type: "geojson", data: state.data.districts });
  }
  if (!map.getLayer("choro")) {
    map.addLayer({
      id: "choro", type: "fill", source: "districts",
      paint: { "fill-color": "#333", "fill-opacity": 0.75, "fill-outline-color": "#0f1216" },
    });
    map.addLayer({
      id: "choro-line", type: "line", source: "districts",
      paint: { "line-color": "#0f1216", "line-width": 0.5 },
    });
  }
  paintChoropleth();
}

function paintChoropleth() {
  const m = state.metric;
  const vals = state.data.districts.features
    .map(f => f.properties[m] || 0).filter(v => v > 0).sort((a, b) => a - b);
  if (!vals.length) return;
  const q = p => vals[Math.floor(p * (vals.length - 1))];
  const stops = [
    [0, "#20242b"],
    [q(0.2), "#3b5a6b"],
    [q(0.4), "#4e79a7"],
    [q(0.6), "#f6c85f"],
    [q(0.8), "#f28e2b"],
    [q(0.95), "#bd0026"],
  ];
  map.setPaintProperty("choro", "fill-color", [
    "interpolate", ["linear"], ["coalesce", ["get", m], 0],
    ...stops.flat(),
  ]);
  legendGradient(stops, m);
}

// ----------------------------------------------------------- deck hexbin ----
function showHexbin() {
  const rows = filteredEvents().map(f => ({
    position: f.geometry.coordinates,
    score: f.properties.severity_score || 0,
    year: f.properties.year,
  }));
  const upTo = state._hexYear ?? state.yearMax;
  const layer = new deck.HexagonLayer({
    id: "hex",
    data: rows.filter(r => r.year <= upTo),
    getPosition: d => d.position,
    getElevationWeight: d => d.score + 1,
    getColorWeight: d => d.score + 1,
    elevationScale: 40,
    extruded: true,
    radius: 6000,
    colorRange: [
      [44, 127, 184], [127, 205, 187], [199, 233, 180],
      [254, 217, 118], [253, 141, 60], [189, 0, 38],
    ],
    coverage: 0.85,
    pickable: true,
  });
  if (!deckOverlay) {
    deckOverlay = new deck.MapboxOverlay({ interleaved: true, layers: [layer] });
    map.addControl(deckOverlay);
  } else {
    deckOverlay.setProps({ layers: [layer] });
  }
}

function clearHexbin() {
  if (deckOverlay) deckOverlay.setProps({ layers: [] });
}

// -------------------------------------------------------------- calendar ----
function drawCalendar() {
  const el = document.getElementById("calendar-panel");
  el.innerHTML = "<h2 style='margin:0 0 4px;font-size:15px'>Events by year &amp; month</h2>" +
    "<p style='margin:0 0 12px;color:#9aa3ad;font-size:12px'>Cell = number of recorded events. Monsoon months (Jun–Sep) carry most of the load.</p>";
  const cal = state.data.calendar;
  if (!cal) { el.innerHTML += "<p>No calendar.json yet.</p>"; return; }

  const rows = [];
  for (const [k, v] of Object.entries(cal)) {
    const [y, mo] = k.split("-").map(Number);
    if (!state.hazards.size || hazMatch(v)) rows.push({ y, mo, count: countFor(v) });
  }
  const years = [...new Set(rows.map(r => r.y))].sort((a, b) => a - b);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const cw = 34, ch = 16, padL = 44, padT = 22;
  const w = padL + months.length * cw + 10;
  const h = padT + years.length * ch + 10;
  const max = d3.max(rows, r => r.count) || 1;
  const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, Math.sqrt(max)]);

  const svg = d3.create("svg").attr("width", w).attr("height", h)
    .attr("font-family", "system-ui").attr("font-size", 10);
  svg.append("g").attr("fill", "#9aa3ad")
    .selectAll("text").data(months).join("text")
    .attr("x", (_, i) => padL + i * cw + cw / 2).attr("y", 14)
    .attr("text-anchor", "middle").text(d => d);
  svg.append("g").attr("fill", "#9aa3ad")
    .selectAll("text").data(years).join("text")
    .attr("x", padL - 6).attr("y", (_, i) => padT + i * ch + ch / 2 + 3)
    .attr("text-anchor", "end").text(d => d);
  const yi = new Map(years.map((y, i) => [y, i]));
  svg.append("g").selectAll("rect").data(rows).join("rect")
    .attr("x", d => padL + (d.mo - 1) * cw)
    .attr("y", d => padT + yi.get(d.y) * ch)
    .attr("width", cw - 1.5).attr("height", ch - 1.5).attr("rx", 2)
    .attr("fill", d => d.count ? color(Math.sqrt(d.count)) : "#20242b")
    .append("title").text(d => `${d.y}-${String(d.mo).padStart(2,"0")}: ${d.count} events`);
  el.append(svg.node());
}
function hazMatch(v) { return Object.keys(v.by_hazard || {}).some(h => state.hazards.has(h)); }
function countFor(v) {
  if (!v.by_hazard) return v.count;
  return Object.entries(v.by_hazard)
    .filter(([h]) => state.hazards.has(h)).reduce((s, [, n]) => s + n, 0);
}

// ------------------------------------------------------------- view switch ----
function setView(v) {
  state.view = v;
  document.querySelectorAll("#view-tabs button")
    .forEach(b => b.classList.toggle("active", b.dataset.view === v));
  document.getElementById("metric-group").hidden = v !== "choropleth";
  document.getElementById("calendar-panel").hidden = v !== "calendar";
  document.getElementById("timeline").hidden = v !== "hexbin";
  document.getElementById("year-group").hidden = v === "calendar";

  ["heat", "heat-points", "choro", "choro-line"].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  });
  clearHexbin();
  stopAnim();

  if (v === "heatmap") {
    addHeatmapLayer();
    ["heat", "heat-points"].forEach(id => map.setLayoutProperty(id, "visibility", "visible"));
  } else if (v === "choropleth") {
    addChoroplethLayer();
    ["choro", "choro-line"].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, "visibility", "visible"));
  } else if (v === "hexbin") {
    initTimeline();
    showHexbin();
  } else if (v === "calendar") {
    drawCalendar();
  }
  updateStats();
}

function refresh() {
  if (state.view === "heatmap") ensureEventSource();
  else if (state.view === "choropleth") paintChoropleth();
  else if (state.view === "hexbin") showHexbin();
  else if (state.view === "calendar") drawCalendar();
  updateStats();
}

// ---------------------------------------------------------------- controls ----
function buildHazardChips() {
  const box = document.getElementById("hazard-filter");
  box.innerHTML = "";
  for (const h of Object.keys(HAZARD_COLORS)) {
    const c = document.createElement("span");
    c.className = "chip on";
    c.textContent = HAZARD_LABELS[h];
    c.style.color = HAZARD_COLORS[h];
    c.onclick = () => {
      state.hazards.has(h) ? state.hazards.delete(h) : state.hazards.add(h);
      c.classList.toggle("on");
      refresh();
    };
    box.appendChild(c);
  }
}

function initYearSliders() {
  const mn = document.getElementById("year-min");
  const mx = document.getElementById("year-max");
  for (const s of [mn, mx]) { s.min = state.yearMin; s.max = state.yearMax; }
  mn.value = state.yearMin; mx.value = state.yearMax;
  const sync = () => {
    let a = +mn.value, b = +mx.value;
    if (a > b) [a, b] = [b, a];
    state.yearMin = a; state.yearMax = b;
    document.getElementById("year-label").textContent = `${a}–${b}`;
    refresh();
  };
  mn.oninput = sync; mx.oninput = sync;
  document.getElementById("year-label").textContent = `${state.yearMin}–${state.yearMax}`;
}

function initTimeline() {
  const s = document.getElementById("time-slider");
  s.min = state.yearMin; s.max = state.yearMax;
  s.value = state._hexYear ?? state.yearMax;
  document.getElementById("time-label").textContent = s.value;
  s.oninput = () => {
    state._hexYear = +s.value;
    document.getElementById("time-label").textContent = s.value;
    showHexbin();
  };
}
document.getElementById("play").onclick = () => {
  if (state.anim) return stopAnim();
  const s = document.getElementById("time-slider");
  document.getElementById("play").textContent = "⏸";
  state.anim = setInterval(() => {
    let y = +s.value + 1;
    if (y > +s.max) y = +s.min;
    s.value = y; state._hexYear = y;
    document.getElementById("time-label").textContent = y;
    showHexbin();
  }, 700);
};
function stopAnim() {
  if (state.anim) { clearInterval(state.anim); state.anim = null; }
  const p = document.getElementById("play"); if (p) p.textContent = "▶";
}

document.querySelectorAll("#view-tabs button")
  .forEach(b => b.onclick = () => setView(b.dataset.view));
document.getElementById("metric").onchange = e => { state.metric = e.target.value; paintChoropleth(); };

// ------------------------------------------------------------------ misc ----
function legendGradient(stops, metric) {
  const l = document.getElementById("legend");
  l.innerHTML = `<label>${metric.replace(/_/g, " ")}</label>`;
  for (const [val, col] of stops) {
    l.insertAdjacentHTML("beforeend",
      `<div class="row"><span class="sw" style="background:${col}"></span>≥ ${Math.round(val)}</div>`);
  }
}

function updateStats() {
  const f = filteredEvents();
  const deaths = f.reduce((s, x) => s + (x.properties.deaths || 0), 0);
  const missing = f.reduce((s, x) => s + (x.properties.missing || 0), 0);
  document.getElementById("stats").innerHTML =
    `<b>${f.length.toLocaleString()}</b> events · <b>${deaths.toLocaleString()}</b> deaths` +
    (missing ? ` · <b>${missing.toLocaleString()}</b> missing` : "") +
    `<br><span style="font-size:11px">${state.yearMin}–${state.yearMax}</span>`;
}

map.on("load", loadAll);

map.on("click", "heat-points", e => {
  const p = e.features[0].properties;
  new maplibregl.Popup()
    .setLngLat(e.lngLat)
    .setHTML(`<b>${HAZARD_LABELS[p.hazard] || p.hazard}</b> — ${p.date}<br>` +
             `${p.title || ""}<br>deaths: ${p.deaths ?? "?"} · severity: ${p.severity_class}`)
    .addTo(map);
});
map.on("mouseenter", "heat-points", () => map.getCanvas().style.cursor = "pointer");
map.on("mouseleave", "heat-points", () => map.getCanvas().style.cursor = "");
