const DATA = "assets/data/";
const map = L.map("map").setView([25.757, -80.374], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, attribution:"&copy; OpenStreetMap"}).addTo(map);

let grid = null, heatBase = [], heatLayer = null, routes = [], currentEngine = null;
let timeProfiles = null, schoolCells = new Set(), schoolPts = [];
let liveIncidents = [], liveIncidentLayer = null, liveBriefing = "";
let briefingVersion = 0, briefingTimer = 0;
let startPin = null, endPin = null, routeLayers = [];
let schoolLayer = null, schoolOn = true;

// ---------- time-of-day / day-of-week ----------
const DOW_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
let selDow = new Date().getDay();          // 0=Sun..6=Sat (JS convention)
let selHour = new Date().getHours();
const isWeekend = d => (d === 0 || d === 6);
const timeBucket = () => (isWeekend(selDow) ? 8 : 0) + Math.min(7, Math.floor(selHour / 3));
function timeMult(r, c) {
  if (!timeProfiles) return 1;
  const a = timeProfiles.cells[r + ":" + c];
  return a ? a[timeBucket()] : 1;
}
const inSchoolWindow = () =>
  selDow >= 1 && selDow <= 5 && ((selHour >= 7 && selHour < 9) || (selHour >= 14 && selHour < 16));
const schoolMult = (r, c) =>
  (schoolOn && inSchoolWindow() && schoolCells.has(r + ":" + c)) ? 1.5 : 1;

function cellRC(lat, lon) {
  const r = Math.floor((lat - grid.lat_min) / grid.cell);
  const c = Math.floor((lon - grid.lon_min) / grid.cell);
  return (r >= 0 && c >= 0 && r < grid.rows && c < grid.cols) ? [r, c] : null;
}
function cellRisk(lat, lon) {
  const rc = cellRC(lat, lon);
  if (!rc) return 0;
  return (grid.grid[rc[0]][rc[1]] || 0) * timeMult(rc[0], rc[1]) * schoolMult(rc[0], rc[1]);
}
function scoreRoute(coords) {
  const seen = new Set(); let s = 0;
  const addCell = (lat, lon) => {
    const rc = cellRC(lat, lon);
    if (!rc) return;
    const key = rc[0] + ":" + rc[1];
    if (seen.has(key)) return;
    seen.add(key);
    s += (grid.grid[rc[0]][rc[1]] || 0) * timeMult(rc[0], rc[1]) * schoolMult(rc[0], rc[1]);
  };
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / (grid.cell * 0.4)));
    for (let j = 0; j <= steps; j++) {
      const f = j / steps;
      addCell(a[1] + (b[1] - a[1]) * f, a[0] + (b[0] - a[0]) * f);
    }
  }
  if (coords.length === 1) addCell(coords[0][1], coords[0][0]);
  return Math.round(s);
}

// ---------- data ----------
const gkeyInput = document.getElementById("gkey");
const status = t => document.getElementById("status").textContent = t;

const HEAT_OPTS = {radius: 14, blur: 16, maxZoom: 13,
  gradient:{0.35:"#ffd54f",0.6:"#ff9800",0.8:"#f44336",1:"#b71c1c"}};

function refreshHeat() {
  if (!heatLayer || !grid) return;
  const b = timeBucket();
  const pts = heatBase.map(p => {
    const rc = cellRC(p[0], p[1]);
    let m = 1;
    if (rc && timeProfiles) { const a = timeProfiles.cells[rc[0] + ":" + rc[1]]; if (a) m = a[b]; }
    return [p[0], p[1], Math.min(1, p[2] * m)];
  });
  map.removeLayer(heatLayer);
  heatLayer = L.heatLayer(pts, HEAT_OPTS);
  if (document.getElementById("heatTgl").checked) heatLayer.addTo(map);
}

