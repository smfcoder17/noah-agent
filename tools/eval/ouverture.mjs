// Budget B1 (socle.md, section 6) : les requêtes /api/ à l'ouverture d'un agent, dans un vrai navigateur, sur le vrai serveur d'essai.
//   node tools/eval/ouverture.mjs      (après `npm run build` dans frontend ; Docker et Playwright requis)
// Mesure 1 : le premier chargement de la page, connecté, jusqu'à 2 s de calme. Mesure 2 : le clic sur un autre agent, jusqu'à 2 s de calme.
// On compte les requêtes /api/ hors flux /api/events, et les doubles (même méthode, même chemin, même requête).
// Pas de fausses routes : le serveur envoie `pret` sur /api/events comme en production, donc la relance générale a bien lieu.
import { jugerTout } from "./cliquet.mjs";
import { connecter, demarrer, navigateur } from "./essai.mjs";

const CALME = 2000;
const navigue = await navigateur();
if (!navigue) process.exit(0);
const serveur = await demarrer();
let ok = false;
try {
  const contexte = await navigue.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR", serviceWorkers: "block" });
  const page = await connecter(contexte, serveur.base);
  const appels = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && u.pathname !== "/api/events") appels.push({ at: Date.now(), cle: `${r.method()} ${u.pathname}${u.search}` });
  });
  const compter = (depuis) => {
    const lot = appels.slice(depuis), vus = new Set();
    let doubles = 0;
    for (const a of lot) { if (vus.has(a.cle)) doubles++; vus.add(a.cle); }
    return { requetes: lot.length, doubles, liste: lot.map((a) => a.cle) };
  };
  const calme = async () => {
    for (let derniere = -1, debut = Date.now(); Date.now() - debut < 30000;) {
      if (appels.length === derniere) return;
      derniere = appels.length;
      await page.waitForTimeout(CALME);
    }
  };

  // Premier chargement : la session est déjà ouverte, la page repart de zéro.
  // Le compte varie d'un passage à l'autre (34 à 41 relevés le même jour, selon l'instant où le flux d'événements relance tout) :
  // trois chargements, le plus sobre compte. Une vraie régression alourdit les trois.
  let chargement = null;
  for (let passage = 0; passage < 3; passage++) {
    const avantChargement = appels.length;
    await page.goto(serveur.base, { waitUntil: "domcontentloaded" });
    await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
    await calme();
    const mesure = compter(avantChargement);
    console.log(`chargement ${passage + 1} : ${mesure.requetes} requêtes, ${mesure.doubles} doubles`);
    if (!chargement || mesure.requetes < chargement.requetes) chargement = mesure;
  }

  // Changement d'agent : l'autre agent de la barre de gauche.
  const avantChangement = appels.length;
  await page.locator("button.agent-nav-row", { hasText: "Bis" }).first().click();
  await page.locator("[data-composer-input]").waitFor();
  await calme();
  const changement = compter(avantChangement);

  console.log(`chargement : ${chargement.liste.join(" | ")}`);
  console.log(`changement : ${changement.liste.join(" | ")}`);
  ok = jugerTout([
    ["B1.changement.requetes", changement.requetes],
    ["B1.changement.doubles", changement.doubles],
    ["B1.chargement.requetes", chargement.requetes],
    ["B1.chargement.doubles", chargement.doubles],
  ]);
} finally {
  await navigue.close();
  await serveur.arreter();
}
process.exit(ok ? 0 : 1);
