// X14 : choisir un modèle précis parmi 656 se fait en 3 gestes, et la liste s'ouvre en moins de 200 ms, dans un vrai navigateur.
// Vite doit tourner dans frontend/ (le banc : frontend/tests/modeles.html).
//   NOAH_PLAYWRIGHT=<module> BASE=http://localhost:5173 node tools/eval/ui-modeles.mjs [dossier des captures]
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT || "playwright");
const BASE = process.env.BASE || "http://localhost:5173";
const out = resolve(process.argv[2] || "mesures-modeles");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.NOAH_CHANNEL ? { channel: process.env.NOAH_CHANNEL } : {}) });
const results = [];

/** De l'instant du toucher sur l'étiquette à la liste dessinée : fenêtre ouverte, recherche en place, premières rangées peintes. */
async function openTime(page) {
  return page.evaluate(() => new Promise((done) => {
    const chip = document.querySelector("[data-model-chip]");
    const t0 = performance.now();
    chip.click();
    const look = () => {
      const search = document.querySelector('[role="dialog"] input[type="search"]');
      const rows = document.querySelectorAll('[role="dialog"] [aria-label="Modèles"] [role="radio"]');
      if (search && rows.length > 3) requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - t0)));
      else requestAnimationFrame(look);
    };
    look();
  }));
}

for (const [name, viewport, mobile] of [["bureau", { width: 1280, height: 800 }, false], ["telephone", { width: 390, height: 844 }, true]]) {
  const context = await browser.newContext({ viewport, locale: "fr-FR", hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage();
  await page.goto(`${BASE}/tests/modeles.html`);
  await page.locator("[data-model-chip]").waitFor();
  assert.equal(await page.evaluate(() => window.__modeles), 656, "656 modèles servis");

  // Ouverture : dix mesures, la première (code encore froid) comprise.
  const times = [];
  for (let i = 0; i < 10; i++) {
    times.push(await openTime(page));
    if (i === 0) await page.screenshot({ path: `${out}/${name}-liste-ouverte.png` });
    await page.keyboard.press("Escape");
    await page.locator('[role="dialog"]').waitFor({ state: "detached" });
  }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)], worst = sorted[sorted.length - 1];
  console.log(`${name} : ouvertures (ms) ${times.map((x) => Math.round(x)).join(", ")}`);
  assert.ok(worst < 200,`${name} : ouverture ${worst.toFixed(0)} ms (< 200 ms attendu)`);
  const rendered = await (async () => { await openTime(page); return page.locator('[role="dialog"] [aria-label="Modèles"] [role="radio"]').count(); })();
  assert.ok(rendered < 40, `${name} : seules les rangées visibles sont dans la page (${rendered})`);
  await page.keyboard.press("Escape");
  await page.locator('[role="dialog"]').waitFor({ state: "detached" });

  // Trois gestes : toucher l'étiquette, taper, toucher le modèle. Un modèle parmi les 600 d'OpenRouter, puis un modèle d'un autre fournisseur.
  for (const [query, expected] of [["modele-413", { model: "cohere/modele-413", provider: "openrouter" }], ["fable 7", { model: "claude-fable-7", provider: "anthropic" }]]) {
    await page.evaluate(() => { window.__picked.length = 0; });
    let gestes = 0;
    await page.locator("[data-model-chip]").click(); gestes++;
    const search = page.locator('[role="dialog"] input[type="search"]');
    await search.waitFor();
    assert.equal(await search.evaluate((el) => el === document.activeElement), true, "le curseur est déjà dans la recherche");
    await page.keyboard.type(query); gestes++;
    const radios = page.locator('[role="dialog"] [aria-label="Modèles"] [role="radio"]');
    await radios.first().waitFor();
    if (name === "bureau" && query === "modele-413") await page.screenshot({ path: `${out}/${name}-recherche.png` });
    await radios.first().click(); gestes++;
    await page.waitForFunction(() => window.__picked.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__picked[0]), expected);
    assert.ok(gestes <= 3, `${name} : ${gestes} gestes`);
    results.push({ ecran: name, recherche: query, gestes, choisi: expected });
    await page.locator('[role="dialog"]').waitFor({ state: "detached" });
  }

  // Les fournisseurs se cochent à plusieurs, les modèles sont groupés par entreprise.
  await page.locator("[data-model-chip]").click();
  await page.getByRole("button", { name: /Tous les fournisseurs/ }).click();
  await page.screenshot({ path: `${out}/${name}-fournisseurs.png` });
  await page.getByLabel("OpenAI", { exact: true }).check();
  await page.getByLabel("Anthropic (Claude)").check();
  assert.match(await page.getByRole("button", { name: /fournisseurs/ }).first().innerText(), /2 fournisseurs/);
  const headsNow = () => page.locator('[role="dialog"] [role="presentation"]').allInnerTexts();
  const first = await headsNow();
  assert.ok(/ANTHROPIC/i.test(first[0]), `première entreprise : ${first[0]}`);
  await page.screenshot({ path: `${out}/${name}-groupes.png` });
  await page.locator('[role="dialog"] [aria-label="Modèles"]').evaluate((el) => { el.scrollTop = 12 * 56 + 28 - 20; el.dispatchEvent(new Event("scroll")); });
  await page.waitForTimeout(150);
  const heads = [...first, ...(await headsNow())];
  assert.ok(heads.some((h) => /OPENAI/i.test(h)) && heads.every((h) => !/OpenRouter/i.test(h)), `groupes par entreprise : ${heads.join(" | ")}`);
  await page.screenshot({ path: `${out}/${name}-groupes-bas.png` });
  results.push({ ecran: name, ouverture_ms: { mediane: Math.round(median), pire: Math.round(worst), mesures: times.map((x) => Math.round(x)) }, rangees_dans_la_page: rendered, groupes: heads });
  await context.close();
}
writeFileSync(`${out}/mesures.json`, JSON.stringify({ date: new Date().toISOString(), modeles: 656, resultats: results }, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
