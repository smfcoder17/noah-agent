// Joindre un fichier à une page : ce qui se garde sans vrai navigateur. Vrai serveur HTTP, vraie extension, page simulée.
// Le parcours avec le vrai Firefox est dans envoi_reel.mjs.
//
//   docker run --rm -v "$PWD/launcher/camofox-noah:/p:ro" -v "$PWD/tests:/tests:ro" node:22-alpine \
//     sh -c "mkdir -p /data && node /tests/navigateur/envoi_test.mjs"
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

process.env.CAMOFOX_API_KEY = "cle-agent";
process.env.NOAH_PRIVATE_KEY = "cle-serveur";
const OUTBOX = "/data/envois";
const { default: register } = await import("/p/index.js");

// --- Une page simulée : des champs avec leur emplacement, ce qui y a été mis
const FILE_INPUT = 'input[type="file"]';
let duringDelivery = null;
function makeInput(id, place, seen) {
  const input = {
    id,
    place,
    closest: () => (input.place === "page" ? null : { checkVisibility: () => input.place === "fenetre" }),
    evaluate: async (fn) => {
      const source = String(fn);
      if (source.includes("closest")) return fn(input);
      if (source.includes("matches")) return true;
      return { id, accept: "", name: "", aria: "" };
    },
    setInputFiles: async (files) => {
      await duringDelivery?.();
      seen.push({ id, files });
    },
  };
  return input;
}
function fakeLocator(items, onCount) {
  return {
    count: async () => {
      await onCount?.();
      return items.length;
    },
    nth: (i) => items[i],
    first: () => items[0] || { evaluate: async () => { throw new Error("rien"); } },
    evaluateAll: async (fn) => fn(items),
  };
}
function page({ dialog = [], all = [], hidden = [], hiddenFrame = [], button = null, chooser = null, seen = [], onCount = null, afterClick = null, reveal = null }) {
  const inputs = [
    ...all.map((id) => makeInput(id, "page", seen)),
    ...dialog.map((id) => makeInput(id, "fenetre", seen)),
    ...hidden.map((id) => makeInput(id, "cachee", seen)),
  ];
  if (button && (afterClick || reveal)) {
    const click = button.click;
    button.click = async () => {
      await click();
      if (afterClick) inputs.push(makeInput(afterClick, "page", seen));
      if (reveal) inputs.find((i) => i.id === reveal).place = "fenetre";
    };
  }
  const main = {
    locator: (selector) => {
      if (selector === FILE_INPUT) return fakeLocator(inputs, onCount);
      if (selector === "#bouton" && button) return fakeLocator([button]);
      const input = selector.startsWith("#") && inputs.find((i) => i.id === selector.slice(1));
      return fakeLocator(input ? [input] : []);
    },
    getByRole: () => fakeLocator([button]),
  };
  const frames = [main];
  if (hiddenFrame.length) {
    frames.push({
      parentFrame: () => main,
      frameElement: async () => ({ isVisible: async () => false }),
      locator: () => fakeLocator(hiddenFrame.map((id) => makeInput(id, "fenetre", seen))),
    });
  }
  return {
    frames: () => frames,
    locator: main.locator,
    isClosed: () => false,
    waitForTimeout: () => new Promise((r) => setTimeout(r, 5)),
    waitForEvent: async () => (chooser ? chooser : new Promise((r) => setTimeout(() => r(null), 30))),
  };
}
const sessions = new Map();
const app = { stack: [], use(fn) { this.stack.push(fn); } };
register(app, { events: { on() {} }, log() {}, sessions, normalizeUserId: String, withUserLimit: (_u, fn) => fn() });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  req.path = url.pathname;
  req.query = Object.fromEntries(url.searchParams);
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(o));
    return res;
  };
  app.stack[0](req, res, () => res.status(404).json({ error: "suivant" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (route, { body, key = "cle-agent" } = {}) => {
  const r = await fetch(base + route, { method: "POST", body, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.status, ...(await r.json()) };
};
const send = async (name = "photo.jpg", body = "contenu") => (await post(`/noah/fichier?nom=${encodeURIComponent(name)}`, { body })).id;
const setTab = (p, user = "noah") => sessions.set(user, { tabGroups: new Map([["g", new Map([["t1", { page: p, refs: new Map() }]])]]) });
const openUpload = (name, length) => new Promise((resolve) => {
  const u = new URL(`${base}/noah/fichier?nom=${name}`);
  const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST",
    headers: { authorization: "Bearer cle-agent", "content-length": String(length) } });
  q.on("error", () => {});
  q.write(Buffer.alloc(1000), () => setTimeout(() => resolve(q), 50));
});

// 1. Seule la clé de l'agent ouvre ces routes.
for (const route of ["/noah/fichier?nom=a", "/noah/joindre?userId=noah&fichiers=a"]) {
  assert.equal((await post(route, { body: "x", key: "" })).status, 403, "sans clé");
  assert.equal((await post(route, { body: "x", key: "mauvaise" })).status, 403, "mauvaise clé");
  assert.equal((await post(route, { body: "x", key: "cle-serveur" })).status, 403, "la clé du mode privé n'ouvre pas l'envoi");
}
assert.equal(fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).length : 0, 0, "rien n'est écrit sans clé");

// 2. Le fichier arrive tel quel, sous son nom, enfermé dans le dossier d'envoi.
const payload = Buffer.alloc(1 << 20, 7);
const sent = await post("/noah/fichier?nom=photo.jpg", { body: payload });
assert.equal(sent.octets, payload.length);
assert.deepEqual(fs.readFileSync(path.join(OUTBOX, sent.id, "photo.jpg")), payload);
for (const evil of ["../../noah-prive.json", "..\\..\\x.jpg", "/etc/passwd", ".env", "a\u0000b.jpg"]) {
  const r = await post(`/noah/fichier?nom=${encodeURIComponent(evil)}`, { body: "x" });
  assert.equal(r.status, 200, evil);
  const [name] = fs.readdirSync(path.join(OUTBOX, r.id));
  assert.ok(name && !/[/\\\u0000]/.test(name) && !name.startsWith("."), `nom assaini : ${JSON.stringify(name)}`);
  assert.ok(!fs.existsSync("/data/noah-prive.json") || r.nom !== evil);
}
assert.ok((await post("/noah/fichier?nom=", { body: "x" })).nom, "un nom vide reçoit un nom");

// 3. Trop lourd ou vide : refusé, et rien ne reste sur le disque.
const before = fs.readdirSync(OUTBOX).length;
assert.equal((await post("/noah/fichier?nom=vide.jpg", { body: "" })).status, 400);
const heavy = await new Promise((resolve) => {
  const u = new URL(`${base}/noah/fichier?nom=gros.bin`);
  const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST",
    headers: { authorization: "Bearer cle-agent", "transfer-encoding": "chunked" } }, (r) => {
    r.resume();
    r.on("end", () => resolve(r.statusCode));
  });
  q.on("error", () => resolve(413));
  const block = Buffer.alloc(1 << 20);
  let n = 0;
  const pump = () => {
    while (n < 320) {
      n++;
      if (!q.write(block)) return q.once("drain", pump);
    }
    q.end();
  };
  pump();
});
assert.equal(heavy, 413, "au-delà de 300 Mo, sans longueur annoncée");
assert.equal(fs.readdirSync(OUTBOX).length, before, "un envoi refusé ne laisse rien");

