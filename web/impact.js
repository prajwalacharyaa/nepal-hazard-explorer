/* Impact view: impact.html?id=<event id>&d=<district slug>
   Zooms to the event and its downstream corridor, animates flow along the
   path, and lists what lies downstream. */
const { HAZARD_COLORS, THEME, MAP_STYLE, paths, slugify, loadJSON, fmt,
        hazardName, readableDate, toast, fatalError, simplifyBasemap } = window.NHM;

const qs = new URLSearchParams(location.search);
const ID = qs.get("id");
const DSLUG = qs.get("d") || "";

let map, EVENT = null, CORRIDOR = null, anim = null;

/* ---- mobile bottom sheet (peek / open), mirrors the home-page panel ---- */
const isMobile = () => matchMedia("(max-width: 899px)").matches;
const sheetEl = document.getElementById("ipanel");
const sheetHandle = document.getElementById("ipanel-handle");
const SHEET_PEEK = 128;                       // keep in sync with style.css
function setSheet(name) { sheetEl.dataset.state = name; }
function collapseSheet() { if (isMobile()) setSheet("peek"); }

(function sheetDrag() {
  const bodyEl = () => sheetEl.querySelector(".ipanel-body");
  const peekPx = () => Math.max(0, sheetEl.offsetHeight - SHEET_PEEK);
  const curT = () => (sheetEl.dataset.state === "open" ? 0 : peekPx());
  let startY = 0, base = 0, dragging = false, lastY = 0, lastT = 0, vy = 0;

  function down(e) {
    if (!isMobile()) return;
    const b = bodyEl();
    if (e.target.closest(".ipanel-body") && b && b.scrollTop > 0) return;
    dragging = true;
    startY = lastY = e.clientY; lastT = performance.now(); vy = 0;
    base = curT();
    sheetEl.dataset.dragging = "1";
    delete sheetEl.dataset.dragMoved;
    sheetEl.style.setProperty("--drag-y", base + "px");
    sheetEl.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) sheetEl.dataset.dragMoved = "1";
    let y = Math.max(-24, Math.min(peekPx() + 24, base + dy));
    sheetEl.style.setProperty("--drag-y", y + "px");
    const now = performance.now();
    vy = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY; lastT = now;
    e.preventDefault();
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    delete sheetEl.dataset.dragging;
    const y = parseFloat(getComputedStyle(sheetEl).getPropertyValue("--drag-y")) || 0;
    let open;
    if (vy < -0.45) open = true;
    else if (vy > 0.45) open = false;
    else open = y < peekPx() / 2;
    sheetEl.style.removeProperty("--drag-y");
    setSheet(open ? "open" : "peek");
    setTimeout(() => { delete sheetEl.dataset.dragMoved; }, 400);
  }
  sheetHandle.addEventListener("pointerdown", down);
  sheetEl.querySelector(".ipanel-head").addEventListener("pointerdown", down);
  addEventListener("pointermove", move, { passive: false });
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
  sheetHandle.addEventListener("click", () => {
    if (sheetEl.dataset.dragMoved) return;
    setSheet(sheetEl.dataset.state === "open" ? "peek" : "open");
  });
})();

if (isMobile()) setSheet("peek");
addEventListener("orientationchange", () => { if (!isMobile()) setSheet("open"); });

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
  collapseSheet();
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
    "verified. The corridor follows the mapped river network and is not an " +
    "observed inundation extent" +
    (CORRIDOR && !CORRIDOR.documented_reach
      ? "; its length is estimated from severity. " : ". ") +
    '<a href="methodology.html">Methodology &amp; data notes →</a>';
}

