// Le serveur d'essai des budgets B1 et B3 : le vrai serveur et la vraie interface construite (frontend/dist), Hermes simulé,
// deux agents déjà créés, un long fil (tests/real/fil_long_serveur.py). Compte : alice / motdepasse-essai.
//   NOAH_BASE=http://127.0.0.1:8099 : un serveur déjà lancé, sans Docker.
// Playwright : variable NOAH_PLAYWRIGHT (chemin du module) ou paquet `playwright` ; absent, les budgets de navigateur disent
// « NON MESURÉ » et réussissent (le cliquet ne bloque que ce qui est mesuré).
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "./cliquet.mjs";

export const racine = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COMPTE = { nom: "alice", motDePasse: "motdepasse-essai" };

/** Rend { base, arreter }. */
export async function demarrer(script = "fil_long_serveur.py") {
  if (process.env.NOAH_BASE) return { base: process.env.NOAH_BASE, arreter: async () => {} };
  process.env.MSYS_NO_PATHCONV = "1";
  const ici = process.platform === "win32" ? execFileSync("bash", ["-c", "pwd -W"], { cwd: racine }).toString().trim() : racine;
  const nom = `noah-budget-essai-${process.pid}`;
  execFileSync("docker", ["run", "-d", "--name", nom, "-p", "127.0.0.1:18098:8099", "-e", "NOAH_WEB_DIR=/web",
    "-v", "noah-pip-cache:/root/.cache/pip", "-v", `${ici}/server:/app`, "-v", `${ici}/tests:/tests`, "-v", `${ici}/frontend/dist:/web`,
    "python:3.12-slim", "sh", "-c", "pip install -q -r /app/requirements.txt uvicorn && python /tests/real/" + script], { stdio: "pipe" });
  const arreter = async () => { try { execFileSync("docker", ["rm", "-f", nom], { stdio: "pipe" }); } catch { /* déjà parti */ } };
  const base = "http://127.0.0.1:18098";
  const fin = Date.now() + 240000;
  for (;;) {
    try { if ((await fetch(`${base}/api/status`)).ok) return { base, arreter }; } catch { /* pas encore */ }
    if (Date.now() > fin) { await arreter(); throw new Error("le serveur d'essai ne répond pas après 4 minutes"); }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
}

/** Le navigateur, ou null (dit pourquoi). */
export async function navigateur() {
  const module = await playwright();
  if (!module) {
    console.log("NON MESURÉ : Playwright absent (NOAH_PLAYWRIGHT=<chemin du module>, ou le paquet `playwright` dans frontend). Le budget ne bloque rien.");
    return null;
  }
  return module.chromium.launch({ channel: process.env.NOAH_NAVIGATEUR || "chrome", headless: true });
}

/** Ouvre une page connectée en alice. */
export async function connecter(contexte, base) {
  const page = await contexte.newPage();
  await page.goto(base);
  await page.locator("input:not([type=password])").first().fill(COMPTE.nom);
  await page.locator('input[type="password"]').first().fill(COMPTE.motDePasse);
  await page.keyboard.press("Enter");
  await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
  return page;
}
