// Citer avec @ et / : de bout en bout, dans un vrai navigateur, sur le vrai serveur d'essai et un faux moteur (tests/real/citer_serveur.py).
//   node tools/eval/citer.mjs      (après `npm run build` dans frontend ; Docker et Playwright requis)
//   NOAH_CAPTURES=<dossier> : y dépose les captures (ordinateur et 390 px) ; jamais dans le dépôt.
// On tape @ et /, on choisit au clavier, on envoie, puis on lit ce que le moteur a reçu (/_essai/etat) et ce que le fil affiche.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connecter, demarrer, navigateur } from "./essai.mjs";

const navigue = await navigateur();
if (!navigue) process.exit(0);
const dossier = process.env.NOAH_CAPTURES;
if (dossier) mkdirSync(dossier, { recursive: true });
const serveur = await demarrer("citer_serveur.py");
let echecs = 0;
const verifie = (nom, ok, detail = "") => { console.log(`${ok ? "OK    " : "ÉCHEC "} ${nom}${detail ? ` : ${detail}` : ""}`); if (!ok) echecs++; };
const capture = async (page, nom) => { if (dossier) await page.screenshot({ path: join(dossier, `${nom}.png`) }); };

/** Le temps entre la frappe d'un déclencheur et la liste visible, mesuré dans la page. */
async function ouvrir(page, touche) {
  await page.evaluate(() => {
    window.__t0 = performance.now(); window.__ouvert = null;
    new MutationObserver((_, o) => { if (document.querySelector("[data-mention-option]")) { window.__ouvert = performance.now() - window.__t0; o.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.type(touche);
  await page.locator("[data-mention-option]").first().waitFor({ timeout: 10000 });
  return page.evaluate(() => window.__ouvert);
}
const options = (page) => page.locator("[data-mention-option]").allInnerTexts();
const envoye = async () => (await (await fetch(`${serveur.base}/_essai/etat`)).json()).started;

try {
  const contexte = await navigue.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR", serviceWorkers: "block" });
  const page = await connecter(contexte, serveur.base);
  const saisie = page.locator("[data-composer-input]");
  await saisie.click();
  await saisie.pressSequentially("Résume ");

  // @ : le premier passage charge le morceau et lit les listes (à froid), les suivants viennent du cache (à chaud).
  const froid = await ouvrir(page, "@pl");
  const liste = await options(page);
  verifie("@ : le fichier récent est proposé", liste.some((o) => o.includes("plan-de-lancement.md")), liste.join(" | "));
  verifie("liste : role=listbox, annonce du nombre de résultats", (await page.locator('[role="listbox"]').count()) === 1 && /résultat/.test(await page.locator('[role="status"]').first().innerText()));
  verifie("liste : aria-activedescendant posé sur la saisie", !!(await saisie.getAttribute("aria-activedescendant")));
  await capture(page, "bureau-1-liste-arobase");
  await page.keyboard.press("Enter");
  verifie("choix : la liste se ferme et la pastille est dans la saisie", (await page.locator("[data-mention-option]").count()) === 0 && (await saisie.inputValue()).includes("@plan-de-lancement.md"));
  verifie("choix : le message n'est pas parti", (await envoye()).length === 0);

  await saisie.pressSequentially(" et demande à ");
  await ouvrir(page, "@Mar");
  const agents = await options(page);
  verifie("@ : l'agent est proposé", agents.some((o) => o.includes("Marie")), agents.join(" | "));
  await page.keyboard.press("Tab");
  await saisie.pressSequentially(" avec ");

  // / : les compétences de l'agent, la désactivée en dernier et dite telle.
  const chaud = await ouvrir(page, "/");
  const competences = await options(page);
  verifie("/ : les compétences de l'agent", competences.some((o) => o.includes("Compte rendu")) && competences.some((o) => o.includes("Tableau de bord")), competences.join(" | "));
  verifie("/ : la désactivée est en dernier et dite désactivée", /Vieille méthode/.test(competences.at(-1) ?? "") && /désactivée/.test(competences.at(-1) ?? ""), competences.at(-1));
  await capture(page, "bureau-2-liste-barre");
  await page.keyboard.type("compte");
  await page.keyboard.press("Enter");
  verifie("/ : la compétence devient une pastille", (await saisie.inputValue()).includes("/Compte rendu"));
  await saisie.pressSequentially(" Merci.");
  await capture(page, "bureau-3-pastilles-dans-la-saisie");
  console.log(`ouverture de la liste : ${froid.toFixed(0)} ms à froid (morceau et listes chargés), ${chaud.toFixed(0)} ms à chaud (cache)`);
  verifie("ouverture à chaud sous 100 ms", chaud < 100, `${chaud.toFixed(0)} ms`);

  // Envoi : ce que reçoit le moteur.
  await page.keyboard.press("Enter");
  await page.locator("[data-mention-pill]").first().waitFor({ timeout: 15000 });
  const recu = (await envoye()).at(-1) ?? "";
  verifie("le moteur reçoit le chemin exact du fichier", recu.includes("/opt/data/workspace/outputs/plan-de-lancement.md"));
  verifie("le moteur reçoit l'agent cité et la voie des demandes entre agents", recu.includes("(id a2)") && recu.includes("noah.py demander a2"));
  verifie("le moteur reçoit l'ordre de charger la compétence avec skill_view", recu.includes('skill_view (name="compte-rendu")'));
  verifie("le message garde ses liens, le contexte les précède", recu.includes("](noah:fichier/outputs/plan-de-lancement.md)") && recu.indexOf("Résume") > recu.indexOf("Compétence"));
  const pastilles = await page.locator("[data-mention-pill]").evaluateAll((l) => l.map((e) => `${e.dataset.mentionPill}:${e.textContent}`));
  verifie("le fil réaffiche les pastilles", pastilles.join(" ") === "fichier:plan-de-lancement.md agent:Marie competence:Compte rendu", pastilles.join(" "));
  verifie("la saisie est vidée", (await saisie.inputValue()) === "");
  await capture(page, "bureau-4-message-envoye");

  // Pas de déclenchement sur une adresse ou un chemin.
  await saisie.click();
  await saisie.pressSequentially("ecris à a@b.fr puis ouvre /home/x");
  await page.waitForTimeout(400);
  verifie("a@b.fr et /home ne déclenchent rien", (await page.locator("[data-mention-option]").count()) === 0);
  await saisie.fill("");

  // Téléphone : 390 px, toucher.
  const mobile = await navigue.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "fr-FR", serviceWorkers: "block" });
  const tel = await connecter(mobile, serveur.base);
  const champ = tel.locator("[data-composer-input]");
  await champ.tap();
  await champ.pressSequentially("Lis ");
  await ouvrir(tel, "@plan");
  const boite = await tel.locator("[data-mention-pop]").boundingBox();
  verifie("390 px : la liste tient dans l'écran", !!boite && boite.x >= 0 && boite.x + boite.width <= 390, JSON.stringify(boite));
  await capture(tel, "telephone-1-liste-arobase");
  await tel.locator("[data-mention-option]").first().tap();
  verifie("390 px : un toucher choisit", (await champ.inputValue()).includes("@plan-de-lancement.md"));
  await champ.pressSequentially(" avec ");
  await ouvrir(tel, "/");
  await capture(tel, "telephone-2-liste-barre");
  await tel.locator("[data-mention-option]").first().tap();
  await tel.keyboard.press("Enter");
  await tel.locator("[data-mention-pill]").first().waitFor({ timeout: 15000 });
  await capture(tel, "telephone-3-message-envoye");
} finally {
  await navigue.close();
  await serveur.arreter();
}
console.log(echecs ? `${echecs} vérification(s) en échec` : "citer avec @ et / : tout est vérifié");
process.exit(echecs ? 1 : 0);
