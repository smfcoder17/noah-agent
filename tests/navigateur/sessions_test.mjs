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

const { keepSessions } = await import("/p/index.js");

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
