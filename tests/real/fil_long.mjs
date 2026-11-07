// Vrai navigateur, vraie interface, longue conversation : dates, chargement par tranches, repères, pages en veille, fichiers en dossiers.
// Serveur : fil_long_serveur.py.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/fil_long.mjs <dossier des captures>
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
const reads = [];
page.on("request", (r) => {
  if (/\/messages(\?|$)/.test(r.url()) && r.method() === "GET") reads.push(r.url());
});

await page.goto(BASE);
await page.locator("input:not([type=password])").first().fill("alice");
await page.locator('input[type="password"]').first().fill("motdepasse-essai");
await page.keyboard.press("Enter");
await page.locator("[data-composer-input]").waitFor({ timeout: 20000 });
await page.locator("[data-noah-msg]", { hasText: "Demande numéro 074" }).first().waitFor({ timeout: 10000 });

// Tranches : la conversation entière ne part pas à l'ouverture.
const count = () => page.locator("[data-noah-msg]").count();
check((await count()) === 60, `60 messages à l'ouverture, pas 150 (${await count()})`);
check(reads.every((u) => /limit=60|depuis=/.test(u)), `aucune lecture de toute la conversation : ${reads[0]}`);
check(!(await page.getByText("Demande numéro 000").count()), "le début de la conversation n'est pas chargé");

