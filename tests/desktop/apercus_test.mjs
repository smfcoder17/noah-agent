// Les aperçus de fichiers dans l'app de bureau : la fenêtre ne coupe jamais une requête vers une adresse du serveur lui-même (image, vidéo, PDF,
// page d'aperçu, texte), l'installateur embarque chaque module que le programme principal charge, et rien dans le bureau ne relâche la
// protection que le serveur pose sur les fichiers (pas de webSecurity désactivé, pas d'en-tête réécrit).
// Le vrai parcours, dans la vraie app Electron contre le serveur d'essai : NOAH_BUREAU=1 node tests/real/apercus_lancer.mjs
//   node tests/desktop/apercus_test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop");
const liens = require(join(desktop, "liens.js"));
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`OK    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`ÉCHEC ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
  }
};

const ROUTES = [
  "/api/agents/a1/files/raw/outputs/video.mp4",
  "/api/agents/a1/files/raw/outputs/rapport%20final.pdf",
  "/api/agents/a1/files/raw/outputs/notes.txt?download=1",
  "/api/agents/a1/fichier/texte/outputs/contrat.docx",
  "/api/agents/a1/media?path=%2Fopt%2Fdata%2Fworkspace%2Foutputs%2Fimage.png",
  "/api/apercu/eyJhIjoxfQ.0123abcd/logo.png",
  "/api/apercu/eyJhIjoxfQ.0123abcd/assets/app.js",
];
check("aucune adresse de fichier du serveur n'est coupée, en HTTPS (port implicite ou 443 écrit) comme en HTTP local", () => {
  for (const origin of ["https://noah.exemple.com", "https://noah.exemple.com:8443", "http://127.0.0.1:8096", "http://192.168.1.20", "https://203-0-113-7.sslip.io"]) {
    for (const route of ROUTES) assert.equal(liens.requestBlocked(origin + route, origin), false, origin + route);
  }
  assert.equal(liens.requestBlocked("https://noah.exemple.com:443/api/agents/a1/files/raw/x.png", "https://noah.exemple.com"), false);
});

check("ce qui part vers un autre port du même hôte est coupé : l'aperçu d'une page ne peut pas y envoyer le cookie de session", () => {
  assert.equal(liens.requestBlocked("https://noah.exemple.com:8443/api/agents/a1/files/raw/x.png", "https://noah.exemple.com"), true);
  assert.equal(liens.requestBlocked("http://127.0.0.1:9000/x.png", "http://127.0.0.1:8096"), true);
  assert.equal(liens.requestBlocked("https://cdn.exemple.net/x.png", "https://noah.exemple.com"), false, "un autre hôte n'est pas l'affaire de cette règle (le CSP du serveur le tient)");
});

check("package.json : l'installateur embarque chaque module local que les fichiers du bureau chargent (un module absent, et la fenêtre ne s'ouvre pas)", () => {
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  const shipped = new Set(pkg.build.files);
  const missing = [];
  for (const file of readdirSync(desktop).filter((f) => f.endsWith(".js"))) {
    if (!shipped.has(file)) continue;
    for (const m of readFileSync(join(desktop, file), "utf8").matchAll(/require\("\.\/([\w-]+)(?:\.js)?"\)/g)) {
      if (!shipped.has(`${m[1]}.js`)) missing.push(`${file} charge ${m[1]}.js`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(shipped.has("liens.js"), "liens.js : requestBlocked de main.js");
});

check("main.js : la fenêtre ne désactive aucune protection de page et ne réécrit aucun en-tête de réponse", () => {
  const main = readFileSync(join(desktop, "main.js"), "utf8");
  assert.doesNotMatch(main, /webSecurity\s*:\s*false/);
  assert.doesNotMatch(main, /allowRunningInsecureContent|onHeadersReceived|disable-web-security|ignore-certificate-errors/);
  assert.match(main, /sandbox: true/, "la vue de Noah reste en bac à sable");
  assert.match(main, /liens\.requestBlocked\(details\.url, origin\)/, "la règle de requêtes passe par liens.js");
  assert.match(main, /Requête coupée/, "une requête coupée se lit au journal du bureau");
});

console.log(failures ? `\n${failures} échec(s)` : "\nOK");
process.exit(failures ? 1 : 0);
