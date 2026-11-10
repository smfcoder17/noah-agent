// Vite doit tourner dans frontend/. NOAH_PLAYWRIGHT=<module> BASE=http://localhost:5173 node tools/eval/ui-lot2.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtures } from "./lot2-fixtures.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT || "playwright");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ locale: "fr-FR" }), release = await fixtures(context);
const page = await context.newPage(), results = [], date = new Date().toISOString();
const out = resolve(process.argv[2] || `docs/epics/0.1.6/mesures/ui-${date.replace(/[:.]/g, "-")}`);
mkdirSync(out, { recursive: true });
const screen = (detail) => page.evaluate((detail) => window.dispatchEvent(new CustomEvent("lot2:test", { detail })), detail);
try {
  for (const width of [1280, 1000, 800]) {
    await page.setViewportSize({ width, height: 800 }); await page.goto((process.env.BASE || "http://localhost:5173") + "/tests/lot2.html");
    await page.locator("[data-composer-input]").waitFor();
    const box = await page.locator(".chat-pane").boundingBox(); assert.ok(box.width >= 480, "discussion au moins 480 px");
    await screen({ kind: "grid" }); await page.getByRole("button", { name: "Grille : Grille" }).click(); await page.locator(".right-panel").waitFor();
    const after = await page.locator(".chat-pane").boundingBox(); assert.ok(after.width >= 480);
    await page.screenshot({ path: `${out}/bureau-${width}.png` }); results.push({ largeur: width, chat: after.width, panneau: "ouvert" });
    await page.getByRole("button", { name: "Fermer l'aperçu" }).click();
  }
  const kinds = ["image", "pdf", "video", "audio", "page", "grid", "table", "csv", "document", "presentation", "code", "diff", "archive", "map", "contact", "chart", "form", "choice", "pr", "email", "thread", "appointment", "routine", "watch", "task", "skill", "approval", "batch", "unknown"];
  for (const kind of kinds) {
    await screen({ kind }); await page.locator(".element-card").click();
    await page.locator(kind === "audio" ? ".audio-bar" : kind === "video" ? ".video-mini" : ".right-panel").waitFor();
    results.push({ carte: kind, ouverte: true });
    if (kind === "audio") await page.getByRole("button", { name: "Fermer l'audio" }).click();
    else if (kind === "video") { const before = await page.locator("video").evaluate((el) => { el.dataset.instance = "gardee"; return el.dataset.instance; }); await page.getByRole("button", { name: "Continuer à discuter" }).click(); assert.equal(await page.locator("video").getAttribute("data-instance"), before); await page.getByRole("button", { name: "Fermer la vidéo" }).click(); }
    else await page.getByRole("button", { name: "Fermer l'aperçu" }).click();
  }
  await page.evaluate(() => { document.cookie = "lot2_cookie=secret"; window.addEventListener("message", (e) => { if (e.data?.lot2CookieBlocked !== undefined) document.documentElement.dataset.cookieBlocked = String(e.data.lot2CookieBlocked); }); });
  await screen({ screen: "elements", sandbox: true }); await page.waitForFunction(() => document.documentElement.dataset.cookieBlocked === "true");
  assert.equal(await page.getByTitle("Widget isolé").getAttribute("sandbox"), "allow-scripts"); results.push({ isolation_cookie: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // Émulation de visualViewport, sur les vrais champs des quatre écrans.
  await page.addInitScript(() => { const v = new EventTarget(); Object.assign(v, { height: 844, width: 390, offsetTop: 0, scale: 1 }); Object.defineProperty(window, "visualViewport", { value: v, configurable: true }); });
  await page.reload(); await page.locator("[data-composer-input]").waitFor();
  for (const name of ["chat", "settings", "competence", "connection"]) {
    await screen({ screen: name });
    if (name === "competence") await page.getByRole("button", { name: /Modifier «/ }).click();
    if (name === "connection") await page.getByRole("button", { name: /Un autre fournisseur/ }).click();
    const input = page.locator(name === "chat" ? "[data-composer-input]" : name === "settings" ? "input[type=number]" : name === "competence" ? "input" : "input[type=url]").filter({ visible: true }).first();
    await input.focus();
    await page.evaluate(() => { window.visualViewport.height = 544; window.visualViewport.dispatchEvent(new Event("resize")); });
    await page.waitForFunction(() => document.documentElement.dataset.keyboard === "open");
    assert.equal(await page.locator(".bottom-tabs").isVisible(), false);
    const b = await input.boundingBox(); assert.ok(b.y >= 0 && b.y + b.height <= 544 + 1, `${name} : champ au-dessus du clavier`);
    await page.evaluate(() => { window.visualViewport.height = 844; window.visualViewport.dispatchEvent(new Event("resize")); });
    await page.waitForFunction(() => document.documentElement.dataset.keyboard === "closed");
    results.push({ clavier: name, reussi: true });
    if (name === "settings") await page.keyboard.press("Escape");
  }
  await page.screenshot({ path: `${out}/telephone.png` });
} finally { writeFileSync(`${out}/ui.json`, JSON.stringify({ date, tests: results, termine: results.some((r) => r.clavier === "connection") }, null, 2)); await release(); await browser.close(); }
