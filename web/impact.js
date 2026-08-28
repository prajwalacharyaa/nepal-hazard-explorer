/* Impact view: impact.html?id=<event id>&d=<district slug>
   Zooms to the event and its downstream corridor, animates flow along the
   path, and lists what lies downstream. */
const { HAZARD_COLORS, THEME, MAP_STYLE, paths, slugify, loadJSON, fmt,
        hazardName, readableDate, toast, fatalError } = window.NHM;

const qs = new URLSearchParams(location.search);
const ID = qs.get("id");
const DSLUG = qs.get("d") || "";

let map, EVENT = null, CORRIDOR = null, anim = null, dashStep = 0;

init();

async function init() {
  if (!ID) {
    fatalError("No event selected", "This page needs an event id in the URL.",
               'Open it from an area card\'s <b>Full view</b> button.');
    return;
  }

  // the per-district file carries the full record; fall back to the whole set
  let features = [];
  if (DSLUG) {
    try { features = (await loadJSON(paths.districtEvents(DSLUG))).features; } catch (e) {}
  }
  if (!features.some((f) => f.properties.id === ID)) {
    try { features = (await loadJSON(paths.events)).features; } catch (e) {}
  }
  EVENT = features.find((f) => f.properties.id === ID);
  if (!EVENT) {
    fatalError("Event not found", `No record matches <code>${ID}</code>.`, "");
    return;
  }
  try { CORRIDOR = await loadJSON(`${window.NHM.DATA}/corridors/${ID}.json`); }
  catch (e) { CORRIDOR = null; }

  renderPanel();
  buildMap();
}

/* ------------------------------------------------------------- panel ----- */
function renderPanel() {
  const p = EVENT.properties;
  const col = HAZARD_COLORS[p.hazard] || THEME.ink;
  document.getElementById("i-title").innerHTML =
    `<span style="color:${col}">${hazardName(p.hazard)}</span> — ${p.district || "Nepal"}`;
  document.getElementById("i-sub").textContent =
    `${readableDate(p.date, p.date_precision)}${p.palika ? " · " + p.palika : ""}`;
  document.title = `${hazardName(p.hazard)}, ${p.district}, ${readableDate(p.date)} — impact view`;

  document.getElementById("i-badge").innerHTML =
    `<span class="sev sev-${p.severity_class}">${p.severity_class}</span>` +
    `<span class="prec">${(p.geo_precision || "").replace(/_/g, " ")} location</span>`;

  const losses = [
    ["Deaths", p.deaths], ["Missing", p.missing], ["Injured", p.injured],
    ["People affected", p.people_affected],
    ["Houses destroyed", p.houses_destroyed], ["Houses damaged", p.houses_damaged],
  ].filter(([, v]) => v);
  document.getElementById("i-losses").innerHTML = losses.length
    ? losses.map(([k, v]) => `<div class="loss"><b>${fmt(v)}</b><span>${k}</span></div>`).join("")
    : '<p class="muted">No casualty or damage figures recorded for this event.</p>';

  document.getElementById("i-event-link").href =
    `event.html?id=${encodeURIComponent(ID)}&d=${DSLUG || slugify(p.district || "")}`;
  document.getElementById("i-district-link").href =
    `district.html?d=${DSLUG || slugify(p.district || "")}`;

  if (CORRIDOR) renderCorridorPanel();

  document.getElementById("i-src").innerHTML =
    "Figures are as recorded by the original source and are not independently " +
    "verified. " + (CORRIDOR && !CORRIDOR.observed
      ? "The corridor is modelled, not an observed flood extent. "
      : "") +
    '<a href="methodology.html">Methodology &amp; data notes →</a>';
}