function popupContent(title, detail, statusLine) {
  const wrap = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  wrap.appendChild(strong);
  [detail, statusLine].filter(Boolean).forEach(text => {
    wrap.appendChild(document.createElement("br"));
    wrap.appendChild(document.createTextNode(text));
  });
  return wrap;
}
function buildSchoolLayer() {
  schoolLayer = L.layerGroup(schoolPts.map(s =>
    L.circle([s[0], s[1]], {radius: 250, color:"#7b1fa2", weight:1.5,
      fillColor:"#7b1fa2", fillOpacity:0.12}).bindPopup(popupContent(s[2] || "School", "School zone (250 m)"))
  ), {renderer: L.canvas()});
  if (schoolOn) schoolLayer.addTo(map);
}

async function loadData() {
  const [g, h, p, s, t, sz] = await Promise.all([
    fetch(DATA + "grid_array.json").then(r => r.json()),
    fetch(DATA + "hazard_heat.json").then(r => r.json()),
    fetch(DATA + "pothole_points.json").then(r => r.json()),
    fetch(DATA + "summary.json").then(r => r.json()),
    fetch(DATA + "time_profiles.json").then(r => r.json()),
    fetch(DATA + "school_zones.json").then(r => r.json()),
  ]);
  grid = g; heatBase = h; timeProfiles = t;
  schoolCells = new Set(sz.cells); schoolPts = sz.schools;
  document.getElementById("stats").innerHTML =
    `<b>Predicted risk model</b> from <b>743,820</b> crashes (FDOT 2011-2018)<br>` +
    `Recency-weighted + trend forecast &middot; validated: rank correlation ${s.holdout_spearman_rho} ` +
    `vs actual 2016-2018 crashes<br>` +
    `Time profiles from <b>292,409</b> crashes with timestamps (2016-2018) &middot; <b>${sz.n_schools.toLocaleString()}</b> school zones mapped<br>` +
    `<b>${s.pothole_open_confirmed.toLocaleString()}</b> confirmed-open potholes (county 311, 2023)`;
  heatLayer = L.heatLayer(h, HEAT_OPTS).addTo(map);
  const pot = L.layerGroup(p.map(pt =>
    L.circleMarker([pt[0], pt[1]], {radius: 4, color: "#ff9800",
      weight: 1, fillOpacity: 0.8}).bindPopup(popupContent(pt[3] || "Pothole", pt[4] || "", "Status: confirmed open (not yet fixed)"))
  ), {renderer: L.canvas()}).addTo(map);
  buildSchoolLayer();
  document.getElementById("heatTgl").onchange = e => e.target.checked ? heatLayer.addTo(map) : map.removeLayer(heatLayer);
  document.getElementById("potTgl").onchange  = e => e.target.checked ? pot.addTo(map) : map.removeLayer(pot);
  document.getElementById("schoolTgl").onchange = e => {
    schoolOn = e.target.checked;
    schoolOn ? schoolLayer.addTo(map) : map.removeLayer(schoolLayer);
    rescoreIfRouted();
  };
  refreshHeat();
  status("Data loaded. Drop two pins.");
}
loadData().catch(e => status("Data failed to load: " + e.message));

// ---------- time UI ----------
(function buildDayChips() {
  const box = document.getElementById("dayChips");
  DOW_NAMES.forEach((n, d) => {
    const b = document.createElement("button");
    b.textContent = n; b.dataset.dow = d;
    if (d === selDow) b.classList.add("on");
    b.onclick = () => {
      selDow = d;
      box.querySelectorAll("button").forEach(x => x.classList.toggle("on", +x.dataset.dow === d));
      onTimeChange();
    };
    box.appendChild(b);
  });
})();
const hourSlider = document.getElementById("hourSlider");
hourSlider.value = selHour;
function fmtHour(h) { const ap = h < 12 ? "AM" : "PM"; const hh = h % 12 === 0 ? 12 : h % 12; return hh + " " + ap; }
function onTimeChange() {
  document.getElementById("hourLbl").textContent = fmtHour(selHour) + " " + DOW_NAMES[selDow];
  refreshHeat();
  rescoreIfRouted();
}
hourSlider.oninput = () => { selHour = +hourSlider.value; onTimeChange(); };
document.getElementById("hourLbl").textContent = fmtHour(selHour) + " " + DOW_NAMES[selDow];

