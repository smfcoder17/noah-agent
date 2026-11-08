// Les écrans de tous les jours, sur téléphone (390×844) ou ordinateur, avec le nombre de mots visibles : la mesure du « trop de texte ».
//   NOAH_PLAYWRIGHT=<chemin de playwright> [MOBILE=1] [BASE=http://localhost:5173] node tools/eval/ecrans.mjs <dossier>
// Repère : Muse montre une rangée par réglage (icône, nom, chevron), au plus une ligne d'aide, et un écran vide en une phrase.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = process.env.BASE || "http://localhost:8080";
const OUT = resolve(process.argv[2] || "ecrans");
process.env.MSYS_NO_PATHCONV = "1";
mkdirSync(OUT, { recursive: true });
const py = (code) => execFileSync("docker", ["exec", "-w", "/app", "-e", "PYTHONPATH=/app", "noah-server", "python", "-c", code]).toString().trim();
const token = py(`from noah import auth, db
print(auth.new_session(db.owner_id(), "Banc des écrans"))`);
const drop = () => py(`from noah import auth, db
with db.connect() as c:
    t = auth.digest(${JSON.stringify(token)})
    c.execute("DELETE FROM alertes_appareils WHERE session = ?", (t,))
    c.execute("DELETE FROM sessions WHERE token = ?", (t,))`);

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ ...(process.env.MOBILE ? PHONE : { viewport: { width: 1280, height: 800 } }), locale: "fr-FR" });
await ctx.addCookies([{ name: "noah_session", value: token, url: BASE }]);
const page = await ctx.newPage();
await page.route("**/api/me/alertes-appareils", (r) => r.fulfill({ json: { alertes: [] } }));

const settle = async () => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForFunction(() => !/Chargement/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
};
const words = () => page.evaluate(() => {
  // Ce que l'œil voit : le texte des éléments visibles dans la fenêtre, pas ce qui est caché ou plus bas.
  const seen = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !n.textContent.trim()) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight || s.visibility === "hidden" || s.opacity === "0") continue;
    seen.push(n.textContent.trim());
  }
  const text = seen.join(" ");
  const buttons = [...document.querySelectorAll("button, a, [role=switch], input, select")].filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
  }).length;
  return { mots: text.split(/\s+/).filter(Boolean).length, commandes: buttons, texte: text.slice(0, 1500) };
});
const tap = async (name, exact = false) => {
  const target = page.getByRole("button", { name, exact }).filter({ visible: true }).first();
  await target.click({ timeout: 5000 });
  await settle();
};

const SCREENS = [
  ["accueil", async () => {}],
  ["taches", async () => tap("Tâches", true)],
  ["agents", async () => tap("Agents", true)],
  ["reglages", async () => { await page.goto(BASE); await settle(); await tap("Réglages", true); }],
  ["connexions", async () => { await page.goto(BASE); await settle(); await tap("Tâches", true); await page.getByRole("tab", { name: "Connexions" }).click(); await settle(); }],
  ["activite", async () => { await page.goto(BASE); await settle(); await tap("Tâches", true); await page.getByRole("tab", { name: "Activité" }).click(); await settle(); }],
  ["modele", async () => { await tap(/^Modèle/); }],
  ["objectifs", async () => { await page.goto(BASE); await settle(); await tap("Agents", true); await tap(/Objectifs/); }],
];
const report = [];
await page.goto(BASE);
await settle();
for (const [name, go] of SCREENS) {
  try {
    await go();
    const w = await words();
    await page.screenshot({ path: `${OUT}/${name}.png` });
    report.push({ ecran: name, ...w });
    console.log(`${name.padEnd(12)} ${String(w.mots).padStart(4)} mots · ${w.commandes} commandes · ${(w.mots / Math.max(1, w.commandes)).toFixed(1)} mots par commande`);
  } catch (e) {
    console.log(`${name.padEnd(12)} non atteint : ${String(e.message).split("\n")[0]}`);
    report.push({ ecran: name, erreur: String(e.message).split("\n")[0] });
  }
}
writeFileSync(`${OUT}/ecrans.json`, JSON.stringify(report, null, 2));
await browser.close();
drop();
