// TaxiRută — service worker: aplicația pornește și fără semnal; harta se ține în cache.
const VERSION = "v1";
const APP = `taxi-app-${VERSION}`;
const TILES = "taxi-tiles";
const SHELL = [
  "/", "/index.html", "/app.css", "/app.js", "/manifest.webmanifest",
  "/vendor/maplibre-gl.js", "/vendor/maplibre-gl.css",
  "/icons/icon-192.png", "/icons/icon-512.png",
];
const MAX_TILES = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("taxi-app-") && k !== APP).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => c.delete(k)));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // API: mereu din rețea (rute, trafic, căutare trebuie să fie proaspete)
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // Hărți OpenFreeMap: cache, apoi actualizare în fundal
  if (url.hostname === "tiles.openfreemap.org") {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      const net = fetch(req).then((res) => {
        if (res.ok) c.put(req, res.clone()).then(() => Math.random() < 0.02 && trimTiles());
        return res;
      }).catch(() => hit);
      return hit || net;
    })());
    return;
  }

  // Aplicația: din rețea când se poate (ca să primești actualizări), altfel din cache
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(APP);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch {
        return (await c.match(req)) || (req.mode === "navigate" ? c.match("/index.html") : Response.error());
      }
    })());
  }
});