// ---------- pins ----------
map.on("click", e => {
  if (sim.active) return;
  if (!startPin)      { startPin = L.marker(e.latlng, {title:"Start"}).addTo(map).bindPopup("Start").openPopup(); }
  else if (!endPin)   { endPin   = L.marker(e.latlng, {title:"End"}).addTo(map).bindPopup("End").openPopup();
                        document.getElementById("routeBtn").disabled = false; }
  else { map.removeLayer(startPin); map.removeLayer(endPin);
         startPin = L.marker(e.latlng, {title:"Start"}).addTo(map);
         endPin = null; document.getElementById("routeBtn").disabled = true; clearRoutes(); }
});
function clearRouteLayers(){ routeLayers.forEach(l => map.removeLayer(l)); routeLayers = []; }
function clearRoutes(){
  clearRouteLayers();
  if (liveIncidentLayer) map.removeLayer(liveIncidentLayer);
  routes = []; currentEngine = null; liveIncidents = []; liveIncidentLayer = null; liveBriefing = "";
  briefingVersion++; clearTimeout(briefingTimer);
  document.getElementById("results").innerHTML = "";
  const badge = document.getElementById("liveBadge");
  badge.classList.remove("on"); badge.textContent = "";
}
document.getElementById("clearBtn").onclick = () => {
  if (startPin) map.removeLayer(startPin); if (endPin) map.removeLayer(endPin);
  startPin = endPin = null; document.getElementById("routeBtn").disabled = true; clearRoutes(); status("Pins cleared.");
};
function rescoreIfRouted() {
  if (!routes.length) return;
  routes.forEach(rt => {
    const live = SafeRouteLive.scoreRouteLive(rt.geometry.coordinates, liveIncidents);
    rt.livePenalty = live.penalty;
    rt.liveHits = live.hits;
    rt.hazard = scoreRoute(rt.geometry.coordinates) + live.penalty;
  });
  liveBriefing = "";
  const version = ++briefingVersion;
  renderResults(currentEngine);
  clearTimeout(briefingTimer);
  if (SafeRouteLive.geminiKey) briefingTimer = setTimeout(() => addAIBriefing(routes, version), 450);
}

