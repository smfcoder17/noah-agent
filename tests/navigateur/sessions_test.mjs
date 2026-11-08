// Connexions gardées : l'état de chaque session est photographié régulièrement, seulement s'il a changé, et rien après la
// fermeture de la session. Vraie extension, événements comme ceux de Camofox, contexte simulé.
//
//   docker run --rm -v "$PWD/launcher/camofox-noah:/p:ro" -v "$PWD/tests:/tests:ro" node:22-alpine \
//     sh -c "mkdir -p /data && node /tests/navigateur/sessions_test.mjs"
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { keepSessions } = await import("/p/index.js");

const events = new EventEmitter();
const saved = [];
// Comme le module de persistance de Camofox : il écrit l'état exporté sur le disque.
events.on("session:storage:export", ({ userId, storageState }) => saved.push({ userId, cookies: storageState.cookies.map((c) => c.name) }));
const ctx = { events, log: () => {}, persistenceStorageStateOptions: undefined };
const keep = keepSessions(ctx, 3_600_000); // minuterie hors jeu : on déclenche à la main
keep.stop();

let cookies = [{ name: "SID" }];
let closed = false;
const context = { storageState: async () => { if (closed) throw new Error("Target closed"); return { cookies, origins: [] }; } };
events.emit("session:created", { userId: "noah", context });

await keep.save();
assert.deepEqual(saved, [{ userId: "noah", cookies: ["SID"] }], "premier passage : l'état est écrit");
await keep.save();
assert.equal(saved.length, 1, "rien de changé : rien d'écrit");
cookies = [{ name: "SID" }, { name: "__Secure-1PSID" }];
await keep.save();
assert.deepEqual(saved.at(-1).cookies, ["SID", "__Secure-1PSID"], "connexion du jour : écrite au passage suivant");
closed = true;
await keep.save(); // un contexte fermé entre deux passages ne fait pas tomber le reste
events.emit("session:destroyed", { userId: "noah" });
await keep.save();
assert.equal(saved.length, 2, "session fermée : plus rien d'écrit");
console.log("Sessions du navigateur : photographiées à chaque changement, jamais après fermeture : OK");
