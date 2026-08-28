/* Experimental section — Approach D (seasonal statistical outlook). */
const { DATA, loadJSON, fmt } = window.NHM;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let OUT = null, SUSC = null, NOW = null;

init();

async function init() {
  try { OUT = await loadJSON(`${DATA}/outlook.json`); }
  catch (e) {
    document.getElementById("verdict").textContent =
      "outlook.json not found — run pipeline/outlook.py.";
    return;
  }
  try { SUSC = await loadJSON(`${DATA}/susceptibility.json`); } catch (e) { SUSC = null; }
  try {
    const n = await loadJSON(`${DATA}/nowcast.json`);
    NOW = n && !n.unavailable ? n : null;
  } catch (e) { NOW = null; }
  document.getElementById("method").textContent = OUT.meta.method +
    `  Recent window ${OUT.meta.recent_window[0]}–${OUT.meta.recent_window[1]}.`;

  const dsel = document.getElementById("d-pick");
  for (const d of Object.keys(OUT.districts).sort()) {
    const o = document.createElement("option"); o.value = d; o.textContent = d;
    dsel.appendChild(o);
  }
  const msel = document.getElementById("m-pick");
  MONTHS.forEach((m, i) => {
    const o = document.createElement("option"); o.value = i + 1; o.textContent = m;
    msel.appendChild(o);
  });
  msel.value = new Date().getMonth() + 1;
  dsel.value = OUT.districts["Rasuwa"] ? "Rasuwa" : Object.keys(OUT.districts)[0];

  dsel.onchange = render; msel.onchange = render;
  render();

  document.getElementById("src").innerHTML =
    "Method: descriptive climatology from the compiled BIPAD + DesInventar record. " +
    "Poisson intervals assume independent events and a stationary rate within the " +
    "window — both are only approximations. Trends are sensitive to reporting changes. " +
    "This is not a forecast and must not be used for operational decisions.";

  window.NHM.stampMeta("#meta-stamp");

  document.querySelectorAll(".sub-tabs a").forEach((a) => {
    a.onclick = () => { document.querySelectorAll(".sub-tabs a").forEach((x) => x.classList.remove("active")); a.classList.add("active"); };
  });
}

function render() {
  const d = document.getElementById("d-pick").value;
  const mo = +document.getElementById("m-pick").value;
  const rec = OUT.districts[d];
  const bm = rec.by_month[mo - 1];

  // verdict sentence
  const lo = bm.lo, hi = bm.hi;
  const conf = { low: "few records — treat as indicative only",
                 medium: "a moderate record", high: "a substantial record" }[rec.confidence];
  const trendTxt = rec.trend_per_year > 0.15
    ? `rising (~${rec.trend_per_year.toFixed(1)} more events/year${rec.trend_pct != null ? `, +${rec.trend_pct}%/yr` : ""})`
    : rec.trend_per_year < -0.15
      ? `falling (~${Math.abs(rec.trend_per_year).toFixed(1)} fewer events/year)`
      : "roughly flat";
  document.getElementById("verdict").innerHTML =
    `In <b>${MONTHS[mo - 1]}</b>, <b>${d}</b> has recorded on average ` +
    `<b>${bm.mean}</b> events (${lo}–${hi} in most years), 2011–2025. ` +
    `Historically deadliest month: <b>${rec.peak_month ? MONTHS[rec.peak_month - 1] : "—"}</b>. ` +
    `Annual count is ${trendTxt}. Based on ${conf} (${fmt(rec.n_recent)} events in window).` +
    (bm.deaths_total ? ` Recorded ${MONTHS[mo - 1]} deaths in this window: ${fmt(bm.deaths_total)}.` : "");

  drawMonthChart(rec, mo);
  drawTrend(rec);
  drawHist(rec);
  renderSusceptibility(d);
  renderNowcast(d);
}

function renderNowcast(d) {
  const method = document.getElementById("nc-method");
  const missing = document.getElementById("nc-missing");
  const body = document.getElementById("nc-body");
  if (!NOW) { missing.hidden = false; body.hidden = true; method.textContent = ""; return; }
  missing.hidden = true; body.hidden = false;
  method.textContent = NOW.model || "";
  document.getElementById("nc-asof").textContent =
    `${NOW.source} — conditions for ${NOW.as_of}`;

  const rec = (NOW.districts || {})[d];
  const dEl = document.getElementById("nc-district");
  if (rec) {
    const col = rec.level === "high" ? "#bd0026" : "#f28e2b";
    dEl.innerHTML =
      `<b>${d}</b>: <span style="color:${col}">${rec.level.toUpperCase()}</span> ` +
      `landslide hazard nowcast for ${NOW.as_of}. ` +
      `${rec.moderate_plus_pct}% of the district flagged moderate+` +
      (rec.high_pct ? `, ${rec.high_pct}% high` : "") + `.`;
  } else {
    dEl.innerHTML = `<b>${d}</b>: not flagged in the ${NOW.as_of} nowcast.`;
  }

  const list = document.getElementById("nc-list");
  list.innerHTML = "";
  for (const name of NOW.elevated || []) {
    const r = NOW.districts[name];
    const s = document.createElement("span");
    s.className = "chip on";
    s.style.color = r.level === "high" ? "#bd0026" : "#f28e2b";
    s.textContent = `${name} · ${r.level}`;
    s.onclick = () => { document.getElementById("d-pick").value = name; render(); };
    list.appendChild(s);
  }
  if (!(NOW.elevated || []).length)
    list.innerHTML = "<span class='muted'>No districts flagged in the latest nowcast.</span>";
}

const LS_COLORS = ["#20242b", "#4e79a7", "#76b7b2", "#f6c85f", "#f28e2b", "#bd0026"];

