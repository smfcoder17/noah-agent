// Budget B3 (socle.md, section 6) : aucun écran ne déborde en largeur, de 320 à 1920 px (X25).
//   node tools/eval/debordement.mjs      (après `npm run build` dans frontend ; Docker et Playwright requis)
// Pour chaque écran de la liste et chaque largeur (320, 390, 768, 1280, 1920) : la page ne défile pas en largeur
// (scrollWidth <= innerWidth), et aucun élément visible ne dépasse le bord droit de la fenêtre. Un élément coupé par un parent qui
// masque ou fait défiler (overflow-x) ne dépasse pas : on ne voit que sa partie dans le parent. Exemptés : `pre`, `table`, et tout
// élément marqué `data-defile-x`, avec ce qu'ils contiennent. Un élément entièrement hors de la fenêtre (volet fermé) n'est pas visible.
// Le jsdom ne calcule aucune mise en page : il faut un vrai navigateur. Écrans servis par le serveur d'essai (essai.mjs), long fil compris.
// Le budget compte les écrans qui débordent à au moins une largeur. Un écran non atteint est dit, jamais compté vert.
import { jugerTout } from "./cliquet.mjs";
import { connecter, demarrer, navigateur } from "./essai.mjs";

const LARGEURS = [320, 390, 768, 1280, 1920];
const HAUTEUR = (largeur) => (largeur < 768 ? 844 : 800);

/** Dans la page : ce qui déborde. `largeur` est celle demandée au navigateur, pas `innerWidth` : sur un téléphone émulé, un contenu trop large
 *  élargit la fenêtre de mise en page, et la mesure se fausserait de ce qu'elle doit trouver. */
