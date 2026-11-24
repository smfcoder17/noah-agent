// Lance le serveur d'essai des aperçus (Docker), puis le test dans un vrai navigateur (apercus.mjs), puis l'arrête.
//   npm run build --prefix frontend && node tests/real/apercus_lancer.mjs [dossier des captures] [étiquette]
// NOAH_PLAYWRIGHT : chemin du module ; sinon celui de frontend/node_modules. NOAH_BUREAU=1 : ajoute l'app de bureau (apercus_bureau.mjs).
// Playwright absent : « NON MESURÉ », sans échec, comme les budgets de navigateur (tools/eval/essai.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const racine = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const playwright = process.env.NOAH_PLAYWRIGHT || resolve(racine, "frontend", "node_modules", "playwright", "index.js");
if (!existsSync(playwright)) {
  console.log("NON MESURÉ : Playwright absent (NOAH_PLAYWRIGHT=<chemin du module>, ou le paquet `playwright` dans frontend).");
  process.exit(0);
}
if (!existsSync(resolve(racine, "frontend", "dist", "index.html"))) {
  console.log("L'interface n'est pas construite : npm run build --prefix frontend");
  process.exit(1);
}
process.env.MSYS_NO_PATHCONV = "1";
const ici = process.platform === "win32" ? execFileSync("bash", ["-c", "pwd -W"], { cwd: racine }).toString().trim() : racine;
const nom = `noah-apercus-essai-${process.pid}`;
const port = 18096;
execFileSync("docker", ["run", "-d", "--name", nom, "-p", `127.0.0.1:${port}:8096`, "-e", "NOAH_WEB_DIR=/web",
  "-v", "noah-pip-cache:/root/.cache/pip", "-v", `${ici}/server:/app`, "-v", `${ici}/tests:/tests`, "-v", `${ici}/frontend/dist:/web`,
  "python:3.12-slim", "sh", "-c", "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/apercus_serveur.py"], { stdio: "pipe" });
const arreter = () => { try { execFileSync("docker", ["rm", "-f", nom], { stdio: "pipe" }); } catch { /* déjà parti */ } };
process.on("exit", arreter);
const base = `http://127.0.0.1:${port}`;
const fin = Date.now() + 240000;
for (;;) {
  try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* pas encore */ }
  if (Date.now() > fin) { console.log("le serveur d'essai ne répond pas après 4 minutes"); process.exit(1); }
  await new Promise((ok) => setTimeout(ok, 1500));
}
const sorties = process.argv[2] || join(tmpdir(), "noah-apercus");
const env = { ...process.env, NOAH_BASE: base, NOAH_PLAYWRIGHT: playwright };
let code = 0;
for (const script of ["apercus.mjs", ...(process.env.NOAH_BUREAU ? ["apercus_bureau.mjs"] : [])]) {
  code ||= spawnSync("node", [resolve(racine, "tests", "real", script), sorties, process.argv[3] || "apercus"], { stdio: "inherit", env }).status || 0;
}
process.exit(code);
