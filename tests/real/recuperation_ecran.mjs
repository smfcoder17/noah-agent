// Mot de passe oublié dans un vrai navigateur, avec le code lu dans les vrais journaux du conteneur. Serveur : bureau_serveur.py.
//   NOAH_URL=http://127.0.0.1:18473 NOAH_CONTENEUR=noah-essai-bureau-1 NOAH_DOSSIER=… NOAH_PLAYWRIGHT=… node tests/real/recuperation_ecran.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const BASE = process.env.NOAH_URL;
const CT = process.env.NOAH_CONTENEUR;
const OUT = process.env.NOAH_DOSSIER;
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const check = (ok, what) => {
  if (!ok) throw new Error(`ÉCHEC : ${what}`);
  console.log(`OK    ${what}`);
};
const CODE = /\b[B-Z]{4}-[B-Z]{4}-[B-Z]{4}\b/g;
const logs = () => {
  const r = spawnSync("docker", ["logs", CT], { encoding: "utf8" });
  return (r.stdout + r.stderr).match(CODE) || [];
};
const login = async (password) => (await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alice", password }) }));

const before = await (await login("motdepasse-essai")).json();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 900, height: 900 }, locale: "fr-FR" })).newPage();
await page.goto(BASE);
await page.getByRole("button", { name: "Mot de passe oublié ?" }).click();
await page.screenshot({ path: `${OUT}/recuperation-ecran.png`, fullPage: true });
const known = logs().length;
await page.getByRole("button", { name: "Créer un code" }).click();
await page.getByRole("status").waitFor();
let codes = logs();
for (let i = 0; i < 20 && codes.length === known; i++) {
  await page.waitForTimeout(250);
  codes = logs();
}
check(codes.length === known + 1, "le bouton écrit un code dans les vrais journaux du conteneur");
const code = codes.at(-1);
check(!(await page.locator("body").innerText()).includes(code), "le code n'apparaît pas à l'écran");

await page.locator("#recovery-code").fill("BCDF-GHJK-LMNP");
await page.locator("#new-password").fill("nouveau-mdp-ecran");
await page.locator("#new-password-again").fill("autre-chose-ecran");
await page.getByRole("button", { name: "Changer le mot de passe" }).click();
await page.getByText("ne sont pas identiques").waitFor();
check(true, "deux mots de passe différents : l'écran le dit");
await page.locator("#new-password-again").fill("nouveau-mdp-ecran");
await page.getByRole("button", { name: "Changer le mot de passe" }).click();
await page.getByText("Ce code est faux").waitFor();
check(true, "faux code : l'écran le dit");
await page.screenshot({ path: `${OUT}/recuperation-faux-code.png`, fullPage: true });

await page.locator("#recovery-code").fill(code);
await page.getByRole("button", { name: "Changer le mot de passe" }).click();
await page.getByText("Mot de passe changé").waitFor();
check((await page.locator("#username").inputValue()) === "alice", "retour à la connexion, nom d'utilisateur rempli");
await page.screenshot({ path: `${OUT}/recuperation-fini.png`, fullPage: true });
check((await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${before.token}` } })).status === 401, "la session d'avant est tombée");
check((await login("motdepasse-essai")).status === 401, "l'ancien mot de passe ne sert plus");

await page.locator("#password").fill("nouveau-mdp-ecran");
await page.getByRole("button", { name: "Se connecter" }).click();
await page.locator("[data-composer-input]").first().waitFor({ timeout: 20000 });
check(true, "connexion à l'écran avec le nouveau mot de passe");
await browser.close();

// La commande dans le vrai conteneur, puis retour au mot de passe de départ pour les essais suivants.
const printed = execFileSync("docker", ["exec", "-w", "/app", CT, "python", "-m", "noah.recuperation"], { encoding: "utf8" }).match(CODE);
check(printed?.length === 1, "docker exec … python -m noah.recuperation affiche un code");
const reset = await fetch(`${BASE}/api/recuperation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: printed[0], password: "motdepasse-essai" }) });
check(reset.status === 200 && (await login("motdepasse-essai")).status === 200, "son code change le mot de passe sur le serveur qui tourne");
console.log("OK");
