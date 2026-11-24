// L'interface reste ouverte pendant une mise à jour du serveur : aucune rubrique ne reste cassée.
//   node tools/eval/mise-a-jour.mjs [dossier des captures] [navigateur|bureau]   (après `npm run build` dans frontend ; Docker et Playwright requis)
// Le serveur d'essai sert une copie de frontend/dist (version A). La page s'ouvre, puis la copie est remplacée par la version B : mêmes
// fichiers, empreintes toutes différentes, comme après une publication. Les morceaux de A n'existent plus. Alors :
//   1. une rubrique chargée à la demande (Réglages > Serveur > Sortie réseau) s'ouvre : la page se recharge seule et la rubrique s'affiche, sans « Try again » ;
//   2. témoin : avec le rechargement déjà consommé (garde-fou d'une minute), la rubrique tombe bien sur « Try again » (l'essai voit la panne) ;
//   3. « Réessayer » recharge alors la page, et la rubrique s'affiche ;
//   4. une page A restée ouverte voit, au retour sur la fenêtre, le bandeau « Noah a été mis à jour » ; « Recharger » charge B.
// Mode « bureau » : la vraie app Electron (desktop/), reliée au même serveur d'essai, au lieu de Chrome.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMPTE, connecter, demarrer, navigateur, racine } from "./essai.mjs";
import { playwright } from "./cliquet.mjs";

const SORTIE = resolve(process.argv[2] || "captures");
const MODE = process.argv[3] === "bureau" ? "bureau" : "navigateur";
mkdirSync(SORTIE, { recursive: true });
const dist = join(racine, "frontend", "dist");
if (!existsSync(join(dist, "index.html"))) { console.error("ÉCHEC  frontend/dist absent : lancer d'abord `npm run build` dans frontend."); process.exit(1); }

/** Version B : la même interface, chaque fichier à empreinte renommé et ses mentions réécrites partout. */
function versionB(de, vers) {
  cpSync(de, vers, { recursive: true });
  const assets = join(vers, "assets");
  const renommes = new Map();
  for (const nom of readdirSync(assets)) {
    const m = /^(.+)-([A-Za-z0-9_-]{8})(\.\w+)$/.exec(nom);
    if (!m) continue;
    const neuf = createHash("sha1").update(`${m[2]}-b`).digest("base64url").slice(0, 8);
    renommes.set(nom, `${m[1]}-${neuf}${m[3]}`);
  }
  const textes = (dossier) => readdirSync(dossier, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? textes(join(dossier, e.name)) : /\.(js|css|html|json|svg|webmanifest)$/.test(e.name) ? [join(dossier, e.name)] : []));
  for (const fichier of textes(vers)) {
    let contenu = readFileSync(fichier, "utf8");
    for (const [ancien, neuf] of renommes) contenu = contenu.split(ancien).join(neuf);
    writeFileSync(fichier, contenu);
  }
  for (const [ancien, neuf] of renommes) renameSync(join(assets, ancien), join(assets, neuf));
  return renommes.size;
}
/** Remplace le contenu du dossier servi (le dossier lui-même reste : c'est lui que Docker a monté). */
function remplacer(servi, par) {
  for (const nom of readdirSync(servi)) rmSync(join(servi, nom), { recursive: true, force: true });
  cpSync(par, servi, { recursive: true });
}

