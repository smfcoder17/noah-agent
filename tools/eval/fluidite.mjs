// Banc de fluidité : frontend réel, données fixes, aucune écriture dans le serveur.
// NOAH_PLAYWRIGHT=<module> BASE=http://localhost:8080 MOBILE=1 node tools/eval/fluidite.mjs <dossier> [--reference-015] [--compare=<json>] [--device=...]
// NOAH_CDP=http://127.0.0.1:9222 : navigateur du téléphone déjà exposé par adb ; prendre un profil de test.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";
import { fixtures } from "./lot2-fixtures.mjs";
const args = process.argv.slice(2), legacy = args.includes("--reference-015");
const option = (key) => args.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3);
const date = new Date().toISOString(), out = resolve(args.find((a) => !a.startsWith("--")) || `docs/epics/0.1.6/mesures/fluidite-${date.replace(/[:.]/g, "-")}`);
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT || "playwright");
const browser = process.env.NOAH_CDP ? await chromium.connectOverCDP(process.env.NOAH_CDP) : await chromium.launch({ headless: true, channel: "chrome" });
const context = process.env.NOAH_CDP ? browser.contexts()[0] : await browser.newContext({ viewport: process.env.MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 }, locale: "fr-FR", serviceWorkers: "block" });
const release = await fixtures(context, { latency: 80, bandwidth: 1_600_000 / 8 });
const page = await context.newPage(), cdp = await context.newCDPSession(page);
const requests = []; page.on("request", (r) => { if (r.url().includes("/api/")) requests.push({ at: Date.now(), path: new URL(r.url()).pathname }); });
let report;
try {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8, connectionType: "cellular4g" });
  const start = async (cold) => { await cdp.send("Network.setCacheDisabled", { cacheDisabled: cold }); if (cold) await cdp.send("Network.clearBrowserCache"); const t = Date.now(); await page.goto(process.env.BASE || "http://localhost:8080", { waitUntil: "domcontentloaded" }); await page.locator("[data-noah-msg]").nth(299).waitFor({ state: "attached", timeout: 60000 }); await page.locator("[data-composer-input]").waitFor(); return Date.now() - t; };
  const froid = await start(true), chaud = await start(false);
  const tap = async (label) => page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).first().click();
  const change = async (label) => {
    if (legacy && ["Activité", "Ordinateur"].includes(label)) { await tap("Tâches"); await page.getByRole("tab", { name: label, exact: true }).click(); }
    else await tap(label);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const tabs = ["Fichiers", "Tâches", "Discussion", "Activité", "Ordinateur", "Discussion"];
  for (const label of tabs) { await change(label); await page.waitForTimeout(500); }
  const changes = [];
  for (let i = 0; i < 30; i++) { const before = Date.now(); await change(tabs[i % tabs.length]); changes.push({ onglet: tabs[i % tabs.length], ms: Date.now() - before }); }
  await change("Discussion");
  assert.equal(await page.locator("[data-noah-msg]").count(), 300, "300 messages réellement montés");
  const frames = await page.evaluate(async () => {
    const viewport = document.querySelector("[data-noah-viewport]"); if (!viewport) throw new Error("Discussion introuvable");
    const intervals = []; let previous = performance.now(), start = previous;
    await new Promise((done) => { const step = (now) => { intervals.push(now - previous); previous = now; viewport.scrollTop = (viewport.scrollTop + 18) % Math.max(1, viewport.scrollHeight - viewport.clientHeight); if (now - start < 5000) requestAnimationFrame(step); else done(); }; requestAnimationFrame(step); });
    return { intervalles_ms: intervals, sans_saut: intervals.filter((ms) => ms <= 25).length / intervals.length };
  });
  await change("Fichiers"); await page.getByRole("button", { name: "Livrables" }).first().waitFor().catch(() => {});
  const files = await page.locator("[data-noah-file]").count();
  assert.equal(files, 20, "20 fichiers réellement affichés");
  await change("Discussion");
  const idleStart = Date.now(); await page.waitForTimeout(60000);
  const repos = requests.filter((r) => r.at >= idleStart);
  const sorted = changes.map((c) => c.ms).sort((a, b) => a - b), p75 = sorted[Math.ceil(sorted.length * .75) - 1];
  const assets = resolve("frontend/dist/assets");
  const bundle = existsSync(assets) ? readdirSync(assets).filter((f) => /\.js$/.test(f)).map((f) => { const body = readFileSync(join(assets, f)); return { fichier: f, octets: statSync(join(assets, f)).size, gzip: gzipSync(body).length }; }) : null;
  const device = await page.evaluate(() => ({ user_agent: navigator.userAgent, ram_go_annoncee: navigator.deviceMemory ?? null, coeurs: navigator.hardwareConcurrency, largeur: innerWidth, hauteur: innerHeight }));
  const comparison = option("compare") ? JSON.parse(readFileSync(option("compare"), "utf8")) : null;
  report = { date, reference: legacy ? "b12b62f" : "lot2", appareil: option("device") || "navigateur-laboratoire", preuve_appareil: device, protocole: { cpu: 4, reseau: "4G 1,6 Mb/s, 80 ms", messages: 300, fichiers: 20, donnees: "API simulée ; transport SSE laissé ouvert ; interface et fichiers statiques réels", limite: "La RAM 4 Go doit être configurée dans l'émulateur ; aucune RAM simulée par ce script." }, froid_ms: froid, chaud_ms: chaud, changements: changes, p75_ms: p75, defilement: frames, fichiers_affiches: files, requetes_repos_par_minute: repos.length, repos, paquet: bundle, criteres: { froid: froid < 3000, chaud: chaud < 1500, onglets: p75 < 300, defilement: frames.sans_saut >= .95 }, comparaison: comparison ? { froid_ms: froid - comparison.froid_ms, chaud_ms: chaud - comparison.chaud_ms, p75_ms: p75 - comparison.p75_ms, requetes_repos: repos.length - comparison.requetes_repos_par_minute } : null };
  mkdirSync(out, { recursive: true }); writeFileSync(join(out, "fluidite.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ fichier: join(out, "fluidite.json"), criteres: report.criteres }));
  if (Object.values(report.criteres).some((ok) => !ok)) process.exitCode = 1;
} finally {
  await release(); await page.close(); if (!process.env.NOAH_CDP) await browser.close();
}