// Dates.
const bodyText = () => page.locator("body").innerText();
check(await page.locator("[data-noah-msg] time").count() >= 50, "chaque message porte son heure");
const titled = await page.locator("[data-noah-msg] time").first().getAttribute("title");
check(/\d{4}/.test(titled || ""), `la date complète au survol : ${titled}`);
check(/Aujourd'hui/.test(await bodyText()), "le séparateur « Aujourd'hui »");
await page.screenshot({ path: `${OUT}/1-ouverture.png` });

// Page récente : chargée. Page ancienne : pas chargée.
await page.locator('iframe[title="Page récente"]').waitFor({ timeout: 8000 });
check(true, "la page du dernier message tourne");

// Repères.
const rail = page.getByRole("navigation", { name: "Repères de la conversation" });
await rail.waitFor({ timeout: 5000 });
const marks = rail.getByRole("button");
check((await marks.count()) === 30, `30 repères au plus (${await marks.count()})`);
const box = await rail.boundingBox();
check(box && box.width <= 36 && box.x > 1000, `discrets, à droite (${Math.round(box.width)} px de large)`);
const target = marks.first();
await target.hover();
await page.waitForTimeout(200);
const label = await target.getAttribute("aria-label");
const tip = await target.innerText();
check(/Demande numéro/.test(tip) && /\d{2}/.test(tip), `au survol : ${tip.replace(/\n/g, " · ")}`);
await page.screenshot({ path: `${OUT}/2-repere-survol.png` });
await target.click();
const wanted = label.replace("Aller à : ", "").split(" : ")[0];
const arrived = async () => page.evaluate((w) => {
  const box = document.querySelector("[data-noah-viewport]");
  const v = box.getBoundingClientRect();
  const m = [...document.querySelectorAll("[data-noah-msg]")].find((x) => x.textContent.includes(w));
  const r = m.getBoundingClientRect();
  return { ok: r.top >= v.top - 2 && r.top < v.bottom - 100, top: Math.round(r.top), scroll: Math.round(box.scrollTop), height: box.scrollHeight };
}, wanted);
let where = await arrived();
for (let i = 0; i < 40 && !where.ok; i++) {
  await page.waitForTimeout(100);
  where = await arrived();
}
const seenTop = where.ok;
check(seenTop, `le clic amène à « ${wanted} » ${JSON.stringify(where)}`);
check((await rail.locator('[aria-current="location"]').count()) === 1, "le repère courant est marqué");

// Plus haut, à la demande, sans perdre sa place.
const viewport = page.locator("[data-noah-viewport]");
await viewport.evaluate((v) => (v.scrollTop = 0));
await page.waitForTimeout(300);
const older = page.getByRole("button", { name: "Charger les messages précédents" });
check(await older.isVisible(), "le bouton est en haut du fil");
const firstNow = page.locator("[data-noah-msg]").first();
const firstText = (await firstNow.innerText()).slice(0, 40);
await older.click();
await page.waitForFunction(() => document.querySelectorAll("[data-noah-msg]").length === 120, null, { timeout: 8000 });
await page.waitForTimeout(300);
const stillThere = await page.evaluate((t) => {
  const v = document.querySelector("[data-noah-viewport]").getBoundingClientRect();
  const m = [...document.querySelectorAll("[data-noah-msg]")].find((x) => x.innerText.startsWith(t));
  const r = m.getBoundingClientRect();
  return r.top >= v.top - 40 && r.top < v.top + 300;
}, firstText);
check(stillThere, "la lecture reste au même endroit après le chargement");
check(/Hier|\d+ \w+/.test(await bodyText()), "les jours précédents ont leur séparateur");

// Page ancienne : en veille, décrite, rechargée sur demande.
const frozenCard = page.locator('[data-noah-msg]', { hasText: "Jeu ancien" }).first();
await frozenCard.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
check(!(await page.locator('iframe[title="Jeu ancien"]').count()), "la page ancienne ne tourne pas");
check((await frozenCard.innerText()).includes("En veille"), "elle se présente en veille, avec son titre");
await page.screenshot({ path: `${OUT}/3-page-en-veille.png` });
await frozenCard.getByRole("button", { name: "Recharger" }).click();
await page.locator('iframe[title="Jeu ancien"]').waitFor({ timeout: 8000 });
check(true, "« Recharger » la relance");
await frozenCard.getByRole("button", { name: "Mettre en veille" }).click();
await page.locator('iframe[title="Jeu ancien"]').waitFor({ state: "detached", timeout: 5000 });
check(true, "« Mettre en veille » la coupe");

// Une lecture lancée avant de remonter ne doit pas effacer ce qui a été remonté entre-temps.
await page.route(/\/messages\?depuis=/, async (route) => {
  await page.waitForTimeout(3000);
  await route.continue().catch(() => {});
});
await page.locator("[data-composer-input]").fill("Message pendant une lecture lente");
await page.keyboard.press("Enter");
await page.locator("[data-noah-msg]", { hasText: "Reçu." }).first().waitFor({ timeout: 8000 });
await page.waitForFunction(() => document.querySelectorAll("[data-noah-msg]").length === 122, null, { timeout: 8000 });
await page.waitForTimeout(300); // la lecture de fin de travail est partie, et attend
await viewport.evaluate((v) => (v.scrollTop = 0));
await older.click();
await page.waitForFunction(() => document.querySelectorAll("[data-noah-msg]").length === 152, null, { timeout: 8000 });
await page.waitForTimeout(3500);
check((await count()) === 152, `une lecture tardive n'efface pas ce qui vient d'être remonté (${await count()})`);
await page.unroute(/\/messages\?depuis=/);
await page.waitForTimeout(200);
check(!(await older.count()), "tout est chargé : le bouton s'en va");
await page.locator("[data-noah-msg]", { hasText: "Demande numéro 000" }).first().waitFor({ timeout: 3000 });
check(true, "le début de la conversation est là");

// Une lecture périodique ne remet pas la conversation à 60.
await page.waitForTimeout(6000);
check((await count()) === 152, "ce qu'on a remonté reste affiché");

// Le chat vivant : pas de récit dans la réponse, un statut près du nom, une réaction, une réponse d'un toucher.
await page.locator("[data-composer-input]").fill("BAVARD fais le travail");
await page.keyboard.press("Enter");
await page.getByText(/cuivre/).first().waitFor({ timeout: 8000 });
check((await page.locator("header, [role=banner]").first().innerText().catch(() => "")).includes("cuivre") || (await page.getByText("En ligne").count()) === 0, "pendant le travail, le statut remplace « En ligne »");
const choiceYes = page.getByRole("button", { name: "Oui, publie", exact: true });
await choiceYes.waitFor({ timeout: 10000 });
const reply = page.locator("[data-noah-msg]").last();
const replyText = await reply.innerText();
check(replyText.includes("C'est fait. On publie maintenant ?"), "la réponse finale est là");
check(!replyText.includes("Je regarde la page") && !replyText.includes("Je clique sur le bouton"), "le récit du travail n'est pas dans la réponse");
check(!replyText.includes("[["), "la marque de réaction ne s'affiche pas");
const asked = page.locator("[data-noah-msg]", { hasText: "BAVARD fais le travail" }).last();
await asked.getByRole("img", { name: "Réaction de l'agent : 👍" }).waitFor({ timeout: 3000 });
check(true, "l'agent réagit d'un emoji au message");
await reply.getByRole("button", { name: "2 étapes" }).click();
check((await reply.innerText()).includes("Je clique sur le bouton"), "les étapes restent lisibles, repliées");
await page.screenshot({ path: `${OUT}/8-chat-vivant.png` });
await reply.hover();
await reply.getByRole("button", { name: "Réagir", exact: true }).click({ timeout: 8000 });
await page.getByRole("button", { name: "Réagir 🔥" }).click();
await reply.getByRole("button", { name: "Retirer ta réaction 🔥" }).waitFor({ timeout: 3000 });
check(true, "je réagis à sa réponse");
await choiceYes.click();
await page.locator("[data-noah-msg]", { hasText: "Oui, publie" }).last().waitFor({ timeout: 5000 });
await page.waitForFunction(async (u) => (await (await fetch(u)).json()).started.some((x) => x.includes("Oui, publie")), `${BASE}/_essai/etat`, { timeout: 8000 });
const told = (await (await fetch(`${BASE}/_essai/etat`)).json()).started.at(-1);
check(told.includes("a réagi 🔥"), "un toucher envoie la réponse, et l'agent apprend ma réaction avec elle");
check(!(await choiceYes.isEnabled()), "la question ne se rejoue pas");

// Fichiers : vrais dossiers.
await page.getByRole("button", { name: /^Agent( Agent)?$/ }).click();
await page.getByRole("tab", { name: "Ordinateur" }).click();
await page.getByRole("tab", { name: "Fichiers" }).click();
const folder = (name) => page.getByRole("checkbox", { name: `Choisir le dossier ${name}` });
await folder("Livrables").waitFor({ timeout: 8000 });
check(await folder("Envoyés par toi").isVisible(), "les dossiers ont un nom clair");
check(await folder("rapports").isVisible(), "les sous-dossiers réels apparaissent");
check(!(await page.getByText("bilan.pdf").count()), "un sous-dossier reste replié");
await page.getByRole("button", { name: /rapports/ }).click();
await page.getByRole("button", { name: /mars/ }).click();
await page.getByText("bilan.pdf").waitFor({ timeout: 3000 });
check(true, "on déplie jusqu'au fichier");

// Tri et recherche.
const names = () => page.locator('input[type="checkbox"][aria-label^="Choisir "]:not([aria-label^="Choisir le dossier"])').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").replace("Choisir ", "")));
await page.getByRole("combobox", { name: "Trier" }).selectOption("nom");
const folders = () => page.locator('input[aria-label^="Choisir le dossier"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").replace("Choisir le dossier ", "")));
const namedOrder = (await folders()).join();
check(namedOrder.startsWith("Applications,Captures,Livrables"), `tri par nom : ${namedOrder}`);
await page.getByRole("combobox", { name: "Trier" }).selectOption("recent");
const recentOrder = (await folders()).join();
check(recentOrder.startsWith("Livrables"), `tri par date : le plus récent d'abord (${recentOrder})`);
await page.getByRole("combobox", { name: "Trier" }).selectOption("nom");
const search = page.getByRole("textbox", { name: "Chercher un fichier" });
await search.fill("notes");
check((await names()).join() === "notes.txt", "la recherche ne garde que ce qui correspond, dossiers ouverts");
await page.screenshot({ path: `${OUT}/4-recherche.png` });
await search.fill("");

// Sélection d'un dossier entier, donnée au chat par son chemin.
await folder("rapports").check();
check(await page.getByRole("checkbox", { name: "Choisir bilan.pdf" }).isChecked(), "choisir un dossier choisit son contenu");
await page.getByRole("checkbox", { name: "Choisir bilan.pdf" }).uncheck();
check(await folder("rapports").evaluate((e) => e.indeterminate), "un dossier en partie choisi le montre");
await page.getByRole("checkbox", { name: "Choisir bilan.pdf" }).check();
check(await page.getByText("3 choisis").isVisible(), "la barre de sélection compte les fichiers");
await page.screenshot({ path: `${OUT}/5-selection.png` });
await page.getByRole("button", { name: "Donner au chat" }).click();
check((await page.locator("[data-composer-input]").evaluate((e) => document.activeElement === e)), "le curseur passe dans la saisie");
await page.locator("[data-composer-input]").fill("Résume ce dossier");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
const state = await (await fetch(`${BASE}/_essai/etat`)).json();
check(state.started.some((t) => t.includes("/opt/data/workspace/outputs/rapports/") && !t.includes("bilan.pdf") && t.includes("Résume ce dossier")), "l'agent reçoit le dossier par son chemin, pas fichier par fichier");

// Suppression : confirmée, puis effective.
await folder("Captures").check();
await page.getByRole("button", { name: "Supprimer" }).click();
const dialog = page.getByRole("dialog");
await dialog.waitFor({ timeout: 3000 });
check((await dialog.innerText()).includes("captures/ecran.txt"), "la confirmation liste ce qui part");
await page.screenshot({ path: `${OUT}/6-confirmation.png` });
check((await (await fetch(`${BASE}/_essai/etat`)).json()).deleted.length === 0, "rien ne part avant la confirmation");
await dialog.getByRole("button", { name: "Supprimer" }).click();
await folder("Captures").waitFor({ state: "detached", timeout: 5000 });
check((await (await fetch(`${BASE}/_essai/etat`)).json()).deleted.join() === "captures/ecran.txt", "le fichier part, le dossier vide disparaît de la liste");

// Des fichiers donnés pour un autre agent n'arrivent pas dans ce fil.
await page.evaluate(() => window.dispatchEvent(new CustomEvent("noah:fichiers", { detail: { agentId: "autre", label: "chez-un-autre", text: "Fichiers d'un autre" } })));
await page.waitForTimeout(200);
check(!(await page.getByText("chez-un-autre").count()), "un don destiné à un autre agent n'entre pas ici");

// Passer à un autre agent : une réponse tardive du premier ne s'affiche pas sous le second, où « Supprimer » le viserait.
await page.route("**/api/agents/a1/files", async (route) => {
  await page.waitForTimeout(1500);
  await route.continue().catch(() => {});
});
await page.getByRole("button", { name: "Actualiser" }).click();
await page.getByRole("button", { name: /Bis/ }).first().click();
await page.getByRole("checkbox", { name: "Choisir de-bis.txt" }).waitFor({ timeout: 5000 });
await page.waitForTimeout(2200);
check(await page.getByRole("checkbox", { name: "Choisir de-bis.txt" }).isVisible() && !(await page.getByRole("checkbox", { name: "Choisir photo.txt" }).count()), "une réponse tardive du premier agent ne remplace pas les fichiers du second");
await page.unroute("**/api/agents/a1/files");
await page.getByRole("button", { name: /Noah/ }).first().click();
await page.getByRole("checkbox", { name: "Choisir photo.txt" }).waitFor({ timeout: 5000 });

// Une autre personne, sans droit sur l'agent, ne supprime rien.
const other = await fetch(`${BASE}/api/agents/a1/files/supprimer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chemins: ["uploads/photo.txt"] }) });
check(other.status === 401, `sans session : refus (${other.status})`);

// Le temps passe : la page sous les yeux reste, celle qui a quitté l'écran s'endort.
await fetch(`${BASE}/_essai/bientot-ancienne`, { method: "POST" });
await page.reload();
const soon = page.locator('iframe[title="Bientôt ancienne"]');
await soon.waitFor({ timeout: 15000 });
await soon.scrollIntoViewIfNeeded();
await page.waitForTimeout(29000);
check(await soon.count() === 1, "après 30 minutes, une page encore à l'écran n'est pas coupée");
await viewport.evaluate((v) => (v.scrollTop = 0));
await soon.waitFor({ state: "detached", timeout: 20000 });
check(true, "dès qu'elle quitte l'écran, elle s'endort sans nouveau message");

// Petit écran : pas de repères, le fil reste lisible.
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(400);
check(!(await rail.isVisible()), "téléphone : pas de repères");
check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "téléphone : pas de défilement de côté");
await page.screenshot({ path: `${OUT}/7-telephone.png` });

check(errors.length === 0, `aucune erreur de page ${errors.join(" | ")}`);
await browser.close();
console.log("OK");
