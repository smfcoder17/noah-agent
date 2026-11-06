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
check(body.includes("Ton agent veut créer quelque chose dans Notion."), "une phrase claire");
check(body.includes("Mon post du jour"), "ce qui serait envoyé est lisible");
for (const word of ["notion_create_pages", "telemetry", "d4b95a89", "{", "Outil «"]) check(!body.includes(word), `pas de « ${word} » à l'écran`);
await page.screenshot({ path: `${OUT}/1-accord-clair.png` });

// Détails techniques cochés : le brut est là.
await page.getByRole("button", { name: "Détails techniques" }).click();
await page.getByText("notion_create_pages", { exact: false }).first().waitFor({ timeout: 5000 });
check(true, "détails techniques : le texte brut apparaît");
await page.screenshot({ path: `${OUT}/2-accord-technique.png` });
await page.getByRole("button", { name: "Détails techniques" }).click();

// L'accord se donne, la carte s'en va, le travail continue.
await card.click();
await card.waitFor({ state: "hidden", timeout: 8000 });
check(true, "accord donné : la carte s'en va");
await page.screenshot({ path: `${OUT}/3-apres-accord.png` });

await fetch(`${BASE}/_essai/finir`, { method: "POST" });
check(errors.length === 0, `aucune erreur de page ${errors.join(" | ")}`);
await browser.close();
console.log("OK");
