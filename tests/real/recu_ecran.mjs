// Vrai navigateur, vraie interface : le reçu sous une réponse, à la fin d'un tour puis après un rechargement. Serveur : recu_serveur.py.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/recu_ecran.mjs <dossier des captures>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = "http://127.0.0.1:8117";
const OUT = resolve(process.argv[2] || "captures");
mkdirSync(OUT, { recursive: true });
const check = (ok, what) => {
  if (!ok) throw new Error(`ÉCHEC : ${what}`);
  console.log(`ok ${what}`);
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "fr-FR" })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(BASE);
await page.locator("input:not([type=password])").first().fill("alice");
await page.locator('input[type="password"]').first().fill("motdepasse-essai");
await page.keyboard.press("Enter");
const composer = page.locator("[data-composer-input]");
await composer.waitFor({ timeout: 20000 });

const WARN = "Noah n'en voit aucune trace";
async function ask(word, answer) {
  await composer.fill(word);
  await page.keyboard.press("Enter");
  await page.getByText(answer, { exact: false }).last().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
}

await ask("ORDINAIRE", "en quoi puis-je aider");
check(!(await page.locator("body").innerText()).includes("Reçu"), "une réponse ordinaire n'a pas de reçu");

await ask("MENSONGE", "J'ai envoyé le courriel à Marc.");
await page.getByText(WARN).first().waitFor({ timeout: 5000 });
check(await page.getByText(WARN).first().isVisible(), "dit et pas fait : l'alerte se voit à la fin du tour, sans clic");
await page.screenshot({ path: `${OUT}/1-dit-pas-fait.png` });

await page.getByRole("button", { name: "Lui demander ce qui s'est passé" }).last().click();
check((await composer.inputValue()).includes("aucune trace"), "le bouton prépare la question, sans l'envoyer");
await composer.fill("");

await ask("VRAI", "J'ai envoyé le courriel à Marc.");
const receipt = page.getByRole("button", { name: /Reçu · 1 vérifié/ }).last();
await receipt.waitFor({ timeout: 5000 });
await receipt.click();
await page.getByText("vu passer par Gmail").first().waitFor({ timeout: 3000 });
check(true, "dit et fait : replié par défaut, et le détail nomme l'outil");
await page.screenshot({ path: `${OUT}/2-verifie.png` });

await ask("CACHE", "Voici le résumé de ta journée.");
await page.getByText("Il a supprimé quelque chose avec Gmail.").first().waitFor({ timeout: 5000 });
check(true, "fait et pas dit : l'action cachée se voit");
await page.screenshot({ path: `${OUT}/3-fait-pas-dit.png` });

await ask("NAVIGATEUR", "J'ai publié ton article.");
await page.getByRole("button", { name: /1 non vérifiable/ }).last().waitFor({ timeout: 5000 });
check(true, "un clic du navigateur : non vérifiable, sans alerte");

await ask("ECHEC", "C'est publié.");
await page.getByText("L'outil a échoué (Blog)").first().waitFor({ timeout: 5000 });
check(true, "l'outil a échoué : ça se voit");

await page.reload();
await composer.waitFor({ timeout: 20000 });
await page.getByText(WARN).first().waitFor({ timeout: 10000 });
await page.getByText("Il a supprimé quelque chose avec Gmail.").first().waitFor({ timeout: 5000 });
check(true, "après un rechargement, le reçu est toujours là");
await page.screenshot({ path: `${OUT}/4-apres-rechargement.png`, fullPage: true });

check(errors.length === 0, `aucune erreur de page ${errors.join(" | ")}`);
await browser.close();
