// Le parcours d'une vraie personne, par les vrais écrans et avec de vraies clés : ce que les tests à faux modèle ne voient pas.
//
//   NOAH_URL, NOAH_TOKEN      serveur et session du propriétaire
//   NOAH_PLAYWRIGHT           chemin de playwright
//   NOAH_DOSSIER              captures
//   NOAH_CLE_EXPIREE          une clé OpenRouter refusée (facultatif)
//   NOAH_CLE_ANTHROPIC        cerveau Anthropic (facultatif) ; change le fournisseur du serveur
//   NOAH_CLE_OPENROUTER       voix et création (facultatif) ; dictée, appel et image
//
// Sans clé, l'étape est écrite NON TESTÉ et le script n'est pas vert : une étape sautée ne compte pas comme réussie.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.NOAH_URL;
const TOKEN = process.env.NOAH_TOKEN;
const DIR = process.env.NOAH_DOSSIER || ".";
const EXPIRED = process.env.NOAH_CLE_EXPIREE;
const ANTHROPIC = process.env.NOAH_CLE_ANTHROPIC;
const OPENROUTER = process.env.NOAH_CLE_OPENROUTER;
mkdirSync(DIR, { recursive: true });

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, state: ok ? "OK" : "ÉCHEC" });
  console.log(`${ok ? "OK    " : "ÉCHEC "} ${name}${detail ? ` : ${detail}` : ""}`);
};
const skip = (name) => {
  results.push({ name, state: "NON TESTÉ" });
  console.log(`NON TESTÉ ${name}`);
};
const api = async (path, init = {}) =>
  fetch(BASE + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Origin: BASE, ...init.headers } });
const brain = async () => (await api("/api/model")).json();

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone"] });
await context.addCookies([{ name: "apollo_session", value: TOKEN, url: BASE }]);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const shot = (name) => page.screenshot({ path: `${DIR}/${name}.png` });
const sees = (text, timeout = 15000) => page.getByText(text).first().waitFor({ timeout }).then(() => true, () => false);

const openSettings = async (tab) => {
  await page.getByRole("button", { name: /Réglages/ }).first().click();
  await page.getByRole("tab", { name: tab }).click();
};
const closeSettings = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
};
const composer = () => page.getByPlaceholder(/Écris à ton agent/).first();
// Écrit à l'agent dans une nouvelle réponse et attend la fin du tour.
const ask = async (text, expected, timeout = 180_000) => {
  await composer().fill(text);
  await composer().press("Enter");
  return page.getByText(expected).last().waitFor({ timeout }).then(() => true, () => false);
};

