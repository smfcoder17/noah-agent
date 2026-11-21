// Mise à jour de l'app de bureau : la logique de desktop/maj.js avec electron-updater simulé (quand proposer, préversion
// ignorée, « Plus tard », erreur réseau silencieuse), le script qui garde latest.yml cohérent avec l'installateur publié,
// et la configuration de l'empaquetage (nom du fichier, dépôt GitHub, fichiers embarqués).
//   node tests/desktop/maj_test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktop = join(root, "desktop");
const maj = require(join(desktop, "maj.js"));
const textes = require(join(desktop, "textes.js"));
const { aProposer } = maj;
let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`OK    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`ÉCHEC ${name}\n       ${String(e.stack || e).split("\n").join("\n       ")}`);
  }
};
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((ok) => setImmediate(ok)); };

/** electron-updater simulé : les mêmes réglages et événements que le vrai autoUpdater. */
function fakeUpdater({ rejects } = {}) {
  const u = Object.assign(new EventEmitter(), {
    checks: 0, installs: [],
    checkForUpdates: async () => { u.checks++; if (rejects) throw rejects; return null; },
    quitAndInstall: (...args) => u.installs.push(args),
  });
  return u;
}
function setup({ version = "0.4.1", answer = 1, updater = fakeUpdater(), askFails = false } = {}) {
  const asked = [], logs = [], timers = [];
  const ui = maj.create({
    updater, version, t: (k, v) => textes.t(k, v, "fr"), log: (m) => logs.push(m),
    ask: async (options) => { asked.push(options); if (askFails) throw new Error("boîte refusée"); return { response: answer }; },
    every: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  });
  return { ui, updater, asked, logs, timers };
}

// --- Quand proposer --------------------------------------------------------------------------------------------------
await check("proposer : une version plus récente, stable, pas encore proposée", () => {
  assert.equal(aProposer("0.4.2", "0.4.1"), true);
  assert.equal(aProposer("0.5.0", "0.4.9"), true);
  assert.equal(aProposer("1.0.0", "0.99.99"), true);
  assert.equal(aProposer("0.4.10", "0.4.9"), true, "comparaison numérique, pas alphabétique");
});
await check("ne pas proposer : même version, plus ancienne, préversion, valeur illisible, déjà proposée", () => {
  assert.equal(aProposer("0.4.1", "0.4.1"), false);
  assert.equal(aProposer("0.4.0", "0.4.1"), false);
  assert.equal(aProposer("0.4.2-rc1", "0.4.1"), false);
  assert.equal(aProposer("0.5.0-rc.2", "0.4.1"), false);
  assert.equal(aProposer("", "0.4.1"), false);
  assert.equal(aProposer(undefined, "0.4.1"), false);
  assert.equal(aProposer("dernière", "0.4.1"), false);
  assert.equal(aProposer("0.4.2", "0.4.1", "0.4.2"), false);
});

// --- Réglages d'electron-updater -------------------------------------------------------------------------------------
await check("réglages : téléchargement seul, installation à la fermeture, préversions et retour en arrière refusés", () => {
  const { ui, updater } = setup();
  ui.start();
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});
await check("vérification au démarrage, puis toutes les 6 heures", () => {
  const { ui, updater, timers } = setup();
  ui.start();
  ui.start(); // un deuxième démarrage ne double rien
  assert.equal(updater.checks, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 6 * 60 * 60 * 1000);
  timers[0].fn();
  assert.equal(updater.checks, 2);
});

// --- Proposition -----------------------------------------------------------------------------------------------------
await check("mise à jour prête : proposition en français simple, deux boutons", async () => {
  const { ui, updater, asked } = setup({ answer: 1 });
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.2" });
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, "Noah 0.4.2 est prête. Redémarrer pour l'installer ?");
  assert.deepEqual(asked[0].buttons, ["Redémarrer", "Plus tard"]);
  assert.equal(asked[0].cancelId, 1, "fermer la boîte vaut « Plus tard »");
});
await check("« Redémarrer » : installe et relance l'app", async () => {
  const { ui, updater } = setup({ answer: 0 });
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.2" });
  await settle();
  assert.deepEqual(updater.installs, [[false, true]], "quitAndInstall(isSilent=false, forceRunAfter=true)");
});
await check("« Plus tard » : rien n'est installé maintenant, une seule proposition, le menu garde la main", async () => {
  const { ui, updater, asked } = setup({ answer: 1 });
  const menus = [];
  ui.onReady((v) => menus.push(v));
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.2" });
  await settle();
  updater.emit("update-downloaded", { version: "0.4.2" }); // la vérification de 6 h le retrouve déjà téléchargé
  await settle();
  assert.deepEqual(updater.installs, []);
  assert.equal(asked.length, 1, "pas de relance toutes les 6 h");
  assert.equal(updater.autoInstallOnAppQuit, true, "installée à la prochaine fermeture");
  assert.equal(ui.ready(), "0.4.2");
  assert.deepEqual(menus, ["0.4.2", "0.4.2"]);
  assert.equal(ui.install(), true, "l'entrée du menu installe plus tard");
  assert.deepEqual(updater.installs, [[false, true]]);
});
await check("pas d'installation sans accord : proposer ne lance jamais quitAndInstall", async () => {
  const { ui, updater } = setup({ answer: 1 });
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.2" });
  await settle();
  assert.equal(updater.installs.length, 0);
});
await check("sans mise à jour prête, install() ne fait rien", () => {
  const { ui, updater } = setup();
  ui.start();
  assert.equal(ui.install(), false);
  assert.deepEqual(updater.installs, []);
});

// --- Préversions et versions qui ne dépassent pas celle qui tourne ---------------------------------------------------
await check("préversion (v0.4.2-rc1) : ni proposition, ni entrée de menu", async () => {
  const { ui, updater, asked, logs } = setup();
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.2-rc1" });
  await settle();
  assert.equal(asked.length, 0);
  assert.equal(ui.ready(), "");
  assert.ok(logs.some((l) => l.includes("0.4.2-rc1") && l.includes("ignorée")));
});
await check("même version ou plus ancienne : ignorée", async () => {
  const { ui, updater, asked } = setup({ version: "0.4.1" });
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.1" });
  updater.emit("update-downloaded", { version: "0.3.9" });
  await settle();
  assert.equal(asked.length, 0);
  assert.equal(ui.ready(), "");
});
await check("une version plus récente que celle déjà proposée est proposée à son tour", async () => {
  const { ui, updater, asked } = setup({ answer: 1 });
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.2" });
  await settle();
  updater.emit("update-downloaded", { version: "0.4.3" });
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(ui.ready(), "0.4.3");
});

// --- Erreurs : le journal seulement ----------------------------------------------------------------------------------
await check("GitHub injoignable : la vérification échoue en silence, l'app continue", async () => {
  const { ui, updater, asked, logs } = setup({ updater: fakeUpdater({ rejects: new Error("net::ERR_INTERNET_DISCONNECTED") }) });
  ui.start();
  await settle();
  await ui.check();
  assert.equal(updater.checks, 2);
  assert.equal(asked.length, 0);
  assert.ok(logs.some((l) => l.includes("ERR_INTERNET_DISCONNECTED")), "dit au journal");
});
await check("événement « error » d'electron-updater : journal seulement, jamais d'exception", () => {
  const { ui, updater, logs } = setup();
  ui.start();
  assert.doesNotThrow(() => updater.emit("error", new Error("latest.yml introuvable (404)")));
  assert.ok(logs.some((l) => l.includes("404")));
});
await check("boîte de proposition en échec : journal seulement, mise à jour gardée pour la fermeture", async () => {
  const { ui, updater, logs } = setup({ askFails: true });
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.2" });
  await settle();
  assert.ok(logs.some((l) => l.includes("boîte refusée")));
  assert.equal(ui.ready(), "0.4.2");
});
await check("quitAndInstall qui échoue : journal, pas d'exception", async () => {
  const updater = fakeUpdater();
  updater.quitAndInstall = () => { throw new Error("installateur introuvable"); };
  const { ui, logs } = setup({ updater });
  ui.start();
  updater.emit("update-downloaded", { version: "0.4.2" });
  await settle();
  assert.equal(ui.install(), false);
  assert.ok(logs.some((l) => l.includes("installateur introuvable")));
});

// --- Textes ----------------------------------------------------------------------------------------------------------
await check("textes de la mise à jour en français et en anglais", () => {
  for (const lang of ["fr", "en"]) {
    for (const key of ["maj.prete", "maj.redemarrer", "maj.plus_tard", "maj.menu"]) assert.ok(textes.t(key, { version: "0.4.2" }, lang).length > 0, `${lang} ${key}`);
    assert.match(textes.t("maj.prete", { version: "0.4.2" }, lang), /0\.4\.2/);
  }
});

// --- latest.yml : cohérent avec l'installateur publié ---------------------------------------------------------------
const script = join(root, "scripts", "latest-yml.mjs");
const work = mkdtempSync(join(tmpdir(), "noah-maj-"));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
try {
  const exe = join(work, "noah-agent-windows-setup.exe");
  const yml = join(work, "latest.yml");
  writeFileSync(exe, Buffer.from("faux installateur ".repeat(5000)));
  const sha = createHash("sha512").update(readFileSync(exe)).digest("base64");
  const size = readFileSync(exe).length;
  // Ce que electron-builder écrit si le fichier garde son nom par défaut : nom avec espaces, empreinte d'un autre fichier.
  const drift = `version: 0.4.2\nfiles:\n  - url: Noah Agent Setup 0.4.2.exe\n    sha512: AAAA\n    size: 12\npath: Noah Agent Setup 0.4.2.exe\nsha512: AAAA\nreleaseDate: '2026-11-21T23:46:46.323Z'\n`;

  await check("latest.yml qui cite un autre nom et une autre empreinte : refusé, avec la raison", () => {
    writeFileSync(yml, drift);
    const r = run("verifier", yml, exe, "0.4.2");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /path/);
    assert.match(r.stderr, /sha512/);
    assert.match(r.stderr, /size/);
  });
  await check("réécrit : cite noah-agent-windows-setup.exe, sha512 et taille du fichier, date d'origine gardée", () => {
    writeFileSync(yml, drift);
    const r = run("ecrire", yml, exe, "0.4.2");
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(yml, "utf8");
    assert.equal(text, `version: 0.4.2\nfiles:\n  - url: noah-agent-windows-setup.exe\n    sha512: ${sha}\n    size: ${size}\npath: noah-agent-windows-setup.exe\nsha512: ${sha}\nreleaseDate: '2026-11-21T23:46:46.323Z'\n`);
    assert.equal(run("verifier", yml, exe, "0.4.2").status, 0);
  });
  await check("latest.yml absent : écrit à neuf", () => {
    rmSync(yml, { force: true });
    assert.equal(run("ecrire", yml, exe, "0.4.2").status, 0);
    assert.match(readFileSync(yml, "utf8"), /^releaseDate: '\d{4}-/m);
  });
  await check("la version de latest.yml doit être celle du Release", () => {
    const r = run("verifier", yml, exe, "0.4.3");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /version/);
  });
  await check("fichier modifié après coup : l'empreinte ne concorde plus", () => {
    writeFileSync(exe, Buffer.from("autre contenu"));
    const r = run("verifier", yml, exe, "0.4.2");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /sha512/);
  });
  await check("installateur absent ou arguments manquants : refusé", () => {
    assert.equal(run("verifier", yml, join(work, "absent.exe"), "0.4.2").status, 1);
    assert.equal(run("verifier").status, 2);
  });
  await check("le format écrit est celui d'electron-builder", () => {
    // Capturé sur une vraie construction (electron-builder 26.0.12, installateur nommé noah-agent-windows-setup.exe).
    const real = "version: 0.1.0\nfiles:\n  - url: noah-agent-windows-setup.exe\n    sha512: dO/K==\n    size: 89343363\npath: noah-agent-windows-setup.exe\nsha512: dO/K==\nreleaseDate: '2026-11-21T23:46:46.323Z'\n";
    writeFileSync(exe, "x");
    writeFileSync(yml, real);
    assert.equal(run("ecrire", yml, exe, "0.1.0").status, 0);
    const lines = (s) => s.split("\n").map((l) => l.replace(/:.*/, ""));
    assert.deepEqual(lines(readFileSync(yml, "utf8")), lines(real));
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

// --- Empaquetage -----------------------------------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
await check("l'installateur Windows garde un nom fixe, celui du lien public releases/latest/download/", () => {
  assert.equal(pkg.build.nsis.artifactName, "noah-agent-windows-setup.exe");
});
await check("electron-updater lit les Releases du dépôt public, embarqué avec l'app (dependencies, pas devDependencies)", () => {
  assert.deepEqual(pkg.build.publish, [{ provider: "github", owner: "smfcoder17", repo: "noah-agent" }]);
  assert.ok(pkg.dependencies["electron-updater"], "dependencies");
  assert.equal(pkg.devDependencies["electron-updater"], undefined);
  assert.match(pkg.dependencies["electron-updater"], /^\d+\.\d+\.\d+$/, "version exacte, comme electron");
});
await check("app non signée : aucun publisherName (sinon electron-updater refuserait toute mise à jour)", () => {
  assert.equal(pkg.build.win.signAndEditExecutable, false);
  assert.equal(pkg.build.win.publisherName, undefined);
});
await check("chaque module local chargé par l'app est dans « files » (sinon l'app installée ne démarre pas)", () => {
  const listed = new Set(pkg.build.files);
  const wanted = new Set(["main.js", "preload.js"]);
  for (const f of readdirSync(desktop).filter((n) => n.endsWith(".js"))) {
    for (const m of readFileSync(join(desktop, f), "utf8").matchAll(/require\("\.\/([\w-]+)(?:\.js)?"\)/g)) wanted.add(`${m[1]}.js`);
  }
  assert.deepEqual([...wanted].filter((f) => !listed.has(f)), []);
});
await check("main.js : mises à jour seulement sous Windows, app installée, hors essai de développement", () => {
  const main = readFileSync(join(desktop, "main.js"), "utf8");
  assert.match(main, /process\.platform !== "win32" \|\| !app\.isPackaged \|\| process\.env\.NOAH_PROFIL\) return;/);
  assert.match(main, /startUpdates\(\);/);
});

console.log(failures ? `${failures} échec(s)` : "Mise à jour du bureau : tout tient.");
process.exit(failures ? 1 : 0);
