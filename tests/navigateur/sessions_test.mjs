// Connexions gardées : l'état de chaque session est photographié régulièrement, seulement s'il a changé, et rien après la
// fermeture de la session. Vraie extension, événements comme ceux de Camofox, contexte simulé.
//
// Le passage régulier ne doit jamais appeler context.storageState : pour une origine sans page ouverte, Playwright crée une page
// temporaire et la fait naviguer (playwright-core coreBundle.js, storageState : newPage puis gotoImpl pour chaque origine). Dans
// Firefox avec un écran, cette page recouvre l'onglet de l'utilisateur, toutes les 60 s. Cookies et pages déjà ouvertes suffisent.
//
//   docker run --rm -v "$PWD/launcher/camofox-noah:/p:ro" -v "$PWD/tests:/tests:ro" node:22-alpine \
//     sh -c "mkdir -p /data && node /tests/navigateur/sessions_test.mjs"
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";

const { keepSessions, default: register } = await import("/p/index.js");

const events = new EventEmitter();
const saved = [];
// Comme le module de persistance de Camofox : il écrit l'état exporté sur le disque.
events.on("session:storage:export", ({ userId, storageState }) =>
  saved.push({ userId, cookies: storageState.cookies.map((c) => c.name), origins: storageState.origins }));
const ctx = { events, log: () => {}, persistenceStorageStateOptions: undefined };
const keep = keepSessions(ctx, 3_600_000); // minuterie hors jeu : on déclenche à la main
keep.stop();

// État déjà gardé sur le disque (restauré à la création de la session) : une origine sans page ouverte.
fs.writeFileSync("/data/avant.json", JSON.stringify({ cookies: [], origins: [{ origin: "https://x.com", localStorage: [{ name: "vieux", value: "1" }] }] }));
let cookies = [{ name: "SID" }];
let closed = false, storageStateCalls = 0;
let storage = [{ name: "jeton", value: "a" }];
const page = { url: () => "https://www.youtube.com/watch", evaluate: async () => storage };
const context = {
  storageState: async () => { storageStateCalls++; if (closed) throw new Error("Target closed"); return { cookies, origins: [] }; },
  cookies: async () => { if (closed) throw new Error("Target closed"); return cookies; },
  pages: () => [page, { url: () => "about:blank", evaluate: async () => { throw new Error("pas d'origine"); } }],
};
events.emit("session:creating", { userId: "noah", contextOptions: { storageState: "/data/avant.json" } });
events.emit("session:created", { userId: "noah", context });

await keep.save();
assert.equal(saved.length, 1, "premier passage : l'état est écrit");
assert.deepEqual(saved[0].cookies, ["SID"]);
assert.deepEqual(saved[0].origins.map((o) => o.origin).sort(), ["https://www.youtube.com", "https://x.com"], "origines : celle de la page ouverte et celle déjà gardée");
assert.deepEqual(saved[0].origins.find((o) => o.origin === "https://x.com").localStorage, [{ name: "vieux", value: "1" }], "l'ancien stockage n'est pas perdu");
assert.deepEqual(saved[0].origins.find((o) => o.origin === "https://www.youtube.com").localStorage, [{ name: "jeton", value: "a" }]);
await keep.save();
assert.equal(saved.length, 1, "rien de changé : rien d'écrit");
storage = [{ name: "jeton", value: "b" }];
await keep.save();
assert.equal(saved.length, 2, "stockage d'une page ouverte changé : écrit");
assert.equal(saved[1].origins.find((o) => o.origin === "https://www.youtube.com").localStorage[0].value, "b");
cookies = [{ name: "SID" }, { name: "__Secure-1PSID" }];
await keep.save();
assert.deepEqual(saved.at(-1).cookies, ["SID", "__Secure-1PSID"], "connexion du jour : écrite au passage suivant");
assert.equal(storageStateCalls, 0, "aucun storageState : aucune page temporaire, aucune navigation, l'onglet visible reste en place");
const n = saved.length;
closed = true;
await keep.save(); // un contexte fermé entre deux passages ne fait pas tomber le reste
events.emit("session:destroyed", { userId: "noah" });
await keep.save();
assert.equal(saved.length, n, "session fermée : plus rien d'écrit");
console.log("Sessions du navigateur : photographiées à chaque changement, sans navigation, jamais après fermeture : OK");

