// Banc de facilité : chaque action courante faite dans le vrai Noah, par le chemin le plus court, comme le ferait la personne.
// Compte les gestes (clic, saisie, touche), dit si le point d'entrée se voit dès l'accueil, cherche le retour attendu, et
// garde une capture par geste pour les juges. Méthode et références : docs/facilite.md.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tools/eval/facilite.mjs <dossier> [actions séparées par des virgules]
// Le serveur local doit tourner (noah-server) ; BASE peut viser le serveur de dev de l'interface (http://localhost:5173).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = process.env.BASE || "http://localhost:8080";
const OUT = resolve(process.argv[2] || "facilite");
const ONLY = (process.argv[3] || "").split(",").filter(Boolean);
process.env.MSYS_NO_PATHCONV = "1";

const docker = (...args) => execFileSync("docker", args, { maxBuffer: 1 << 26 }).toString();
const py = (code) => docker("exec", "-w", "/app", "-e", "PYTHONPATH=/app", "noah-server", "python", "-c", code).trim();
const token = py(`from noah import auth, db
print(auth.new_session(db.owner_id(), "Banc de facilité"))`);
// L'alerte « nouvel appareil » de la session du banc est tranchée d'office, et tout disparaît à la fin : la personne ne la voit pas.
const BENCH_SQL = `from noah import auth, db
with db.connect() as c:
    t = auth.digest(${JSON.stringify(token)})`;
const settleBench = () => py(`${BENCH_SQL}
    c.execute("UPDATE alertes_appareils SET tranche = 1 WHERE session = ?", (t,))`);
const dropBench = () => py(`${BENCH_SQL}
    c.execute("DELETE FROM alertes_appareils WHERE session = ?", (t,))
    c.execute("DELETE FROM sessions WHERE token = ?", (t,))`);

// Références : nombre de gestes du parcours équivalent chez Grok Bot ou Muse (docs/facilite.md, section Références).
export const ACTIONS = {
  A1: { but: "Envoyer un message à ton agent et lire sa réponse", ref: 2 },
  A2: { but: "Arrêter un travail que ton agent est en train de faire", ref: 1 },
  A3: { but: "Créer un nouvel agent", ref: 3 },
  A4: { but: "Connecter un nouvel outil à ton agent (par exemple Google Drive)", ref: 2 },
  A5: { but: "Programmer une tâche pour plus tard", ref: 2 },
  A6: { but: "Voir les tâches programmées de ton agent", ref: 2 },
  A7: { but: "Retrouver un fichier que ton agent a produit", ref: 2 },
  A8: { but: "Appeler ton agent à la voix", ref: 1 },
  A9: { but: "Changer le modèle d'IA qu'utilise ton agent", ref: 2 },
  A10: { but: "Voir ce que ton agent a fait aujourd'hui", ref: 1 },
  A11: { but: "Relier ton téléphone à ton compte", ref: 2 },
  R1: { but: "Voir combien ton agent a coûté ce mois-ci", ref: 2 },
  R2: { but: "Changer la couleur de ton agent", ref: 2 },
  R3: { but: "Déconnecter un appareil relié à ton compte", ref: 3 },
  R4: { but: "Mettre en pause une tâche programmée", ref: 3 },
};

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
// MOBILE=1 : un téléphone Android, là où la personne se sert le plus de Noah.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const ctx = await browser.newContext({ ...(process.env.MOBILE ? PHONE : { viewport: { width: 1280, height: 800 } }), locale: "fr-FR", permissions: ["microphone"] });
await ctx.addCookies([{ name: "noah_session", value: token, url: BASE }]);
const page = await ctx.newPage();
// Les alertes d'autres appareils restent à la personne : le banc ne les voit pas et n'y touche pas.
await page.route("**/api/me/alertes-appareils", (r) => r.fulfill({ json: { alertes: [] } }));
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [method, path, body]);