function renderCorridorPanel() {
  document.getElementById("i-corridor-field").hidden = false;
  document.getElementById("i-corridor-len").textContent = `${CORRIDOR.length_km} km`;
  const note = document.getElementById("i-corridor-note");
  note.innerHTML = CORRIDOR.observed
    ? `<b>Observed path.</b> ${CORRIDOR.source_note || ""}` +
      (CORRIDOR.reference ? `<br><span class="ref">${CORRIDOR.reference}</span>` : "")
    : `<b>Modelled path.</b> ${CORRIDOR.source_note || ""}`;

  if (CORRIDOR.elevation && CORRIDOR.elevation.length > 3) {
    document.getElementById("i-profile-field").hidden = false;
    drawProfile(CORRIDOR.elevation);
    document.getElementById("i-profile-note").textContent =
      `Falls ${fmt(CORRIDOR.drop_m)} m from source to the end of the traced reach. ` +
      "Elevation sampled from SRTM 30 m along the path.";
  }

  const pals = CORRIDOR.palikas || [];
  if (pals.length) {
    document.getElementById("i-palikas-field").hidden = false;
    document.querySelector("#i-palikas tbody").innerHTML = pals.map((m) =>
      `<tr><td>${m.palika}</td><td>${m.district || ""}</td>
       <td class="num">${m.events ? `${fmt(m.events)} events` : "—"}</td></tr>`).join("");
  }

  const near = CORRIDOR.nearby_events || [];
  if (near.length) {
    document.getElementById("i-nearby-field").hidden = false;
    document.getElementById("i-nearby-count").textContent =
      `${fmt(CORRIDOR.nearby_total)} recorded`;
    document.querySelector("#i-nearby tbody").innerHTML = near.map((e) =>
      `<tr><td><a href="impact.html?id=${encodeURIComponent(e.id)}&d=${DSLUG}">${readableDate(e.date)}</a></td>
       <td style="color:${HAZARD_COLORS[e.hazard] || ""}">${hazardName(e.hazard)}</td>
       <td class="num">${e.deaths || ""}</td></tr>`).join("");
  }
}

