// Vraie app reconstruite : ordinateur 1280×800 et téléphone 390×844.
// NOAH_PLAYWRIGHT=<module> node tools/eval/vue-reglages.mjs [dossier-de-sortie]
// BASE permet de viser une autre adresse ; aucune clé de modèle n'est nécessaire.
// Build de production sans API (vraie App, pas tests/lot2.html) :
// cd frontend && npx vite build && npx vite preview --host 127.0.0.1 --port 4173
// NOAH_FIXTURES=1 BASE=http://127.0.0.1:4173 NOAH_PLAYWRIGHT=<module> node tools/eval/vue-reglages.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fixtures } from "./lot2-fixtures.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:8080";
const OUT = resolve(process.argv[2] || `docs/epics/0.1.6/mesures/reglages-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";
const py = (c) => execFileSync("docker", ["exec", "-w", "/app", "-e", "PYTHONPATH=/app", "noah-server", "python", "-c", c]).toString().trim();
const simulated = process.env.NOAH_FIXTURES === "1";
const token = simulated ? null : py(`from noah import auth, db\nprint(auth.new_session(db.owner_id(), "Captures réglages S4"))`);
const measures = [];
let b;
try {
  b = await chromium.launch({ channel: process.env.NOAH_BROWSER_CHANNEL || "chrome", headless: true });
  for (const [name, opts] of [["ordinateur", { viewport: { width: 1280, height: 800 } }], ["telephone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    const ctx = await b.newContext({ ...opts, locale: "fr-FR", serviceWorkers: "block" });
    const release = simulated ? await fixtures(ctx) : async () => {};
    if (simulated) {
      await ctx.route("**/api/calls/pending", r => r.fulfill({ json: { appels: [] } }));
      await ctx.route("**/api/decision", r => r.fulfill({ json: { modele: null, nom: null, secours: false, raison: null, prix_entree: null, ms: null, choisi_par: "auto", candidats: [], cerveau: "openai/gpt-test", en_cours: false, mesure: true, type: null, decisions: [], ecartes: [], aucun: true, petits: [], cles: { openrouter: true, typesafe: false, openai: false } } }));
    }
    const p = await ctx.newPage();
    const capture = async (step) => {
      await p.evaluate(() => document.fonts.ready);
      await p.screenshot({ path: `${OUT}/${name}-${step}.png` });
    };
    try {
      if (token) await ctx.addCookies([{ name: "noah_session", value: token, url: BASE }]);
      await p.route("**/api/me/alertes-appareils", (r) => r.fulfill({ json: { alertes: [] } }));
      await p.goto(BASE);
      if (name === "telephone") await p.getByRole("button", { name: "Menu", exact: true }).click();
      await p.getByRole("button", { name: "Réglages", exact: true }).filter({ visible: true }).click();
      const dialog = p.locator('.desktop-settings[role="dialog"]');
      await dialog.waitFor({ state: "visible" });
      await capture("1-reglages");

      // Mesurer avant un autre clic : Playwright ferait défiler une liste cachée.
      const layout = await dialog.evaluate((el) => {
        const list = el.querySelector(".settings-list"), first = list.firstElementChild;
        const style = getComputedStyle(el);
        return { frame: el.getBoundingClientRect().toJSON(), list: list.getBoundingClientRect().toJSON(), first: first.getBoundingClientRect().toJSON(), scroll: el.scrollTop, listScroll: list.scrollTop, modal: el.getAttribute("aria-modal"), focused: el.contains(document.activeElement), computed: { translate: style.translate, transform: style.transform, inset: style.inset }, stylesheets: [...document.styleSheets].map(s => s.href).filter(Boolean) };
      });
      measures.push({ vue: name, api: simulated ? "simulée" : "serveur", ...layout });
      assert.equal(layout.modal, "true");
      assert.equal(layout.focused, true, "focus dans les réglages");
      assert.equal(layout.scroll, 0, "cadre ouvert en haut");
      assert.equal(layout.frame.x, name === "ordinateur" ? 232 : 0);
      assert.equal(layout.frame.y, 0);
      assert.equal(layout.frame.width, opts.viewport.width - (name === "ordinateur" ? 232 : 0));
      assert.equal(layout.frame.height, opts.viewport.height);
      if (name === "ordinateur") {
        assert.equal(layout.list.width, 280, "colonne des rubriques conservée");
        assert.equal(layout.listScroll, 0);
        assert.ok(layout.first.y >= 56 && layout.first.bottom <= opts.viewport.height, "première rubrique visible en haut");
      }
      const navigation = dialog.locator(name === "ordinateur" ? ".settings-list" : ".settings-detail");
      await navigation.getByRole("button", { name: "Modèles et budget", exact: true }).click();
      const brain = dialog.getByRole("tab", { name: "Cerveau", exact: true });
      await brain.waitFor({ state: "visible" });
      await capture("2-modeles-et-budget");
      await brain.click();
      assert.equal(await brain.getAttribute("aria-selected"), "true");
      await dialog.locator('input[type="number"]').first().waitFor({ state: "visible" });
      await capture("3-cerveau");
      await dialog.getByRole("tab", { name: "Fournisseurs", exact: true }).click();
      await dialog.getByRole("region", { name: "Fournisseurs", exact: true }).waitFor({ state: "visible" });
      await dialog.getByRole("button", { name: /^Un autre fournisseur/ }).waitFor({ state: "visible" });
      await capture("4-fournisseurs");
    } catch (error) {
      await capture("erreur").catch(() => {});
      throw error;
    } finally { await release(); await ctx.close(); }
  }
} finally {
  try {
    await b?.close();
  } finally {
    try { writeFileSync(`${OUT}/mesures.json`, JSON.stringify(measures, null, 2)); }
    finally {
      // La session de capture est retirée aussi si un écran ou le navigateur échoue.
      if (token) py(`from noah import auth, db\nwith db.connect() as c:\n    c.execute("DELETE FROM sessions WHERE token = ?", (auth.digest(${JSON.stringify(token)}),))`);
    }
  }
}
console.log(`Captures et mesures : ${OUT}`);
