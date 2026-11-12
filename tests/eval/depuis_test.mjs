// --depuis de tools/eval/sabotage.mjs : ne rejoue que les sabotages dont le fichier a changé, et refuse une référence inconnue.
//     node tests/eval/depuis_test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cheminDepot, filtrer, lireDepuis } from "../../tools/eval/depuis.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "tools/eval/sabotage.mjs");

// Le serveur se sabote sous « noah/… », sa place dans le dépôt est server/noah/… ; le reste garde son chemin.
assert.equal(cheminDepot("noah/juge.py"), "server/noah/juge.py");
assert.equal(cheminDepot("launcher/launcher.py"), "launcher/launcher.py");
assert.equal(cheminDepot("desktop/dossiers.js"), "desktop/dossiers.js");

const S = [
  ["a", "noah/juge.py", "", "", ""],
  ["b", "desktop/dossiers.js", "", "", ""],
  ["c", "frontend/src/lib/chatMedia.ts", "", "", ""],
];
assert.deepEqual(filtrer(S, ["server/noah/juge.py", "README.md"]).map((s) => s[0]), ["a"]);
assert.deepEqual(filtrer(S, ["desktop\\dossiers.js\r", ""]).map((s) => s[0]), ["b"], "chemins Windows et fins de ligne");
assert.deepEqual(filtrer(S, ["noah/juge.py"]), [], "noah/juge.py hors de server/ n'est pas le fichier saboté");
assert.deepEqual(filtrer(S, []), []);

assert.equal(lireDepuis([]), null);
assert.equal(lireDepuis(["--depuis", "v0.1.8"]), "v0.1.8");
assert.equal(lireDepuis(["--depuis=v0.1.8", "--liste"]), "v0.1.8");
assert.throws(() => lireDepuis(["--depuis"]));
assert.throws(() => lireDepuis(["--depuis", "--liste"]));

// Le vrai script : sans --depuis il nomme tous les sabotages ; avec --depuis HEAD, seulement ceux dont le fichier diffère de HEAD.
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NOAH_SABOTAGE: "" } });
const tous = run("--liste");
assert.equal(tous.status, 0, tous.stderr);
const noms = JSON.parse(tous.stdout);
assert.ok(noms.length > 100, `liste complète attendue, ${noms.length} sabotages`);

const diff = spawnSync("git", ["diff", "--name-only", "HEAD", "--"], { cwd: ROOT, encoding: "utf8" });
assert.equal(diff.status, 0, diff.stderr);
const depuis = run("--depuis", "HEAD", "--liste");
assert.equal(depuis.status, 0, depuis.stderr);
const filtres = JSON.parse(depuis.stdout);
assert.ok(filtres.length <= noms.length);
assert.ok(filtres.every((n) => noms.includes(n)));
const tousLesTuples = run("--liste"); // même ordre : le filtre ne réordonne rien
assert.deepEqual(filtres, JSON.parse(tousLesTuples.stdout).filter((n) => filtres.includes(n)));
if (!diff.stdout.trim()) assert.deepEqual(filtres, [], "arbre propre : rien à rejouer");

const inconnue = run("--depuis", "reference-qui-n-existe-pas-0000", "--liste");
assert.notEqual(inconnue.status, 0, "une référence inconnue doit arrêter, pas tout rejouer ni rien rejouer en silence");

console.log("depuis_test : ok");
