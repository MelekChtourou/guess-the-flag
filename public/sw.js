// Service worker — minimal offline shell + faster repeat loads.
//
// Strategy:
//   - Same-origin asset GETs (/, /js/*, /css/*, /icon*, manifest, etc.)
//     are served stale-while-revalidate: cached copy first if we have it,
//     network fetch in parallel to refresh the cache for next time.
//   - Cross-origin (flagcdn, Wikipedia, three.js CDN) → cache-first with
//     a 7-day TTL so repeat plays are instant.
//   - Anything else (Socket.IO, /api/*) → network only.
//
// Bumping CACHE_VERSION evicts the old cache on next activate.

// Bumped when the asset list changes — old cache is purged on activate.
const CACHE_VERSION = "atlas-v2";
const ASSET_CACHE   = `${CACHE_VERSION}-assets`;
const REMOTE_CACHE  = `${CACHE_VERSION}-remote`;

// Pre-cache the app shell so the first cold offline open works.
const PRECACHE = [
  "/", "/index.html",
  "/css/style.css",
  "/js/sound.js",
  "/js/ui.js",
  "/js/profile.js",
  "/js/achievements.js",
  "/js/share.js",
  "/js/leaderboard.js",
  "/js/colorExtractor.js",
  "/js/country.js",
  "/js/game.js",
  "/js/games/flag.js",
  "/js/games/capital.js",
  "/js/games/population.js",
  "/js/daily.js",
  "/js/multiplayer.js",
  "/js/router.js",
  "/js/theme.js",
  "/js/globe.js",
  "/js/topojson-mini.js",
  "/js/menu.js",
  "/js/app.js",
  "/data/world-110m.json",
  "/manifest.json",
  "/icon-192.svg",
  "/icon-512.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(ASSET_CACHE).then((cache) => cache.addAll(PRECACHE)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isAsset(url) {
  return url.origin === self.location.origin
      && !url.pathname.startsWith("/api/")
      && !url.pathname.startsWith("/socket.io/");
}

function isRemoteCacheable(url) {
  // Big static-ish payloads we want offline.
  return url.host.endsWith("flagcdn.com")
      || url.host.endsWith("upload.wikimedia.org")
      || url.host.endsWith("cdn.jsdelivr.net")
      || url.host.endsWith("unpkg.com")
      || url.host.endsWith("fonts.googleapis.com")
      || url.host.endsWith("fonts.gstatic.com");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (isAsset(url)) {
    // Stale-while-revalidate — instant load, refresh in background.
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  if (isRemoteCacheable(url)) {
    // Cache-first — these are immutable URLs.
    event.respondWith((async () => {
      const cache = await caches.open(REMOTE_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // /api/, /socket.io/, anything else: network only.
});
