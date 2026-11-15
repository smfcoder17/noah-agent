// Empreinte gardée : tirée une fois par agent, reposée à chaque lancement de Firefox. Vraie extension, événements comme ceux
// de Camofox (browser:launching avec les options de camoufox-js, puis browser:launched), empreintes simulées.
//
//   docker run --rm -v "$PWD/launcher/camofox-noah:/p:ro" -v "$PWD/tests:/tests:ro" node:22-alpine \
//     sh -c "mkdir -p /data && node /tests/navigateur/empreinte_test.mjs"
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { keepFingerprint } = await import(process.env.NOAH_PLUGIN || "/p/index.js");

let n = 0;
// Comme launchOptions() de camoufox-js : une empreinte au hasard, découpée en CAMOU_CONFIG_<n>.
function launchOptions({ locale = "fr-CA", ff = 135 } = {}) {
  n++;
  const config = {
    "navigator.userAgent": `Mozilla/5.0 (X11; Linux x86_64; rv:${ff}.0) Gecko/20100101 Firefox/${ff}.0`,
    "navigator.hardwareConcurrency": [2, 4, 8, 12, 16][n % 5],
    "screen.width": 1280 + n * 10, "screen.height": 720 + n * 10,
    "webGl:renderer": `Rendu ${n}`, "fonts:spacing_seed": 1000 + n, "canvas:aaOffset": n,
    fonts: ["Arial", "DejaVu Sans"], "locale:language": locale.split("-")[0], "locale:region": locale.split("-")[1],
    humanize: true, addons: [`/image-${n}/ubo`],
    "x": "y".repeat(40000), // assez long pour tenir sur deux variables, comme une vraie empreinte avec ses polices
  };
  const text = JSON.stringify(config), env = { PATH: "/bin" };
  for (let i = 0, k = 1; i < text.length; i += 32767, k++) env[`CAMOU_CONFIG_${k}`] = text.slice(i, i + 32767);
  return { env, firefoxUserPrefs: { "webgl.enable-webgl2": n % 2 === 0 } };
}
const read = (env) => JSON.parse(Object.keys(env).filter((k) => k.startsWith("CAMOU_CONFIG_"))
  .sort((a, b) => +a.split("_")[2] - +b.split("_")[2]).map((k) => env[k]).join(""));
const machine = (c) => ({ ua: c["navigator.userAgent"], coeurs: c["navigator.hardwareConcurrency"], ecran: [c["screen.width"], c["screen.height"]],
  webgl: c["webGl:renderer"], polices: c["fonts:spacing_seed"] });

function agent(file) {
  const events = new EventEmitter();
  keepFingerprint({ events, log: () => {} }, file);
  return (opts, ok = true) => {
    const options = launchOptions(opts);
    events.emit("browser:launching", { options });
    if (ok) events.emit("browser:launched", {});
    return { config: read(options.env), prefs: options.firefoxUserPrefs };
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empreinte-"));
const fileA = path.join(dir, "a.json"), fileB = path.join(dir, "b.json");
const launchA = agent(fileA);
const first = launchA();
assert.ok(fs.existsSync(fileA), "premier lancement : l'empreinte est gardée");
assert.equal(fs.statSync(fileA).mode & 0o777, 0o600);
const second = launchA();
assert.deepEqual(machine(second.config), machine(first.config), "deuxième lancement : même machine");
assert.equal(second.prefs["webgl.enable-webgl2"], first.prefs["webgl.enable-webgl2"], "WebGL 2 suit son rendu");
assert.equal(second.config["canvas:aaOffset"], first.config["canvas:aaOffset"]);
assert.equal(second.config.x, first.config.x, "empreinte longue recousue sans perte");
console.log("lancement 1 :", JSON.stringify(machine(first.config)));
console.log("lancement 2 :", JSON.stringify(machine(second.config)));

// Une autre langue (l'agent a changé de pays) et une image neuve : la machine reste, la langue et les extensions suivent.
const moved = launchA({ locale: "en-US", ff: 146 });
assert.equal(moved.config["locale:language"], "en");
assert.notDeepEqual(moved.config.addons, first.config.addons, "extensions : celles de l'image du jour");
assert.match(moved.config["navigator.userAgent"], /rv:146\.0\) Gecko\/20100101 Firefox\/146\.0$/, "Firefox mis à jour : seul le numéro change");
assert.deepEqual({ ...machine(moved.config), ua: undefined }, { ...machine(first.config), ua: undefined });

// Un autre agent : sa propre empreinte.
const otherB = agent(fileB)();
assert.notDeepEqual(machine(otherB.config), machine(first.config), "un autre agent a une autre machine");
console.log("autre agent :", JSON.stringify(machine(otherB.config)));

// Nouvelle identité voulue : fichier supprimé, une empreinte neuve est tirée puis gardée.
fs.unlinkSync(fileA);
const fresh = launchA();
assert.notDeepEqual(machine(fresh.config), machine(first.config));
assert.deepEqual(machine(launchA().config), machine(fresh.config), "la nouvelle est gardée à son tour");

// Deux lancements ratés avec l'empreinte gardée : le troisième part avec une neuve, sans effacer le fichier.
const launchC = agent(path.join(dir, "c.json"));
const kept = launchC();
launchC({}, false);
launchC({}, false);
const rescue = launchC();
assert.notDeepEqual(machine(rescue.config), machine(kept.config), "navigateur jamais bloqué par son empreinte");
assert.deepEqual(machine(launchC().config), machine(kept.config), "puis l'empreinte gardée revient");

fs.rmSync(dir, { recursive: true });
console.log("Empreinte du navigateur : la même d'un lancement à l'autre, une par agent, régénérable : OK");