try {
  await page.goto(BASE);
  await composer().waitFor({ timeout: 60000 });

  // 1. Une clé expirée ne passe nulle part, et ne casse pas le cerveau en service.
  if (EXPIRED) {
    const before = await brain();
    await openSettings("Voix");
    await page.getByLabel(/Clé OpenRouter pour la voix/).fill(EXPIRED);
    await page.getByRole("button", { name: "Vérifier et enregistrer" }).click();
    check("Réglages > Voix : la clé expirée est refusée", await sees(/invalide ou expirée/));
    await shot("cle-expiree-voix");

    await page.getByRole("tab", { name: "Cerveau" }).click();
    const change = page.getByRole("button", { name: "Changer" });
    if (await change.count()) await change.click();
    await page.getByRole("radio", { name: /OpenRouter/ }).click();
    await page.getByPlaceholder(/Colle ta clé|Clé enregistrée/).last().fill(EXPIRED);
    await page.getByRole("button", { name: "Afficher les modèles" }).click();
    check("Réglages > Cerveau : la clé expirée est refusée", await sees(/invalide ou expirée/));
    await shot("cle-expiree-cerveau");
    await closeSettings();
    const after = await brain();
    check("le cerveau en service n'a pas changé", after?.provider === before?.provider && after?.model === before?.model);
  } else skip("clé expirée refusée");

  // 2. Cerveau Anthropic : le chemin que seuls de vrais appels montrent (réponses compressées, outils).
  if (ANTHROPIC) {
    await openSettings("Cerveau");
    const change = page.getByRole("button", { name: "Changer" });
    if (await change.count()) await change.click();
    await page.getByRole("radio", { name: /Anthropic/ }).click();
    check("le fournisseur annonce ce qu'il ne fait pas", await sees(/La voix, les images et la vidéo passent par OpenRouter/));
    await page.getByPlaceholder(/Colle ta clé|Clé enregistrée/).last().fill(ANTHROPIC);
    await page.getByRole("button", { name: "Afficher les modèles" }).click();
    await page.getByRole("radio", { name: "Un modèle précis" }).click().catch(() => {});
    const model = page.locator('[role="dialog"] button, [role="dialog"] [role="radio"]').filter({ hasText: /Haiku/i }).first();
    await model.click({ timeout: 30000 });
    await shot("anthropic-modele");
    await page.getByRole("button", { name: /Enregistrer/ }).first().click();
    await page.waitForTimeout(4000);
    await closeSettings();
    check("Anthropic enregistré", (await brain())?.provider === "anthropic");

    const n = Date.now() % 100000;
    check("réponse en texte", await ask(`Réponds seulement : Vert ${n}`, `Vert ${n}`));
    await shot("anthropic-texte");
    const file = `essai-${n}.txt`;
    check(
      "travail avec un outil : crée un fichier",
      await ask(`Crée le fichier outputs/${file} contenant le mot ${n}, puis réponds exactement : Fichier ${n} fait`, `Fichier ${n} fait`),
    );
    await shot("anthropic-outil");
  } else skip("cerveau Anthropic : texte et outil");

  // 3. Sans clé de voix, le micro ne s'ouvre pas pour rien : il dit pourquoi.
  const ready = await (await api("/api/voice/ready")).json();
  if (ready.dictation) {
    await page.getByRole("button", { name: "Dicter un message" }).click();
    check("dictée : la vraie raison s'affiche", await sees(/passent par OpenRouter/));
    await shot("dictee-sans-cle");
    await page.getByRole("button", { name: "Mode vocal" }).click();
    check("appel : la vraie raison s'affiche", await sees(/passent par OpenRouter/));
    await shot("appel-sans-cle");
    await page.getByRole("button", { name: /Raccrocher|Terminer/ }).first().click().catch(() => {});
  } else skip("voix sans clé : cette installation a déjà une clé");

  // 4. Avec une clé OpenRouter valide : dictée, appel, image.
  if (OPENROUTER) {
    await openSettings("Voix");
    await page.getByLabel(/Clé OpenRouter pour la voix/).fill(OPENROUTER);
    await page.getByRole("button", { name: "Vérifier et enregistrer" }).click();
    check("la clé valide est acceptée", await sees(/Clé vérifiée et enregistrée/));
    await closeSettings();

    await page.getByRole("button", { name: "Dicter un message" }).click();
    await page.waitForTimeout(5000);
    await page.getByRole("button", { name: "Arrêter la dictée" }).click();
    await page.waitForTimeout(6000);
    const bad = await page.getByText(/refusé la clé|n'a pas pu être transcrit/).count();
    check("dictée sans erreur", bad === 0);
    await shot("dictee-avec-cle");
    await composer().fill("");

    const n = Date.now() % 100000;
    await composer().fill(`Génère une petite image d'un lion sur la lune, puis écris à la fin : Image ${n} prête`);
    await composer().press("Enter");
    check("image : l'agent termine", await page.getByText(`Image ${n} prête`).last().waitFor({ timeout: 240_000 }).then(() => true, () => false));
    check("image : elle s'affiche", await page.locator('main img, [role="main"] img').last().waitFor({ timeout: 20000 }).then(() => true, () => false));
    await shot("image");

    await page.getByRole("button", { name: "Mode vocal" }).click();
    check("appel : écoute", await sees(/Je t'écoute/, 20000));
    await shot("appel-avec-cle");
    await page.getByRole("button", { name: /Raccrocher|Terminer/ }).first().click().catch(() => {});
  } else skip("voix et image avec une clé OpenRouter valide");

  check("aucune erreur JavaScript", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
} catch (e) {
  await shot("erreur").catch(() => {});
  check("le parcours va au bout", false, e.message.split("\n")[0]);
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.state === "ÉCHEC").length;
const missing = results.filter((r) => r.state === "NON TESTÉ").length;
console.log(`\n${results.length - failed - missing} OK, ${failed} échec(s), ${missing} non testé(s)`);
process.exit(failed ? 1 : missing ? 2 : 0);
