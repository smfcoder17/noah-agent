// Service worker minimal : rend l'app installable et garde la coquille hors ligne.
// Les appels /api/ passent toujours au réseau (données toujours fraîches).
const CACHE = "noah-v7";
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
  if (url.origin !== location.origin) return; // rien d'un autre site ne passe par ce cache
  // Fichiers à empreinte (index-AbC123xy.js, polices) : jamais modifiés, le cache répond tout de suite.
  if (/^\/assets\/.+-[A-Za-z0-9_-]{8}\.\w+$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            const copy = res.clone();
            if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy));
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
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy)); // jamais une page d'erreur en secours
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});

// Notifications Web Push (chiffrées de bout en bout par le serveur Noah, RFC 8291). Pas affichée si Noah est déjà
// ouvert et visible sur cet appareil : l'utilisateur la voit déjà dans l'interface.
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { texte: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      if (wins.some((w) => w.visibilityState === "visible" && w.focused)) return;
      return self.registration.showNotification(data.titre || "Noah", {
        body: data.texte || "",
        icon: "/assets/icon-192.png",
        badge: "/assets/icon-192.png",
        data: { url: data.url || "/" },
        tag: data.titre || "noah",
      });
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(self.location.origin));
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