function renderCorridorPanel() {
  document.getElementById("i-corridor-field").hidden = false;
  document.getElementById("i-corridor-len").textContent = `${CORRIDOR.length_km} km`;
  const note = document.getElementById("i-corridor-note");
  note.innerHTML = CORRIDOR.documented_reach
    ? `<b>Documented reach.</b> ${CORRIDOR.source_note || ""}` +
      (CORRIDOR.reference ? `<br><span class="ref">${CORRIDOR.reference}</span>` : "")
    : `<b>Modelled reach.</b> ${CORRIDOR.source_note || ""}`;

  // explain the gap between the event marker and the start of the river reach
  if (CORRIDOR.snap_km > 0.05) {
    note.insertAdjacentHTML("beforeend",
      `<br><span class="ref">The event sits ${CORRIDOR.snap_km} km from the nearest ` +
      `mapped river; that link is drawn as a dotted line. Smaller streams are ` +
      `below the river dataset's threshold, so the true route to the channel is ` +
      `not mapped.</span>`);
  }

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
  map.on("dragstart", collapseSheet);

  // 'load' is the only safe moment to add layers: styledata also fires *during*
  // style loading, when isStyleLoaded() can briefly report true, and anything
  // added then is discarded when the style finishes parsing. A late retry
  // covers the case where 'load' was somehow missed.
  let layersAdded = false;
  const tryAddLayers = () => {
    if (layersAdded || !map.isStyleLoaded()) return;
    layersAdded = true;
    try { simplifyBasemap(map); } catch (e) { /* cosmetic */ }
    try { addLayers(); } catch (e) { console.error("[impact] addLayers", e); }
  };
  map.on("load", tryAddLayers);
  map.on("error", (e) => console.error("[impact map]", (e && e.error && e.error.message) || e));
  const retry = setInterval(() => {
    if (layersAdded) return clearInterval(retry);
    if (map.isStyleLoaded()) tryAddLayers();
  }, 1500);
  setTimeout(() => clearInterval(retry), 30000);

  function addLayers() {
    const col = HAZARD_COLORS[EVENT.properties.hazard] || THEME.accent;

    if (CORRIDOR && CORRIDOR.path && CORRIDOR.path.length > 1) {
      const line = { type: "Feature", geometry: { type: "LineString", coordinates: CORRIDOR.path } };
      map.addSource("corridor", { type: "geojson", data: line });

      // The reach the event covered is shown from the moment the page opens, as
      // a soft band rather than a bare line. Three stacked widths at falling
      // opacity fake the gradient falloff of the density layer, so the extent
      // reads at a glance without hiding the basemap underneath.
      const band = [
        ["corridor-band-3", 0.06, [7, 22, 12, 54]],
        ["corridor-band-2", 0.10, [7, 14, 12, 34]],
        ["corridor-band-1", 0.16, [7, 8, 12, 19]],
      ];
      for (const [id, opacity, w] of band) {
        map.addLayer({ id, type: "line", source: "corridor",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": col, "line-opacity": opacity, "line-blur":
            ["interpolate", ["linear"], ["zoom"], 7, 4, 12, 10],
            "line-width": ["interpolate", ["linear"], ["zoom"], ...w] } });
      }

      map.addLayer({ id: "corridor-line", type: "line", source: "corridor",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": col, "line-opacity": 0.85,
          "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2.2, 12, 5],
          // dashed when the length is modelled, solid when it is documented
          ...(CORRIDOR.documented_reach ? {} : { "line-dasharray": [2, 1.4] }),
        } });

      // Overland link from the event to the nearest mapped river. Drawn thin
      // and dotted because it is a straight-line stand-in, not a channel:
      // HydroRIVERS omits streams below its drainage threshold.
      if (CORRIDOR.connector && CORRIDOR.snap_km > 0.05) {
        map.addSource("connector", { type: "geojson", data: {
          type: "Feature",
          geometry: { type: "LineString", coordinates: CORRIDOR.connector } } });
        map.addLayer({ id: "connector-line", type: "line", source: "connector",
          layout: { "line-cap": "round" },
          paint: { "line-color": col, "line-opacity": 0.55,
            "line-dasharray": [1, 1.6],
            "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.4, 12, 2.6] } });
      }

      // explicit end-of-reach marker so the covered span reads as source -> end
      const endPt = CORRIDOR.path[CORRIDOR.path.length - 1];
      map.addSource("reach-end", { type: "geojson",
        data: { type: "Feature", geometry: { type: "Point", coordinates: endPt } } });
      map.addLayer({ id: "reach-end-ring", type: "circle", source: "reach-end",
        paint: { "circle-radius": 6, "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 2.5, "circle-stroke-color": col,
          "circle-stroke-opacity": 0.9 } });
      map.addLayer({ id: "reach-end-label", type: "symbol", source: "reach-end",
        layout: { "text-field": `end of ${CORRIDOR.length_km} km reach`,
          "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top",
          "text-allow-overlap": false },
        paint: { "text-color": THEME.inkDim, "text-halo-color": "#ffffff",
          "text-halo-width": 1.6 } });
      // --- flow animation: a trail that draws in behind a travelling head ---
      map.addSource("trail", { type: "geojson", data: emptyLine() });
      map.addLayer({ id: "corridor-trail", type: "line", source: "trail",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0f172a", "line-opacity": 0.9,
          "line-width": ["interpolate", ["linear"], ["zoom"], 7, 4, 12, 8] } });

      map.addSource("head", { type: "geojson", data: emptyPoint() });
      map.addLayer({ id: "head-pulse", type: "circle", source: "head",
        layout: { visibility: "none" },
        paint: { "circle-radius": 18, "circle-color": col, "circle-opacity": 0.22 } });
      map.addLayer({ id: "head-dot", type: "circle", source: "head",
        layout: { visibility: "none" },
        paint: { "circle-radius": 7, "circle-color": "#0f172a",
          "circle-stroke-width": 3, "circle-stroke-color": "#ffffff" } });

      // direction arrows along the path
      map.addLayer({ id: "corridor-dir", type: "symbol", source: "corridor",
        layout: { "symbol-placement": "line", "symbol-spacing": 90,
                  "text-field": "▶", "text-size": 11, "text-rotation-alignment": "map",
                  "text-allow-overlap": false },
        paint: { "text-color": col, "text-opacity": 0.75,
                 "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });

      fitCorridor(false);   // snap on open; the button animates
      autoPlayFlow();
    }

    addCorridorPlaceLabels();

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

/* Name the municipalities the corridor runs through, from our own boundary
   file. The basemap only starts drawing village names around z9, but a 100 km
   corridor is framed well below that — and these are precisely the places a
   reader needs named. Drawn as a labelled point at each unit's centroid. */
function addCorridorPlaceLabels() {
  if (!CORRIDOR || !(CORRIDOR.palikas || []).length) return;
  const want = new Map();
  for (const p of CORRIDOR.palikas) want.set(`${p.palika}|${p.district}`, p);

  fetch(`${window.NHM.DATA}/palikas.geojson`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((fc) => {
      if (!map || map.getSource("corridor-places")) return;
      const feats = [];
      for (const f of fc.features) {
        const key = `${f.properties.adm3_name}|${f.properties.adm2_name}`;
        const rec = want.get(key);
        if (!rec) continue;
        let pt;
        try { pt = turfCentroid(f.geometry); } catch (e) { continue; }
        if (!pt) continue;
        feats.push({
          type: "Feature", geometry: { type: "Point", coordinates: pt },
          properties: {
            name: f.properties.adm3_name,
            sub: `${f.properties.adm2_name} district`,
            events: rec.events || 0,
          },
        });
      }
      if (!feats.length) return;
      map.addSource("corridor-places", {
        type: "geojson", data: { type: "FeatureCollection", features: feats } });
      map.addLayer({ id: "corridor-place-dot", type: "circle", source: "corridor-places",
        paint: { "circle-radius": 3.2, "circle-color": "#ffffff",
          "circle-stroke-width": 1.6, "circle-stroke-color": THEME.inkDim,
          "circle-opacity": 0.95 } });
      map.addLayer({ id: "corridor-place-label", type: "symbol", source: "corridor-places",
        layout: {
          "text-field": ["get", "name"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10.5, 12, 13],
          "text-offset": [0, 0.9], "text-anchor": "top",
          "text-allow-overlap": false, "text-padding": 1,
          "text-font": ["Noto Sans Medium"],
        },
        paint: { "text-color": THEME.ink, "text-halo-color": "#ffffff",
          "text-halo-width": 1.8 } });

      map.on("click", "corridor-place-dot", (e) => {
        const p = e.features[0].properties;
        new maplibregl.Popup().setLngLat(e.lngLat)
          .setHTML(`<b>${p.name}</b><br>${p.sub}` +
            (p.events ? `<br>${p.events} recorded events` : "")).addTo(map);
      });
      map.on("mouseenter", "corridor-place-dot",
        () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "corridor-place-dot",
        () => (map.getCanvas().style.cursor = ""));
    })
    .catch(() => { /* labels are a bonus, never block the map on them */ });
}

/* area-weighted centroid without pulling in turf on this page */
function turfCentroid(geom) {
  const rings = geom.type === "Polygon" ? [geom.coordinates]
    : geom.type === "MultiPolygon" ? geom.coordinates : null;
  if (!rings) return null;
  let bestA = -1, best = null;
  for (const poly of rings) {
    const ring = poly[0];
    let a = 0, x = 0, y = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f;
    }
    a *= 0.5;
    if (Math.abs(a) > bestA && a !== 0) { bestA = Math.abs(a); best = [x / (6 * a), y / (6 * a)]; }
  }
  return best;
}

function fitCorridor(animate = true) {
  if (!CORRIDOR || !CORRIDOR.path.length) return;
  const b = flowPath().reduce(
    (a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]),
               Math.max(a[2], c[0]), Math.max(a[3], c[1])],
    [180, 90, -180, -90]);
  const pad = matchMedia("(min-width: 900px)").matches
    ? { top: 60, bottom: 60, left: 60, right: 420 }
    : { top: 56, bottom: SHEET_PEEK + 28, left: 26, right: 26 };
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]],
    { padding: pad, duration: animate ? 700 : 0, maxZoom: 12 });
}

