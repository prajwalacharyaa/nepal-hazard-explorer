/* Per-district page: district.html?d=<slug> */
const { HAZARD_COLORS, HAZARD_LABELS, paths, slugify, loadJSON, fmt,
        hazardName, readableDate, eventsToCSV, download } = window.NHM;

const slug = new URLSearchParams(location.search).get("d") || "";
let FEATURES = [], IX = null, NAME = slug;
let sortKey = "date", sortDir = -1;

init();

async function init() {
  let manifest = {};
  try { manifest = await loadJSON(paths.manifest); } catch (e) {}
  for (const [name, m] of Object.entries(manifest)) if (m.slug === slug) NAME = name;

  const [ix, fc] = await Promise.allSettled([
    loadJSON(paths.districtIndex),
    loadJSON(paths.districtEvents(slug)),
  ]);
  if (ix.status === "fulfilled") IX = ix.value[NAME] || null;
  if (fc.status === "fulfilled") { FEATURES = fc.value.features; NAME = fc.value.district || NAME; }

  document.getElementById("d-name").textContent = NAME;
  document.title = `${NAME} — hazard history — Nepal`;
  if (!FEATURES.length) {
    document.getElementById("d-sub").textContent = "No recorded events in this dataset.";
    return;
  }
  const yrs = FEATURES.map((f) => f.properties.year).filter(Boolean);
  document.getElementById("d-sub").textContent =
    `${fmt(FEATURES.length)} recorded events, ${Math.min(...yrs)}–${Math.max(...yrs)}`;

  renderAnswers();
  renderMiniMap();
  renderCharts();
  renderTable();
  wireDownloads();
  document.getElementById("d-src").innerHTML =
    "Sources: Nepal DRR/BIPAD, DesInventar Sentinel, curated major events. Older " +
    "records are placed at village or district centroids — treat point positions " +
    "as approximate. Event counts rise sharply after ~2011 because reporting improved.";
  NHM.stampMeta(document.getElementById("d-src").insertAdjacentElement(
    "beforebegin", Object.assign(document.createElement("p"), { className: "src" })));
}

/* -------- "has my area been hit?" answer cards -------- */
function renderAnswers() {
  const byHaz = {};
  for (const f of FEATURES) {
    const p = f.properties;
    const b = (byHaz[p.hazard] ||= { n: 0, deaths: 0, last: null, worst: null });
    b.n++; b.deaths += p.deaths || 0;
    if (!b.last || p.date > b.last) b.last = p.date;
    if (!b.worst || (p.severity_score || 0) > (b.worst.severity_score || 0)) b.worst = p;
  }
  const order = ["flood", "landslide", "flash_flood", "debris_flow", "glof", "avalanche"];
  const el = document.getElementById("answers");
  el.innerHTML = "";
  for (const h of order) {
    const b = byHaz[h];
    const card = document.createElement("div");
    card.className = "card" + (b ? "" : " empty");
    if (!b) {
      card.innerHTML = `<h3>${hazardName(h)}</h3><p class="none">None recorded</p>`;
    } else {
      const w = b.worst;
      card.innerHTML =
        `<h3 style="color:${HAZARD_COLORS[h]}">${hazardName(h)}</h3>
         <p class="big">${fmt(b.n)}</p><p class="muted">events · ${fmt(b.deaths)} deaths</p>
         <p class="muted">last: ${readableDate(b.last)}</p>
         <p class="muted">worst: ${readableDate(w.date)}, ${fmt(w.deaths || 0)} dead
           <a href="event.html?id=${encodeURIComponent(w.id)}&d=${slug}">›</a></p>`;
    }
    el.appendChild(card);
  }
}

/* -------- mini locator map -------- */
async function renderMiniMap() {
  const m = new maplibregl.Map({
    container: "d-map", style: "https://tiles.openfreemap.org/styles/positron",
    center: meanCenter(), zoom: 8, attributionControl: { compact: true },
  });
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  m.on("load", async () => {
    m.addSource("pts", { type: "geojson",
      data: { type: "FeatureCollection", features: FEATURES } });
    m.addLayer({
      id: "pts", type: "circle", source: "pts",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "severity_score"], 0, 3, 200, 11],
        "circle-color": ["match", ["get", "hazard"], ...Object.entries(HAZARD_COLORS).flat(), "#888"],
        "circle-opacity": 0.7, "circle-stroke-width": 0.5, "circle-stroke-color": "#0b0d10",
      },
    });
    try {
      const dj = await loadJSON(paths.districts);
      const poly = dj.features.find((f) => f.properties.district === NAME);
      if (poly) {
        m.addSource("poly", { type: "geojson", data: poly });
        m.addLayer({ id: "poly", type: "line", source: "poly",
          paint: { "line-color": "#ff7a45", "line-width": 1.5 } }, "pts");
        m.fitBounds(turfBounds(poly), { padding: 30, duration: 0 });
      }
    } catch (e) {}
    m.on("click", "pts", (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup().setLngLat(e.lngLat).setHTML(
        `<b>${hazardName(p.hazard)}</b> · ${readableDate(p.date, p.date_precision)}<br>` +
        `deaths ${p.deaths ?? "?"} · <a href="event.html?id=${encodeURIComponent(p.id)}&d=${slug}">details →</a>`,
      ).addTo(m);
    });
    m.on("mouseenter", "pts", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "pts", () => (m.getCanvas().style.cursor = ""));
  });
}
function meanCenter() {
  const c = FEATURES.reduce((a, f) => [a[0] + f.geometry.coordinates[0], a[1] + f.geometry.coordinates[1]], [0, 0]);
  return [c[0] / FEATURES.length, c[1] / FEATURES.length];
}
function turfBounds(poly) {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const walk = (co) => {
    if (typeof co[0] === "number") {
      minX = Math.min(minX, co[0]); maxX = Math.max(maxX, co[0]);
      minY = Math.min(minY, co[1]); maxY = Math.max(maxY, co[1]);
    } else co.forEach(walk);
  };
  walk(poly.geometry.coordinates);
  return [[minX, minY], [maxX, maxY]];
}

