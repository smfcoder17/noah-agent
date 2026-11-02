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

// Notifications Web Push (chiffrées de bout en bout par le serveur Noah, RFC 8291). Toujours affichées : Safari et
// Chrome retirent la permission à un site qui reçoit un push sans rien montrer. Si Noah est déjà au premier plan,
// elle arrive sans son ni vibration.
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { texte: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    Promise.all([
      self.clients.matchAll({ type: "window", includeUncontrolled: true }),
      caches.open("noah-session").then((c) => c.match("/__session")).then((r) => (r ? r.text() : "")).catch(() => ""),
    ]).then(([wins, current]) => {
      const foreground = wins.some((w) => w.visibilityState === "visible" && w.focused);
      // Message pour une autre session que celle ouverte ici (un autre compte s'est connecté depuis) : on prévient sans
      // rien montrer de son contenu (une notification reste obligatoire après un push).
      if (data.pour && current && data.pour !== current) data = { titre: "Noah", texte: "Nouvelle notification pour un autre compte.", url: "/" };
      return self.registration.showNotification(data.titre || "Noah", {
        silent: foreground,
        body: data.texte || "",
        icon: "/assets/icon-192.png",
        badge: "/assets/icon-192.png",
        data: { url: data.url || "/" },
        tag: data.titre || "noah",
      });
    }),
  );
});

// Le navigateur renouvelle parfois l'abonnement (expiration, clés changées) : on réabonne et on prévient le serveur,
// sinon les notifications se perdraient en silence.
self.addEventListener("pushsubscriptionchange", (e) => {
  const options = e.oldSubscription?.options;
  e.waitUntil(
    (e.newSubscription ? Promise.resolve(e.newSubscription) : options ? self.registration.pushManager.subscribe(options) : Promise.reject())
      .then(async (sub) => {
        const j = sub.toJSON();
        // Serveur en maintenance (503) ou injoignable : quelques essais ; sinon, la page réconciliera à sa prochaine
        // ouverture (Réglages → Appareils compare l'abonnement du navigateur à celui du serveur).
        for (const wait of [0, 5000, 30000]) {
          await new Promise((ok) => setTimeout(ok, wait));
          const r = await fetch("/api/push/subscription", {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }),
          }).catch(() => null);
          if (r && r.ok) return;
        }
      })
      .catch(() => {}),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(self.location.origin));
      if (!open) return self.clients.openWindow(url);
      return (open.url === url ? Promise.resolve(open) : open.navigate(url)).then((w) => (w || open).focus());
    }),
  );
});