/* ============================================================================
   FLOW ANIMATION
   A marker travels from the source to the end of the reach while the trail
   draws in behind it. (An earlier version animated a white dash pattern, which
   was invisible against a light basemap.)
   ========================================================================== */
const emptyLine = () => ({ type: "Feature", geometry: { type: "LineString", coordinates: [] } });
const emptyPoint = () => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] } });

/* cumulative planar distance along the path — good enough for interpolation */
function cumulative(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const dx = (path[i][0] - path[i - 1][0]) * Math.cos(path[i][1] * Math.PI / 180);
    const dy = path[i][1] - path[i - 1][1];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

/* position and partial path at travel fraction t (0..1) */
function atFraction(path, cum, t) {
  const target = cum[cum.length - 1] * t;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const span = cum[i] - cum[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (target - cum[i - 1]) / span));
  const pt = [
    path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f,
    path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f,
  ];
  return { pt, trail: path.slice(0, i).concat([pt]) };
}

/* the animated route includes the overland link so the flow starts at the
   event itself rather than jumping to the river */
function flowPath() {
  if (!CORRIDOR) return [];
  const c = CORRIDOR.connector;
  return c && CORRIDOR.snap_km > 0.05
    ? [c[0]].concat(CORRIDOR.path)
    : CORRIDOR.path;
}

