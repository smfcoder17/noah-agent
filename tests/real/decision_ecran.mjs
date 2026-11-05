// Captures du modèle de décision, des routines à condition et de la relecture de mémoire dans un vrai navigateur, sur une pile
// gardée par routines_reelles.mjs (--garder). Les compteurs de la veille affichée sont posés pour voir leur rendu à l'écran.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/decision_ecran.mjs <dossier des captures>
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const OUT = resolve(process.argv[2] || ".");
mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";
const BASE = "http://127.0.0.1:18190";
const check = (ok, what) => {
  console.log(`${ok ? "OK   " : "ÉCHEC"} ${what}`);
  if (!ok) process.exitCode = 1;
};
const inServer = (code) => execFileSync("docker", ["exec", "-w", "/app", "-e", "PYTHONPATH=/app", "noah-routines-server", "python", "-c", code]).toString().trim();

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "fr-FR" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.locator("#username").fill("alice");
  await page.locator("#password").fill("motdepasse-essai");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.getByRole("button", { name: "Réglages" }).click();
  await page.getByRole("tab", { name: "Cerveau" }).click();
  const panel = page.getByRole("region", { name: "Modèle de décision" });
  await panel.waitFor();
  const text = await panel.innerText();
  check(/Modèle de décision : /.test(text) && /Changer/.test(text), `Réglages > Cerveau : ${text.split("\n")[0]}`);
  await page.screenshot({ path: `${OUT}/reglage-decision.png` });
  await panel.getByRole("button", { name: "Changer" }).click();
  const select = panel.getByRole("combobox", { name: "Modèle de décision" });
  await select.waitFor();
  check((await select.locator("option").count()) >= 2, "« Changer » propose Automatique et les modèles de la clé");
  await panel.screenshot({ path: `${OUT}/reglage-decision-changer.png` });
  await page.keyboard.press("Escape");

  // Détails : la routine à condition et son compte.
  const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const r = await fetch(p, { method: m, headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [method, path, body]);
  const id = (await call("GET", "/api/agents")).json[0].id;
  for (const w of (await call("GET", `/api/agents/${id}/watches`)).json.veilles) await call("POST", `/api/agents/${id}/watches/${w.id}/supprimer`, {});
  const created = await call("POST", `/api/agents/${id}/watches`, { nom: "Courriels de Paul", url: "gmail:from:paul@exemple.fr", critere: "un courriel de Paul à propos d'une facture", consigne: "prépare une réponse", minutes: 30 });
  check(created.status === 200, `routine à condition créée (${created.status})`);
  inServer(`from noah import db
with db.connect() as c:
    c.execute("UPDATE watches SET checks = 12, wakes = 1, alerts = 1, decision_cost = 0.0008, brain_cost = 0.0012, last_error = ''")`);
  await page.reload();
  await page.getByRole("button", { name: "Détails", exact: true }).click();
  const section = page.getByRole("button", { name: /Veilles et routines à condition/ });
  await section.click();
  await page.getByText("12 passages, 1 réveil, 0,002 $").waitFor({ timeout: 8000 }).catch(async (e) => {
    await page.screenshot({ path: `${OUT}/details-echec.png` });
    throw e;
  });
  check(true, "Détails : « 12 passages, 1 réveil, 0,002 $ »");
  await page.screenshot({ path: `${OUT}/details-routine-condition.png` });
  await section.click();

  // Mémoire : la relecture propose, sans rien retirer.
  await call("PUT", `/api/agents/${id}/memory`, { cible: "memory", entrees: ["Le jeton du client OAuth d'essai expire : détail d'installation à retrouver dans la console.", "Il a décidé que les rapports partent le vendredi."] });
  await page.reload();
  await page.getByRole("button", { name: "Détails", exact: true }).click();
  await page.getByRole("button", { name: /^Mémoire/ }).click();
  await page.getByRole("button", { name: "Relire et proposer un nettoyage" }).click();
  await page.getByText(/propose de retirer|Rien à retirer/).waitFor({ timeout: 90000 });
  check(true, "Mémoire : la relecture répond à l'écran");
  await page.screenshot({ path: `${OUT}/details-memoire-relue.png` });
  check((await call("GET", `/api/agents/${id}/memory`)).json.memory.length === 2, "rien n'est retiré sans accord");
  check(!errors.length, `aucune erreur dans la page ${errors.join(" ; ")}`);
} finally {
  await browser.close();
}
