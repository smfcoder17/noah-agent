// Vrai navigateur, vraie interface : les portes de Noah, sur ordinateur et sur téléphone. Serveur : fil_long_serveur.py.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/portes.mjs <dossier des captures>
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
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];

async function login(options) {
  const context = await browser.newContext({ locale: "fr-FR", ...options });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.locator("input:not([type=password])").first().fill("alice");
  await page.locator('input[type="password"]').first().fill("motdepasse-essai");
  await page.keyboard.press("Enter");
  await page.locator("[data-composer-input]").waitFor({ timeout: 20000 });
  return page;
}
const tabs = async (page, label) => {
  const list = page.getByRole("tablist", { name: label }).getByRole("tab");
  await list.first().waitFor({ timeout: 8000 });
  return list.allInnerTexts();
};
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// --- Ordinateur ---
const desk = await login({ viewport: { width: 1280, height: 800 } });
// Bis passe pour un agent partagé : son propriétaire peut toujours y connecter une plateforme.
await desk.route("**/api/agents", async (r) => {
  if (r.request().method() !== "GET") return r.continue();
  const answer = await r.fetch();
  await r.fulfill({ response: answer, json: (await answer.json()).map((a) => (a.id === "a2" ? { ...a, partage: true } : a)) });
});
check(await desk.getByRole("button", { name: /^À toi/ }).isVisible(), "barre latérale : À toi en haut");
check(!(await desk.getByRole("navigation", { name: "Navigation" }).isVisible()), "pas de barre du bas sur ordinateur");
check(!(await desk.getByText("Ce mois-ci").isVisible()), "pas de dépense quand rien ne l'exige");
await desk.getByRole("button", { name: "Réglages" }).click();
const six = (await tabs(desk, "Rubriques")).join("|");
check(six === "Compte|Appareils|Notifications|Modèles et budget|Personnes|Serveur", `six rubriques (${six})`);
check(await desk.getByRole("tab", { name: "Compte" }).getAttribute("aria-selected") === "true", "la porte d'entrée est le compte");
await desk.screenshot({ path: `${OUT}/1-reglages-compte.png` });
await desk.getByRole("tab", { name: "Modèles et budget" }).click();
check((await tabs(desk, "Modèles et budget")).join("|") === "Cerveau|Création|Voix", "Cerveau, Création et Voix sont rangés ensemble");
await desk.screenshot({ path: `${OUT}/2-reglages-modeles.png` });
await desk.getByRole("tab", { name: "Serveur" }).click();
check((await tabs(desk, "Serveur")).join("|") === "Mises à jour|Courriel|Confidentialité|Diagnostic", "le serveur à part");
await desk.keyboard.press("Escape");

await desk.getByRole("button", { name: /Ouvrir le panneau de/ }).first().click();
await desk.getByRole("tab", { name: "Activité" }).waitFor({ timeout: 8000 });
check((await desk.getByRole("tab").allInnerTexts()).join("|") === "Activité|Connexions|Ordinateur|Routines|Mémoire", "le visage ouvre cinq onglets");
await desk.screenshot({ path: `${OUT}/3-panneau-activite.png` });
check(await desk.getByText("Cerveau :").count() === 1, "une seule ligne pour le cerveau");
await desk.getByText("Ce qu'il a fait").waitFor({ timeout: 5000 });
check(!(await desk.getByText("Appels au modèle").isVisible()), "pas de jetons d'emblée");

