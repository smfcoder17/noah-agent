// Noms exacts des modèles de Claude Code : le vrai serveur (tests/real/noms_exacts_serveur.py) et la vraie interface construite.
//   node tools/eval/noms-exacts.mjs [dossier des captures]    (après `npm run build` dans frontend ; Docker et Playwright requis)
// haiku : un tour l'a fait connaître (claude-haiku-5-5) ; sonnet : la dernière mesure d'utilisation (claude-sonnet-5-5) ; opus : inconnu, l'alias seul.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { connecter, demarrer, navigateur } from "./essai.mjs";

const SORTIE = resolve(process.argv[2] || "captures");
mkdirSync(SORTIE, { recursive: true });
const navigue = await navigateur();
if (!navigue) process.exit(0);
const serveur = await demarrer("noms_exacts_serveur.py");
const resultats = [];
const verifie = (ok, ce) => { resultats.push(ok); console.log(`${ok ? "VERT  " : "ROUGE "} ${ce}`); };
try {
  const contexte = await navigue.newContext({ viewport: { width: 1280, height: 800 }, locale: "fr-FR", serviceWorkers: "block" });
  const page = await connecter(contexte, serveur.base);

  // 1. L'étiquette sous la saisie.
  const etiquette = page.locator("[data-composer-model], button:has-text('Haiku')").first();
  await etiquette.waitFor({ timeout: 15000 });
  const texte = (await etiquette.innerText()).trim();
  verifie(/Haiku · claude-haiku-5-5/.test(texte), `1. l'étiquette sous la saisie dit « ${texte} »`);
  await page.screenshot({ path: join(SORTIE, "1-etiquette-sous-la-saisie.png") });

  // 2. Réglages > Modèles et budget.
  await page.getByRole("button", { name: "Réglages", exact: true }).filter({ visible: true }).first().click();
  await page.locator("button.set-link", { hasText: /Modèles et budget/ }).first().click();
  const reglages = page.locator('main[aria-label="Réglages"]');
  await reglages.getByText(/claude-haiku-5-5/).first().waitFor({ timeout: 15000 }).catch(() => {});
  const corps = await reglages.innerText();
  verifie(/Haiku · claude-haiku-5-5/.test(corps), "2. Modèles et budget : « Haiku · claude-haiku-5-5 »");
  verifie(/Sonnet · claude-sonnet-5-5/.test(corps), "2. Modèles et budget : « Sonnet · claude-sonnet-5-5 » (mesure d'utilisation)");
  verifie(/Opus/.test(corps) && !/claude-opus/.test(corps), "2. Modèles et budget : « Opus » seul tant qu'aucun tour ne l'a servi");
  await page.screenshot({ path: join(SORTIE, "2-reglages-modeles-et-budget.png") });

  // 3. La liste de recherche d'un modèle précis.
  await page.getByText(/Un modèle précis/).first().click();
  await page.waitForTimeout(800);
  const recherche = await reglages.innerText();
  verifie(/Claude Code · Haiku · claude-haiku-5-5/.test(recherche), "3. la liste des modèles : « Claude Code · Haiku · claude-haiku-5-5 »");
  await page.screenshot({ path: join(SORTIE, "3-liste-des-modeles.png") });

  // 4. La page de l'agent : son modèle (opus, inconnu) et celui de tous (haiku).
  await page.goto(serveur.base);
  await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /Bis/ }).first().click();
  await page.waitForTimeout(800);
  const autre = page.locator("button:has-text('Opus')").first();
  verifie(await autre.isVisible().catch(() => false), "4. l'agent au modèle propre montre « Opus » (nom exact inconnu : l'alias seul)");
  await page.screenshot({ path: join(SORTIE, "4-agent-opus-alias-seul.png") });
  await autre.click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SORTIE, "5-page-de-l-agent.png") });
  const dialogue = await page.locator('[role="dialog"], .right-panel').first().innerText().catch(() => "");
  verifie(/claude-haiku-5-5/.test(dialogue) && /Sonnet · claude-sonnet-5-5/.test(dialogue), "5. la page de l'agent : « Comme mes autres agents » et les niveaux Auto portent les noms exacts");
} finally {
  await navigue.close();
  await serveur.arreter();
}
console.log(resultats.every(Boolean) ? "VERT   noms exacts des modèles de Claude Code" : "ROUGE  noms exacts des modèles de Claude Code");
process.exit(resultats.every(Boolean) ? 0 : 1);