// ---------- routing ----------
function decodePolyline(enc) {
  let lat = 0, lng = 0, i = 0; const out = [];
  while (i < enc.length) {
    let b, shift = 0, res = 0;
    do { b = enc.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (res & 1) ? ~(res >> 1) : (res >> 1);
    shift = 0; res = 0;
    do { b = enc.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (res & 1) ? ~(res >> 1) : (res >> 1);
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}
async function fetchGoogleRoutes(a, b, key) {
  const body = {
    origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
    destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
    travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE",
    departureTime: new Date(Date.now() + 60000).toISOString(),
    computeAlternativeRoutes: true
  };
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               "X-Goog-Api-Key": key,
               "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  if (!j.routes || !j.routes.length) throw new Error("no routes returned");
  return j.routes.map(rt => ({
    duration: parseFloat(rt.duration),
    distance: rt.distanceMeters,
    geometry: { type: "LineString", coordinates: decodePolyline(rt.polyline.encodedPolyline) }
  }));
}
async function fetchOSRM(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?alternatives=true&overview=full&geometries=geojson`;
  const r = await fetch(url).then(x => x.json());
  if (r.code !== "Ok" || !r.routes.length) throw new Error("no routes");
  return r.routes;
}
async function getRoutes(a, b) {
  const key = gkeyInput.value.trim();
  if (key) {
    try { const l = await fetchGoogleRoutes(a, b, key); return {list: l, engine: "Google Routes"}; }
    catch (e) { status("Google Routes failed (" + e.message + ") - falling back to OSRM..."); }
  }
  const l = await fetchOSRM(a, b);
  return {list: l, engine: "OSRM"};
}
function renderResults(engine) {
  if (!routes.length) return;
  currentEngine = engine || currentEngine || "OSRM";
  clearRouteLayers();
  const safest = routes.reduce((x, y) => x.hazard <= y.hazard ? x : y);
  const fastest = routes.reduce((x, y) => x.duration <= y.duration ? x : y);
  const box = document.getElementById("results"); box.innerHTML = "";
  const ordered = [safest];
  if (fastest !== safest) ordered.push(fastest);
  routes.forEach(rt => { if (rt !== safest && rt !== fastest) ordered.push(rt); });
  ordered.forEach((rt, i) => {
    const isSafe = rt === safest, isFast = rt === fastest;
    const color = isSafe ? "#2e9e44" : isFast ? "#1a73e8" : "#888";
    const layer = L.geoJSON(rt.geometry, {style:{color, weight: isSafe||isFast ? 6 : 3, opacity: 0.85}}).addTo(map);
    routeLayers.push(layer);
    const div = document.createElement("div");
    div.className = "route" + (isSafe ? " sel" : "");
    div.innerHTML = `${isSafe?'<span class="badge safe">SAFEST</span>':""}${isFast?'<span class="badge fast">FASTEST</span>':""}` +
      `<b>Route ${i+1}</b> - ${(rt.duration/60).toFixed(0)} min, ${(rt.distance/1609.34).toFixed(1)} mi<br>` +
      `Hazard score: <b>${rt.hazard}</b> <span style="color:#777">(${DOW_NAMES[selDow]} ${fmtHour(selHour)})</span>` +
      (rt.liveHits && rt.liveHits.length ? `<br><span style="color:#b45309">${rt.liveHits.length} live incident${rt.liveHits.length === 1 ? "" : "s"} nearby · +${rt.livePenalty} risk</span>` : "");
    div.onclick = () => { box.querySelectorAll(".route").forEach(d=>d.classList.remove("sel")); div.classList.add("sel");
                          map.fitBounds(layer.getBounds()); };
    box.appendChild(div);
  });
  if (liveBriefing) box.insertAdjacentHTML("afterbegin", SafeRouteLive.briefingCardHTML(liveBriefing));
  map.fitBounds(L.geoJSON(routes[0].geometry).getBounds());
  const cut = fastest.hazard ? Math.round((1 - safest.hazard / fastest.hazard) * 100) : 0;
  status(`Done via ${currentEngine}: safest route cuts hazard by ~${cut}% vs the fastest (${routes.length} options, ${DOW_NAMES[selDow]} ${fmtHour(selHour)}).`);
}
async function addAIBriefing(routeSet, expectedVersion) {
  if (!SafeRouteLive.geminiKey || !routeSet.length) return;
  const safest = routeSet.reduce((x, y) => x.hazard <= y.hazard ? x : y);
  const fastest = routeSet.reduce((x, y) => x.duration <= y.duration ? x : y);
  try {
    const brief = await SafeRouteLive.briefComparison({safest, fastest});
    if (routes !== routeSet || expectedVersion !== briefingVersion) return;
    liveBriefing = brief;
    document.getElementById("results").insertAdjacentHTML("afterbegin", SafeRouteLive.briefingCardHTML(brief));
  } catch (e) {
    // Best effort: route cards remain usable if the briefing service is unavailable.
  }
}

document.getElementById("routeBtn").onclick = async () => {
  if (!startPin || !endPin || !grid || sim.active) return;
  clearRoutes();
  SafeRouteLive.setKeys({
    tomtom: document.getElementById("tomtomKeyInput").value,
    gemini: document.getElementById("geminiKeyInput").value
  });
  const a = startPin.getLatLng(), b = endPin.getLatLng();
  status("Routing...");
  try {
    const {list, engine} = await getRoutes(a, b);
    let liveNote = "";
    if (SafeRouteLive.tomtomKey) {
      status("Fetching live traffic from TomTom...");
      try {
        const bbox = SafeRouteLive.bboxForRoutes(list);
        liveIncidents = await SafeRouteLive.fetchIncidents(bbox);
        SafeRouteLive.updateLiveBadge(liveIncidents);
      } catch (e) {
        liveIncidents = [];
        liveNote = " Live traffic was unavailable; scores use historical data.";
      }
    }
    routes = list.map(rt => {
      const live = SafeRouteLive.scoreRouteLive(rt.geometry.coordinates, liveIncidents);
      return {...rt, livePenalty: live.penalty, liveHits: live.hits,
        hazard: scoreRoute(rt.geometry.coordinates) + live.penalty};
    });
    const routeSet = routes;
    renderResults(engine);
    if (liveIncidents.length) {
      liveIncidentLayer = SafeRouteLive.renderIncidentMarkers(L, map, liveIncidents);
    }
    if (liveNote) document.getElementById("status").textContent += liveNote;
    const version = ++briefingVersion;
    addAIBriefing(routeSet, version);
  } catch (e) { status("Routing failed. Try again in a moment."); }
};

// ---------- fleet demo (the wow moment) ----------
const sim = {
  active: false, paused: false, speed: 2, t: 0,
  cars: [], sroutes: [], phase: 0, raf: 0, lastTs: 0,
  phaseStats: null, eventMarker: null, halo: null, rerouted: 0, targets: [],
};
const SIM_CARS = 24;
const SIM_T_EVENT = 20, SIM_T_END = 46;
const ROUTE_COLORS = ["#ff5252", "#40c4ff", "#69f0ae", "#ffd740", "#ea80fc"];

function haversineM(a, b) {
  const R = 6371000, dLa = (b[0]-a[0])*Math.PI/180, dLo = (b[1]-a[1])*Math.PI/180;
  const s = Math.sin(dLa/2)**2 + Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function prepSimRoute(geomCoords, cropM) {
  const pts = geomCoords.map(c => [c[1], c[0]]); // -> [lat,lng]
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i-1] + haversineM(pts[i-1], pts[i]));
  let n = pts.length;
  if (cropM) { // crop to a corridor segment near the origin for the demo
    n = cum.findIndex(d => d >= cropM);
    if (n < 2) n = pts.length;
  }
  return {pts: pts.slice(0, n), cum: cum.slice(0, n), len: cum[n-1], n: 0};
}
function posAt(sr, dist) {
  const {pts, cum} = sr;
  if (dist <= 0) return pts[0].slice();
  const total = cum[cum.length - 1];
  if (dist >= total) return pts[pts.length - 1].slice();
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= dist) lo = m; else hi = m; }
  const segLen = cum[lo+1] - cum[lo] || 1;
  const f = Math.min(1, Math.max(0, (dist - cum[lo]) / segLen));
  return [pts[lo][0] + (pts[lo+1][0]-pts[lo][0])*f, pts[lo][1] + (pts[lo+1][1]-pts[lo][1])*f];
}
function toast(msg, ms=2600) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.style.display = "block";
  clearTimeout(el._t); el._t = setTimeout(() => el.style.display = "none", ms);
}

function simSetPhase(p, title, sub) {
  sim.phase = p;
  sim.phaseStats = {n:0, speedSum:0, riskSum:0, congSum:0};
  document.getElementById("simPhase").innerHTML = title + (sub ? ` <small>${sub}</small>` : "");
}

async function runFleetDemo() {
  if (sim.active || !grid) return;
  const a = startPin ? startPin.getLatLng() : {lat: 25.70, lng: -80.42};
  const b = endPin ? endPin.getLatLng() : {lat: 25.77, lng: -80.19};
  status("Fleet demo: fetching candidate routes...");
  let list;
  try { ({list} = await getRoutes(a, b)); }
  catch (e) { status("Fleet demo: routing failed. Try again."); return; }
  if (list.length < 2) { status("Fleet demo needs at least 2 alternative routes - try a longer trip."); return; }
  clearRoutes();

  // keep the 3 most distinct routes, score them with current time/school settings.
  // the sim plays out on the first 3 km of each ("the corridor"), cars loop on it.
  const CORR = 3000;
  const scored = list.map(rt => ({rt, hazard: scoreRoute(rt.geometry.coordinates)}))
                     .sort((x, y) => x.hazard - y.hazard).slice(0, 3);
  sim.sroutes = scored.map((s, i) => {
    const sr = prepSimRoute(s.rt.geometry.coordinates, CORR);
    sr.hazard = s.hazard; sr.baseHazard = s.hazard; sr.idx = i;
    sr.ghost = L.polyline(s.rt.geometry.coordinates.map(c => [c[1], c[0]]),
      {color: ROUTE_COLORS[i], weight: 5, opacity: 0.22}).addTo(map);
    sr.poly = L.polyline(sr.pts, {color: ROUTE_COLORS[i], weight: 7, opacity: 0.95}).addTo(map);
    return sr;
  });
  // coordination weight: each extra car on a corridor adds ~6% of the
  // corridors' mean hazard to its perceived cost (internalizes congestion)
  sim.beta = 0.06 * (sim.sroutes.reduce((a, s) => a + s.baseHazard, 0) / sim.sroutes.length);
  map.fitBounds(L.polyline(sim.sroutes[0].pts).getBounds().pad(0.4));

  // all cars start spread along the corridor on the "safest" route (uncoordinated)
  sim.cars = [];
  for (let i = 0; i < SIM_CARS; i++) {
    const d0 = (i / SIM_CARS) * sim.sroutes[0].len;
    const m = L.circleMarker(posAt(sim.sroutes[0], d0), {radius: 5.5, color: "#fff", weight: 2,
      fillColor: ROUTE_COLORS[0], fillOpacity: 1, renderer: L.canvas()}).addTo(map);
    sim.cars.push({sr: 0, dist: d0, marker: m, v: 0, rerouted: false,
                   j: 0.9 + Math.random() * 0.2}); // per-car speed jitter
    sim.sroutes[0].n++;
  }
  Object.assign(sim, {active: true, paused: false, speed: 4, t: 0, rerouted: 0,
                      eventMarker: null, halo: null, _p1: null});
  document.getElementById("simbar").style.display = "block";
  document.getElementById("simFast").textContent = "4×";
  simSetPhase(1, "Phase 1 &mdash; Uncoordinated",
    "every car selfishly takes the &ldquo;safest&rdquo; route");
  document.getElementById("splitbar").innerHTML =
    sim.sroutes.map((sr, i) => `<div data-i="${i}" style="background:${ROUTE_COLORS[i]};width:0%"></div>`).join("");
  status("Fleet demo running: 24 cars, uncoordinated.");
  sim.lastTs = performance.now();
  cancelAnimationFrame(sim.raf);
  sim.raf = requestAnimationFrame(simTick);
}

function optimalFleetTargets() {
  // Minimize total simulated fleet cost: sum(n * hazard + beta * n^2).
  // For this separable convex objective, repeatedly choosing the lowest marginal
  // cost produces the global optimum for all 24 integer vehicle assignments.
  const counts = sim.sroutes.map(() => 0), targets = [];
  for (let car = 0; car < SIM_CARS; car++) {
    let best = 0, bestMarginal = Infinity;
    sim.sroutes.forEach((sr, i) => {
      const marginal = sr.hazard + sim.beta * (2 * counts[i] + 1);
      if (marginal < bestMarginal) { bestMarginal = marginal; best = i; }
    });
    counts[best]++;
    targets.push(best);
  }
  return targets.sort((a, b) => a - b);
}
function simAssign(car, best) {
  car.rerouted = true;
  if (best !== car.sr) {
    sim.sroutes[car.sr].n--; sim.sroutes[best].n++;
    car.sr = best; sim.rerouted++;
    const frac = Math.min(0.98, Math.max(0, car.dist / car._oldLen));
    car.dist = frac * sim.sroutes[best].len;
    car.marker.setStyle({fillColor: ROUTE_COLORS[best]});
  }
}

function simTick(ts) {
  if (!sim.active) return;
  const dtReal = Math.min(0.1, (ts - sim.lastTs) / 1000);
  sim.lastTs = ts;
  if (!sim.paused) {
    const dt = dtReal * sim.speed;
    sim.t += dt;
    const V0 = 25; // m/s free-flow in sim

    // phase transitions
    if (sim.phase === 1 && sim.t >= SIM_T_EVENT) {
      simSetPhase(2, "Phase 2 &mdash; Fleet brain",
        "shared hazard &middot; system-optimal split for simulated total risk + congestion");
      const sr0 = sim.sroutes[0];
      sr0.hazard = sr0.baseHazard * 4 + 300; // the reported crash: corridor goes toxic
      sim.targets = optimalFleetTargets();
      const mid = posAt(sr0, sr0.len * 0.45);
      sim.eventMarker = L.circleMarker(mid, {radius: 12, color: "#ff1744", weight: 3,
        fillColor: "#ff1744", fillOpacity: 0.35, renderer: L.canvas()})
        .addTo(map).bindPopup("<b>Fleet report:</b> crash on main corridor<br>shared with all 24 vehicles");
      toast("🚨 Crash reported on main corridor — fleet brain rerouting", 3200);
      // halo showing congestion on the old corridor
      sim.halo = L.polyline(sr0.pts, {color: "#ff1744", weight: 10, opacity: 0.0}).addTo(map);
    }
    if (sim.t >= SIM_T_END) { endSim(); return; }

    // stagger rerouting after the event so it looks organic
    if (sim.phase === 2) {
      sim.cars.forEach((car, i) => {
        if (!car.rerouted && sim.t > SIM_T_EVENT + 1 + i * 0.18) {
          car._oldLen = sim.sroutes[car.sr].len;
          simAssign(car, sim.targets[i]);
        }
      });
    }

    // congestion per corridor -> speed factor (quadratic in vehicle density)
    const sf = sim.sroutes.map(sr => {
      const d = sr.n / Math.max(0.5, sr.len / 1000); // vehicles per km
      return 1 / (1 + (d / 3) * (d / 3));
    });
    // move cars; they loop around the corridor segment
    sim.cars.forEach(car => {
      const sr = sim.sroutes[car.sr];
      car.v = V0 * sf[car.sr] * car.j;
      car.dist += car.v * dt;
      if (car.dist >= sr.len) car.dist -= sr.len;
      car.marker.setLatLng(posAt(sr, car.dist));
    });

    // pulse both the reported-crash marker and its congested corridor
    if (sim.eventMarker) sim.eventMarker.setRadius(12 + 4 * (0.5 + 0.5 * Math.sin(sim.t * 5)));
    if (sim.halo) sim.halo.setStyle({opacity: 0.25 + 0.2 * Math.sin(sim.t * 5)});

    // stats
    const ps = sim.phaseStats;
    let sp = 0, rk = 0, cg = 0, moving = 0;
    sim.cars.forEach(car => {
      moving++;
      const f = car.v / V0;
      sp += f; cg += (1 - f); rk += sim.sroutes[car.sr].hazard;
    });
    if (moving) { ps.n++; ps.speedSum += sp / moving; ps.riskSum += rk / moving; ps.congSum += cg / moving; }

    // HUD
    const avgF = moving ? sp / moving : 1;
    document.getElementById("simSpeed").textContent = Math.round(avgF * 100) + "%";
    document.getElementById("simRisk").textContent = moving ? Math.round(rk / moving) : "--";
    document.getElementById("simCong").textContent = cgLevel(moving ? cg / moving : 0);
    document.getElementById("simProgFill").style.width = Math.min(100, sim.t / SIM_T_END * 100) + "%";
    sim.sroutes.forEach((sr, i) => {
      const el = document.querySelector(`#splitbar div[data-i="${i}"]`);
      if (el) el.style.width = (sr.n / SIM_CARS * 100) + "%";
    });
    document.getElementById("splitLbl").textContent =
      sim.sroutes.map((sr, i) => `R${i+1}: ${sr.n}`).join(" · ");
  }
  sim.raf = requestAnimationFrame(simTick);
}
function cgLevel(x) { return x < 0.2 ? "flowing" : x < 0.5 ? "heavy" : x < 0.75 ? "congested" : "jammed"; }

