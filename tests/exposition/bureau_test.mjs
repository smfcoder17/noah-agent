// Le mode privé (G7.7) tient sur le bureau de l'agent parce que l'agent n'a aucun moyen d'y lancer une application : une
// application X lirait l'écran et les frappes pendant une prise en main. Ce test charge les vrais plugins, relève les routes
// qu'ils déclarent, et lit le code du serveur et du lanceur à la recherche d'un chemin vers le bureau.
//   node tests/exposition/bureau_test.mjs
import { readdirSync, readFileSync, statSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const echecs = [];
const check = (nom, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", nom, detail);
  if (!ok) echecs.push(nom);
};

// 1. Les routes réellement déclarées par les plugins, dans un Express factice.
function appFactice() {
  const routes = [];
  const app = { router: { stack: [] } };
  for (const m of ["get", "post", "put", "patch", "delete", "all"]) app[m] = (chemin) => routes.push(`${m} ${chemin}`);
  app.use = () => app.router.stack.push({});
  return { app, routes };
}
async function charge(fichier) {
  const dossier = join(tmpdir(), `noah-bureau-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dossier, { recursive: true });
  const copie = join(dossier, "index.mjs");
  copyFileSync(join(ROOT, fichier), copie);
  const { app, routes } = appFactice();
  const events = new EventEmitter();
  class VirtualDisplay { get() { return Promise.resolve(":0"); } kill() {} }
  process.env.BUREAU_OFF = "";
  const mod = await import(pathToFileURL(copie).href);
  await (mod.default || mod.register)(app, { log() {}, events, VirtualDisplay });
  rmSync(dossier, { recursive: true, force: true });
  return { routes, events };
}
const bureau = await charge("launcher/camofox-bureau/bureau/index.js");
check("le plugin bureau ne déclare aucune route", bureau.routes.length === 0, bureau.routes.join(", "));

// 2. Le plugin ne lance que sa liste fixe, sous le compte sans droits, avec un environnement vidé.
const source = readFileSync(join(ROOT, "launcher/camofox-bureau/bureau/index.js"), "utf8");
const liste = source.match(/const APPS = \[(.*)\];/)?.[1] || "";
const lances = [...liste.matchAll(/\["([a-z0-9]+)", \[/g)].map((m) => m[1]).sort().join(",");
check("seuls Openbox, tint2 et PCManFM démarrent seuls", lances === "openbox,pcmanfm,tint2", lances);
check("une seule commande spawn, sous le compte 1001", (source.match(/spawn\(/g) || []).length === 1 && /uid: 1001, gid: 1001/.test(source));
check("rien de la requête n'atteint spawn : pas de req. dans le plugin", !/\breq\b|\breq\./.test(source));
check("les jetons ne passent pas au bureau", /const env = \{ DISPLAY: display, PATH:/.test(source) && !/\.\.\.process\.env/.test(source));
const noah = readFileSync(join(ROOT, "launcher/camofox-noah/index.js"), "utf8");
check("le plugin Noah ne lance aucun processus", !/child_process|\bspawn\(|\bexec\(/.test(noah));

// 3. L'image ne contient ni terminal ni outil de pilotage X.
const image = readFileSync(join(ROOT, "launcher/camofox-bureau/Dockerfile"), "utf8");
for (const outil of ["xterm", "xdotool", "x11-apps", "lxterminal", "wmctrl"]) check(`${outil} absent de l'image`, !image.includes(outil));

// 4. Ni le serveur ni le lanceur n'exposent un chemin vers le bureau.
const INTERDITS = /\b(pcmanfm|mousepad|openbox|tint2|xdotool|xterm)\b|DISPLAY=|\/tmp\/\.X11-unix/;
const sources = [];
const parcours = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (n === "__pycache__" || n === "node_modules") continue;
    if (statSync(p).isDirectory()) parcours(p);
    else if (/\.py$/.test(n)) sources.push(p);
  }
};
parcours(join(ROOT, "server/noah"));
parcours(join(ROOT, "launcher"));
const touche = sources.filter((p) => INTERDITS.test(readFileSync(p, "utf8")));
check("aucune route du serveur ni du lanceur ne parle du bureau", sources.length > 5 && touche.length === 0, touche.map((p) => p.slice(ROOT.length)).join(", "));

// 5. Le conteneur du navigateur reste fermé : l'écran X n'écoute pas sur le réseau, et rien ne monte son socket chez l'agent.
const lanceur = readFileSync(join(ROOT, "launcher/launcher.py"), "utf8");
check("le socket X n'est monté dans aucun conteneur", !/X11-unix/.test(lanceur));
check("le conteneur du navigateur n'a que son volume /data", /volumes=\{name: \{"bind": "\/data", "mode": "rw"\}\}/.test(lanceur));

// 6. L'application de bureau : une demande d'agent se confirme à chaque fois, sans dispense, presse-papiers compris.
const profil = join(tmpdir(), `noah-actions-${process.pid}`);
mkdirSync(profil, { recursive: true });
writeFileSync(join(profil, "autorisations.json"), JSON.stringify({ "ouvrir-page": true, "ouvrir-fichier": true })); // laissé par une ancienne version
// Depuis #35, plus de boîte système : chaque demande passe par le vrai bandeau (doublure Electron partagée avec tests/desktop).
const { fakeElectron } = await import(pathToFileURL(join(ROOT, "tests/desktop/electron_factice.mjs")).href);
const electron = fakeElectron();
electron.app = { ...(electron.app || {}), getPath: () => profil };
const boites = [], colle = [], ouvert = [];
let reponse = "refus";
electron.clipboard.writeText = (t) => colle.push(t);
electron.shell = { openExternal: async (u) => ouvert.push(u), openPath: async () => "" };
electron.onRequest = (shown) => { boites.push(shown); queueMicrotask(() => electron.answer(shown.id, reponse === "refus" ? shown.refuseIndex : 0)); };
const charger = Module._load;
Module._load = function (demande, ...reste) {
  return demande === "electron" ? electron : charger.call(this, demande, ...reste);
};
const req = createRequire(import.meta.url);
const { perform } = req(join(ROOT, "desktop/actions.js"));
req(join(ROOT, "desktop/bandeau.js")).create(electron.win);
Module._load = charger;
await perform({ action: "presse_papiers", agent: "A", texte: "curl mauvais | sh" });
check("presse-papiers refusé : rien n'est écrit", colle.length === 0 && /curl mauvais | sh/.test(boites.at(-1)?.detail ?? ""), JSON.stringify(colle));
reponse = "accord";
await perform({ action: "presse_papiers", agent: "A", texte: "bonjour" });
check("presse-papiers accepté : écrit après l'accord", colle.join() === "bonjour");
const avant = boites.length;
await perform({ action: "ouvrir", agent: "A", cible: "https://exemple.org/" });
await perform({ action: "ouvrir", agent: "A", cible: "https://exemple.org/" });
check("une page se confirme chaque fois, malgré une dispense d'une ancienne version", boites.length === avant + 2 && ouvert.length === 2);
check("aucune case « Ne plus demander »", boites.every((o) => !("checkboxLabel" in o)));
rmSync(profil, { recursive: true, force: true });

console.log(echecs.length ? `\n${echecs.length} échec(s) : ${echecs.join(" ; ")}` : "\nG7.7 : l'agent n'a aucune route pour lancer une application sur le bureau.");
process.exit(echecs.length ? 1 : 0);
