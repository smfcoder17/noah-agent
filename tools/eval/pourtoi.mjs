// « Pour toi » : une question sans champ « question » dit la vraie question, et « Voir dans le fil » mène au bon message.
// De bout en bout, dans un vrai navigateur, sur le vrai serveur d'essai (tests/real/pourtoi_serveur.py).
//   node tools/eval/pourtoi.mjs      (après `npm run build` dans frontend ; Docker et Playwright requis)
//   NOAH_CAPTURES=<dossier> : y dépose les captures (ordinateur et 390 px) ; jamais dans le dépôt.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connecter, demarrer, navigateur } from "./essai.mjs";

const navigue = await navigateur();
if (!navigue) process.exit(0);
const dossier = process.env.NOAH_CAPTURES;
if (dossier) mkdirSync(dossier, { recursive: true });
const serveur = await demarrer("pourtoi_serveur.py");
let echecs = 0;
const verifie = (nom, ok, detail = "") => { console.log(`${ok ? "OK    " : "ÉCHEC "} ${nom}${detail ? ` : ${detail}` : ""}`); if (!ok) echecs++; };
const capture = async (page, nom) => { if (dossier) await page.screenshot({ path: join(dossier, `${nom}.png`) }); };
const etat = await (await fetch(`${serveur.base}/_essai/etat`)).json();

const QUESTION = "Tu veux que je te propose un créneau pour la vidéo de jeudi ?";
const ANCIENNE = "On l'envoie à toute l'équipe maintenant ?";

/** Ouvre « Pour toi », vérifie les titres des cartes, suit le lien de la carte de Noah et lit où le fil s'arrête. */
async function parcours(contexte, prefixe, toucher) {
  const page = await connecter(contexte, serveur.base);
  const clic = (loc) => (toucher ? loc.tap() : loc.click());
  if (toucher) await clic(page.getByRole("button", { name: "Menu", exact: true }).filter({ visible: true }).first());
  await clic(page.getByRole("button", { name: /^Pour toi/ }).filter({ visible: true }).first());
  await page.locator("[data-question]").first().waitFor({ timeout: 15000 });
  const titres = await page.locator("[data-question] h2").allInnerTexts();
  verifie(`${prefixe} : la carte de Noah dit la vraie question`, titres.includes(QUESTION), titres.join(" | "));
  verifie(`${prefixe} : la ligne enregistrée avec le titre générique est relue dans son message`, titres.includes(ANCIENNE), titres.join(" | "));
  verifie(`${prefixe} : le texte générique n'est plus montré`, !(await page.locator("body").innerText()).includes("Une question attend ta réponse."));
  verifie(`${prefixe} : chaque carte a son lien « Voir dans le fil »`, (await page.locator("[data-question] [data-voir-fil]").count()) === 2);
  verifie(`${prefixe} : répondre sur place reste possible`, (await page.locator("[data-question]").first().getByRole("button", { name: "Oui, parle-moi" }).count()) === 1);
  await capture(page, `${prefixe}-1-pour-toi`);

  await clic(page.locator("[data-question]", { hasText: QUESTION }).locator("[data-voir-fil]"));
  const cible = page.locator(`[data-noah-msg="h${etat.messages.noah}"]`);
  await cible.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(900);
  const place = await cible.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { haut: r.top, bas: r.bottom, ecran: window.innerHeight, anim: el.getAnimations().length, texte: el.innerText.slice(0, 80) };
  });
  verifie(`${prefixe} : le fil s'ouvre sur le message de la question`, place.haut >= 0 && place.bas <= place.ecran, JSON.stringify(place));
  verifie(`${prefixe} : le message est mis en évidence un instant`, place.anim > 0, `${place.anim} animation(s)`);
  verifie(`${prefixe} : c'est bien le bon message`, place.texte.includes("calendrier de juin"), place.texte);
  await capture(page, `${prefixe}-2-fil-au-message`);
  await page.waitForTimeout(2600);
  verifie(`${prefixe} : la mise en évidence s'efface`, (await cible.evaluate((el) => el.getAnimations().length)) === 0);
  return page;
}

try {
  await parcours(await navigue.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR", serviceWorkers: "block" }), "bureau", false);
  await parcours(await navigue.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "fr-FR", serviceWorkers: "block" }), "telephone", true);
} finally {
  await navigue.close();
  await serveur.arreter();
}
console.log(echecs ? `${echecs} vérification(s) en échec` : "pour toi : tout est vérifié");
process.exit(echecs ? 1 : 0);
