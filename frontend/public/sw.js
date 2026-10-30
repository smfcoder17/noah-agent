// Service worker minimal : rend l'app installable et garde la coquille hors ligne.
// Les appels /api/ passent toujours au réseau (données toujours fraîches).
const CACHE = "noah-v6";
const SHELL = ["/", "/assets/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  // Fichiers à empreinte (index-AbC123xy.js) et polices : jamais modifiés, le cache répond tout de suite.
  // Sans ça, chaque ouverture attendait Google Fonts avant d'afficher la page.
  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (fonts || /^\/assets\/.+-[A-Za-z0-9_-]{8}\.\w+$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            const copy = res.clone();
            // La feuille de Google Fonts arrive en réponse « opaque » (sans CORS) : on la garde quand même.
            if (res.ok || (fonts && res.type === "opaque")) caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          }),
      ),
    );
    return;
  }
  // Réseau d'abord, cache en secours.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
