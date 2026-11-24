// La vraie app de bureau (Electron, desktop/) reliée au serveur d'essai de apercus_serveur.py : l'aperçu de chaque type de fichier dans sa fenêtre,
// avec les vraies règles de requêtes (desktop/liens.js) et le vrai journal du bureau (requêtes coupées).
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/apercus_bureau.mjs <dossier des captures> [étiquette]
// Le serveur d'essai est en http://127.0.0.1 : l'app l'accepte (adresse locale). Les réglages de l'app restent dans un dossier d'essai.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, afficherTableau, juger, ouvrirDepuisLaConversation, ouvrirDepuisLePanneau } from "./apercus_commun.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NOAH_PLAYWRIGHT);
const BASE = process.env.NOAH_BASE || "http://127.0.0.1:8096";
const OUT = resolve(process.argv[2] || "captures");
const LABEL = process.argv[3] || "apercus-bureau";
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop");
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "noah-apercus-"));
writeFileSync(join(profile, "config.json"), JSON.stringify({ mode: "remote", server: BASE }));
const lignes = [];
const journal = [];
// L'app se lance telle quelle ; le test s'y relie par le protocole de débogage (le lanceur Electron de Playwright n'aboutit pas sur ce dossier).
const PORT = 9333;
const child = spawn(require(join(DESKTOP, "node_modules", "electron")), [DESKTOP, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--lang=fr-FR"], { env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1", NOAH_PROFIL: "" }, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => journal.push(String(d)));
child.stderr.on("data", (d) => journal.push(String(d)));
let browser;
for (let i = 0; i < 60 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
  if (!browser) await new Promise((ok) => setTimeout(ok, 1000));
}
if (!browser) throw new Error("l'app de bureau ne répond pas");
const windows = () => browser.contexts().flatMap((c) => c.pages());

/** La page de Noah dans la fenêtre (une vue native à part), connectée au compte d'essai. */
async function pageDeNoah() {
  const fin = Date.now() + 60000;
  for (;;) {
    const page = windows().find((w) => w.url().startsWith(BASE));
    if (page) return page;
    if (Date.now() > fin) throw new Error(`aucune fenêtre sur ${BASE} : ${windows().map((w) => w.url().slice(0, 50)).join(" ; ")}`);
    await new Promise((ok) => setTimeout(ok, 500));
  }
}
/** L'app de bureau ne se connecte pas par un mot de passe : elle porte la session d'un appareil relié. L'essai pose donc, dans la session de l'app, le même cookie que le jeton relié (desktop/main.js, useToken). */
let session = false;
async function connecter() {
  if (!session) {
    const r = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password: "motdepasse-essai" }) });
    const value = /noah_session=([^;]+)/.exec(r.headers.get("set-cookie") || "")?.[1];
    if (!value) throw new Error(`connexion d'essai refusée (${r.status})`);
    await browser.contexts()[0].addCookies([{ name: "noah_session", value, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    session = true;
  }
  const page = await pageDeNoah();
  await page.goto(BASE);
  await page.locator("[data-composer-input]").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  return page;
}
const noter = async (page, kind, endroit, label) => {
  const r = await juger(kind, page);
  await page.screenshot({ path: resolve(OUT, `${LABEL}-${label}-${kind}.png`) }).catch(() => {});
  lignes.push({ kind, lieu: `bureau · ${endroit}`, ...r });
};

let page = await connecter();
for (const [kind, path] of FILES.filter(([k]) => k !== "app")) {
  page = await connecter();
  if (await ouvrirDepuisLePanneau(page, path)) await noter(page, kind, "panneau", "panneau");
  else lignes.push({ kind, lieu: "bureau · panneau", ok: false, why: "pas de ligne dans la liste des fichiers" });
}
for (const [kind, path] of FILES) {
  page = await connecter();
  await ouvrirDepuisLaConversation(page, path);
  await noter(page, kind, "conversation", "fil");
}
await browser.close().catch(() => {});
child.kill();
await new Promise((ok) => setTimeout(ok, 1500));
try { rmSync(profile, { recursive: true, force: true }); } catch { /* l'app libère ses fichiers à son rythme ; le dossier est dans le dossier temporaire */ }
const coupees = journal.join("").split("\n").filter((l) => /Requête coupée/.test(l));
console.log(coupees.length ? `requêtes coupées par le bureau :\n${coupees.join("\n")}` : "le bureau n'a coupé aucune requête");
const casses = afficherTableau(lignes);
process.exit(casses || coupees.length ? 1 : 0);