// Coupé en route : rien ne reste, et le compteur se libère.
const cut = await openUpload("coupe.bin", 1000000);
cut.destroy();
await new Promise((r) => setTimeout(r, 150));
assert.equal(fs.readdirSync(OUTBOX).length, before, "un envoi coupé ne laisse rien");
assert.ok(await send(), "le compteur d'envois se libère après une coupure");

// Le plafond global tient entre deux envois simultanés : l'espace est réservé dès le début.
const full = path.join(OUTBOX, "f".repeat(24));
fs.mkdirSync(full);
fs.closeSync(fs.openSync(path.join(full, "gros"), "w"));
fs.truncateSync(path.join(full, "gros"), 900 * 2 ** 20); // fichier creux : compte sans occuper le disque
const first = await openUpload("a.bin", 100 * 2 ** 20);
const second = await post("/noah/fichier?nom=b.bin", { body: "x".repeat(10) });
assert.equal(second.status, 200, "un petit fichier passe encore");
const tooMuch = await new Promise((resolve) => {
  const u = new URL(`${base}/noah/fichier?nom=c.bin`);
  const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST",
    headers: { authorization: "Bearer cle-agent", "content-length": String(100 * 2 ** 20) } }, (r) => {
    r.resume();
    resolve(r.statusCode);
  });
  q.on("error", () => resolve(0));
  q.write(Buffer.alloc(1000));
  setTimeout(() => {
    q.destroy();
    resolve("accepté");
  }, 1500);
});
assert.equal(tooMuch, 413, "le plafond compte ce qui est en cours d'envoi");
first.destroy();
await new Promise((r) => setTimeout(r, 150));
fs.rmSync(full, { recursive: true, force: true });

// 4. Le ménage : plus d'une heure, le fichier part au prochain envoi.
const old = await send("ancien.jpg");
fs.utimesSync(path.join(OUTBOX, old), new Date(0), new Date(0));
await send("neuf.jpg");
assert.ok(!fs.existsSync(path.join(OUTBOX, old)), "les vieux envois s'effacent");
setTab(page({ all: ["x"] }));
assert.equal((await post(`/noah/joindre?userId=noah&fichiers=${old}`)).status, 404, "fichier expiré");
for (const bad of ["../x", "", "abc", "a".repeat(24) + "/.."]) {
  assert.equal((await post(`/noah/joindre?userId=noah&fichiers=${encodeURIComponent(bad)}`)).status, 400, `identifiant ${bad}`);
}

// 5. Le champ visé : jamais au hasard.
const id = await send();
const attach = (extra = "") => post(`/noah/joindre?userId=noah&fichiers=${id}${extra}`);
const byButton = () => attach(`&selecteur=${encodeURIComponent("#bouton")}`);