const results = {};
let cur;
const shot = (name) => page.screenshot({ path: `${OUT}/${cur.id}/${String(cur.steps.length).padStart(2, "0")}-${name}.png` });
// Un geste : ce que la personne fait, puis ce qu'elle voit une fois l'écran chargé (au plus 12 s). L'attente se compte à part.
const LOADING = /^(?:(Lecture|Chargement|Connexion à l'écran)…?|…)$/;
const act = async (what, fn, settle = 700) => {
  await fn();
  cur.steps.push(what);
  await page.waitForTimeout(settle);
  const t = Date.now();
  await page.waitForFunction((src) => {
    const re = new RegExp(src);
    return ![...document.querySelectorAll("body *")].some((el) => el.offsetParent !== null && re.test([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()));
  }, LOADING.source, { timeout: 12000 }).catch(() => {});
  cur.attente = (cur.attente || 0) + (Date.now() - t);
  await shot(what.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40));
};
const visible = async (loc) => {
  // Visible veut dire à l'écran : un tiroir replié hors de l'écran ne compte pas.
  try {
    await loc.first().waitFor({ state: "attached", timeout: 1500 });
    const width = page.viewportSize().width;
    for (const one of await loc.all()) {
      const box = (await one.isVisible()) && (await one.boundingBox());
      if (box && box.x >= 0 && box.x + box.width <= width + 1) return true;
    }
    return false;
  } catch { return false; }
};
const home = async () => {
  await page.goto(BASE);
  await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  if (await page.getByRole("alertdialog").count()) {
    settleBench();
    await page.reload();
    await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);
  }
};

const door = (name) => page.getByRole("button", { name }).and(page.locator(":not([role=tab])"));
const clickOnScreen = async (loc) => {
  const width = page.viewportSize().width;
  for (const one of await loc.all()) {
    const box = (await one.isVisible()) && (await one.boundingBox());
    if (box && box.x >= 0 && box.x + box.width <= width + 1) return one.click();
  }
  throw new Error("rien à l'écran");
};
const viaPanel = async (doorName, tabName, label) => {
  const d = door(doorName);
  cur.entree = await visible(d);
  if (cur.entree) return act(label, () => clickOnScreen(d));
  await act("panneau de l'agent", () => page.getByRole("button", { name: /Ouvrir le panneau/ }).first().click());
  await act(`onglet ${label}`, () => page.getByRole("tab", { name: tabName }).first().click());
};

const RUNS = {
  async A1() {
    const box = page.locator("[data-composer-input]");
    cur.entree = await visible(box);
    await act("écrire", () => box.fill("Réponds seulement : ok."));
    const before = await page.locator("[data-role=assistant], .prose").count();
    await act("Entrée", () => box.press("Enter"), 300);
    const t = Date.now();
    await page.waitForFunction((n) => document.querySelectorAll("[data-role=assistant], .prose").length > n, before, { timeout: 60000 }).catch(() => {});
    cur.retour = Date.now() - t < 60000;
    cur.mesure = { reponse_ms: Date.now() - t };
    await page.waitForTimeout(4000);
    await shot("réponse");
  },
  async A2() {
    const box = page.locator("[data-composer-input]");
    await box.fill("Écris les nombres de 1 à 300, un par ligne, sans rien d'autre.");
    await box.press("Enter");
    const stop = page.getByRole("button", { name: /Arrêter/ });
    await stop.first().waitFor({ timeout: 20000 }).catch(() => {});
    await shot("travail-en-cours");
    cur.entree = await visible(stop);
    if (!cur.entree) return;
    await act("Arrêter", () => stop.first().click(), 1500);
    cur.retour = !(await visible(stop));
  },
  async A3() {
    const create = page.getByRole("button", { name: /Créer un agent|Nouvel agent/ });
    cur.entree = await visible(create);
    if (!cur.entree) await act("Agents", () => page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "Agents" }).click());
    await act("Créer un agent", () => clickOnScreen(create));
    await act("nom", () => page.getByPlaceholder(/Ex\./).first().fill("Essai facilité"));
    // On s'arrête avant de lancer une machine : le dernier geste serait « Créer l'agent ».
    const go = page.getByRole("button", { name: /Créer l'agent|Créer$/ });
    cur.retour = await visible(go);
    if (cur.retour) cur.steps.push("Créer l'agent (non cliqué)");
    await page.keyboard.press("Escape");
  },
  async A4() {
    await viaPanel(/^(Connexions|Outils)$/, /Connexions/, "Connexions");
    // La liste des outils à connecter arrive après celle des connexions : on l'attend avant de juger l'écran.
    await page.getByText(/^Google( Drive)?$/).first().waitFor({ timeout: 12000 }).catch(() => {});
    await shot(cur.steps.at(-1).replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40)); // remplace la capture prise trop tôt
    const drive = page.getByText(/^Google( Drive)?$/).first();
    if (!(await visible(drive))) await act("chercher Google", () => page.getByRole("textbox").last().fill("Google"));
    const btn = page.getByRole("button", { name: /Connecter|Ajouter/ }).first();
    cur.retour = await visible(btn);
    if (cur.retour) cur.steps.push("Connecter (non cliqué : l'accord se fait chez Google)");
  },
  async A5() {
    const box = page.locator("[data-composer-input]");
    cur.entree = await visible(box);
    await act("écrire", () => box.fill("Dans 3 heures, rappelle-moi de boire de l'eau. Juste ce rappel, rien d'autre."));
    await act("Entrée", () => box.press("Enter"), 300);
    await page.waitForTimeout(45000);
    await shot("après");
    const routines = (await api("GET", `/api/agents/${cur.agent}/routines`)).json;
    const list = Array.isArray(routines) ? routines : routines?.routines || [];
    const made = list.find((r) => /eau/i.test(JSON.stringify(r)));
    cur.retour = !!made;
    if (made) await api("POST", `/api/agents/${cur.agent}/routines/${made.id}/supprimer`);
  },
  async A6() {
    await viaPanel(/^(Tâches programmées|Tâches|Routines)$/, /Routines/, "Routines");
    cur.retour = await visible(page.getByText(/routine|Chaque|Tous les|Aucune/i));
  },
  async A7() {
    const d = door(/^Fichiers$/);
    cur.entree = await visible(d);
    if (cur.entree) await act("Fichiers", () => clickOnScreen(d));
    else {
      await act("panneau de l'agent", () => page.getByRole("button", { name: /Ouvrir le panneau/ }).first().click());
      const tab = page.getByRole("tab", { name: /Fichiers/ });
      if (!(await visible(tab))) await act("onglet Ordinateur", () => page.getByRole("tab", { name: /Ordinateur/ }).first().click());
      else await act("onglet Fichiers", () => tab.first().click());
    }
    const inner = page.getByRole("tab", { name: /^Fichiers$/ }).first(); // dans l'Ordinateur, quand le panneau n'a pas d'onglet Fichiers à lui
    if (cur.steps.includes("onglet Ordinateur") && (await visible(inner))) await act("Fichiers", () => inner.click());
    cur.retour = await visible(page.getByText(/essai-recu\.txt|\.png|\.txt|\.pdf/));
  },
  async A8() {
    const call = page.getByRole("button", { name: /Mode vocal|Appeler/ });
    cur.entree = await visible(call);
    await act("Mode vocal", () => call.first().click(), 2500);
    const hang = page.getByRole("button", { name: /Raccrocher|Terminer/ });
    cur.retour = await visible(hang);
    if (cur.retour) await hang.first().click();
  },
  async A9() {
    const chip = page.locator('button[title="Changer de modèle"]');
    cur.entree = await visible(chip);
    if (cur.entree) await act("modèle sous la saisie", () => clickOnScreen(chip), 1500);
    else await act("panneau de l'agent", () => page.getByRole("button", { name: /Ouvrir le panneau/ }).first().click());
    const card = page.getByRole("button", { name: /^Modèle/ });
    if (cur.entree) { /* déjà ouvert */ } else if (await visible(card)) await act("carte Modèle", () => card.first().click());
    else await act("Changer (Cerveau)", () => page.getByRole("button", { name: /^Changer$/ }).first().click());
    const pick = page.getByRole("button", { name: /^(Celui de tous|Comme tous mes agents)$/ });
    if (!(await visible(pick)) && (await visible(page.getByRole("button", { name: /^Changer$/ })))) await act("Changer", () => clickOnScreen(page.getByRole("button", { name: /^Changer$/ })));
    cur.retour = await visible(pick);
    if (cur.retour) cur.steps.push("choisir le modèle");
  },
  async A10() {
    cur.entree = await visible(page.getByText(/Ce qu'il a fait|Activité/));
    await act("panneau de l'agent", () => page.getByRole("button", { name: /Ouvrir le panneau/ }).first().click());
    cur.retour = await visible(page.getByText(/Ce qu.il a fait/i));
  },
  async A11() {
    cur.entree = await visible(page.getByRole("button", { name: /Relier|téléphone/i }));
    await act("Réglages", () => page.getByRole("button", { name: /^Réglages$/ }).locator("visible=true").first().click());
    const direct = page.getByRole("button", { name: /^Relier un (téléphone ou un ordinateur|appareil)$/ });
    if (await visible(direct)) await act("Relier (raccourci)", () => clickOnScreen(direct), 1500);
    else await act("Appareils", () => page.getByRole("tab", { name: /Appareils/ }).or(page.getByRole("button", { name: /^Appareils$/ })).locator("visible=true").first().click());
    const link = page.getByRole("button", { name: /Relier un appareil|Relier un téléphone/ });
    if (!cur.steps.some((x) => x.startsWith("Relier (raccourci)")) && (await visible(link))) await act("Relier un appareil", () => link.first().click(), 1500);
    cur.retour = await visible(page.locator("canvas, svg[role=img], img[alt*=QR]"));
  },
  async R1() {
    cur.entree = await visible(page.getByText(/Dépense|coût/i));
    await act("panneau de l'agent", () => page.getByRole("button", { name: /Ouvrir le panneau/ }).first().click());
    const tile = page.getByRole("button", { name: /^Dépense du mois/ });
    if (await visible(tile)) await act("Dépense du mois", () => clickOnScreen(tile), 1200);
    cur.retour = await visible(page.getByText(/Coût ce mois-ci|ce mois-ci/));
  },
  async R2() {
    cur.entree = false;
    await act("panneau de l'agent", () => page.getByRole("button", { name: /Ouvrir le panneau/ }).first().click());
    await act("Personnaliser", () => clickOnScreen(page.getByRole("button", { name: /Personnaliser/ })));
    cur.retour = await visible(page.getByText(/Couleur/));
    if (cur.retour) cur.steps.push("choisir la couleur (non cliqué)");
    await page.keyboard.press("Escape");
  },
  async R3() {
    cur.entree = false;
    await act("Réglages", () => page.getByRole("button", { name: /^Réglages$/ }).locator("visible=true").first().click());
    await act("Appareils", () => page.getByRole("tab", { name: /Appareils/ }).or(page.getByRole("button", { name: /^Appareils$/ })).locator("visible=true").first().click());
    cur.retour = await visible(page.getByText(/Appareils connectés/));
    if (cur.retour) cur.steps.push("supprimer l'appareil (non cliqué)");
  },
  async R4() {
    await viaPanel(/^(Tâches programmées|Tâches|Routines)$/, /Routines/, "Routines");
    const pause = page.getByRole("button", { name: /pause/i }).or(page.getByRole("switch"));
    cur.retour = await visible(pause);
    if (!cur.retour) {
      const row = page.getByText(/Veille modèles/).first();
      if (await visible(row)) await act("ouvrir la tâche", () => row.click());
      cur.retour = await visible(pause);
    }
    if (cur.retour) cur.steps.push("Pause (non cliqué)");
  },
};

try {
  await home();
  const agents = (await api("GET", "/api/agents")).json;
  const agent = (agents.find?.((a) => a.name === "Noah") || agents[0]).id;
  for (const [id, meta] of Object.entries(ACTIONS)) {
    if (ONLY.length && !ONLY.includes(id)) continue;
    mkdirSync(`${OUT}/${id}`, { recursive: true });
    cur = { id, agent, steps: [], entree: false, retour: false };
    await home();
    await page.screenshot({ path: `${OUT}/${id}/00-accueil.png` });
    try {
      await RUNS[id]();
    } catch (e) {
      cur.erreur = String(e.message).split("\n")[0].slice(0, 300);
      await shot("erreur").catch(() => {});
    }
    results[id] = { but: meta.but, ref: meta.ref, gestes: cur.steps.length, chemin: cur.steps, entree_visible: cur.entree, retour: cur.retour, attente_ms: cur.attente || 0, ...(cur.mesure ? { mesure: cur.mesure } : {}), ...(cur.erreur ? { erreur: cur.erreur } : {}) };
    console.log(id, JSON.stringify(results[id]));
  }
} finally {
  dropBench(); // d'abord : la session du banc ne doit jamais rester sur le compte
  await browser.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/mesures.json`, JSON.stringify(results, null, 2));
}