function renderSusceptibility(d) {
  const method = document.getElementById("susc-method");
  const missing = document.getElementById("susc-missing");
  const body = document.getElementById("susc-body");
  if (!SUSC) { missing.hidden = false; body.hidden = true; method.textContent = ""; return; }
  missing.hidden = true; body.hidden = false;
  const m = SUSC.meta || {};
  method.textContent = m.note || "";
  document.getElementById("ls-src").textContent = m.landslide_source || "";
  document.getElementById("fl-src").textContent = m.flood_source || "";

  const rec = SUSC.districts[d] || {};
  const ls = document.getElementById("ls-box");
  if (rec.ls_majority_class) {
    const c = rec.ls_majority_class;
    ls.innerHTML =
      `<p class="big" style="color:${LS_COLORS[c]}">${rec.ls_majority_label}</p>
       <p class="muted">most common class across the district (mean ${rec.ls_mean_class}/5)</p>
       <div class="meter"><span style="width:${rec.ls_high_pct}%;background:${LS_COLORS[4]}"></span></div>
       <p class="muted">${rec.ls_high_pct}% of the district is class 4–5 (high / very high)</p>`;
  } else {
    ls.innerHTML = "<p class='muted'>No landslide raster loaded.</p>";
  }
  const fl = document.getElementById("fl-box");
  if (rec.fl_area_pct != null) {
    fl.innerHTML =
      `<p class="big" style="color:${window.NHM.HAZARD_COLORS.flood}">${rec.fl_area_pct}%</p>
       <p class="muted">of district area within the 100-year river floodplain</p>
       <p class="muted">mean depth there: ${rec.fl_mean_depth_m} m · max ${rec.fl_max_depth_m} m</p>`;
  } else {
    fl.innerHTML = "<p class='muted'>No flood raster loaded.</p>";
  }
}

function drawMonthChart(rec, mo) {
  const box = document.getElementById("month-chart"); box.innerHTML = "";
  const W = 460, H = 200, padL = 30, padB = 24, padT = 8;
  const data = rec.by_month;
  const x = d3.scaleBand().domain(d3.range(12)).range([padL, W - 6]).padding(0.25);
  const ymax = d3.max(data, (b) => Math.max(b.hi, b.mean)) || 1;
  const y = d3.scaleLinear().domain([0, ymax]).nice().range([H - padB, padT]);
  const svg = d3.create("svg").attr("width", W).attr("height", H).attr("font-size", 9);

  svg.append("g").attr("transform", `translate(0,${H - padB})`).attr("color", "#9aa3ad")
    .call(d3.axisBottom(x).tickFormat((i) => MONTHS[i]).tickSizeOuter(0));
  svg.append("g").attr("transform", `translate(${padL},0)`).attr("color", "#9aa3ad")
    .call(d3.axisLeft(y).ticks(4).tickSizeOuter(0));

  svg.append("g").selectAll("rect").data(data).join("rect")
    .attr("x", (_, i) => x(i)).attr("width", x.bandwidth())
    .attr("y", (b) => y(b.mean)).attr("height", (b) => y(0) - y(b.mean))
    .attr("fill", (_, i) => (i + 1 === mo ? "#ff7a45" : "#4e79a7"))
    .append("title").text((b) => `${MONTHS[b.m - 1]}: mean ${b.mean}, 5–95% ${b.lo}–${b.hi}`);

  svg.append("g").attr("stroke", "#e8eaed").attr("stroke-width", 1)
    .selectAll("line").data(data).join("line")
    .attr("x1", (_, i) => x(i) + x.bandwidth() / 2).attr("x2", (_, i) => x(i) + x.bandwidth() / 2)
    .attr("y1", (b) => y(b.lo)).attr("y2", (b) => y(b.hi));
  box.append(svg.node());
}

function drawTrend(rec) {
  const box = document.getElementById("trend-box");
  const s = rec.trend_per_year;
  const arrow = s > 0.15 ? "↑" : s < -0.15 ? "↓" : "→";
  const col = s > 0.15 ? "#f28e2b" : s < -0.15 ? "#4e79a7" : "#9aa3ad";
  box.innerHTML =
    `<p style="font-size:26px;margin:4px 0;color:${col}">${arrow} ${s > 0 ? "+" : ""}${s.toFixed(2)}<span style="font-size:12px"> events / year</span></p>` +
    `<p class="cap">OLS slope of annual recorded totals, 2011–2025. Reporting coverage also grew over this period, so part of any rise is observational.</p>`;
}

function drawHist(rec) {
  const box = document.getElementById("hist-chart"); box.innerHTML = "";
  const share = rec.hist_month_share;
  if (!share || share.every((v) => v == null)) { box.innerHTML = "<p class='muted'>No 1971–2010 records.</p>"; return; }
  const W = 300, H = 90, padB = 16;
  const x = d3.scaleBand().domain(d3.range(12)).range([0, W]).padding(0.25);
  const y = d3.scaleLinear().domain([0, d3.max(share) || 1]).range([H - padB, 4]);
  const svg = d3.create("svg").attr("width", W).attr("height", H).attr("font-size", 8);
  svg.append("g").selectAll("rect").data(share).join("rect")
    .attr("x", (_, i) => x(i)).attr("width", x.bandwidth())
    .attr("y", (v) => y(v || 0)).attr("height", (v) => H - padB - y(v || 0))
    .attr("fill", "#76b7b2")
    .append("title").text((v, i) => `${MONTHS[i]}: ${Math.round((v || 0) * 100)}% of 1971–2010 events`);
  svg.append("g").attr("transform", `translate(0,${H - padB})`).attr("color", "#9aa3ad")
    .call(d3.axisBottom(x).tickFormat((i) => MONTHS[i][0]).tickSizeOuter(0));
  box.append(svg.node());
}