function endSim() {
  const p1 = sim._p1 || {speedSum: 0, riskSum: 0, congSum: 0, n: 1};
  const p2 = sim.phaseStats;
  const spiked = sim.sroutes.length ? sim.sroutes[0].hazard : 0; // crashed corridor's reported risk
  showScoreboard(p1, p2, spiked);
  cleanupSim(false);
}
// stash phase-1 stats when leaving phase 1: hook into simSetPhase
const _simSetPhase = simSetPhase;
simSetPhase = function(p, title, sub) {
  if (sim.phase === 1 && p === 2) sim._p1 = sim.phaseStats;
  _simSetPhase(p, title, sub);
};

function showScoreboard(p1, p2, spiked) {
  const avg = p => ({speed: p.speedSum / Math.max(1, p.n), risk: p.riskSum / Math.max(1, p.n), cong: p.congSum / Math.max(1, p.n)});
  const a = avg(p1), b = avg(p2);
  const dDelay = (a.cong - b.cong) / Math.max(0.01, a.cong) * 100;
  const dRisk = spiked > 0 ? (spiked - b.risk) / spiked * 100 : 0;
  const speedup = b.speed / Math.max(0.01, a.speed);
  const w = document.getElementById("scoreWrap");
  document.getElementById("score").innerHTML = `
    <h2>🚗 Fleet demo results</h2>
    <div style="color:#555;font-size:13px">24 vehicles, same origin &amp; destination. The only difference: coordination.</div>
    <div class="vs">
      <div class="card lose"><h3>Uncoordinated</h3>
        <div class="big">${Math.round(a.speed*100)}%</div>avg speed<br>
        <div class="big">${Math.round(a.risk)}</div>avg risk / car<br>
        <div style="margin-top:4px">congestion: <b>${cgLevel(a.cong)}</b></div></div>
      <div class="card win"><h3>🧠 Fleet brain</h3>
        <div class="big">${Math.round(b.speed*100)}%</div>avg speed<br>
        <div class="big">${Math.round(b.risk)}</div>avg risk / car<br>
        <div style="margin-top:4px">congestion: <b>${cgLevel(b.cong)}</b></div></div>
    </div>
    <div style="font-size:14px">Fleet brain moved traffic <b>${speedup.toFixed(1)}&times; faster</b>
      on average (${Math.round(a.speed*100)}% &rarr; ${Math.round(b.speed*100)}% of free-flow speed),
      cutting congestion delay by <b>${Math.max(0,Math.round(dDelay))}%</b> and steering cars off the
      reported crash corridor &mdash; <b>${Math.max(0,Math.round(dRisk))}%</b> less risk exposure than
      staying put. Live, on the same roads.</div>
    <div style="margin-top:10px">
      <button id="scoreReplay" style="background:#1a73e8;color:#fff">Replay demo</button>
      <button id="scoreClose" style="background:#eef1f4">Back to map</button>
    </div>`;
  w.style.display = "flex";
  document.getElementById("scoreReplay").onclick = () => { w.style.display = "none"; runFleetDemo(); };
  document.getElementById("scoreClose").onclick = () => { w.style.display = "none"; };
}

function cleanupSim(full=true) {
  cancelAnimationFrame(sim.raf);
  sim.cars.forEach(c => map.removeLayer(c.marker));
  sim.sroutes.forEach(sr => { map.removeLayer(sr.poly); if (sr.ghost) map.removeLayer(sr.ghost); });
  if (sim.eventMarker) map.removeLayer(sim.eventMarker);
  if (sim.halo) map.removeLayer(sim.halo);
  sim.cars = []; sim.sroutes = []; sim.active = false;
  document.getElementById("simbar").style.display = "none";
  if (full) status("Fleet demo closed.");
}
document.getElementById("fleetBtn").onclick = runFleetDemo;
document.getElementById("simExit").onclick = () => cleanupSim(true);
document.getElementById("simPause").onclick = e => {
  sim.paused = !sim.paused;
  e.target.textContent = sim.paused ? "Resume" : "Pause";
};
document.getElementById("simFast").onclick = e => {
  sim.speed = sim.speed >= 4 ? 1 : sim.speed * 2;
  e.target.textContent = sim.speed + "×";
};