let seen = [];
setTab(page({ all: ["seul"], seen }));
let r = await attach();
assert.equal(r.ok, true);
assert.deepEqual(r.fichiers, ["photo.jpg"]);
assert.equal(seen[0].id, "seul", "le seul champ de la page");
assert.ok(seen[0].files[0].startsWith(OUTBOX), "chemin du dossier d'envoi");

seen = [];
setTab(page({ dialog: ["fenetre"], all: ["profil"], seen }));
await attach();
assert.equal(seen[0].id, "fenetre", "la fenêtre ouverte passe avant le premier champ de la page");

seen = [];
setTab(page({ hidden: ["ferme"], all: ["principal"], seen }));
r = await attach();
assert.equal(seen[0]?.id, "principal", "une fenêtre cachée ne compte pas");

seen = [];
setTab(page({ hiddenFrame: ["cadre"], all: ["principal"], seen }));
r = await attach();
assert.equal(seen[0]?.id, "principal", "un cadre caché ne compte pas");

seen = [];
setTab(page({ all: ["photo-de-profil", "autre"], seen }));
r = await attach();
assert.equal(r.status, 409, "deux champs sans fenêtre : refus");
assert.equal(seen.length, 0, "rien n'est posé au hasard");
assert.equal(r.champs.length, 2, "la liste aide à choisir");
r = await attach(`&selecteur=${encodeURIComponent("#autre")}`);
assert.equal(seen[0].id, "autre", "le champ désigné");

seen = [];
setTab(page({ seen }));
r = await attach();
assert.equal(r.status, 422, "aucun champ : la consigne dit quoi faire");
assert.match(r.error, /ouvre d'abord/);

// Un bouton : le sélecteur de fichiers du système reçoit le fichier, une seule fois.
seen = [];
const chooser = { setFiles: async (files) => seen.push({ id: "selecteur", files }) };
setTab(page({ button: { evaluate: async () => false, click: async () => {} }, chooser, seen }));
r = await byButton();
assert.equal(r.via, "selecteur");
assert.equal(seen.length, 1, "joint une seule fois");

// Un bouton qui fait apparaître un champ : celui-là, pas celui qui était déjà là.
seen = [];
setTab(page({ button: { evaluate: async () => false, click: async () => {} }, all: ["profil"], afterClick: "monte", seen }));
r = await byButton();
assert.equal(seen[0]?.id, "monte", "le champ apparu après le clic");

// Un bouton qui ouvre une fenêtre déjà présente dans la page, fermée : son champ est la bonne cible.
seen = [];
setTab(page({ button: { evaluate: async () => false, click: async () => {} }, all: ["profil"], hidden: ["ferme"], reveal: "ferme", seen }));
r = await byButton();
assert.equal(seen[0]?.id, "ferme", "le champ de la fenêtre que le bouton vient d'ouvrir");

// Un bouton sans effet : surtout pas le champ déjà là.
seen = [];
setTab(page({ button: { evaluate: async () => false, click: async () => {} }, all: ["profil"], seen }));
r = await byButton();
assert.equal(r.status, 422, "le bouton n'a rien ouvert");
assert.equal(seen.length, 0, "le champ déjà là ne reçoit rien");

// 6. Une autre identité ne voit pas l'onglet ; pendant la prise en main, rien, même si elle commence en route.
assert.equal((await post(`/noah/joindre?userId=invite&fichiers=${id}`)).status, 404, "l'onglet d'un autre");
await post("/noah/prive?secondes=60", { key: "cle-serveur" });
assert.equal((await attach()).status, 423, "l'utilisateur a la main");
await post("/noah/prive?secondes=0", { key: "cle-serveur" });

seen = [];
let taken = false;
setTab(page({ all: ["seul"], seen, onCount: async () => {
  if (!taken) await post("/noah/prive?secondes=60", { key: "cle-serveur" });
  taken = true;
} }));
assert.equal((await attach()).status, 423, "prise en main commencée pendant la recherche du champ");
assert.equal(seen.length, 0, "rien n'est remis au site");
await post("/noah/prive?secondes=0", { key: "cle-serveur" });

// Prise en main pendant la remise : elle ne s'annule pas, mais l'agent ne reçoit pas un « tout va bien ».
seen = [];
duringDelivery = () => post("/noah/prive?secondes=60", { key: "cle-serveur" });
setTab(page({ all: ["seul"], seen }));
r = await attach();
duringDelivery = null;
assert.equal(r.status, 423, "l'agent sait que la main a changé");
assert.match(r.error, /a pu être remis/);
await post("/noah/prive?secondes=0", { key: "cle-serveur" });

// 7. Les autres routes continuent leur chemin.
assert.equal((await fetch(`${base}/tabs`)).status, 404, "passe au suivant");

server.close();
server.closeAllConnections();
console.log("Envoi de fichier : clé, nom assaini, plafonds réservés, coupure, ménage, champ jamais deviné, prise en main respectée.");
process.exit(0);