// Une réponse tardive du journal d'un agent ne s'affiche pas sous un autre.
const row = (titre) => [{ kind: "tache", titre, resultat: "", etat: "fait", at: Date.now() / 1000, conversation_id: "c", main: true }];
await desk.route("**/api/agents/a1/activite", async (r) => {
  await new Promise((done) => setTimeout(done, 1500));
  await r.fulfill({ json: row("Tâche de Noah") });
});
await desk.route("**/api/agents/a2/activite", (r) => r.fulfill({ json: row("Tâche de Bis") }));
await desk.getByRole("button", { name: /Bis/ }).first().click();
await desk.getByRole("button", { name: /Noah/ }).first().click();
await desk.getByRole("button", { name: /Bis/ }).first().click();
await desk.getByText("Tâche de Bis").waitFor({ timeout: 5000 });
await desk.waitForTimeout(2000);
check(await desk.getByText("Tâche de Noah").count() === 0 && await desk.getByText("Tâche de Bis").count() === 1, "le journal reste celui de l'agent affiché");
await desk.unroute("**/api/agents/a1/activite");
await desk.unroute("**/api/agents/a2/activite");
await desk.getByRole("tab", { name: "Connexions" }).click();
await desk.getByText("Instagram", { exact: true }).waitFor({ timeout: 8000 });
check(await desk.getByText("Cet agent est partagé : ceux qui l'utilisent pourront aussi publier sur ce compte.").isVisible(), "agent partagé : Instagram se connecte, et le risque se dit");
await desk.getByRole("tab", { name: "Activité" }).click();
await desk.getByRole("button", { name: /Noah/ }).first().click();
await desk.getByRole("tab", { name: "Connexions" }).click();
await desk.getByRole("button", { name: "Connecter une application" }).waitFor({ timeout: 8000 });
await desk.getByText("Instagram", { exact: true }).waitFor({ timeout: 8000 });
await desk.screenshot({ path: `${OUT}/4-panneau-connexions.png` });
await desk.getByRole("tab", { name: "Ordinateur" }).click();
for (const name of ["Écran", "Fichiers", "Dossiers", "Logiciels"]) check(await desk.getByRole("tab", { name, exact: true }).isVisible(), `Ordinateur : ${name}`);
await desk.getByRole("tab", { name: "Fichiers", exact: true }).click();
await desk.screenshot({ path: `${OUT}/5-panneau-fichiers.png` });
await desk.getByRole("tab", { name: "Routines" }).click();
await desk.getByText("Routines", { exact: true }).nth(1).waitFor({ timeout: 8000 });
await desk.getByRole("tab", { name: "Mémoire" }).click();
await desk.waitForTimeout(400);
await desk.screenshot({ path: `${OUT}/6-panneau-memoire.png` });
// Une panne d'écran ne blanchit pas l'application.
await desk.route("**/api/agents/*/memory", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
await desk.getByRole("tab", { name: "Routines" }).click();
await desk.getByRole("tab", { name: "Mémoire" }).click();
await desk.getByRole("alert").getByText("n'a pas pu s'afficher").waitFor({ timeout: 8000 });
check(await desk.locator("[data-composer-input]").isVisible(), "un écran en panne laisse la conversation debout");
await desk.screenshot({ path: `${OUT}/12-ecran-en-panne.png` });
errors.length = 0; // la panne provoquée est volontaire
await desk.context().close();

// --- Téléphone, au doigt ---
const phone = await login({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const bar = phone.getByRole("navigation", { name: "Navigation" });
check((await bar.getByRole("button").allInnerTexts()).map((t) => t.trim()).join("|") === "Discussion|À toi|Agents|Réglages", "quatre portes en bas");
check(await fits(phone), "rien ne dépasse en largeur");
check(await bar.getByRole("button", { name: "Discussion" }).getAttribute("aria-current") === "page", "la barre dit où l'on est");
await phone.screenshot({ path: `${OUT}/7-telephone-fil.png` });
const react = phone.getByRole("button", { name: "Réagir" }).last();
check(await phone.evaluate(() => matchMedia("(pointer: coarse)").matches), "écran tactile simulé");
check(Number(await react.evaluate((el) => getComputedStyle(el).opacity)) > 0.5, "« Réagir » se voit sans survol");
await bar.getByRole("button", { name: "À toi" }).click();
await phone.getByText("Rien ne t'attend pour le moment.").waitFor({ timeout: 8000 });
await phone.screenshot({ path: `${OUT}/8-telephone-a-toi.png` });
await phone.keyboard.press("Escape");
await bar.getByRole("button", { name: "Agents" }).click();
await phone.getByRole("button", { name: "Créer un agent" }).waitFor({ timeout: 5000 });
await phone.waitForTimeout(300);
await phone.screenshot({ path: `${OUT}/9-telephone-agents.png` });
await phone.mouse.click(370, 400); // le voile
await phone.waitForTimeout(300);
await bar.getByRole("button", { name: "Réglages" }).click();
check(await fits(phone), "Réglages : rien ne dépasse");
const summary = phone.getByRole("navigation", { name: "Rubriques" }).getByRole("button");
await summary.first().waitFor({ timeout: 5000 });
check((await summary.allInnerTexts()).join("|") === "Compte|Appareils|Notifications|Modèles et budget|Personnes|Serveur", "téléphone : un sommaire, pas un formulaire");
await phone.screenshot({ path: `${OUT}/10-telephone-reglages.png` });
await summary.filter({ hasText: "Serveur" }).click();
await phone.getByRole("tab", { name: "Courriel" }).waitFor({ timeout: 5000 });
await phone.getByRole("button", { name: "Serveur", exact: true }).click();
await summary.first().waitFor({ timeout: 5000 });
await phone.keyboard.press("Escape");
await phone.getByRole("button", { name: /Ouvrir le panneau de/ }).first().click();
await phone.getByRole("tab", { name: "Activité" }).waitFor({ timeout: 5000 });
await phone.screenshot({ path: `${OUT}/11-telephone-panneau.png` });
check(await fits(phone), "panneau : rien ne dépasse");
const lastTab = await phone.getByRole("tab", { name: "Mémoire" }).boundingBox();
const closeTab = await phone.getByRole("button", { name: "Fermer le panneau" }).boundingBox();
check(lastTab.x + lastTab.width <= closeTab.x, "panneau : les cinq onglets tiennent sur un téléphone");
await phone.getByRole("button", { name: "Fermer le panneau" }).click();
await phone.locator("[data-composer-input]").focus();
await phone.waitForTimeout(150);
check(!(await bar.isVisible()), "la barre laisse la place au clavier");
await phone.locator("[data-composer-input]").blur();
await phone.waitForTimeout(150);
check(await bar.isVisible(), "et revient ensuite");
check(!errors.length, `aucune erreur dans la page ${errors.join(" ; ")}`);
await browser.close();
console.log("portes : tout est vert");