// --- GET /sessions/:userId/storage_state ----------------------------------------------------------------------------------
// La route de Camofox appelle context.storageState() : le serveur de Noah la demandait toutes les 3 min (keep_browser_sessions)
// et après chaque appel d'aide, et l'écran de l'agent défilait en 0.4.4 malgré le passage régulier corrigé. L'extension la
// remplace par la même photo sans navigation, et la garde derrière les clés de l'agent et du serveur.
process.env.CAMOFOX_API_KEY = "cle-agent";
process.env.NOAH_PRIVATE_KEY = "cle-serveur";
const events2 = new EventEmitter();
const written = [];
events2.on("session:storage:export", ({ storageState }) => written.push(storageState));
const stack = [];
register({ use: (fn) => stack.push(fn), router: { stack }, post() {}, get() {} }, { events: events2, log: () => {}, sessions: new Map(), normalizeUserId: String, withUserLimit: (_u, fn) => fn() });
let calls2 = 0;
const page2 = { url: () => "https://www.tiktok.com/", evaluate: async () => [{ name: "k", value: "v" }] };
events2.emit("session:created", { userId: "noah", context: {
  storageState: async () => { calls2++; return { cookies: [], origins: [] }; },
  cookies: async () => [{ name: "sessionid" }],
  pages: () => [page2],
} });
const route = (path, key) => new Promise((resolve) => {
  let status = 200;
  const res = { headersSent: false, status: (c) => ((status = c), res), json: (data) => { resolve({ status, data }); return res; } };
  stack[0]({ method: "GET", path, query: {}, headers: { authorization: key && `Bearer ${key}` } }, res, () => resolve({ status: "suivant" }));
});
assert.equal((await route("/sessions/noah/storage_state")).status, 403, "sans clé : refusé");
for (const key of ["cle-serveur", "cle-agent"]) {
  const r = await route("/sessions/noah/storage_state", key);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.cookies.map((c) => c.name), ["sessionid"]);
  assert.deepEqual(r.data.origins.map((o) => o.origin), ["https://www.tiktok.com"]);
}
assert.equal(written.length, 1, "l'état est écrit sur le volume, une fois tant qu'il ne change pas");
assert.equal((await route("/sessions/autre/storage_state", "cle-serveur")).status, 404, "pas de session : 404 comme Camofox");
assert.equal(calls2, 0, "la route n'appelle jamais context.storageState : aucune page cachée sur l'écran de l'agent");
assert.equal((await route("/tabs", "cle-serveur")).status, "suivant", "les autres routes passent à Camofox");
console.log("Route storage_state : même photo sans navigation, derrière les clés : OK");

// Un site visité puis quitté entre deux passages : son stockage local est relevé au chargement de la page, et reste gardé.
const listeners = new Map();
let url3 = "https://fr.wikipedia.org/wiki/Montr%C3%A9al";
const page3 = { url: () => url3, on: (name, fn) => listeners.set(name, fn), evaluate: async () => (url3.includes("wikipedia") ? [{ name: "mwprefs", value: "1" }] : []) };
let onPage;
events2.emit("session:created", { userId: "lea", context: {
  storageState: async () => { calls2++; return { cookies: [], origins: [] }; },
  cookies: async () => [],
  pages: () => [page3],
  on: (name, fn) => { if (name === "page") onPage = fn; },
} });
assert.equal(typeof onPage, "function", "les pages ouvertes plus tard sont suivies aussi");
listeners.get("load")();
await new Promise((ok) => setTimeout(ok, 50)); // le premier relevé part au chargement même
url3 = "https://example.com/";
const r3 = await route("/sessions/lea/storage_state", "cle-serveur");
assert.deepEqual(r3.data.origins.map((o) => o.origin), ["https://fr.wikipedia.org"], "Wikipédia quitté : son stockage reste dans l'état");
assert.equal(calls2, 0);
console.log("Site quitté entre deux passages : stockage relevé au chargement, gardé : OK");