/* -------- charts: events per year + per decade + hazard mix -------- */
function renderCharts() {
  const box = document.getElementById("d-charts");
  box.innerHTML = "<h3>Events per year</h3>";
  const byYear = d3.rollup(FEATURES, (v) => v.length, (f) => f.properties.year);
  const years = d3.range(d3.min([...byYear.keys()]), new Date().getFullYear() + 1);
  const w = 420, h = 130, pad = 24;
  const x = d3.scaleBand().domain(years).range([pad, w - 4]).padding(0.15);
  const y = d3.scaleLinear().domain([0, d3.max([...byYear.values()]) || 1]).range([h - pad, 4]);
  const svg = d3.create("svg").attr("width", w).attr("height", h).attr("font-size", 9);
  svg.append("g").selectAll("rect").data(years).join("rect")
    .attr("x", (d) => x(d)).attr("y", (d) => y(byYear.get(d) || 0))
    .attr("width", x.bandwidth()).attr("height", (d) => h - pad - y(byYear.get(d) || 0))
    .attr("fill", "#4e79a7").append("title").text((d) => `${d}: ${byYear.get(d) || 0}`);
  svg.append("g").attr("transform", `translate(0,${h - pad})`).attr("color", "#9aa3ad")
    .call(d3.axisBottom(x).tickValues(years.filter((d) => d % 10 === 0)).tickSizeOuter(0));
  svg.append("g").attr("transform", `translate(${pad},0)`).attr("color", "#9aa3ad")
    .call(d3.axisLeft(y).ticks(3).tickSizeOuter(0));
  box.append(svg.node());

  box.insertAdjacentHTML("beforeend", "<h3>Hazard mix</h3>");
  const byHaz = d3.rollup(FEATURES, (v) => v.length, (f) => f.properties.hazard);
  const tot = FEATURES.length;
  const bar = document.createElement("div"); bar.className = "hbar";
  for (const [hz, n] of [...byHaz].sort((a, b) => b[1] - a[1])) {
    const seg = document.createElement("span");
    seg.style.width = `${(n / tot) * 100}%`;
    seg.style.background = HAZARD_COLORS[hz] || "#888";
    seg.title = `${hazardName(hz)}: ${n} (${Math.round((n / tot) * 100)}%)`;
    bar.appendChild(seg);
  }
  box.appendChild(bar);
  box.insertAdjacentHTML("beforeend",
    "<p class='cap'>Bars: absolute yearly counts. The post-2011 jump is mostly reporting coverage (BIPAD), " +
    "not a real regime change — compare decades with care.</p>");
}

/* -------- sortable event table -------- */
function renderTable() {
  const tb = document.querySelector("#d-table tbody");
  const rows = [...FEATURES].sort((a, b) => {
    const av = a.properties[sortKey] ?? "", bv = b.properties[sortKey] ?? "";
    return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
  });
  tb.innerHTML = "";
  for (const f of rows) {
    const p = f.properties;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><a href="event.html?id=${encodeURIComponent(p.id)}&d=${slug}">${readableDate(p.date, p.date_precision)}</a></td>
       <td style="color:${HAZARD_COLORS[p.hazard] || "#888"}">${hazardName(p.hazard)}</td>
       <td>${p.deaths ?? ""}</td><td>${p.missing ?? ""}</td>
       <td>${p.houses_destroyed ?? ""}</td>
       <td>${p.severity_score ? Math.round(p.severity_score) : ""}</td>
       <td class="muted">${p.place_detail || p.title || ""}${p.source ? ` · <span class="pill">${p.source}</span>` : ""}</td>`;
    tb.appendChild(tr);
  }
  document.querySelectorAll("#d-table th[data-k]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      sortDir = sortKey === k ? -sortDir : (k === "date" ? -1 : -1);
      sortKey = k; renderTable();
      document.querySelectorAll("#d-table th").forEach((x) => (x.dataset.sort = ""));
      th.dataset.sort = sortDir < 0 ? "desc" : "asc";
    };
  });
}

function wireDownloads() {
  document.getElementById("dl-csv").onclick = () =>
    download(`${slug}_events.csv`, eventsToCSV(FEATURES), "text/csv");
  document.getElementById("dl-geo").onclick = () =>
    download(`${slug}_events.geojson`,
      JSON.stringify({ type: "FeatureCollection", district: NAME, features: FEATURES }),
      "application/geo+json");
}
