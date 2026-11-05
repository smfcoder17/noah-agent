// Vrai navigateur, vraie interface : pendant que l'agent travaille, la saisie reste ouverte. Serveur : chat_pendant_serveur.py.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/chat_pendant.mjs <dossier des captures>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = "http://127.0.0.1:8099";
const OUT = resolve(process.argv[2] || "captures");
mkdirSync(OUT, { recursive: true });
const check = (ok, what) => {
  if (!ok) throw new Error(`ÉCHEC : ${what}`);
  console.log(`ok ${what}`);
};
const server = async (path, method = "GET") => (await fetch(BASE + path, { method })).json();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR" })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(BASE);
await page.locator("input:not([type=password])").first().fill("alice");
await page.locator('input[type="password"]').first().fill("motdepasse-essai");
await page.keyboard.press("Enter");
const input = page.locator("[data-composer-input]");
await input.waitFor({ timeout: 20000 });

const type = async (text) => {
  await input.fill(text);
  await input.press("Enter");
};
const sees = (text, timeout = 10000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });

// 1. Un travail démarre : la ligne de travail dit ce qu'il fait, et la saisie reste ouverte.
await type("Rédige le rapport");
await sees("Cherche « prix du cuivre »");
check(await input.isEnabled(), "la saisie reste ouverte pendant le travail");
check(await page.getByRole("button", { name: "Arrêter" }).isVisible(), "le bouton Arrêter reste là");
await page.screenshot({ path: `${OUT}/1-travail.png` });

// 2. Une question : réponse rapide, le travail continue.
await type("Tu en es où ?");
await sees("Là : Cherche « prix du cuivre »");
check(await page.getByText("Cherche « prix du cuivre »", { exact: false }).last().isVisible(), "le travail continue après la réponse");
await sees("Le transmettre aussi à l'agent");
await page.screenshot({ path: `${OUT}/2-question.png` });

// 3. Une précision : transmise, et l'écran le dit.
await type("Plutôt en anglais");
await sees("Compris, je lui passe ça.");
check((await server("/_essai/etat")).steered.includes("Plutôt en anglais"), "la précision est arrivée au run");
await page.screenshot({ path: `${OUT}/3-precision.png` });

// 4. Corriger le tri : la question est transmise elle aussi.
await page.getByText("Le transmettre aussi à l'agent").first().click();
await sees("Transmis à l'agent.");
for (let i = 0; i < 20 && !(await server("/_essai/etat")).steered.includes("Tu en es où ?"); i++) await page.waitForTimeout(100);
check((await server("/_essai/etat")).steered.includes("Tu en es où ?"), "la question a été transmise à la demande");

// 5. D'autres demandes : à la suite, visibles, retirables.
await type("Fais aussi un résumé");
await sees("À la suite");
await type("Et une demande à retirer");
await page.getByText("Et une demande à retirer").waitFor();
await page.screenshot({ path: `${OUT}/4-file.png` });
await page.locator("div", { hasText: /^À la suiteEt une demande à retirer/ }).getByRole("button", { name: "Retirer" }).click();
await page.getByText("Et une demande à retirer").waitFor({ state: "detached" });
check(true, "une demande se retire");

// 5 bis. La réponse du serveur se perd : le message ne se dit pas perdu, repart sous le même identifiant, et ne compte qu'une fois.
let lost = 0;
await page.route("**/api/chat/pendant", async (route) => {
  if (lost++ === 0) {
    await route.fetch();
    await route.abort();
  } else await route.continue();
});
await type("Une demande ACCORD");
for (let i = 0; i < 80 && lost < 2; i++) await page.waitForTimeout(100);
await page.locator("div", { hasText: /^À la suiteUne demande ACCORD/ }).first().waitFor({ timeout: 10000 });
await page.unroute("**/api/chat/pendant");
check(lost >= 2, "la réponse perdue a provoqué un nouvel essai");
check((await page.getByText("Une demande ACCORD").count()) === 1, "une seule fois à l'écran, sans doublon");
check((await page.getByText("pas parti").count()) === 0, "pas de fausse annonce de perte");

// 6. Recharger en plein travail : rien n'est perdu, et l'écran sait que ça travaille.
await page.reload();
await input.waitFor({ timeout: 20000 });
await sees("Fais aussi un résumé");
await sees("Cherche « prix du cuivre »");
check(await page.getByRole("button", { name: "Arrêter" }).isVisible(), "après rechargement : l'écran sait qu'il travaille");
await page.screenshot({ path: `${OUT}/5-rechargement.png` });

// 7. Fin du travail : la demande en attente part toute seule et sa réponse arrive sans recharger.
await server("/_essai/finir", "POST");
await sees("Fini : Rédige le rapport", 15000);
for (let i = 0; i < 40 && !(await server("/_essai/etat")).started.some((t) => t.includes("Fais aussi un résumé")); i++) await page.waitForTimeout(250);
check((await server("/_essai/etat")).started.some((t) => t.includes("Fais aussi un résumé")), "la demande en attente est partie");
check((await server("/_essai/etat")).started.every((t) => !t.includes("à retirer")), "la demande retirée n'est pas partie");
await page.waitForTimeout(3500);
await server("/_essai/finir", "POST");
await sees("Fini : Fais aussi un résumé", 15000);
await page.screenshot({ path: `${OUT}/6-suite.png` });

// 7 bis. Un travail de la file demande un accord : aucun flux ici, le bouton s'affiche quand même et débloque.
await page.reload();
await input.waitFor({ timeout: 20000 });
await sees("Supprimer le dossier ?", 15000);
await page.screenshot({ path: `${OUT}/6-accord.png` });
await page.getByRole("button", { name: "Autoriser" }).click();
await sees("Lit apres-accord.txt", 10000);
check(true, "un accord se donne sans le flux, et le travail reprend");
await server("/_essai/finir", "POST");
await sees("Fini : Une demande ACCORD", 15000);

// 8. Tout est calme : on écrit normalement, et la conversation est dans l'ordre.
await page.waitForFunction(() => !document.querySelector('[aria-label="Arrêter"]'), null, { timeout: 15000 });
await page.setViewportSize({ width: 390, height: 780 });
await page.screenshot({ path: `${OUT}/7-telephone.png` });
check(errors.length === 0, `aucune erreur de page ${errors.join(" | ")}`);
await browser.close();
console.log("OK");
