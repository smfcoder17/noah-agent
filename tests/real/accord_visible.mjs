// Vrai navigateur, vraie interface : un accord demandé par un travail lancé sans cet écran s'affiche sans rafraîchir, en langage clair.
// Serveur : chat_pendant_serveur.py.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/accord_visible.mjs <dossier des captures>
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
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR" })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(BASE);
await page.locator("input:not([type=password])").first().fill("alice");
await page.locator('input[type="password"]').first().fill("motdepasse-essai");
await page.keyboard.press("Enter");
await page.locator("[data-composer-input]").waitFor({ timeout: 20000 });
let reloads = 0;
page.on("load", () => reloads++);

// Le travail repart côté serveur : aucun flux dans cet écran, et il était au repos.
await fetch(`${BASE}/_essai/reprendre`, { method: "POST" });
const card = page.getByRole("button", { name: "Autoriser" });
const t = Date.now();
await card.waitFor({ timeout: 12000 });
check(reloads === 0, `l'accord apparaît sans rafraîchir, en ${((Date.now() - t) / 1000).toFixed(1)} s`);
check(await card.isVisible(), "le bouton est à l'écran, sans avoir à défiler");

const body = await page.locator("body").innerText();
check(body.includes("Ton agent veut créer « Mon post du jour » dans Notion."), "une phrase claire, qui dit quoi");
check(body.includes("Mon post du jour"), "ce qui serait envoyé est lisible");
for (const word of ["notion_create_pages", "telemetry", "d4b95a89", "{", "Outil «"]) check(!body.includes(word), `pas de « ${word} » à l'écran`);
await page.screenshot({ path: `${OUT}/1-accord-clair.png` });

// Un clic voulu montre le brut sur cette carte seulement, pour décider en connaissance de cause.
await page.getByRole("button", { name: "Voir les détails" }).click();
await page.getByText("notion_create_pages", { exact: false }).first().waitFor({ timeout: 5000 });
check(true, "« Voir les détails » : le texte brut apparaît");
await page.getByRole("button", { name: "Masquer les détails" }).click();
check(!(await page.locator("body").innerText()).includes("notion_create_pages"), "« Masquer les détails » : il repart");

// Détails techniques cochés : le brut est là.
await page.getByRole("button", { name: "Détails techniques" }).click();
await page.getByText("notion_create_pages", { exact: false }).first().waitFor({ timeout: 5000 });
check(true, "détails techniques : le texte brut apparaît");
await page.screenshot({ path: `${OUT}/2-accord-technique.png` });
await page.getByRole("button", { name: "Détails techniques" }).click();

// À toi : l'accord se voit depuis ailleurs, avec ce qui serait envoyé, et ramène à sa carte.
const inbox = page.getByRole("button", { name: /^À toi\s*1$/ });
await inbox.waitFor({ timeout: 8000 });
check(true, "À toi compte l'accord");
await inbox.click();
await page.getByRole("dialog").getByText("Ton agent veut créer « Mon post du jour » dans Notion.").waitFor({ timeout: 5000 });
check(await page.getByRole("dialog").getByRole("button", { name: "Autoriser" }).isVisible(), "À toi permet de décider");
await page.screenshot({ path: `${OUT}/2b-a-toi.png` });
await page.getByRole("dialog").getByRole("button", { name: /Ouvrir la conversation/ }).click();
await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5000 });
await card.waitFor({ timeout: 5000 });
check(true, "un toucher ramène à la carte");

// L'accord se donne, la carte s'en va, le travail continue.
await card.click();
await card.waitFor({ state: "hidden", timeout: 8000 });
check(true, "accord donné : les boutons s'en vont");
await page.getByText(/Autorisé · créer « Mon post du jour » dans Notion/).waitFor({ timeout: 3000 });
check(true, "la décision reste lisible");
await page.getByRole("button", { name: /^À toi$/ }).waitFor({ timeout: 6000 });
check(true, "le badge tombe");
await page.screenshot({ path: `${OUT}/3-apres-accord.png` });

await fetch(`${BASE}/_essai/finir`, { method: "POST" });

// Répondu depuis À toi pendant que le fil reçoit son flux : sa carte le sait aussi.
await page.getByText(/^Fini/).first().waitFor({ timeout: 15000 });
await page.locator("[data-composer-input]").fill("NOTION encore une fois");
await page.keyboard.press("Enter");
await card.waitFor({ timeout: 12000 });
await page.getByRole("button", { name: /^À toi\s*1$/ }).click();
await page.getByRole("dialog").getByRole("button", { name: "Refuser" }).click();
await page.keyboard.press("Escape");
await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5000 });
await card.waitFor({ state: "hidden", timeout: 5000 });
check(true, "répondu depuis À toi : les boutons du fil s'en vont");
await page.getByText(/Refusé · créer « Mon post du jour » dans Notion/).waitFor({ timeout: 3000 });
check(true, "et le fil garde la décision");
await fetch(`${BASE}/_essai/finir`, { method: "POST" });

// Un second accord arrive pendant que la réponse au premier revient : il reste à donner, la décision ne passe pas sur lui.
await page.getByText("Fini : NOTION encore une fois").waitFor({ timeout: 15000 });
await fetch(`${BASE}/_essai/deux`, { method: "POST" });
await card.waitFor({ timeout: 12000 });
await page.getByText("Ton agent veut créer « Premier » dans Notion.").waitFor({ timeout: 3000 });
const firstAnswer = page.waitForResponse((r) => r.url().includes("/approval"));
await card.click();
await page.getByText("Ton agent veut créer « Second » dans Notion.").waitFor({ timeout: 6000 });
await firstAnswer;
await page.waitForTimeout(400);
check((await page.getByText(/Autorisé · créer « Second »/).count()) === 0, "le premier accord ne répond pas au second");
check(await card.isVisible(), "le second accord garde ses boutons");
await card.click();
await page.getByText(/Autorisé · créer « Second »/).waitFor({ timeout: 5000 });
check(true, "et se donne à son tour");
await fetch(`${BASE}/_essai/finir`, { method: "POST" });

// Même chose depuis À toi : le second accord y apparaît sans fermer la fenêtre.
await page.getByText("Fini : DEUX suite").waitFor({ timeout: 15000 });
await fetch(`${BASE}/_essai/deux`, { method: "POST" });
await card.waitFor({ timeout: 12000 });
await page.getByRole("button", { name: /^À toi\s*1$/ }).click();
const dialog = page.getByRole("dialog");
const answerInInbox = page.waitForResponse((r) => r.url().includes("/approval"));
await dialog.getByRole("button", { name: "Autoriser" }).click();
await answerInInbox;
await dialog.getByText("Ton agent veut créer « Second » dans Notion.").waitFor({ timeout: 4000 });
check(true, "À toi montre le second accord, sans rouvrir");
await dialog.getByRole("button", { name: "Autoriser" }).click();
await dialog.getByText("Rien ne t'attend").waitFor({ timeout: 6000 });
check(true, "puis se vide");
await page.keyboard.press("Escape");
await fetch(`${BASE}/_essai/finir`, { method: "POST" });

check(errors.length === 0, `aucune erreur de page ${errors.join(" | ")}`);
await browser.close();
console.log("OK");