function debordements(largeur) {
  const sorties = [];
  if (document.documentElement.scrollWidth > largeur) sorties.push(`page : scrollWidth ${document.documentElement.scrollWidth} > ${largeur}`);
  const exempte = (el) => el.closest("pre, table, [data-defile-x]");
  const decrit = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}`;
  for (const el of document.body.querySelectorAll("*")) {
    if (exempte(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed" && style.pointerEvents === "none") continue;
    let { left, right, width, height } = el.getBoundingClientRect();
    if (!width || !height) continue;
    // Ce que les parents laissent voir.
    for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const p = getComputedStyle(parent);
      if (p.overflowX !== "visible") { const box = parent.getBoundingClientRect(); left = Math.max(left, box.left); right = Math.min(right, box.right); }
    }
    if (right <= left || left >= largeur || right <= 0) continue;
    if (right > largeur + 1) sorties.push(`${decrit(el)} : bord droit à ${Math.round(right)} px, fenêtre ${largeur}`);
  }
  return sorties.slice(0, 8);
}

const navigue = await navigateur();
if (!navigue) process.exit(0);
const serveur = await demarrer();
let ok = false;
try {
  const resultat = [];
  // Du contenu qui pousse : un message de la personne avec une adresse et un mot sans espace, longs. Il reste dans le fil de tout l'essai.
  {
    const contexte = await navigue.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR", serviceWorkers: "block" });
    const page = await connecter(contexte, serveur.base);
    await page.locator("[data-composer-input]").fill(`Voici le lien https://exemple.org/${"a".repeat(300)} et un mot interminable ${"b".repeat(200)}`);
    await page.keyboard.press("Enter");
    await page.locator("[data-noah-msg]", { hasText: "mot interminable" }).first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    await contexte.close();
  }
  for (const largeur of LARGEURS) {
    const telephone = largeur < 768;
    const contexte = await navigue.newContext({
      viewport: { width: largeur, height: HAUTEUR(largeur) }, locale: "fr-FR", serviceWorkers: "block",
      ...(telephone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    const page = await connecter(contexte, serveur.base);
    const stable = async () => { await page.waitForFunction(() => !/Chargement/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {}); await page.waitForTimeout(500); };
    // Un bouton ou une entrée de menu, par son nom exact.
    const toucher = async (nom) => {
      const cible = page.getByRole("button", { name: nom, exact: true }).or(page.getByRole("menuitem", { name: nom, exact: true })).filter({ visible: true }).first();
      await cible.click({ timeout: 5000 });
      await stable();
    };
    const menu = async () => { if (telephone) await toucher("Menu"); };
    // Les contenus de l'agent (L9a) : le panneau de droite, ouvert par son bouton, puis son onglet.
    // Trois onglets tiennent sur une ligne ; les autres (Ordinateur, Session…) sont dans « Plus » (0.4.2).
    const panneau = async (onglet) => {
      await toucher("Ouvrir ou fermer le panneau");
      const direct = page.getByRole("tab", { name: onglet, exact: true }).filter({ visible: true }).first();
      if (await direct.count()) await direct.click({ timeout: 5000 });
      else { await page.locator("[data-plus]").filter({ visible: true }).first().click({ timeout: 5000 }); await toucher(onglet); }
      await stable();
    };
    // Le nom exact de la rubrique : sa ligne d'aide (masquée sur ordinateur) peut citer une autre rubrique (« … sur ce serveur »).
    const reglages = (section) => async () => { await menu(); await toucher("Réglages"); await page.locator(".set-link").filter({ visible: true }).getByText(section, { exact: true }).first().click({ timeout: 5000 }); await stable(); };
    // Activité en page entière (L9b) : un bouton de la barre de gauche (ou du tiroir), comme « Pour toi ».
    const activitePage = async () => { await menu(); await page.getByRole("button", { name: /^Activité/ }).filter({ visible: true }).first().click({ timeout: 5000 }); await stable(); };
    const pageAgent = async () => { if (telephone) await toucher("Page de l'agent"); else { await toucher("Menu de Noah"); await toucher("Page de Noah"); } };
    // [nom, aller, texte qui prouve qu'on y est]
    const ECRANS = [
      ["fil", async () => {}, /Écris à ton agent|Demande numéro/],
      ["routines", async () => panneau("Routines"), /Routines/i],
      ["travail", async () => panneau("Travail"), /Ce qu'il a fait|Tâches/i],
      ["activite", activitePage, /Activité/],
      ["fichiers", async () => panneau("Fichiers"), /Livrables/],
      ["ordinateur", async () => panneau("Ordinateur"), /Écran/],
      ["objectifs", async () => { if (telephone) await menu(); else await page.locator(".rail-account").click(); await toucher("Objectifs"); }, /Ce que tu veux atteindre/],
      ["nouvel-agent", async () => { await menu(); await toucher(/Nouvel agent/); }, /Nouvel agent/],
      ...["Apparence", "Compte", "Coffre", "Appareils", "Notifications", "Équipe", "Modèles et budget", "Personnes", "Serveur"].map((s) => [`reglages-${s.split(" ")[0].toLowerCase()}`, reglages(s), new RegExp(s === "Serveur" ? "Mises à jour" : s)]),
      ["agent", pageAgent, /Quand tu ne lui parles pas/],
      ...["Cerveau", "Autonomie", "Connexions", "Compétences", "Mémoire"].map((s) => [`agent-${s.toLowerCase()}`, async () => { await pageAgent(); await toucher(s); }, new RegExp(s)]),
      ...(telephone ? [["menu", menu, /Nouvel agent/]] : [["session", async () => panneau("Session"), /Derniers fichiers/i]]),
    ];
    for (const [nom, aller, preuve] of ECRANS) {
      try {
        await page.goto(serveur.base);
        await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
        await stable();
        await aller();
        if (!preuve.test(await page.evaluate(() => document.body.innerText))) throw new Error(`l'écran attendu n'est pas affiché (${preuve})`);
        const trouves = await page.evaluate(debordements, largeur);
        resultat.push({ ecran: nom, largeur, trouves });
      } catch (e) {
        resultat.push({ ecran: nom, largeur, non_atteint: String(e.message).split("\n")[0] });
      }
    }
    await contexte.close();
  }
  for (const r of resultat) {
    const etat = r.non_atteint ? `NON ATTEINT : ${r.non_atteint}` : r.trouves.length ? `DÉBORDE : ${r.trouves.join(" ; ")}` : "ok";
    console.log(`       ${r.ecran.padEnd(11)} ${String(r.largeur).padStart(4)} px  ${etat}`);
  }
  const debordent = new Set(resultat.filter((r) => r.trouves?.length).map((r) => r.ecran));
  const non = resultat.filter((r) => r.non_atteint).length;
  console.log(`${resultat.length - non}/${resultat.length} écrans-largeurs atteints ; écrans qui débordent : ${[...debordent].join(", ") || "aucun"}`);
  ok = jugerTout([["B3.ecrans_qui_debordent", debordent.size]]);
} finally {
  await navigue.close();
  await serveur.arreter();
}
process.exit(ok ? 0 : 1);
