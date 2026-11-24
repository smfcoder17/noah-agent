// Vrai navigateur, vraie interface, vrais en-têtes : l'aperçu de chaque type de fichier (image, vidéo, Markdown, texte, page HTML), depuis le
// panneau Fichiers et depuis la conversation, sur ordinateur (1280 px) et sur téléphone (390 px). Serveur : apercus_serveur.py.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/apercus.mjs <dossier des captures> [étiquette]
// Sort avec un code non nul si un aperçu est cassé ; imprime le tableau type × lieu.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = process.env.NOAH_BASE || "http://127.0.0.1:8096";
const OUT = resolve(process.argv[2] || "captures");
const LABEL = process.argv[3] || "apercus";
mkdirSync(OUT, { recursive: true });

import { FILES, afficherTableau, juger, jugerOnglet, ouvrirDepuisLaConversation, ouvrirDepuisLePanneau } from "./apercus_commun.mjs";

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const lignes = [];
const problems = [];
/** Une page neuve, connectée : chaque aperçu part d'un navigateur propre, comme à la première ouverture. */
async function connecter(context) {
  const page = await context.newPage();
  page.on("response", (r) => { if (/files\/raw|apercu|\/media/.test(r.url()) && r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname.slice(0, 60)}`); });
  page.on("crash", () => problems.push("la page a planté"));
  await page.goto(BASE);
  if (!(await page.locator("[data-composer-input]").waitFor({ timeout: 6000 }).then(() => true, () => false))) {
    await page.locator("input:not([type=password])").first().fill("alice");
    await page.locator('input[type="password"]').first().fill("motdepasse-essai");
    await page.keyboard.press("Enter");
  }
  await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  return page;
}

for (const [lieu, width, height] of [["ordinateur", 1280, 900], ["téléphone 390 px", 390, 800]]) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "fr-FR", ...(width < 600 ? { hasTouch: true, isMobile: true } : {}) });
  const noter = async (page, kind, endroit, label) => {
    const r = await juger(kind, page);
    await page.screenshot({ path: resolve(OUT, `${LABEL}-${width}-${label}-${kind}.png`) }).catch(() => {});
    lignes.push({ kind, lieu: `${lieu} · ${endroit}`, ...r });
  };
  // 1. Le panneau Fichiers
  for (const [kind, path] of FILES.filter(([k]) => k !== "app")) {
    const page = await connecter(context);
    if (await ouvrirDepuisLePanneau(page, path)) await noter(page, kind, "panneau", "panneau");
    else lignes.push({ kind, lieu: `${lieu} · panneau`, ok: false, why: "pas de ligne dans la liste des fichiers" });
    await page.close();
  }
  // 2. La conversation : la carte du fichier s'ouvre dans le panneau (ou plein écran sur téléphone)
  for (const [kind, path] of FILES) {
    const page = await connecter(context);
    await ouvrirDepuisLaConversation(page, path);
    await noter(page, kind, "conversation", "fil");
    await page.close();
  }
  // 3. Le fichier seul dans un onglet (« Ouvrir dans un onglet », « Ouvrir avec ») et la lecture par morceaux que Safari et Android exigent d'une vidéo
  if (width >= 1000) {
    const page = await connecter(context);
    for (const [kind, path] of FILES.filter(([k]) => k !== "app")) {
      const onglet = await context.newPage();
      await onglet.goto(`${BASE}/api/agents/a1/files/raw/${path}`).catch(() => {});
      await onglet.waitForTimeout(1500);
      const r = await jugerOnglet(kind, onglet);
      await onglet.screenshot({ path: resolve(OUT, `${LABEL}-${width}-onglet-${kind}.png`) }).catch(() => {});
      lignes.push({ kind, lieu: `${lieu} · onglet`, ...r });
      await onglet.close();
    }
    const morceau = await context.request.get(`${BASE}/api/agents/a1/files/raw/outputs/video.mp4`, { headers: { Range: "bytes=0-99" } });
    const entete = morceau.headers();
    lignes.push({ kind: "video", lieu: `${lieu} · lecture par morceaux`, ok: morceau.status() === 206 && /^bytes 0-99\/\d+$/.test(entete["content-range"] || "") && (await morceau.body()).length === 100, why: `statut ${morceau.status()}, Content-Range ${entete["content-range"] ?? "absent"}, Accept-Ranges ${entete["accept-ranges"] ?? "absent"}` });
    await page.close();
  }
  await context.close();
}
await browser.close();
if (problems.length) console.log("réponses en erreur :", [...new Set(problems)].join(", "));
process.exit(afficherTableau(lignes) ? 1 : 0);