/** Remplace le dossier servi, puis attend que le serveur (dans Docker) serve bien la nouvelle page d'accueil. */
async function servir(par) {
  remplacer(servi, par);
  const voulue = /src="([^"]*\/assets\/[^"]+\.js)"/.exec(readFileSync(join(par, "index.html"), "utf8"))?.[1];
  for (let i = 0; i < 60; i++) {
    const html = await fetch(`${serveur.base}/`).then((r) => r.text()).catch(() => "");
    if (html.includes(voulue)) return;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  throw new Error("le serveur d'essai ne sert pas la nouvelle interface");
}

const racines = mkdtempSync(join(tmpdir(), "noah-mise-a-jour-"));
const servi = join(racines, "servi"), b = join(racines, "b");
cpSync(dist, servi, { recursive: true });
const n = versionB(dist, b);
console.log(`version B : ${n} fichiers à empreinte renommés`);

const resultats = [];
const verifie = (ok, ce) => { resultats.push(ok); console.log(`${ok ? "VERT  " : "ROUGE "} ${ce}`); };
let serveur;
serveur = await demarrer("fil_long_serveur.py", { web: servi });
let fermer = async () => {};
try {
  let contexte, ouvrir, ouvrirSansSW, navigateurOuvert, electron;
  if (MODE === "navigateur") {
    navigateurOuvert = await navigateur();
    if (!navigateurOuvert) process.exit(0);
    contexte = await navigateurOuvert.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR" });
    let premiere = true;
    ouvrir = async () => {
      if (premiere) { premiere = false; return connecter(contexte, serveur.base); }
      const page = await contexte.newPage(); // la session est déjà ouverte dans ce contexte
      await page.goto(serveur.base);
      await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
      return page;
    };
    // Témoin (2, 3) : sans service worker, qui peut avoir gardé des morceaux de l'ancienne interface et masquer la panne.
    let sansSW = null;
    ouvrirSansSW = async () => {
      if (!sansSW) { sansSW = await navigateurOuvert.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR", serviceWorkers: "block" }); return connecter(sansSW, serveur.base); }
      const page = await sansSW.newPage();
      await page.goto(serveur.base);
      await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
      return page;
    };
    fermer = async () => { await navigateurOuvert.close(); };
  } else {
    const require = createRequire(import.meta.url);
    const { chromium } = await playwright();
    const profil = mkdtempSync(join(tmpdir(), "noah-mise-a-jour-bureau-"));
    writeFileSync(join(profil, "config.json"), JSON.stringify({ mode: "remote", server: serveur.base }));
    const PORT = 9334;
    electron = spawn(require(join(racine, "desktop", "node_modules", "electron")), [join(racine, "desktop"), `--user-data-dir=${profil}`, `--remote-debugging-port=${PORT}`, "--lang=fr-FR"], { env: { ...process.env, NOAH_PROFIL: "" }, stdio: "ignore" });
    let cdp;
    for (let i = 0; i < 60 && !cdp; i++) { cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null); if (!cdp) await new Promise((ok) => setTimeout(ok, 1000)); }
    if (!cdp) throw new Error("l'app de bureau ne répond pas");
    contexte = cdp.contexts()[0];
    const r = await fetch(`${serveur.base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: COMPTE.nom, password: COMPTE.motDePasse }) });
    const valeur = /noah_session=([^;]+)/.exec(r.headers.get("set-cookie") || "")?.[1];
    if (!valeur) throw new Error(`connexion d'essai refusée (${r.status})`);
    await contexte.addCookies([{ name: "noah_session", value: valeur, url: serveur.base, httpOnly: true, sameSite: "Lax" }]);
    ouvrir = async () => {
      const fin = Date.now() + 60000;
      let page;
      while (!(page = contexte.pages().find((p) => p.url().startsWith(serveur.base)))) {
        if (Date.now() > fin) throw new Error("aucune fenêtre sur le serveur d'essai");
        await new Promise((ok) => setTimeout(ok, 500));
      }
      await page.goto(serveur.base);
      await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
      return page;
    };
    ouvrirSansSW = ouvrir;
    fermer = async () => { await cdp.close().catch(() => {}); electron.kill(); };
  }

  const entree = (page) => page.evaluate(() => document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute("src"));
  // Réglages (chargé à la demande), puis une rubrique qui charge son propre morceau (Fournisseurs : Providers-*.js).
  const ouvrirReglages = async (page) => {
    await page.getByRole("button", { name: "Réglages", exact: true }).filter({ visible: true }).first().click();
    await page.locator('main[aria-label="Réglages"]').waitFor({ timeout: 30000 });
    await page.locator("button.set-link", { hasText: /^\s*(Serveur|Server)/ }).first().click(); // la rubrique Serveur : ses onglets, dont Sortie réseau
    await page.getByRole("tab", { name: /Sortie réseau|Network egress|Outbound/i }).waitFor({ timeout: 15000 });
  };
  const ouvrirSortie = (page) => page.getByRole("tab", { name: /Sortie réseau|Network egress|Outbound/i }).click();
  const erreurRubrique = (page) => page.getByText(/couldn't be displayed|n'a pas pu s'afficher/i).first();
  const sortieAffichee = (page) => page.getByRole("tabpanel").getByText(/sortent|Installe l'app Noah|Lecture…/i).first();
  // 1. Page A ouverte, puis le serveur passe à B ; Réglages s'ouvre : rechargement seul.
  let page = await ouvrir();
  const entreeA = await entree(page);
  await page.screenshot({ path: join(SORTIE, `${MODE}-1-avant-mise-a-jour.png`) });
  await ouvrirReglages(page);
  await servir(b);
  let rechargements = 0;
  page.on("load", () => { rechargements++; });
  await ouvrirSortie(page);
  await sortieAffichee(page).waitFor({ timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const entreeB = await entree(page);
  verifie(await sortieAffichee(page).isVisible(), "1. la rubrique Sortie réseau s'affiche après la mise à jour du serveur");
  verifie(!(await erreurRubrique(page).isVisible().catch(() => false)), "1. aucun « Try again » / « n'a pas pu s'afficher »");
  verifie(rechargements === 1 && entreeB !== entreeA, `1. la page s'est rechargée une fois, seule (${entreeA} -> ${entreeB})`);
  await page.screenshot({ path: join(SORTIE, `${MODE}-2-reglages-apres-rechargement-auto.png`) });

  // 2. Témoin : retour à A côté serveur, page A rouverte, puis B ; le rechargement déjà consommé, la panne se voit.
  await servir(dist);
  page = await ouvrirSansSW();
  await ouvrirReglages(page);
  await page.evaluate(() => sessionStorage.setItem("noah:rechargement", String(Date.now())));
  await servir(b);
  await ouvrirSortie(page);
  await erreurRubrique(page).waitFor({ timeout: 30000 }).catch(() => {});
  verifie(await erreurRubrique(page).isVisible().catch(() => false), "2. témoin : sans rechargement possible, la rubrique tombe sur l'erreur (la panne est bien reproduite)");
  await page.screenshot({ path: join(SORTIE, `${MODE}-3-temoin-erreur.png`) });

  // 3. « Réessayer » recharge la page au lieu de remonter le composant.
  await page.getByRole("button", { name: /réessayer|try again/i }).first().click();
  await page.waitForLoadState("load");
  await page.waitForTimeout(1500);
  verifie(await sortieAffichee(page).isVisible() && !(await erreurRubrique(page).isVisible().catch(() => false)), "3. « Réessayer » recharge la page : la rubrique s'affiche");

  // 4. Bandeau : page A ouverte, serveur passé à B, retour sur la fenêtre.
  await servir(dist);
  page = await ouvrir();
  await servir(b);
  await page.evaluate(() => sessionStorage.setItem("noah:rechargement", String(Date.now()))); // pas de rechargement seul : le bandeau est la seule voie
  await page.waitForTimeout(11000); // la page a déjà vérifié à son ouverture : la vérification suivante attend 10 s
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  const bandeau = page.locator("[data-interface-mise-a-jour]");
  await bandeau.waitFor({ timeout: 30000 }).catch(() => {});
  verifie(await bandeau.isVisible(), "4. le bandeau « Noah a été mis à jour » apparaît au retour sur la fenêtre");
  await page.screenshot({ path: join(SORTIE, `${MODE}-4-bandeau.png`) });
  await bandeau.getByRole("button").click();
  await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
  verifie((await entree(page)) === entreeB, "4. « Recharger » charge la nouvelle interface");
} finally {
  await fermer();
  await serveur.arreter();
  rmSync(racines, { recursive: true, force: true });
}
console.log(resultats.every(Boolean) ? "VERT   mise à jour du serveur pendant que l'interface est ouverte" : "ROUGE  mise à jour du serveur pendant que l'interface est ouverte");
process.exit(resultats.every(Boolean) ? 0 : 1);