function stopFlow() {
  if (anim) { cancelAnimationFrame(anim); anim = null; }
  document.getElementById("i-play").textContent = "▶ Play flow";
}

function resetFlow() {
  stopFlow();
  if (map.getSource("trail")) map.getSource("trail").setData(emptyLine());
  if (map.getSource("head")) map.getSource("head").setData(emptyPoint());
  if (map.getLayer("head-dot")) {
    map.setLayoutProperty("head-dot", "visibility", "none");
    map.setLayoutProperty("head-pulse", "visibility", "none");
  }
}

function startFlow() {
  if (anim) return;
  if (!CORRIDOR || !map.getSource("trail")) return false;
  const path = flowPath();
  if (path.length < 2) return;

  const cum = cumulative(path);
  // longer reaches take longer to traverse, within sensible bounds
  const dur = Math.min(14000, Math.max(4000, CORRIDOR.length_km * 90));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  map.setLayoutProperty("head-dot", "visibility", "visible");
  map.setLayoutProperty("head-pulse", "visibility", "visible");
  document.getElementById("i-play").textContent = "⏸ Pause";

  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur);
    const { pt, trail } = atFraction(path, cum, t);
    map.getSource("trail").setData(
      { type: "Feature", geometry: { type: "LineString", coordinates: trail } });
    map.getSource("head").setData(
      { type: "Feature", geometry: { type: "Point", coordinates: pt } });
    // gentle pulse on the head so it reads as moving water, not a static pin
    if (!reduce && map.getLayer("head-pulse")) {
      map.setPaintProperty("head-pulse", "circle-radius",
        16 + 6 * Math.sin(now / 160));
    }
    if (t < 1) {
      anim = requestAnimationFrame(step);
    } else {
      anim = null;
      document.getElementById("i-play").textContent = "↻ Replay flow";
    }
  };
  // a fresh run always starts from the source
  map.getSource("trail").setData(emptyLine());
  anim = requestAnimationFrame(step);
  return true;
}

document.getElementById("i-play").onclick = () => {
  if (anim) return stopFlow();
  if (startFlow() === false) {
    toast("The corridor is still loading — try again in a moment.");
  }
};

document.getElementById("i-fit").onclick = fitCorridor;

/* start the flow automatically once the corridor is on the map */
function autoPlayFlow() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let tries = 0;
  const t = setInterval(() => {
    if (++tries > 20) return clearInterval(t);
    if (anim) return clearInterval(t);
    if (map && map.getSource && map.getSource("trail") && CORRIDOR) {
      clearInterval(t);
      startFlow();
    }
  }, 400);
}
