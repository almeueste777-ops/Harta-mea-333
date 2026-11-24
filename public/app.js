/* TaxiRută — navigație gratuită pentru taximetriști.
 * Rute pe străduțe, ocolirea blocajelor, max. 10 curse pe zi.
 * Tot ce ține de tine (lista, setările, locurile învățate) rămâne pe telefon (localStorage).
 */
(() => {
  "use strict";

  // ------------------------------------------------------------ utilitare
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stocare indisponibilă */ } },
  };
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dist = (a, b) => {
    const x = toRad(b[0] - a[0]) * Math.cos(toRad((a[1] + b[1]) / 2));
    const y = toRad(b[1] - a[1]);
    return Math.sqrt(x * x + y * y) * R;
  };
  const bearing = (a, b) => {
    const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
    const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  };
  const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  // proiecția punctului p pe segmentul [a,b]: distanța și poziția t∈[0,1]
  function project(p, a, b) {
    const kx = Math.cos(toRad(p[1])) * R * (Math.PI / 180), ky = R * (Math.PI / 180);
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return { d: Math.sqrt(x * x + y * y), t };
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1).replace(".", ",")} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
  const fmtMin = (s) => Math.max(1, Math.round(s / 60));
  const fmtClock = (d) => d.toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" });
  function voiceDist(m) {
    if (m >= 1000) {
      const km = Math.round(m / 100) / 10;
      if (km === 1) return "un kilometru";
      return `${String(km).replace(".", ",")} kilometri`;
    }
    const r = Math.max(50, Math.round(m / 50) * 50);
    return `${r} de metri`;
  }
  const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

  let toastTimer;
  function toast(msg, ms = 3500) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), ms);
  }

  async function api(path, body) {
    const opt = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {};
    const res = await fetch(path, opt);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Eroare ${res.status}`);
    return data;
  }

  // ------------------------------------------------------------ stare
  const params = new URLSearchParams(location.search);
  const SIM = params.has("sim"); // ?sim — simulează condusul pe rută (pentru probă la birou)
  const MAX_STOPS = 10;

  const state = {
    settings: Object.assign(
      { voice: true, traffic: true, learn: true, autoReroute: true, tolls: false, theme: "auto", mode: "stradute" },
      LS.get("tr_settings", {})
    ),
    stops: LS.get("tr_stops", []),
    slow: LS.get("tr_slow", []), // locuri unde ai stat pe loc: {lat, lon, h, hits:[timestamp]}
    manualAvoid: [], // „Blocat!” — {lat, lon, heading, until}
    pos: null,
    config: { traffic: false },
    preview: null,
    nav: null,
    follow: true,
    trafficLayer: LS.get("tr_trafficLayer", false),
    jams: [],
  };
  // cursele făcute în zilele trecute dispar singure
  state.stops = state.stops.filter((s) => !(s.done && s.day !== today()));

  const saveStops = () => LS.set("tr_stops", state.stops);
  const saveSettings = () => LS.set("tr_settings", state.settings);
  const saveSlow = () => LS.set("tr_slow", state.slow);

  // ------------------------------------------------------------ hartă
  const STYLES = {
    day: "https://tiles.openfreemap.org/styles/liberty",
    night: "https://tiles.openfreemap.org/styles/dark",
  };
  function themeNow() {
    const t = state.settings.theme;
    if (t === "day" || t === "night") return t;
    const h = new Date().getHours();
    return h >= 19 || h < 7 ? "night" : "day";
  }
  let currentTheme = themeNow();
  const lastView = LS.get("tr_view", { c: [26.1025, 44.4268], z: 13 });

  const map = new maplibregl.Map({
    container: "map",
    style: STYLES[currentTheme],
    center: lastView.c,
    zoom: lastView.z,
    attributionControl: { compact: true },
    maxPitch: 60,
  });
  map.touchZoomRotate.disableRotation();

  const EMPTY = { type: "FeatureCollection", features: [] };
  const overlay = { route: EMPTY, alt: EMPTY, jams: EMPTY, slow: EMPTY };

  function firstSymbolId() {
    const l = (map.getStyle().layers || []).find((x) => x.type === "symbol");
    return l ? l.id : undefined;
  }

  // numele locale (București, nu „Bucharest”)
  function localLabels() {
    for (const l of map.getStyle().layers || []) {
      const tf = l.layout && l.layout["text-field"];
      if (tf && JSON.stringify(tf).includes("name_en")) {
        map.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name:ro"], ["get", "name"], ["get", "name:latin"]]);
      }
    }
  }

  function ensureOverlays() {
    if (!map.getStyle()) return;
    if (!map.__labelsDone) { localLabels(); map.__labelsDone = true; }
    const before = firstSymbolId();
    if (state.config.traffic && !map.getSource("traffic")) {
      map.addSource("traffic", {
        type: "raster",
        tiles: [`${location.origin}/api/traffic-tile/{z}/{x}/{y}.png`],
        tileSize: 256, minzoom: 6, maxzoom: 18,
      });
      map.addLayer({
        id: "traffic", type: "raster", source: "traffic",
        layout: { visibility: state.trafficLayer ? "visible" : "none" },
        paint: { "raster-opacity": 0.85 },
      }, before);
    }
    if (!map.getSource("route")) {
      map.addSource("alt", { type: "geojson", data: overlay.alt });
      map.addSource("route", { type: "geojson", data: overlay.route });
      map.addSource("jams", { type: "geojson", data: overlay.jams });
      map.addSource("slow", { type: "geojson", data: overlay.slow });
      map.addLayer({
        id: "alt-line", type: "line", source: "alt",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#8a96a8", "line-width": 7, "line-opacity": 0.75 },
      }, before);
      map.addLayer({
        id: "route-casing", type: "line", source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0b3a8a", "line-width": 11 },
      }, before);
      map.addLayer({
        id: "route-line", type: "line", source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#2f80ff", "line-width": 7 },
      }, before);
      map.addLayer({
        id: "jams-line", type: "line", source: "jams",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": ["case", ["get", "closed"], "#111", [">=", ["get", "magnitude"], 3], "#e11d48", "#f97316"],
          "line-width": 5, "line-dasharray": [1, 1.2],
        },
      }, before);
      map.addLayer({
        id: "slow-dot", type: "circle", source: "slow",
        paint: { "circle-radius": 5, "circle-color": "#a855f7", "circle-opacity": 0.7, "circle-stroke-width": 1, "circle-stroke-color": "#fff" },
      });
    }
    refreshSlowLayer();
  }
  map.on("style.load", () => { map.__labelsDone = false; ensureOverlays(); });

  function setOverlay(name, data) {
    overlay[name] = data;
    const src = map.getSource(name);
    if (src) src.setData(data);
  }
  const lineFeature = (coords, props = {}) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
  const fc = (features) => ({ type: "FeatureCollection", features });

  function refreshSlowLayer() {
    setOverlay("slow", fc(state.slow.map((s) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [s.lon, s.lat] } }))));
  }

  function setTheme(t) {
    if (t === currentTheme) return;
    currentTheme = t;
    map.setStyle(STYLES[t], { diff: false });
  }
  setInterval(() => setTheme(themeNow()), 5 * 60 * 1000);

  map.on("moveend", () => {
    if (state.nav) return;
    const c = map.getCenter();
    LS.set("tr_view", { c: [c.lng, c.lat], z: map.getZoom() });
  });
  map.on("dragstart", (e) => {
    if (e.originalEvent && state.follow) {
      state.follow = false;
      $("btnLocate").classList.remove("on");
    }
  });

  // înălțimea foii de jos -> spațiu pentru butoane și centrarea hărții
  const sheetObserver = new ResizeObserver(() => {
    const h = $("sheet").offsetHeight;
    document.documentElement.style.setProperty("--sheet-h", `${h}px`);
  });
  sheetObserver.observe($("sheet"));

  // ------------------------------------------------------------ markere
  const meEl = document.createElement("div");
  meEl.className = "me nohead";
  const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: "map", pitchAlignment: "map" });
  let meOnMap = false;
  let stopMarkers = [];

  function renderStopMarkers() {
    stopMarkers.forEach((m) => m.remove());
    stopMarkers = state.stops.map((s, i) => {
      const el = document.createElement("div");
      const target = state.nav && state.nav.stop.id === s.id;
      el.innerHTML = `<div class="pin${s.done ? " done" : ""}${target ? " target" : ""}"><span>${s.done ? "✓" : i + 1}</span></div>`;
      el.title = s.name;
      el.addEventListener("click", (ev) => { ev.stopPropagation(); if (!state.nav && !s.done) previewRoute(s); });
      return new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -4] }).setLngLat([s.lon, s.lat]).addTo(map);
    });
  }

  // ------------------------------------------------------------ GPS
  function updatePos(p) {
    const prev = state.pos;
    if (p.heading == null && prev && dist([prev.lon, prev.lat], [p.lon, p.lat]) > 8) {
      p.heading = bearing([prev.lon, prev.lat], [p.lon, p.lat]);
    } else if (p.heading == null && prev) {
      p.heading = prev.heading;
    }
    if (p.speed == null && prev && p.t > prev.t) {
      p.speed = dist([prev.lon, prev.lat], [p.lon, p.lat]) / ((p.t - prev.t) / 1000);
    }
    state.pos = p;
    meMarker.setLngLat([p.lon, p.lat]);
    if (!meOnMap) {
      meMarker.addTo(map);
      meOnMap = true;
      if (!state.nav && state.follow && !state.preview) map.jumpTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 14) });
    }
    if (p.heading != null) {
      meEl.classList.remove("nohead");
      meMarker.setRotation(p.heading);
    }
    $("speedVal").textContent = p.speed != null ? Math.round(p.speed * 3.6) : 0;
    if (state.nav) navTick();
    else if (state.follow && !state.preview) map.easeTo({ center: [p.lon, p.lat], duration: 600 });
  }

  function startGeo() {
    if (SIM) {
      const s = (params.get("sim") || "").split(",").map(Number);
      const start = s.length === 2 && s.every(Number.isFinite) ? s : [44.4268, 26.1025];
      updatePos({ lat: start[0], lon: start[1], heading: null, speed: 0, acc: 5, t: Date.now() });
      toast("Mod simulare: plecare din Piața Unirii");
      return;
    }
    if (!("geolocation" in navigator)) { toast("Telefonul nu oferă GPS în browser."); return; }
    navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        updatePos({
          lat: c.latitude, lon: c.longitude,
          heading: c.heading != null && !Number.isNaN(c.heading) && (c.speed || 0) > 1.5 ? c.heading : null,
          speed: c.speed != null && !Number.isNaN(c.speed) ? c.speed : null,
          acc: c.accuracy, t: pos.timestamp || Date.now(),
        });
      },
      (err) => {
        if (err.code === 1) toast("Permite accesul la locație ca să pot naviga.", 6000);
        else toast("Caut semnal GPS…");
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  // ------------------------------------------------------------ căutare
  const searchEl = $("search"), resultsEl = $("results");
  let searchTimer, searchSeq = 0, results = [];

  function biasPoint() {
    if (state.pos) return state.pos;
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchEl.value.trim();
    if (q.length < 2) { resultsEl.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const b = biasPoint();
      try {
        const data = await api(`/api/geocode?q=${encodeURIComponent(q)}&lat=${b.lat.toFixed(5)}&lon=${b.lon.toFixed(5)}`);
        if (seq !== searchSeq) return;
        results = data.results || [];
        renderResults();
      } catch (e) {
        if (seq === searchSeq) toast(e.message);
      }
    }, 300);
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && results[0]) { e.preventDefault(); pickResult(results[0]); }
    if (e.key === "Escape") { resultsEl.hidden = true; searchEl.blur(); }
  });
  searchEl.addEventListener("focus", () => { if (results.length && searchEl.value.trim().length >= 2) resultsEl.hidden = false; });
  document.addEventListener("pointerdown", (e) => { if (!$("searchBox").contains(e.target)) resultsEl.hidden = true; });

  function renderResults() {
    resultsEl.innerHTML = results.length
      ? results.map((r, i) => {
          const d = state.pos ? ` · ${fmtDist(dist([state.pos.lon, state.pos.lat], [r.lon, r.lat]))}` : "";
          return `<li data-i="${i}"><b>${esc(r.name)}</b><span>${esc(r.detail)}${d}</span></li>`;
        }).join("")
      : `<li class="muted">Nimic găsit. Încearcă altfel (ex. „Str. Lipscani 10”).</li>`;
    resultsEl.hidden = false;
  }
  resultsEl.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) pickResult(results[Number(li.dataset.i)]);
  });

  function pickResult(r) {
    resultsEl.hidden = true;
    searchEl.value = "";
    searchEl.blur();
    results = [];
    const s = addStop(r);
    if (s) map.flyTo({ center: [s.lon, s.lat], zoom: 15 });
  }

  // ------------------------------------------------------------ opriri
  function addStop(r) {
    if (state.stops.length >= MAX_STOPS) {
      toast(`Ai deja ${MAX_STOPS} opriri azi. Șterge cursele făcute ca să adaugi altele.`, 5000);
      return null;
    }
    const s = {
      id: Math.random().toString(36).slice(2, 10),
      name: r.name || "Oprire", detail: r.detail || "",
      lat: r.lat, lon: r.lon, done: false, day: today(),
    };
    state.stops.push(s);
    saveStops();
    renderStops();
    toast(`Adăugat: ${s.name}`);
    return s;
  }

  let openStop = null;
  function renderStops() {
    const ol = $("stops");
    const pending = state.stops.filter((s) => !s.done).length;
    $("stopCount").textContent = state.stops.length ? `${pending} rămase · ${state.stops.length}/${MAX_STOPS}` : "";
    $("emptyHint").hidden = state.stops.length > 0;
    $("btnOptimize").disabled = pending < 2;
    $("btnClearDone").hidden = !state.stops.some((s) => s.done);
    ol.innerHTML = state.stops.map((s, i) => `
      <li class="${s.done ? "done" : ""}" data-id="${s.id}">
        <div class="st-main" data-act="toggle">
          <span class="num">${s.done ? "✓" : i + 1}</span>
          <div class="st-text"><div class="st-name">${esc(s.name)}</div><div class="st-detail">${esc(s.detail)}</div></div>
          ${s.done ? "" : `<button class="st-btn go" data-act="go" aria-label="Navighează">▶</button>`}
        </div>
        ${openStop === s.id ? `<div class="st-actions">
          ${i > 0 ? `<button class="chip" data-act="up">↑ Mută sus</button>` : ""}
          <button class="chip" data-act="done">${s.done ? "↺ Nefăcută" : "✓ Făcută"}</button>
          <button class="chip" data-act="del">✕ Șterge</button>
          <a class="chip" target="_blank" rel="noopener" href="${wazeUrl(s)}">Waze</a>
        </div>` : ""}
      </li>`).join("");
    renderStopMarkers();
  }

  $("stops").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const actEl = e.target.closest("[data-act]");
    const act = actEl && actEl.dataset.act;
    const i = state.stops.findIndex((s) => s.id === li.dataset.id);
    const s = state.stops[i];
    if (!s || !act) return;
    if (act === "go") { e.stopPropagation(); previewRoute(s); return; }
    if (act === "toggle") { openStop = openStop === s.id ? null : s.id; map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 14) }); }
    if (act === "up" && i > 0) { state.stops.splice(i, 1); state.stops.splice(i - 1, 0, s); }
    if (act === "done") { s.done = !s.done; s.day = today(); }
    if (act === "del") { state.stops.splice(i, 1); openStop = null; }
    saveStops();
    renderStops();
  });

  $("btnClearDone").addEventListener("click", () => {
    state.stops = state.stops.filter((s) => !s.done);
    saveStops();
    renderStops();
  });

  $("btnOptimize").addEventListener("click", async () => {
    const pending = state.stops.filter((s) => !s.done);
    if (pending.length < 2) return;
    if (!state.pos) { toast("Aștept GPS ca să știu de unde pleci…"); return; }
    $("btnOptimize").disabled = true;
    toast("Calculez cea mai bună ordine…");
    try {
      const data = await api("/api/optimize", { start: state.pos, stops: pending.map((s) => ({ lat: s.lat, lon: s.lon })), tolls: state.settings.tolls });
      const ordered = data.order.map((i) => pending[i]);
      state.stops = [...state.stops.filter((s) => s.done), ...ordered];
      saveStops();
      renderStops();
      toast(`Ordine optimă: cca ${fmtMin(data.seconds)} min de condus în total.`, 5000);
    } catch (e) {
      toast(e.message);
    } finally {
      $("btnOptimize").disabled = false;
    }
  });

  // apăsare lungă pe hartă (sau clic dreapta) -> adaugă oprire
  let pressTimer = null, pressStart = null;
  map.on("touchstart", (e) => {
    if (e.originalEvent.touches.length > 1) return;
    pressStart = e.point;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => showAddPopup(e.lngLat), 600);
  });
  map.on("touchmove", (e) => { if (pressStart && (Math.abs(e.point.x - pressStart.x) > 10 || Math.abs(e.point.y - pressStart.y) > 10)) clearTimeout(pressTimer); });
  map.on("touchend", () => clearTimeout(pressTimer));
  map.on("touchcancel", () => clearTimeout(pressTimer));
  map.on("contextmenu", (e) => showAddPopup(e.lngLat));

  let addPopup = null;
  async function showAddPopup(ll) {
    if (state.nav) return;
    if (addPopup) addPopup.remove();
    const div = document.createElement("div");
    div.className = "popup-add";
    div.innerHTML = `<b>Caut adresa…</b><span class="muted small">${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</span>
      <button data-a="add">＋ Adaugă oprire</button><button data-a="go" style="background:var(--blue);color:#fff">▶ Mergi acum</button>`;
    addPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" }).setLngLat(ll).setDOMContent(div).addTo(map);
    let place = { name: "Punct pe hartă", detail: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`, lat: ll.lat, lon: ll.lng };
    div.addEventListener("click", (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      addPopup.remove();
      const s = addStop({ ...place, lat: ll.lat, lon: ll.lng });
      if (s && a === "go") previewRoute(s);
    });
    try {
      const { result } = await api(`/api/reverse?lat=${ll.lat}&lon=${ll.lng}`);
      if (result) {
        place = { ...result, lat: ll.lat, lon: ll.lng };
        div.querySelector("b").textContent = result.name;
        div.querySelector("span").textContent = result.detail;
      } else div.querySelector("b").textContent = place.name;
    } catch { div.querySelector("b").textContent = place.name; }
  }

  // ------------------------------------------------------------ învățare: unde stai pe loc
  function isWeekend(d) { const w = d.getDay(); return w === 0 || w === 6; }
  function recordSlowSpot(lat, lon, heading) {
    if (!state.settings.learn) return;
    const now = Date.now();
    const near = state.slow.find((s) => dist([s.lon, s.lat], [lon, lat]) < 50 && (s.h == null || heading == null || angleDiff(s.h, heading) < 45));
    if (near) {
      near.hits.push(now);
      near.hits = near.hits.slice(-20);
    } else {
      state.slow.push({ lat, lon, h: heading == null ? null : Math.round(heading), hits: [now] });
      if (state.slow.length > 300) state.slow.shift();
    }
    saveSlow();
    refreshSlowLayer();
  }
  // locurile învățate care contează ACUM (aceeași oră ±1, zi lucrătoare/weekend, ultimele 60 de zile)
  function relevantSlowSpots(bbox) {
    const now = new Date(), wk = isWeekend(now), hr = now.getHours();
    const cutoff = Date.now() - 60 * 864e5;
    return state.slow.filter((s) => {
      if (s.lon < bbox[0] || s.lat < bbox[1] || s.lon > bbox[2] || s.lat > bbox[3]) return false;
      return s.hits.some((t) => {
        if (t < cutoff) return false;
        const d = new Date(t);
        const dh = Math.abs(d.getHours() - hr);
        return isWeekend(d) === wk && Math.min(dh, 24 - dh) <= 1;
      });
    }).sort((a, b) => b.hits.length - a.hits.length);
  }

  function avoidPoints(from, to) {
    const now = Date.now();
    state.manualAvoid = state.manualAvoid.filter((a) => a.until > now);
    const pad = 0.03;
    const bbox = [Math.min(from.lon, to.lon) - pad, Math.min(from.lat, to.lat) - pad, Math.max(from.lon, to.lon) + pad, Math.max(from.lat, to.lat) + pad];
    const manual = state.manualAvoid.map((a) => ({ lat: a.lat, lon: a.lon, heading: a.heading }));
    const learned = state.settings.learn ? relevantSlowSpots(bbox).slice(0, 15).map((s) => ({ lat: s.lat, lon: s.lon, heading: s.h ?? undefined })) : [];
    return [...manual, ...learned].slice(0, 35);
  }

  // ------------------------------------------------------------ rutare
  async function fetchRoutes(stop, extra = {}) {
    const p = state.pos;
    const from = { lat: p.lat, lon: p.lon };
    if (p.heading != null && (p.speed || 0) > 2) from.heading = p.heading;
    return api("/api/route", {
      from,
      to: { lat: stop.lat, lon: stop.lon },
      mode: state.settings.mode,
      avoidTraffic: state.settings.traffic,
      tolls: state.settings.tolls,
      avoid: avoidPoints(p, stop),
      ...extra,
    });
  }

  function showJams(jams) {
    state.jams = jams || [];
    setOverlay("jams", fc(state.jams.map((j) => lineFeature(j.coords, { closed: !!j.closed, magnitude: j.magnitude || 0 }))));
  }

  function wazeUrl(s) { return `https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`; }
  function gmapsUrl(s) { return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`; }

  async function previewRoute(stop) {
    if (state.nav) return;
    if (!state.pos) { toast("Aștept semnalul GPS…"); return; }
    showPanel("pnPreview");
    $("pvTitle").textContent = stop.name;
    $("pvRoutes").innerHTML = `<p class="muted">Caut cea mai liberă rută…</p>`;
    $("pvNote").textContent = "";
    $("btnGo").disabled = true;
    $("lnkWaze").href = wazeUrl(stop);
    $("lnkGmaps").href = gmapsUrl(stop);
    state.preview = { stop, routes: [], sel: 0 };
    state.follow = false;
    try {
      const data = await fetchRoutes(stop);
      if (!state.preview || state.preview.stop !== stop) return;
      state.preview.routes = data.routes;
      state.preview.data = data;
      showJams(data.jams);
      renderPreview();
      const b = new maplibregl.LngLatBounds();
      data.routes.forEach((r) => r.coords.forEach((c) => b.extend(c)));
      map.fitBounds(b, { padding: { top: 90, bottom: $("sheet").offsetHeight + 30, left: 40, right: 40 }, duration: 700, maxZoom: 16 });
    } catch (e) {
      $("pvRoutes").innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  }

  function routeTags(r, i, all) {
    const tags = [];
    const fastest = Math.min(...all.map((x) => x.s));
    const shortest = Math.min(...all.map((x) => x.km));
    if (r.closed) tags.push(`<span class="tag bad">drum închis</span>`);
    else if (r.jamDelayS >= 60) tags.push(`<span class="tag bad">+${fmtMin(r.jamDelayS)} min blocaje</span>`);
    else if (state.preview.data.traffic && state.settings.traffic) tags.push(`<span class="tag">fără blocaje</span>`);
    if (all.length > 1 && r.km === shortest) tags.push(`<span class="tag">cea mai scurtă</span>`);
    if (all.length > 1 && r.s === fastest && i !== 0) tags.push(`<span class="tag">cea mai rapidă pe hârtie</span>`);
    return tags.join(" ");
  }

  function renderPreview() {
    const pv = state.preview;
    if (!pv.routes.length) { $("pvRoutes").innerHTML = `<p class="muted">Nu am găsit drum.</p>`; return; }
    $("pvRoutes").innerHTML = pv.routes.map((r, i) => `
      <button class="rt ${i === pv.sel ? "sel" : ""}" data-i="${i}">
        <b>${fmtMin(r.s + (r.jamDelayS || 0))} min</b>
        <span class="rt-meta">${r.km.toFixed(1).replace(".", ",")} km${i === 0 ? " · recomandată" : ""}</span>
        ${routeTags(r, i, pv.routes)}
      </button>`).join("");
    const d = pv.data;
    const notes = [];
    const modeName = { rapid: "Rapid", stradute: "Străduțe", maxim: "Doar străduțe" }[d.mode];
    notes.push(`Mod: ${modeName}.`);
    if (d.rerouted) notes.push("Am ocolit blocajele de pe traseul obișnuit.");
    if (!d.traffic) notes.push("Fără trafic live — evit locurile unde ai stat pe loc înainte.");
    const nAvoid = avoidPoints(state.pos, pv.stop).length;
    if (nAvoid) notes.push(`Evit ${nAvoid} ${nAvoid === 1 ? "punct aglomerat" : "puncte aglomerate"} învățate/raportate.`);
    $("pvNote").textContent = notes.join(" ");
    $("btnGo").disabled = false;
    drawPreview();
  }

  function drawPreview() {
    const pv = state.preview;
    setOverlay("route", fc([lineFeature(pv.routes[pv.sel].coords)]));
    setOverlay("alt", fc(pv.routes.filter((_, i) => i !== pv.sel).map((r) => lineFeature(r.coords, { i: pv.routes.indexOf(r) }))));
  }

  $("pvRoutes").addEventListener("click", (e) => {
    const b = e.target.closest(".rt");
    if (!b) return;
    state.preview.sel = Number(b.dataset.i);
    renderPreview();
  });
  map.on("click", "alt-line", (e) => {
    if (!state.preview || !e.features.length) return;
    state.preview.sel = e.features[0].properties.i;
    renderPreview();
  });

  $("btnPvClose").addEventListener("click", closePreview);
  function closePreview() {
    state.preview = null;
    setOverlay("route", EMPTY);
    setOverlay("alt", EMPTY);
    showJams([]);
    showPanel("pnStops");
  }
  $("btnGo").addEventListener("click", () => {
    const pv = state.preview;
    if (!pv || !pv.routes.length) return;
    startNav(pv.stop, pv.routes[pv.sel], pv.data.jams);
  });

  function showPanel(id) {
    for (const p of ["pnStops", "pnPreview", "pnNav"]) $(p).hidden = p !== id;
    $("searchBox").hidden = id === "pnNav";
    $("banner").hidden = id !== "pnNav";
    $("speed").hidden = id !== "pnNav";
    if (id !== "pnNav") $("bannerNext").hidden = true;
  }

  // ------------------------------------------------------------ voce
  let roVoice = null;
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const vs = speechSynthesis.getVoices();
    roVoice = vs.find((v) => /^ro(-|_|$)/i.test(v.lang)) || null;
  }
  if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function speak(text) {
    if (!state.settings.voice || !("speechSynthesis" in window) || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ro-RO";
      if (roVoice) u.voice = roVoice;
      u.rate = 1.02;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* fără voce */ }
  }

  // ------------------------------------------------------------ săgeți
  function arrowSvg(type) {
    if (type === 4 || type === 5 || type === 6) {
      return `<svg viewBox="0 0 48 48"><path d="M14 44V6h2v2h20l-5 7 5 7H16v22z" fill="#fff"/></svg>`;
    }
    if (type === 26 || type === 27) {
      return `<svg viewBox="0 0 48 48"><circle cx="24" cy="26" r="9" fill="none" stroke="#fff" stroke-width="5"/><path d="M24 4l9 10h-6v6h-6v-6h-6z" fill="#fff"/><path d="M22 34h4v10h-4z" fill="#fff"/></svg>`;
    }
    if (type === 12 || type === 13) {
      const flip = type === 13 ? "" : `transform="translate(48 0) scale(-1 1)"`;
      return `<svg viewBox="0 0 48 48"><g ${flip}><path d="M30 44V18a8 8 0 0 0-16 0v10h-6l9 10 9-10h-6V18a2 2 0 0 1 4 0v26z" fill="#fff"/></g></svg>`;
    }
    const rot = { 2: 90, 3: -90, 9: 45, 10: 90, 11: 135, 14: -135, 15: -90, 16: -45, 18: 40, 19: -40, 20: 40, 21: -40, 23: 25, 24: -25, 37: 25, 38: -25 }[type] || 0;
    return `<svg viewBox="0 0 48 48"><g transform="rotate(${rot} 24 26)"><path d="M24 4l13 14h-9v26h-8V18h-9z" fill="#fff"/></g></svg>`;
  }

  // ------------------------------------------------------------ navigație
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && "wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { /* nu e grav */ }
  }
  document.addEventListener("visibilitychange", () => { if (state.nav && document.visibilityState === "visible") keepAwake(true); });

  function prepRoute(r) {
    const cum = [0];
    for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + dist(r.coords[i - 1], r.coords[i]));
    return { ...r, cum, total: cum[cum.length - 1] || 1 };
  }

  function setNavRoute(r) {
    const n = state.nav;
    n.route = prepRoute(r);
    n.idx = 0;
    n.spoken = {};
    n.off = 0;
    setOverlay("route", fc([lineFeature(r.coords)]));
    setOverlay("alt", EMPTY);
    if (SIM) sim.along = 0;
  }

  function startNav(stop, route, jams) {
    state.preview = null;
    state.nav = {
      stop, route: null, idx: 0, spoken: {}, off: 0,
      lastReroute: 0, lastCheck: Date.now(), lastStuck: 0, slowWin: [], busy: false,
    };
    setNavRoute(route);
    showJams(jams);
    showPanel("pnNav");
    $("nvDest").textContent = `→ ${stop.name}${stop.detail ? ", " + stop.detail : ""}`;
    state.follow = true;
    $("btnLocate").classList.add("on");
    renderStopMarkers();
    keepAwake(true);
    const first = route.maneuvers[0];
    speak(first ? first.pre : "Pornim.");
    if (SIM) sim.start();
    navTick();
  }

  function endNav(msg) {
    if (SIM) sim.stop();
    state.nav = null;
    keepAwake(false);
    setOverlay("route", EMPTY);
    setOverlay("alt", EMPTY);
    showJams([]);
    showPanel("pnStops");
    renderStops();
    map.easeTo({ pitch: 0, bearing: 0, zoom: 15, duration: 800 });
    if (msg) toast(msg, 5000);
  }
  $("btnStop").addEventListener("click", () => endNav());

  function arrive() {
    const n = state.nav;
    speak("Ai ajuns la destinație.");
    const s = state.stops.find((x) => x.id === n.stop.id);
    if (s) { s.done = true; s.day = today(); saveStops(); }
    const next = state.stops.find((x) => !x.done);
    endNav(next ? `Ai ajuns! Următoarea: ${next.name} — apasă ▶` : "Ai ajuns! Gata cursele de azi 👍");
  }

  function navTick() {
    const n = state.nav, p = state.pos;
    if (!n || !p || !n.route) return;
    const r = n.route, C = r.coords;
    const here = [p.lon, p.lat];

    // 1. ne poziționăm pe rută (căutăm în jurul ultimei poziții)
    let best = { d: Infinity, i: n.idx, t: 0 };
    const lo = Math.max(0, n.idx - 3), hi = Math.min(C.length - 2, n.idx + 200);
    for (let i = lo; i <= hi; i++) {
      const pr = project(here, C[i], C[i + 1]);
      if (pr.d < best.d) best = { d: pr.d, i, t: pr.t };
    }
    const tol = Math.max(35, Math.min(80, (p.acc || 20) + 15));
    if (best.d > tol) n.off++;
    else { n.off = 0; n.idx = best.i; }
    $("banner").classList.toggle("off-route", n.off > 0);

    const segLen = C.length > 1 ? r.cum[best.i + 1] - r.cum[best.i] : 0;
    const along = n.off > 0 ? r.cum[n.idx] : r.cum[best.i] + best.t * segLen;
    const remaining = Math.max(0, r.total - along);
    const toDest = dist(here, [n.stop.lon, n.stop.lat]);

    if (toDest < 35 || (remaining < 30 && n.off === 0)) { arrive(); return; }

    if (n.off >= 3 && Date.now() - n.lastReroute > 8000) {
      reroute("off");
      return;
    }

    // 2. următoarea manevră
    let mi = r.maneuvers.findIndex((m, k) => k > 0 && r.cum[Math.min(m.begin, r.cum.length - 1)] > along + 3);
    if (mi < 0) mi = r.maneuvers.length - 1;
    const m = r.maneuvers[mi];
    const toM = Math.max(0, r.cum[Math.min(m.begin, r.cum.length - 1)] - along);
    $("bnArrow").innerHTML = arrowSvg(m.type);
    $("bnDist").textContent = fmtDist(toM);
    $("bnText").textContent = m.text;
    const m2 = r.maneuvers[mi + 1];
    if (m2 && m2.type !== 4 && m.km < 0.15) {
      $("bannerNext").hidden = false;
      $("bannerNext").textContent = `apoi: ${m2.text}`;
    } else $("bannerNext").hidden = true;

    // 3. voce
    const v = Math.max(5, p.speed || 8);
    const alertAt = Math.max(150, Math.min(600, v * 18));
    if (toM < alertAt && toM > 90 && !n.spoken[mi + "a"]) {
      n.spoken[mi + "a"] = 1;
      speak(`Peste ${voiceDist(toM)}, ${lowerFirst(m.alert || m.pre)}`);
    }
    if (toM <= Math.max(35, v * 4) && !n.spoken[mi + "p"]) {
      n.spoken[mi + "p"] = n.spoken[mi + "a"] = 1;
      speak(m.pre);
    }

    // 4. statistici
    const remS = r.s * (remaining / r.total) + (r.jamDelayS || 0) * (remaining / r.total);
    $("nvMin").textContent = fmtMin(remS);
    $("nvKm").textContent = (remaining / 1000).toFixed(1).replace(".", ",");
    $("nvEta").textContent = fmtClock(new Date(Date.now() + remS * 1000));

    // 5. ce a rămas din traseu
    const rest = [here, ...C.slice(n.idx + 1)];
    setOverlay("route", fc([lineFeature(rest)]));

    // 6. camera
    if (state.follow) {
      const segBearing = bearing(C[n.idx], C[Math.min(n.idx + 1, C.length - 1)]);
      const brg = p.heading != null && (p.speed || 0) > 2 ? p.heading : segBearing;
      const zoom = v > 20 ? 15.3 : v > 12 ? 16 : 16.8;
      map.easeTo({
        center: here, bearing: brg, pitch: 50, zoom, duration: SIM ? 900 : 800,
        padding: { top: 140, bottom: $("sheet").offsetHeight + 120, left: 0, right: 0 },
      });
    }

    // 7. stai pe loc? (sub ~60 m în 2 minute, departe de destinație)
    const now = Date.now();
    n.slowWin.push({ t: now, c: here });
    while (n.slowWin.length && now - n.slowWin[0].t > 150000) n.slowWin.shift();
    const w = n.slowWin;
    if (state.settings.autoReroute && w.length > 3 && now - w[0].t >= 120000 && remaining > 400 && now - n.lastStuck > 240000) {
      const moved = Math.max(...w.map((x) => dist(x.c, here)));
      if (moved < 60) onStuck(true);
    }

    // 8. verificare periodică: a apărut ceva mai liber?
    if (state.config.traffic && state.settings.traffic && now - n.lastCheck > 120000 && !n.busy) {
      n.lastCheck = now;
      checkBetter(along);
    }
  }

  async function reroute(kind) {
    const n = state.nav;
    if (!n || n.busy) return;
    n.busy = true;
    n.lastReroute = Date.now();
    if (kind === "off") { $("bnText").textContent = "Recalculez…"; speak("Recalculez traseul."); }
    try {
      const data = await fetchRoutes(n.stop);
      if (state.nav !== n) return;
      const old = n.route;
      setNavRoute(data.routes[0]);
      showJams(data.jams);
      if (kind === "stuck") {
        const same = Math.abs(old.total - n.route.total) < 50 && Math.abs(old.s - n.route.s) < 30;
        if (same) { speak("Nu am găsit o ocolire mai bună. Rămâi pe traseu."); toast("Nicio ocolire mai bună acum."); }
        else { speak("Am găsit o ocolire. " + (n.route.maneuvers[0] ? n.route.maneuvers[0].pre : "")); toast("Rută nouă pe lângă blocaj ✔"); }
      }
    } catch (e) {
      toast(e.message);
    } finally {
      n.busy = false;
      navTick();
    }
  }

  // Ai apăsat „Blocat!” sau stai pe loc de 2 minute: evită următorii ~600 m din traseu
  function onStuck(auto) {
    const n = state.nav, p = state.pos;
    if (!n || !p) return;
    n.lastStuck = Date.now();
    n.slowWin = [];
    const r = n.route, C = r.coords;
    recordSlowSpot(p.lat, p.lon, p.heading != null ? p.heading : bearing(C[n.idx], C[Math.min(n.idx + 1, C.length - 1)]));
    const startAlong = r.cum[n.idx] + 80;
    const until = Date.now() + 25 * 60 * 1000;
    for (let d = startAlong; d < startAlong + 600 && d < r.total - 80; d += 150) {
      let i = n.idx;
      while (i < C.length - 2 && r.cum[i + 1] < d) i++;
      const segL = r.cum[i + 1] - r.cum[i] || 1;
      const t = (d - r.cum[i]) / segL;
      const a = C[i], b = C[i + 1];
      state.manualAvoid.push({ lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, heading: Math.round(bearing(a, b)), until });
    }
    if (auto) speak("Stai pe loc de două minute. Caut o ocolire.");
    else speak("Caut o ocolire.");
    toast("Caut o ocolire…");
    reroute("stuck");
  }
  $("btnStuck").addEventListener("click", () => onStuck(false));

  async function checkBetter(along) {
    const n = state.nav;
    if (!n || n.busy) return;
    const r = n.route;
    const rest = r.coords.slice(n.idx);
    const step = Math.max(1, Math.ceil(rest.length / 300));
    const compare = rest.filter((_, i) => i % step === 0 || i === rest.length - 1);
    n.busy = true;
    try {
      const data = await fetchRoutes(n.stop, { compare });
      if (state.nav !== n || !data.routes.length) return;
      const remaining = Math.max(0, r.total - along);
      const curS = r.s * (remaining / r.total) + (data.compare ? data.compare.jamDelayS : 0);
      const cand = data.routes[0];
      const candS = cand.s + (cand.jamDelayS || 0);
      showJams(data.jams);
      if ((data.compare && data.compare.closed && !cand.closed) || candS < curS - 120) {
        const gain = Math.round((curS - candS) / 60);
        setNavRoute(cand);
        speak(gain >= 2 ? `Am găsit o rută mai liberă. Câștigi cam ${gain} minute.` : "Drum închis în față. Am schimbat traseul.");
        toast("Rută mai liberă ✔");
      }
    } catch { /* încercăm din nou peste 2 minute */ }
    finally { n.busy = false; }
  }

  // ------------------------------------------------------------ simulare (?sim)
  const sim = {
    timer: null, along: 0, speed: 9,
    start() {
      this.stop();
      this.along = 0;
      this.timer = setInterval(() => {
        const n = state.nav;
        if (!n) return;
        const r = n.route;
        this.along = Math.min(r.total, this.along + this.speed);
        let i = 0;
        while (i < r.coords.length - 2 && r.cum[i + 1] < this.along) i++;
        const segL = r.cum[i + 1] - r.cum[i] || 1;
        const t = Math.min(1, (this.along - r.cum[i]) / segL);
        const a = r.coords[i], b = r.coords[i + 1] || a;
        updatePos({ lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, heading: bearing(a, b), speed: this.speed, acc: 5, t: Date.now() });
      }, 1000);
    },
    stop() { clearInterval(this.timer); this.timer = null; },
  };

  // ------------------------------------------------------------ butoane, setări
  $("btnLocate").addEventListener("click", () => {
    state.follow = true;
    $("btnLocate").classList.add("on");
    if (state.pos) {
      if (state.nav) navTick();
      else map.flyTo({ center: [state.pos.lon, state.pos.lat], zoom: Math.max(map.getZoom(), 15) });
    } else toast("Aștept semnalul GPS…");
  });

  $("btnTraffic").addEventListener("click", () => {
    state.trafficLayer = !state.trafficLayer;
    LS.set("tr_trafficLayer", state.trafficLayer);
    $("btnTraffic").classList.toggle("on", state.trafficLayer);
    if (map.getLayer("traffic")) map.setLayoutProperty("traffic", "visibility", state.trafficLayer ? "visible" : "none");
  });

  function renderModes() {
    document.querySelectorAll(".mode").forEach((b) => {
      const on = b.dataset.mode === state.settings.mode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on);
    });
  }
  document.querySelector(".modes").addEventListener("click", (e) => {
    const b = e.target.closest(".mode");
    if (!b) return;
    state.settings.mode = b.dataset.mode;
    saveSettings();
    renderModes();
    const hint = { rapid: "Rapid: ca o aplicație obișnuită.", stradute: "Străduțe: scurtături prin cartiere, evită bulevardele.", maxim: "Doar străduțe: drumul cel mai scurt, chiar cu multe viraje." }[state.settings.mode];
    toast(hint);
  });

  function renderTrafficState() {
    $("trafficState").textContent = state.config.traffic
      ? (state.settings.traffic ? "🚦 trafic live activ" : "🚦 trafic live oprit")
      : "fără trafic live";
    $("btnTraffic").hidden = !state.config.traffic;
    $("btnTraffic").classList.toggle("on", state.trafficLayer);
    $("ttCredit").textContent = state.config.traffic ? " · trafic TomTom" : "";
  }

  const settingIds = { setVoice: "voice", setTraffic: "traffic", setLearn: "learn", setAutoReroute: "autoReroute", setTolls: "tolls" };
  $("btnSettings").addEventListener("click", () => {
    for (const [id, k] of Object.entries(settingIds)) $(id).checked = !!state.settings[k];
    $("setTheme").value = state.settings.theme;
    $("setTraffic").disabled = !state.config.traffic;
    $("learnInfo").textContent = `Am învățat ${state.slow.length} ${state.slow.length === 1 ? "loc" : "locuri"} unde ai stat pe loc (puncte mov pe hartă).` +
      (state.config.traffic ? "" : " Trafic live: neconfigurat pe server (vezi README).");
    $("dlgSettings").showModal();
  });
  for (const [id, k] of Object.entries(settingIds)) {
    $(id).addEventListener("change", (e) => {
      state.settings[k] = e.target.checked;
      saveSettings();
      renderTrafficState();
      if (k === "voice" && e.target.checked) speak("Instrucțiunile vocale sunt pornite.");
    });
  }
  $("setTheme").addEventListener("change", (e) => {
    state.settings.theme = e.target.value;
    saveSettings();
    setTheme(themeNow());
  });
  $("btnForget").addEventListener("click", () => {
    state.slow = [];
    saveSlow();
    refreshSlowLayer();
    $("learnInfo").textContent = "Am șters locurile învățate.";
  });

  // ------------------------------------------------------------ pornire
  renderModes();
  renderStops();
  showPanel("pnStops");
  startGeo();
  api("/api/config").then((c) => {
    state.config = c;
    renderTrafficState();
    if (map.isStyleLoaded()) ensureOverlays();
  }).catch(() => renderTrafficState());

  if ("serviceWorker" in navigator && !SIM) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  // pentru teste automate
  window.__taxi = { state, map, addStop, previewRoute, startNav, onStuck, sim };
})();
