// TaxiRută — Cloudflare Worker
// Servește PWA-ul (din /public) și un API mic care face proxy către servicii
// gratuite: Valhalla (rutare, OSM), Photon (căutare adrese, OSM) și, opțional,
// TomTom Traffic (trafic în timp real, gratuit până la 2.500 cereri/zi).

const VALHALLA = "https://valhalla1.openstreetmap.de";
const PHOTON = "https://photon.komoot.io";
const TOMTOM = "https://api.tomtom.com";
const UA = "TaxiRuta/1.0 (PWA navigatie taxi; Cloudflare Worker)";
const MAX_EXCLUDE = 50; // limita serverului Valhalla public

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/config") {
        return json({ traffic: Boolean(env.TOMTOM_KEY), version: 1 });
      }
      if (url.pathname === "/api/geocode") return geocode(url);
      if (url.pathname === "/api/reverse") return reverse(url);
      if (url.pathname === "/api/route" && request.method === "POST") {
        return route(await request.json(), env, ctx);
      }
      if (url.pathname === "/api/optimize" && request.method === "POST") {
        return optimize(await request.json());
      }
      if (url.pathname.startsWith("/api/traffic-tile/")) {
        return trafficTile(url, env, ctx);
      }
      if (url.pathname.startsWith("/api/")) {
        return json({ error: "Not found" }, 404);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

// ---------------------------------------------------------------- utilitare

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validPoint(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

function dist(a, b) {
  // a, b = [lon, lat]
  const x = toRad(b[0] - a[0]) * Math.cos(toRad((a[1] + b[1]) / 2));
  const y = toRad(b[1] - a[1]);
  return Math.sqrt(x * x + y * y) * R;
}

function bearing(a, b) {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// distanța de la punctul p la segmentul [a, b] (în metri, aproximare plană)
function distToSeg(p, a, b) {
  const kx = Math.cos(toRad(p[1])) * R * (Math.PI / 180);
  const ky = R * (Math.PI / 180);
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.sqrt(x * x + y * y);
}

// polyline cu precizie 6 (formatul Valhalla) -> [[lon, lat], ...]
function decodePolyline6(str) {
  const coords = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

async function valhalla(path, body) {
  const res = await fetch(`${VALHALLA}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Valhalla ${res.status}`);
    e.code = data.error_code;
    e.status = res.status;
    throw e;
  }
  return data;
}

// ------------------------------------------------------------- geocodare

function photonFeature(f) {
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(" ");
  const name = p.name || street || p.city || "Locație";
  const parts = [];
  if (p.name && street) parts.push(street);
  if (p.district && p.district !== name) parts.push(p.district);
  if (p.city && p.city !== name) parts.push(p.city);
  else if (p.county && p.county !== name) parts.push(p.county);
  return { name, detail: parts.join(", "), lat, lon };
}

async function geocode(url) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
  if (q.length < 2) return json({ results: [] });
  const params = new URLSearchParams({ q, limit: "7" });
  const lat = num(url.searchParams.get("lat"));
  const lon = num(url.searchParams.get("lon"));
  if (lat !== null && lon !== null) {
    params.set("lat", String(lat));
    params.set("lon", String(lon));
    params.set("location_bias_scale", "0.4");
    params.set("zoom", "12");
  }
  const res = await fetch(`${PHOTON}/api/?${params}`, { headers: { "user-agent": UA } });
  if (!res.ok) return json({ results: [], error: `Căutare indisponibilă (${res.status})` }, 502);
  const data = await res.json();
  return json({ results: (data.features || []).map(photonFeature) });
}

async function reverse(url) {
  const lat = num(url.searchParams.get("lat"));
  const lon = num(url.searchParams.get("lon"));
  if (lat === null || lon === null) return json({ error: "lat/lon lipsă" }, 400);
  const res = await fetch(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&limit=1`, { headers: { "user-agent": UA } });
  if (!res.ok) return json({ result: null });
  const data = await res.json();
  const f = (data.features || [])[0];
  return json({ result: f ? { ...photonFeature(f), lat, lon } : null });
}

// ------------------------------------------------------------- trafic

// Ambuteiaje / închideri din TomTom Traffic Incidents v5, cache 90 s.
async function fetchIncidents(bbox, env, ctx) {
  if (!env.TOMTOM_KEY) return [];
  // rotunjim bbox-ul ca să refolosim cache-ul între cereri apropiate
  const r = (v, up) => (up ? Math.ceil(v * 50) : Math.floor(v * 50)) / 50;
  const b = [r(bbox[0], false), r(bbox[1], false), r(bbox[2], true), r(bbox[3], true)];
  const cacheKey = new Request(`https://cache.taxi-ruta/incidents/${b.join(",")}`);
  const cache = caches.default;
  let hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const fields =
    "{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,delay,length,from,to,roadNumbers,events{description}}}}";
  const params = new URLSearchParams({
    key: env.TOMTOM_KEY,
    bbox: b.join(","),
    fields,
    timeValidityFilter: "present",
    categoryFilter: "1,6,7,8,9,14",
  });
  const res = await fetch(`${TOMTOM}/traffic/services/5/incidentDetails?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const jams = [];
  for (const inc of data.incidents || []) {
    const g = inc.geometry;
    const p = inc.properties || {};
    if (!g || g.type !== "LineString" || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
    const cat = p.iconCategory;
    const closed = cat === 8;
    const mag = p.magnitudeOfDelay || 0;
    // păstrăm doar ce te ține pe loc: blocaje moderate/mari, accidente, închideri
    if (!closed && mag < 2 && !(p.delay > 60)) continue;
    jams.push({
      coords: g.coordinates,
      cat,
      closed,
      magnitude: mag,
      delay: p.delay || 0,
      length: p.length || 0,
      from: p.from || "",
      to: p.to || "",
      desc: (p.events && p.events[0] && p.events[0].description) || "",
    });
  }
  ctx.waitUntil(
    cache.put(cacheKey, new Response(JSON.stringify(jams), { headers: { "cache-control": "max-age=90" } }))
  );
  return jams;
}

async function trafficTile(url, env, ctx) {
  if (!env.TOMTOM_KEY) return new Response("no traffic", { status: 404 });
  const m = url.pathname.match(/^\/api\/traffic-tile\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (!m) return new Response("bad tile", { status: 400 });
  const [, z, x, y] = m;
  if (Number(z) < 6 || Number(z) > 18) return new Response("zoom", { status: 400 });
  const cacheKey = new Request(`https://cache.taxi-ruta/flow/${z}/${x}/${y}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = await fetch(
    `${TOMTOM}/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?tileSize=256&thickness=8&key=${env.TOMTOM_KEY}`
  );
  if (!res.ok) return new Response("tile error", { status: 502 });
  const out = new Response(res.body, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=120" },
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// Grilă spațială pentru verificarea rapidă a suprapunerii rută ↔ blocaje.
function buildJamIndex(jams) {
  const cell = 0.002; // ~ 160-220 m
  const grid = new Map();
  jams.forEach((jam, ji) => {
    for (let i = 0; i < jam.coords.length - 1; i++) {
      const a = jam.coords[i], b = jam.coords[i + 1];
      const minX = Math.floor(Math.min(a[0], b[0]) / cell), maxX = Math.floor(Math.max(a[0], b[0]) / cell);
      const minY = Math.floor(Math.min(a[1], b[1]) / cell), maxY = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let x = minX; x <= maxX; x++)
        for (let y = minY; y <= maxY; y++) {
          const k = x + ":" + y;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push([ji, i]);
        }
    }
  });
  return { cell, grid, jams };
}

function nearJam(index, p, heading) {
  const { cell, grid, jams } = index;
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
  for (let x = cx - 1; x <= cx + 1; x++)
    for (let y = cy - 1; y <= cy + 1; y++) {
      const list = grid.get(x + ":" + y);
      if (!list) continue;
      for (const [ji, i] of list) {
        const a = jams[ji].coords[i], b = jams[ji].coords[i + 1];
        if (distToSeg(p, a, b) > 22) continue;
        // blocajele TomTom au sens de mers: verificăm să mergem în același sens
        if (heading !== null && angleDiff(heading, bearing(a, b)) > 55) continue;
        return ji;
      }
    }
  return -1;
}

// Cât din rută trece prin blocaje și cât te-ar costa (secunde estimate)
function scoreAgainstJams(coords, index) {
  if (!index || !index.jams.length) return { overlapM: 0, delayS: 0, closed: false, hit: new Set() };
  let overlapM = 0, delayS = 0, closed = false;
  const hit = new Set();
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const d = dist(a, b);
    if (d < 0.5) continue;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const ji = nearJam(index, mid, bearing(a, b));
    if (ji < 0) continue;
    const jam = index.jams[ji];
    overlapM += d;
    hit.add(ji);
    if (jam.closed) closed = true;
    // întârzierea blocajului repartizată pe metru
    const perM = jam.length > 0 && jam.delay > 0 ? jam.delay / jam.length : 0.15 * jam.magnitude;
    delayS += d * perM;
  }
  if (closed) delayS += 3600;
  return { overlapM: Math.round(overlapM), delayS: Math.round(delayS), closed, hit };
}

// Puncte de excludere de-a lungul unui blocaj (la ~120 m, cu direcția de mers)
function exclusionPointsForJam(jam, maxPts) {
  const out = [];
  let acc = 60;
  for (let i = 0; i < jam.coords.length - 1 && out.length < maxPts; i++) {
    const a = jam.coords[i], b = jam.coords[i + 1];
    const d = dist(a, b);
    while (acc <= d && out.length < maxPts) {
      const t = acc / d;
      out.push({
        lon: a[0] + (b[0] - a[0]) * t,
        lat: a[1] + (b[1] - a[1]) * t,
        heading: Math.round(bearing(a, b)),
        heading_tolerance: 45,
      });
      acc += 120;
    }
    acc -= d;
  }
  return out;
}

// ------------------------------------------------------------- rutare

function costingFor(mode, opts, straightKm) {
  const c = {
    use_ferry: 0,
    use_tracks: 0,
    use_tolls: opts.tolls ? 0.5 : 0,
    exclude_unpaved: mode !== "rapid",
  };
  if (mode === "rapid") {
    c.maneuver_penalty = 5;
  } else if (mode === "maxim") {
    // drumul cel mai scurt: intră pe străduțe ori de câte ori scurtează
    c.shortest = true;
    c.maneuver_penalty = 1;
    c.use_highways = 0;
  } else {
    // „Străduțe” (implicit): cântărește mult distanța, nu doar viteza teoretică
    // a bulevardelor, și penalizează puțin virajele.
    c.use_distance = 0.75;
    c.maneuver_penalty = 2;
    c.use_highways = 0.2;
    c.use_living_streets = 0.4;
  }
  if (mode !== "rapid" && straightKm < 40) c.disable_hierarchy_pruning = true;
  return { auto: c };
}

function simplifyManeuvers(leg) {
  return (leg.maneuvers || []).map((m) => ({
    type: m.type,
    text: m.instruction,
    alert: m.verbal_transition_alert_instruction || "",
    pre: m.verbal_pre_transition_instruction || m.instruction,
    post: m.verbal_post_transition_instruction || "",
    street: (m.street_names || m.begin_street_names || [])[0] || "",
    begin: m.begin_shape_index,
    end: m.end_shape_index,
    km: m.length,
    s: m.time,
    exit: m.roundabout_exit_count || 0,
  }));
}

function tripToRoute(trip) {
  const leg = trip.legs[0];
  return {
    coords: decodePolyline6(leg.shape),
    maneuvers: simplifyManeuvers(leg),
    km: trip.summary.length,
    s: Math.round(trip.summary.time),
  };
}

async function route(body, env, ctx) {
  const from = body.from, to = body.to;
  if (!validPoint(from) || !validPoint(to)) return json({ error: "Plecare/destinație invalidă" }, 400);
  const mode = ["rapid", "stradute", "maxim"].includes(body.mode) ? body.mode : "stradute";
  const straightKm = dist([from.lon, from.lat], [to.lon, to.lat]) / 1000;
  if (straightKm > 400) return json({ error: "Distanță prea mare pentru navigația de oraș" }, 400);

  const origin = { lat: from.lat, lon: from.lon };
  if (Number.isFinite(from.heading) && from.heading >= 0) {
    origin.heading = Math.round(from.heading) % 360;
    origin.heading_tolerance = 60;
  }
  const locations = [origin, { lat: to.lat, lon: to.lon }];

  // Puncte de evitat de la client: "Sunt blocat" + locuri unde ai stat pe loc în trecut
  const clientAvoid = (Array.isArray(body.avoid) ? body.avoid : [])
    .filter(validPoint)
    // nu excludem chiar locul de plecare/sosire (Valhalla nu ar mai găsi drum)
    .filter((p) => dist([p.lon, p.lat], [from.lon, from.lat]) > 60 && dist([p.lon, p.lat], [to.lon, to.lat]) > 60)
    .slice(0, 35)
    .map((p) => {
      const o = { lat: p.lat, lon: p.lon };
      if (Number.isFinite(p.heading)) { o.heading = Math.round(p.heading) % 360; o.heading_tolerance = 45; }
      return o;
    });

  // Blocaje în timp real în zona traseului
  const pad = 0.02 + straightKm / 400;
  const bbox = [
    Math.min(from.lon, to.lon) - pad, Math.min(from.lat, to.lat) - pad,
    Math.max(from.lon, to.lon) + pad, Math.max(from.lat, to.lat) + pad,
  ];
  const jams = body.avoidTraffic !== false ? await fetchIncidents(bbox, env, ctx) : [];
  const index = jams.length ? buildJamIndex(jams) : null;

  const baseReq = {
    locations,
    costing: "auto",
    costing_options: costingFor(mode, body, straightKm),
    language: "ro-RO",
    units: "kilometers",
    directions_options: { language: "ro-RO", units: "kilometers" },
  };

  const run = async (exclude, alternates) => {
    const req = { ...baseReq, alternates };
    if (exclude.length) req.exclude_locations = exclude.slice(0, MAX_EXCLUDE);
    const data = await valhalla("route", req);
    return [data.trip, ...(data.alternates || []).map((a) => a.trip)].map(tripToRoute);
  };

  let candidates;
  let usedAvoid = clientAvoid;
  try {
    candidates = await run(clientAvoid, 2);
  } catch (e) {
    if (!clientAvoid.length) return json({ error: routeErrorText(e) }, 502);
    // Cu puncte excluse nu există drum — reîncercăm fără ele
    usedAvoid = [];
    candidates = await run([], 2);
  }

  const score = (r) => {
    const j = scoreAgainstJams(r.coords, index);
    r.jamOverlapM = j.overlapM;
    r.jamDelayS = j.delayS;
    r.closed = j.closed;
    r.score = r.s + j.delayS;
    return j;
  };
  candidates.forEach(score);

  // Dacă toate variantele trec prin blocaje, cerem o rută care le exclude
  let rerouted = false;
  const excludedJams = new Set();
  for (let pass = 0; pass < 3 && index; pass++) {
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    if (best.jamDelayS < 45 && !best.closed) break;
    // blocajele de pe toate variantele (întâi cele de pe cea mai bună), ca noua
    // rută să nu fugă dintr-un blocaj în altul
    const order = [];
    for (const c of candidates.slice(0, 4)) {
      for (const ji of scoreAgainstJams(c.coords, index).hit) if (!excludedJams.has(ji) && !order.includes(ji)) order.push(ji);
    }
    const hit = order.map((ji) => [ji, jams[ji]])
      .sort((a, b) => (b[1].closed - a[1].closed) || (b[1].delay - a[1].delay));
    const room = MAX_EXCLUDE - usedAvoid.length;
    if (room <= 0 || !hit.length) break;
    const extra = [];
    for (const [ji, jam] of hit) {
      if (extra.length >= room) break;
      extra.push(...exclusionPointsForJam(jam, Math.min(4, room - extra.length)));
      excludedJams.add(ji);
    }
    const exclude = [...usedAvoid, ...extra];
    try {
      const more = await run(exclude, 1);
      more.forEach(score);
      candidates.push(...more);
      usedAvoid = exclude;
      rerouted = true;
    } catch {
      break;
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  // eliminăm duplicatele (aceeași lungime și durată)
  const seen = new Set();
  const routes = candidates.filter((r) => {
    const k = `${r.km.toFixed(2)}|${Math.round(r.s / 10)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 3);
  routes.forEach((r) => delete r.score);

  // Ruta curentă (pentru verificarea periodică „există ceva mai liber?”)
  let compare = null;
  if (Array.isArray(body.compare) && body.compare.length > 1 && index) {
    const coords = body.compare.filter((c) => Array.isArray(c) && c.length === 2).slice(0, 600);
    const j = scoreAgainstJams(coords, index);
    compare = { jamOverlapM: j.overlapM, jamDelayS: j.delayS, closed: j.closed };
  }

  return json({
    routes,
    mode,
    rerouted,
    traffic: Boolean(env.TOMTOM_KEY),
    jams: jams.map((j) => ({ coords: j.coords, closed: j.closed, magnitude: j.magnitude, delay: j.delay, from: j.from, to: j.to, desc: j.desc })),
    compare,
  });
}

function routeErrorText(e) {
  if (e && (e.code === 442 || e.code === 443)) return "Nu am găsit drum până acolo.";
  if (e && e.code === 171) return "Nu găsesc un drum lângă unul dintre puncte.";
  return "Serviciul de rutare nu răspunde. Încearcă din nou.";
}

// ------------------------------------------------------- ordinea opririlor

// Cea mai bună ordine pentru max 10 opriri pornind din poziția curentă
// (drum deschis: nu trebuie să te întorci la start). Held-Karp exact.
async function optimize(body) {
  const start = body.start;
  const stops = Array.isArray(body.stops) ? body.stops.filter(validPoint).slice(0, 10) : [];
  if (!validPoint(start) || stops.length < 2) return json({ order: stops.map((_, i) => i) });
  const pts = [start, ...stops].map((p) => ({ lat: p.lat, lon: p.lon }));
  const data = await valhalla("sources_to_targets", {
    sources: pts,
    targets: pts,
    costing: "auto",
    costing_options: costingFor("stradute", body, 10),
  });
  const n = pts.length;
  const T = data.sources_to_targets.map((row) => row.map((c) => (c && c.time != null ? c.time : 1e7)));
  const m = n - 1; // opririle sunt 1..m
  const FULL = 1 << m;
  const dp = new Float64Array(FULL * m).fill(Infinity);
  const par = new Int8Array(FULL * m).fill(-1);
  for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = T[0][j + 1];
  for (let mask = 1; mask < FULL; mask++) {
    for (let j = 0; j < m; j++) {
      const cur = dp[mask * m + j];
      if (!(mask & (1 << j)) || cur === Infinity) continue;
      for (let k = 0; k < m; k++) {
        if (mask & (1 << k)) continue;
        const nm = mask | (1 << k);
        const v = cur + T[j + 1][k + 1];
        if (v < dp[nm * m + k]) { dp[nm * m + k] = v; par[nm * m + k] = j; }
      }
    }
  }
  let best = Infinity, last = 0;
  for (let j = 0; j < m; j++) if (dp[(FULL - 1) * m + j] < best) { best = dp[(FULL - 1) * m + j]; last = j; }
  const order = [];
  let mask = FULL - 1, j = last;
  while (j >= 0) {
    order.push(j);
    const p = par[mask * m + j];
    mask &= ~(1 << j);
    j = p;
  }
  order.reverse();
  return json({ order, seconds: Math.round(best) });
}
