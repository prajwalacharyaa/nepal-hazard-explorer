/* Per-district page: district.html?d=<slug> */
const { HAZARD_COLORS, HAZARD_LABELS, THEME, MAP_STYLE, paths, slugify,
        loadJSON, fmt, hazardName, readableDate, eventsToCSV, download,
        toast } = window.NHM;

const qp = new URLSearchParams(location.search);
const slug = qp.get("d") || "";
let ALL = [], FEATURES = [], IX = null, NAME = slug;
let sortKey = "date", sortDir = -1;

// optional filter carried from the map (district.html?d=x&y=2000-2026&h=flood,landslide)
const FILTER = (() => {
  const f = {};
  if (qp.has("y")) {
    const [a, b] = qp.get("y").split("-").map(Number);
    if (a && b) { f.yMin = Math.min(a, b); f.yMax = Math.max(a, b); }
  }
  if (qp.has("h")) f.haz = new Set(qp.get("h").split(",").filter(Boolean));
  return f;
})();
function applyFilter(list) {
  return list.filter((f) => {
    const p = f.properties;
    if (FILTER.yMin && (p.year < FILTER.yMin || p.year > FILTER.yMax)) return false;
    if (FILTER.haz && !FILTER.haz.has(p.hazard)) return false;
    return true;
  });
}

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
  if (fc.status === "fulfilled") { ALL = fc.value.features; NAME = fc.value.district || NAME; }
  FEATURES = (FILTER.yMin || FILTER.haz) ? applyFilter(ALL) : ALL;

  document.getElementById("d-name").textContent = NAME;
  document.title = `${NAME} — hazard history — Nepal`;
  if (!ALL.length) {
    document.getElementById("d-sub").textContent = "No recorded events in this dataset.";
    return;
  }
  const yrs = FEATURES.map((f) => f.properties.year).filter(Boolean);
  const span = yrs.length ? `${Math.min(...yrs)}–${Math.max(...yrs)}` : "—";
  document.getElementById("d-sub").textContent =
    `${fmt(FEATURES.length)} recorded events, ${span}`;

  if (FILTER.yMin || FILTER.haz) {
    const bits = [];
    if (FILTER.yMin) bits.push(`${FILTER.yMin}–${FILTER.yMax}`);
    if (FILTER.haz) bits.push([...FILTER.haz].map(hazardName).join(", "));
    const b = document.createElement("div");
    b.className = "filter-banner";
    b.innerHTML = `Filtered from the map: <b>${bits.join(" · ")}</b> ` +
      `<a href="district.html?d=${encodeURIComponent(slug)}">show all ${fmt(ALL.length)} →</a>`;
    document.querySelector(".doc-head").appendChild(b);
  }

  if (!FEATURES.length) {
    document.getElementById("answers").innerHTML =
      "<p class='muted'>No events match the filter carried from the map.</p>";
    return;
  }
  renderAnswers();
  renderMiniMap();
  renderCharts();
  renderPalikas();
  renderTable();
  wireDownloads();
  document.getElementById("d-src").innerHTML =
    "Sources: Nepal DRR/BIPAD, DesInventar Sentinel, curated major events. Older " +
    "records are placed at village or district centroids — treat point positions " +
    "as approximate. Event counts rise sharply after ~2011 because reporting improved. " +
    '<a href="methodology.html">Methodology &amp; data notes →</a>';
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
    container: "d-map", style: MAP_STYLE,
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
        "circle-opacity": 0.85, "circle-stroke-width": 1, "circle-stroke-color": "#ffffff",
      },
    });
    try {
      const dj = await loadJSON(paths.districts);
      const poly = dj.features.find((f) => f.properties.district === NAME);
      if (poly) {
        m.addSource("poly", { type: "geojson", data: poly });
        m.addLayer({ id: "poly", type: "line", source: "poly",
          paint: { "line-color": THEME.accent, "line-width": 1.6 } }, "pts");
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
  const ERA = 2011;
  const svg = d3.create("svg").attr("class", "chart").attr("viewBox", `0 0 ${w} ${h}`)
    .attr("preserveAspectRatio", "xMinYMid meet").attr("font-size", 9)
    .attr("style", `max-width:${w}px`)
    .attr("role", "img").attr("aria-label", "Recorded events per year");
  // reporting-era band: dim the under-reported pre-2011 span
  if (years[0] < ERA) {
    svg.append("rect")
      .attr("x", x(years[0])).attr("y", 4)
      .attr("width", Math.max(0, (x(ERA - 1) ?? x(years.at(-1))) + x.bandwidth() - x(years[0])))
      .attr("height", h - pad - 4)
      .attr("fill", THEME.ink).attr("opacity", 0.045);
    svg.append("text").attr("x", x(years[0]) + 3).attr("y", 12)
      .attr("fill", THEME.inkFaint).attr("font-size", 8.5).attr("font-weight", 600).text("sparser reporting");
  }
  svg.append("g").selectAll("rect.bar").data(years).join("rect").attr("class", "bar")
    .attr("x", (d) => x(d)).attr("y", (d) => y(byYear.get(d) || 0))
    .attr("width", x.bandwidth()).attr("height", (d) => h - pad - y(byYear.get(d) || 0))
    .attr("fill", (d) => (d < ERA ? THEME.barMuted : THEME.bar))
    .append("title").text((d) => `${d}: ${byYear.get(d) || 0}`);
  svg.append("g").attr("transform", `translate(0,${h - pad})`).attr("color", THEME.inkFaint)
    .call(d3.axisBottom(x).tickValues(years.filter((d) => d % 10 === 0)).tickSizeOuter(0));
  svg.append("g").attr("transform", `translate(${pad},0)`).attr("color", THEME.inkFaint)
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
       <td class="num">${p.deaths ?? ""}</td><td class="num">${p.missing ?? ""}</td>
       <td class="num">${p.houses_destroyed ?? ""}</td>
       <td class="num">${p.severity_score ? Math.round(p.severity_score) : ""}</td>
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

let pSortKey = "events", pSortDir = -1;
function renderPalikas() {
  // compute from the (possibly filtered) feature set so it stays consistent
  const byP = new Map();
  for (const f of FEATURES) {
    const name = f.properties.palika;
    if (!name) continue;
    const r = byP.get(name) || { palika: name, events: 0, deaths: 0, last_year: 0, worst: null };
    r.events++;
    r.deaths += f.properties.deaths || 0;
    r.last_year = Math.max(r.last_year, f.properties.year || 0);
    if (!r.worst || (f.properties.severity_score || 0) > (r.worst.severity_score || 0)) r.worst = f.properties;
    byP.set(name, r);
  }
  const rows = [...byP.values()];
  if (!rows.length) return;
  document.getElementById("palika-section").hidden = false;
  const tb = document.querySelector("#p-table tbody");
  const draw = () => {
    const sorted = [...rows].sort((a, b) => {
      const av = a[pSortKey] ?? "", bv = b[pSortKey] ?? "";
      return (av < bv ? -1 : av > bv ? 1 : 0) * pSortDir;
    });
    tb.innerHTML = "";
    for (const p of sorted) {
      const w = p.worst;
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${p.palika}</td><td class="num">${fmt(p.events)}</td><td class="num">${fmt(p.deaths)}</td>
         <td class="num">${p.last_year || ""}</td>
         <td class="muted">${w ? `${hazardName(w.hazard)} ${readableDate(w.date)}` +
           (w.deaths ? `, ${w.deaths} dead` : "") +
           ` <a href="event.html?id=${encodeURIComponent(w.id)}&d=${slug}">›</a>` : ""}</td>`;
      tb.appendChild(tr);
    }
  };
  document.querySelectorAll("#p-table th[data-k]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      pSortDir = pSortKey === k ? -pSortDir : -1; pSortKey = k; draw();
      document.querySelectorAll("#p-table th").forEach((x) => (x.dataset.sort = ""));
      th.dataset.sort = pSortDir < 0 ? "desc" : "asc";
    };
  });
  draw();
}

function wireDownloads() {
  document.getElementById("dl-csv").onclick = () =>
    download(`${slug}_events.csv`, eventsToCSV(FEATURES), "text/csv");
  document.getElementById("dl-geo").onclick = () =>
    download(`${slug}_events.geojson`,
      JSON.stringify({ type: "FeatureCollection", district: NAME, features: FEATURES }),
      "application/geo+json");
}
