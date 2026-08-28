/* Per-event permalink: event.html?id=<id>&d=<slug> */
const { HAZARD_COLORS, paths, slugify, loadJSON, fmt, hazardName,
        readableDate, download } = window.NHM;

const qs = new URLSearchParams(location.search);
const ID = qs.get("id");
const DSLUG = qs.get("d") || "";

init();

async function init() {
  let features = [];
  if (DSLUG) {
    try { features = (await loadJSON(paths.districtEvents(DSLUG))).features; } catch (e) {}
  }
  if (!features.some((f) => f.properties.id === ID)) {
    // fallback: scan the full set
    try { features = (await loadJSON(paths.events)).features; } catch (e) {}
  }
  const feat = features.find((f) => f.properties.id === ID);
  if (!feat) {
    document.getElementById("e-title").textContent = "Event not found";
    document.getElementById("e-sub").textContent = ID || "";
    return;
  }
  render(feat, features);
}

function render(feat, siblings) {
  const p = feat.properties;
  const [lon, lat] = feat.geometry.coordinates;
  const dslug = DSLUG || slugify(p.district || "");

  document.getElementById("e-title").textContent =
    `${hazardName(p.hazard)} — ${p.district || "Nepal"}`;
  document.getElementById("e-sub").textContent =
    `${readableDate(p.date, p.date_precision)} · record ${p.id}`;
  document.title = `${hazardName(p.hazard)}, ${p.district}, ${readableDate(p.date)} — Nepal hazards`;

  const rows = [
    ["Date", readableDate(p.date, p.date_precision) + (p.date_precision !== "day" ? ` (${p.date_precision}-precision)` : "")],
    ["Hazard", hazardName(p.hazard)],
    ["District", p.district || "—"],
    ["Place detail", p.place_detail || "—"],
    ["Deaths", fmt(p.deaths ?? 0)],
    ["Missing", fmt(p.missing ?? 0)],
    ["Injured", fmt(p.injured ?? 0)],
    ["People affected", fmt(p.people_affected ?? 0)],
    ["Houses destroyed", fmt(p.houses_destroyed ?? 0)],
    ["Houses damaged", fmt(p.houses_damaged ?? 0)],
    ["Severity score", p.severity_score != null ? `${Math.round(p.severity_score)} (${p.severity_class})` : "—"],
    ["Coordinates", `${lat.toFixed(4)}, ${lon.toFixed(4)}`],
    ["Location precision", (p.geo_precision || "—").replace(/_/g, " ")],
    ["Data source", p.source || "—"],
    ["GLIDE", p.glide || "—"],
    ["Reported by", p.report_sources || "—"],
  ];
  document.getElementById("e-facts").innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

  const link = p.source_url
    ? `<dt>Source link</dt><dd><a href="${p.source_url}" target="_blank" rel="noopener">open ↗</a></dd>` : "";
  document.getElementById("e-facts").insertAdjacentHTML("beforeend", link);

  // map
  const m = new maplibregl.Map({
    container: "e-map", style: "https://tiles.openfreemap.org/styles/positron",
    center: [lon, lat], zoom: p.geo_precision === "exact" ? 11 : 8,
    attributionControl: { compact: true },
  });
  m.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  m.on("load", () => {
    m.addSource("pt", { type: "geojson", data: feat });
    m.addLayer({
      id: "pt", type: "circle", source: "pt",
      paint: { "circle-radius": 8, "circle-color": HAZARD_COLORS[p.hazard] || "#888",
        "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
    });
    if (p.geo_precision !== "exact") {
      m.addLayer({ id: "halo", type: "circle", source: "pt",
        paint: { "circle-radius": 40, "circle-color": HAZARD_COLORS[p.hazard] || "#888", "circle-opacity": 0.12 } }, "pt");
    }
  });

  // citation
  const acc = new Date().toISOString().slice(0, 10);
  document.getElementById("e-cite").textContent =
    `Nepal Water & Slope Hazard Explorer. "${hazardName(p.hazard)}, ${p.district}, ` +
    `${readableDate(p.date, p.date_precision)}" (record ${p.id}, source: ${p.source}). ` +
    `Compiled from Nepal DRR/BIPAD and DesInventar Sentinel. Accessed ${acc}. ${location.href}`;

  document.getElementById("dl-rec").onclick = () =>
    download(`${p.id}.geojson`, JSON.stringify(feat), "application/geo+json");

  const dl = document.getElementById("e-district-link");
  dl.href = `district.html?d=${encodeURIComponent(dslug)}`;

  // prev / next within siblings, by date
  const sorted = [...siblings].sort((a, b) => (a.properties.date < b.properties.date ? -1 : 1));
  const i = sorted.findIndex((f) => f.properties.id === ID);
  const nav = (j, el) => {
    const t = sorted[j];
    const a = document.getElementById(el);
    if (!t) { a.classList.add("disabled"); a.removeAttribute("href"); return; }
    a.href = `event.html?id=${encodeURIComponent(t.properties.id)}&d=${dslug}`;
    a.textContent = (el === "e-prev" ? "← " : "") +
      `${hazardName(t.properties.hazard)} ${readableDate(t.properties.date)}` +
      (el === "e-next" ? " →" : "");
  };
  nav(i - 1, "e-prev"); nav(i + 1, "e-next");

  document.getElementById("e-src").innerHTML =
    "Figures are as recorded by the original source and are not independently verified. " +
    "For older records the mapped point is a village or district centroid, not the exact site.";
}