function drawProfile(prof) {
  const box = document.getElementById("i-profile");
  box.innerHTML = "";
  const W = 320, H = 112, pad = 40;      // wide enough for a 4-digit metre label
  const x = d3.scaleLinear().domain([0, prof.length - 1]).range([pad, W - 6]);
  const y = d3.scaleLinear().domain(d3.extent(prof)).nice().range([H - 18, 6]);
  const svg = d3.create("svg").attr("class", "chart").attr("viewBox", `0 0 ${W} ${H}`)
    .attr("style", `max-width:${W}px`).attr("font-size", 8.5)
    .attr("role", "img").attr("aria-label", "Elevation profile along the corridor");
  svg.append("path").datum(prof)
    .attr("fill", "rgba(44,108,160,0.16)")
    .attr("d", d3.area().x((_, i) => x(i)).y0(y.range()[0]).y1((d) => y(d)).curve(d3.curveMonotoneX));
  svg.append("path").datum(prof)
    .attr("fill", "none").attr("stroke", THEME.bar).attr("stroke-width", 1.6)
    .attr("d", d3.line().x((_, i) => x(i)).y((d) => y(d)).curve(d3.curveMonotoneX));
  const fmtEl = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`);
  svg.append("g").attr("transform", `translate(${pad},0)`).attr("color", THEME.inkFaint)
    .call(d3.axisLeft(y).ticks(3).tickFormat(fmtEl).tickSizeOuter(0))
    .call((g) => g.append("text").attr("x", -pad + 2).attr("y", 10)
      .attr("fill", THEME.inkFaint).attr("text-anchor", "start")
      .attr("font-size", 8).text("metres"));
  box.append(svg.node());
}

/* --------------------------------------------------------------- map ----- */
function buildMap() {
  const [lon, lat] = EVENT.geometry.coordinates;
  map = new maplibregl.Map({
    container: "imap", style: MAP_STYLE,
    center: [lon, lat], zoom: 10, attributionControl: { compact: true },
  });
  window.__map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), "bottom-left");

  // Everything on this page hangs off the style being ready, so add the layers
  // from whichever signal arrives first and never add them twice.
  let layersAdded = false;
  const tryAddLayers = () => {
    if (layersAdded || !map.isStyleLoaded()) return;
    layersAdded = true;
    addLayers();
  };
  map.on("load", tryAddLayers);
  map.on("styledata", tryAddLayers);
  map.on("idle", tryAddLayers);
  map.on("error", (e) => console.error("[impact map]", (e && e.error && e.error.message) || e));

  function addLayers() {
    const col = HAZARD_COLORS[EVENT.properties.hazard] || THEME.accent;

    if (CORRIDOR && CORRIDOR.path && CORRIDOR.path.length > 1) {
      const line = { type: "Feature", geometry: { type: "LineString", coordinates: CORRIDOR.path } };
      map.addSource("corridor", { type: "geojson", data: line });
      // soft halo so the path reads over any basemap detail
      map.addLayer({ id: "corridor-halo", type: "line", source: "corridor",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": col, "line-opacity": 0.18, "line-width":
          ["interpolate", ["linear"], ["zoom"], 7, 8, 12, 22] } });
      map.addLayer({ id: "corridor-line", type: "line", source: "corridor",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": col, "line-opacity": 0.85,
          "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2.2, 12, 5],
          // dashed when modelled, solid when observed
          ...(CORRIDOR.observed ? {} : { "line-dasharray": [2, 1.4] }),
        } });
      // travelling pulse used by the animation
      map.addLayer({ id: "corridor-pulse", type: "line", source: "corridor",
        layout: { "line-cap": "round", visibility: "none" },
        paint: { "line-color": "#ffffff", "line-opacity": 0.9,
          "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3, 12, 7],
          "line-dasharray": [0, 4, 3] } });

      // direction arrows along the path
      map.addLayer({ id: "corridor-dir", type: "symbol", source: "corridor",
        layout: { "symbol-placement": "line", "symbol-spacing": 90,
                  "text-field": "▶", "text-size": 11, "text-rotation-alignment": "map",
                  "text-allow-overlap": false },
        paint: { "text-color": col, "text-opacity": 0.75,
                 "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });

      fitCorridor();
    }

    // the event itself, on top
    map.addSource("src", { type: "geojson", data: EVENT });
    map.addLayer({ id: "src-halo", type: "circle", source: "src",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 14, 12, 34],
        "circle-color": col, "circle-opacity": 0.15 } });
    map.addLayer({ id: "src-dot", type: "circle", source: "src",
      paint: { "circle-radius": 8, "circle-color": col,
        "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" } });

    map.on("click", "src-dot", () => {
      const p = EVENT.properties;
      new maplibregl.Popup().setLngLat(EVENT.geometry.coordinates)
        .setHTML(`<b>${hazardName(p.hazard)}</b><br>${readableDate(p.date, p.date_precision)}<br>` +
                 `${p.title || ""}`).addTo(map);
    });
  }

  // if the basemap never arrives, say so rather than showing an empty page
  setTimeout(() => {
    if (!layersAdded) {
      toast("The basemap did not load, so the corridor cannot be drawn. The details on the right are unaffected.", 8000);
    }
  }, 20000);
}

function fitCorridor() {
  if (!CORRIDOR || !CORRIDOR.path.length) return;
  const b = CORRIDOR.path.reduce(
    (a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]),
               Math.max(a[2], c[0]), Math.max(a[3], c[1])],
    [180, 90, -180, -90]);
  const pad = matchMedia("(min-width: 900px)").matches
    ? { top: 60, bottom: 60, left: 60, right: 420 }
    : { top: 40, bottom: 40, left: 30, right: 30 };
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: pad, duration: 700, maxZoom: 12 });
}

/* ---- flow animation: march the dash pattern downstream ---- */
const DASH_SEQ = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1],
  [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5],
  [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];
function stopFlow() {
  if (anim) { clearInterval(anim); anim = null; }
  if (map.getLayer("corridor-pulse")) map.setLayoutProperty("corridor-pulse", "visibility", "none");
  document.getElementById("i-play").textContent = "▶ Play flow";
}
document.getElementById("i-play").onclick = () => {
  if (anim) return stopFlow();
  if (!map.getLayer("corridor-pulse")) return;
  map.setLayoutProperty("corridor-pulse", "visibility", "visible");
  document.getElementById("i-play").textContent = "⏸ Pause";
  const ms = matchMedia("(prefers-reduced-motion: reduce)").matches ? 260 : 90;
  anim = setInterval(() => {
    dashStep = (dashStep + 1) % DASH_SEQ.length;
    map.setPaintProperty("corridor-pulse", "line-dasharray", DASH_SEQ[dashStep]);
  }, ms);
};
document.getElementById("i-fit").onclick = fitCorridor;
