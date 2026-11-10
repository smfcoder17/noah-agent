// #33 : vrai SidePanel dans Chromium, API et document noVNC simulés. Aucun serveur Noah ni Docker requis.
// NOAH_PLAYWRIGHT=/chemin/node_modules/playwright-core node tests/exposition/ecran_montage_test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NOAH_PLAYWRIGHT || "playwright");
const { createServer } = await import("../../frontend/node_modules/vite/dist/node/index.js");
const root = fileURLToPath(new URL("../../frontend", import.meta.url));
const html = `<!doctype html><html><head></head><body><div id="root"></div><script type="module">
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SidePanel } from "/src/components/SidePanel.tsx";
import { forgetSeen, SEEN } from "/src/lib/seen.ts";
import { screenUrl } from "/src/lib/screenCache.ts";
import { request } from "/src/lib/api.ts";
import "/src/index.css";
const noop = () => {};
function App() {
  const [tab, setTab] = useState("computer");
  const [id, setId] = useState("a1");
  const [open, setOpen] = useState(true);
  window.harness = { setTab, setId, setOpen, forgetSeen, screenUrl, request, SEEN };
  return open && React.createElement(SidePanel, {
    agent: { id, name: "Noah", droit: "proprietaire", tasks: {}, state: "idle" }, tab, onTab: setTab,
    onClose: () => setOpen(false), refreshKey: 0, threads: [], main: null, threadId: null,
    onAgentChanged: noop, onEditAgent: noop, onConversationChanged: noop, onOpenThread: noop,
    onArchiveThread: noop, technical: false, onTechnical: noop,
  });
}
createRoot(document.getElementById("root")).render(React.createElement(React.StrictMode, null, React.createElement(App)));
</script></body></html>`;

const server = await createServer({
  root, server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "ecran-fixture", configureServer(s) {
    s.middlewares.use(async (req, res, next) => {
      if (req.url !== "/__ecran_test") return next();
      res.setHeader("Content-Type", "text/html");
      res.end(await s.transformIndexHtml(req.url, html));
    });
  } }],
});
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  let state = "pret", broken = false, refuseFrame = false, frameLoads = 0;
  let wrongFrame = false, frameNavigations = 0, containerState = null;
  let holdList = false, waitingList, refuseProactive = 0;
  const calls = [];
  const vnc = `<!doctype html><html class="noVNC_connected"><body>
    <input id="noVNC_setting_view_only" type="checkbox" checked>
    <script>document.querySelector('input').addEventListener('change', e => document.body.dataset.readonly = e.target.checked);</script>
  </body></html>`;
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url());
    calls.push({ path: url.pathname, query: url.search, method: req.method() });
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname.endsWith("/screen-status")) {
      if (broken) return json({ detail: "coupure" }, 503);
      // Réponse du diagnostic quand le conteneur est paused, dead ou restarting.
      if (containerState) return json({ etat: "injoignable", awake: false, reachable: false, running: false, tabs: 0 });
      return json({ etat: state, awake: state !== "veille", reachable: true, running: state !== "veille", tabs: state === "aucune_page" ? 0 : 2 });
    }
    if (url.pathname.endsWith("/screen-url")) return json(req.method() === "POST" ? { ok: true } : { url: url.pathname.replace("screen-url", "screen/vnc.html") + "#view_only=1&password=essai" });
    if (url.pathname.endsWith("/screen/vnc.html")) {
      frameLoads++;
      if (req.isNavigationRequest()) frameNavigations++;
      return route.fulfill({ status: refuseFrame ? 403 : 200, contentType: "text/html", body: refuseFrame ? "refusé" : wrongFrame ? '<html><body id="screen-error">Screen unavailable</body></html>' : vnc });
    }
    if (url.pathname.endsWith("/competences")) {
      if (holdList) await new Promise((resolve) => { waitingList = resolve; });
      return json({ competences: [{ nom: "essai", titre: "Compétence en cache", texte: "Données connues" }] });
    }
    if (url.pathname.endsWith("/files")) return json([{ path: "outputs/preuve.txt", size: 12, modified: 1 }]);
    if (url.pathname.endsWith("/proactif")) return refuseProactive ? json({ detail: "Réglage refusé" }, refuseProactive) : json({
      mode: "coupe", choisi: true, minutes: 30, modifiable: true,
    });
    if (url.pathname.endsWith("/browser/wake")) { state = "pret"; return json({ ecran_actif: true }); }
    if (url.pathname.endsWith("/browser/restart")) { containerState = null; state = "pret"; return json({ ecran_actif: true }); }
    return json({});
  });
  const count = (suffix, method = "GET") => calls.filter((c) => c.path.endsWith(suffix) && c.method === method).length;
  const wait = async (check) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("condition non atteinte");
  };
  const tab = (value) => page.evaluate((v) => window.harness.setTab(v), value);
  const advance = async (ms) => { await page.clock.runFor(ms); await new Promise((resolve) => setTimeout(resolve, 100)); };
  await page.goto(`http://127.0.0.1:${port}/__ecran_test`);
  const frame = page.locator('iframe[title="Écran de l\'agent"]');
  await frame.waitFor({ state: "visible" });
  await wait(() => frameLoads === 1);
  await page.evaluate(() => { window.savedFrame = document.querySelector('iframe'); });
  assert.equal(count("/screen-url"), 1);

  await tab("competences");
  await page.getByText("Compétence en cache", { exact: true }).waitFor();
  const beforeHidden = count("/screen-status");
  await advance(12_000);
  assert.equal(count("/screen-status"), beforeHidden, "pas de relève dans l'onglet caché");
  await tab("computer");
  await frame.waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.querySelector('iframe') === window.savedFrame), true);
  assert.equal(frameLoads, 1);
  assert.equal(count("/screen-url"), 1);
  console.log("1. Ordinateur → Compétences → Ordinateur : même iframe et même chargement, une lecture du lien, relève suspendue");

  holdList = true;
  await tab("competences");
  await page.getByText("Compétence en cache", { exact: true }).waitFor();
  assert.equal(await page.getByText("Lecture…", { exact: true }).count(), 0);
  await wait(() => !!waitingList);
  waitingList(); holdList = false;
  await tab("computer");
  await frame.waitFor({ state: "visible" });
  console.log("2. compétences déjà visitées : données immédiatement visibles pendant la requête volontairement bloquée, sans spinner");

  await page.getByRole("button", { name: "Prendre le contrôle", exact: true }).click();
  await page.getByRole("button", { name: "Rendre la main à l'agent", exact: true }).waitFor();
  assert.equal(await page.frameLocator('iframe[title="Écran de l\'agent"]').locator("input").isChecked(), false);
  await tab("competences");
  await advance(59_000);
  assert.equal(calls.filter((c) => c.method === "POST" && c.query === "?view_only=1").length, 0);
  await advance(1000);
  await wait(() => calls.some((c) => c.method === "POST" && c.query === "?view_only=1"));
  assert.equal(await page.frameLocator('iframe[title="Écran de l\'agent"]').locator("input").isChecked(), true);
  await tab("computer");
  await frame.waitFor({ state: "visible" });
  assert.equal(frameLoads, 1);
  console.log("3. à 60 s en arrière-plan : lecture seule confirmée par le serveur et appliquée dans le même document noVNC");

  await advance(0); // laisser finir la relève déclenchée au retour avant d'injecter la coupure
  broken = true;
  const beforeFailures = count("/screen-status");
  await advance(3000);
  await wait(() => count("/screen-status") === beforeFailures + 1);
  assert.equal(await page.getByText("Écran injoignable", { exact: true }).count(), 0);
  assert.equal(await frame.isVisible(), true, "une erreur garde l'écran");
  await advance(3000);
  await page.getByText("Écran injoignable", { exact: true }).waitFor();
  const afterTwo = count("/screen-status");
  await advance(2999);
  assert.equal(count("/screen-status"), afterTwo);
  await advance(1);
  await wait(() => count("/screen-status") === afterTwo + 1);
  await advance(5999);
  assert.equal(count("/screen-status"), afterTwo + 1);
  await advance(1);
  await wait(() => count("/screen-status") === afterTwo + 2);
  await advance(11_999);
  assert.equal(count("/screen-status"), afterTwo + 2);
  broken = false;
  await advance(1);
  await frame.waitFor({ state: "visible" });
  assert.equal(frameLoads, 1);
  assert.equal(count("/screen-url"), 1);
  console.log("4. erreur transitoire conservée, erreur après deux échecs, reprise automatique à 3/6/12 s sans recharger l'écran");

  state = "aucune_page";
  await advance(3000);
  await page.getByText("Aucune page ouverte", { exact: true }).waitFor();
  state = "veille";
  await advance(3000);
  await page.getByText("Le navigateur est en veille", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Le réveiller", exact: true }).click();
  await frame.waitFor({ state: "visible" });
  assert.equal(frameLoads, 1);
  console.log("5. aucune_page et veille ont leurs libellés distincts ; le réveil garde le même écran");

  // Le conteneur s'arrête au repos : le document noVNC peut alors être une page d'erreur.
  state = "veille";
  refuseFrame = true;
  const beforeStopPages = frameLoads;
  await frame.evaluate((el) => el.contentWindow.location.reload());
  await wait(() => frameLoads === beforeStopPages + 1);
  const beforeSleepLinks = count("/screen-url");
  const beforeSleepPages = frameLoads;
  await advance(3000);
  await advance(3000);
  await advance(6000);
  await page.getByText("Le navigateur est en veille", { exact: true }).waitFor();
  assert.equal(await page.getByText("Écran injoignable", { exact: true }).count(), 0);
  assert.equal(count("/screen-url"), beforeSleepLinks, "la veille ne refuse pas le lien en cache");
  assert.equal(frameLoads, beforeSleepPages, "aucune sonde de la page noVNC en veille");
  refuseFrame = false;
  const beforeWake = count("/browser/wake", "POST");
  await page.getByRole("button", { name: "Le réveiller", exact: true }).click();
  await advance(3000);
  await wait(() => frame.evaluate((el) => !!el.contentDocument?.getElementById("noVNC_setting_view_only")));
  await advance(3000);
  await frame.waitFor({ state: "visible" });
  assert.equal(count("/browser/wake", "POST"), beforeWake + 1);
  assert.equal(count("/screen-url"), beforeSleepLinks);
  assert.equal(await page.evaluate(() => document.querySelector('iframe') === window.savedFrame), true);
  console.log("5 bis. conteneur en veille et document noVNC en erreur : veille conservée ; Le réveiller reprend la même iframe");

  await page.getByRole("button", { name: "Prendre le contrôle", exact: true }).click();
  await page.getByRole("button", { name: "Rendre la main à l'agent", exact: true }).waitFor();
  const beforeClose = calls.filter((c) => c.method === "POST" && c.query === "?view_only=1").length;
  await page.evaluate(() => window.harness.setOpen(false));
  await wait(() => calls.filter((c) => c.method === "POST" && c.query === "?view_only=1").length === beforeClose + 1);
  await page.evaluate(() => window.harness.setOpen(true));
  await frame.waitFor({ state: "visible" });
  assert.equal(count("/screen-url"), 1, "fermer et rouvrir réutilise le lien");
  holdList = true; waitingList = undefined;
  await tab("competences");
  await page.getByText("Compétence en cache", { exact: true }).waitFor();
  assert.equal(await page.getByText("Lecture…", { exact: true }).count(), 0);
  await wait(() => !!waitingList);
  waitingList(); holdList = false;
  await tab("computer");
  await frame.waitFor({ state: "visible" });
  console.log("6. fermeture pendant la prise en main : restitution G7.7 ; réouverture avec le lien en cache");

  await page.evaluate(() => window.harness.setId("a2"));
  await wait(() => calls.some((c) => c.path === "/api/agents/a2/screen-url"));
  await frame.waitFor({ state: "visible" });
  assert.match(await frame.getAttribute("src"), /\/a2\/screen\//);
  await page.evaluate(() => window.harness.forgetSeen());
  const beforeForget = count("/screen-url");
  await page.evaluate(() => window.harness.screenUrl("a2"));
  assert.equal(count("/screen-url"), beforeForget + 1);
  assert.deepEqual(errors, []);
  console.log("7. liens séparés par agent et oubliés au changement de compte ; aucune erreur React");

  // Deux reconnexions locales pendant que les sondes serveur continuent de répondre « pret ».
  const beforeReconnect = count("/screen-status");
  const beforeReconnectLoads = frameLoads;
  for (let i = 0; i < 2; i++) {
    await frame.evaluate((el) => { el.contentDocument.documentElement.className = "noVNC_reconnecting"; });
    await advance(3000);
    await advance(3000);
    assert.equal(await page.getByText("Écran injoignable", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Aucune page ouverte", { exact: true }).count(), 0);
    await frame.evaluate((el) => { el.contentDocument.documentElement.className = "noVNC_connected"; });
    await advance(3000);
    await frame.waitFor({ state: "visible" });
  }
  assert.equal(count("/screen-status"), beforeReconnect + 6);
  assert.equal(frameLoads, beforeReconnectLoads);
  console.log("8. deux reconnexions noVNC avec statut pret : jamais Écran injoignable, même iframe sans rechargement");

  const beforeRefresh = frameLoads;
  const beforeRefreshLinks = count("/screen-url");
  await page.getByRole("button", { name: "Rafraîchir l'écran", exact: true }).click();
  await wait(() => frameLoads === beforeRefresh + 1);
  assert.equal(count("/screen-url"), beforeRefreshLinks, "rafraîchir conserve le lien en cache");
  assert.equal(await page.evaluate(() => document.querySelector('iframe') !== null), true);
  await frame.waitFor({ state: "visible" });
  console.log("9. Rafraîchir l'écran recharge réellement le document noVNC avec le même lien en cache");

  // Un refus de la page invalide le lien ; les erreurs de statut précédentes ne l'ont jamais invalidé.
  const beforeRefusal = count("/screen-url");
  const beforeRefusalLoads = frameLoads;
  refuseFrame = true;
  await frame.evaluate((el) => el.contentWindow.location.reload());
  await advance(3000);
  await wait(() => frameLoads >= beforeRefusalLoads + 2);
  await advance(3000);
  await wait(() => count("/screen-url") > beforeRefusal);
  refuseFrame = false;
  await advance(6000);
  await advance(12_000);
  await frame.waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.querySelector('iframe') !== null), true);
  assert.deepEqual(errors, []);
  console.log("10. refus HTTP de la page : lien relu puis rétabli, sans démontage du composant");

  await advance(0);
  const beforeBackground = count("/screen-status");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await advance(12_000);
  assert.equal(count("/screen-status"), beforeBackground);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await wait(() => count("/screen-status") > beforeBackground);
  assert.deepEqual(errors, []);
  console.log("11. navigateur en arrière-plan : aucune relève ; retour visible : reprise immédiate");

  await tab("routines");
  const modeGroup = page.getByRole("radiogroup", { name: "Ce qu'il fait de lui-même" });
  await modeGroup.waitFor();
  for (const refusal of [401, 403]) {
    await tab("computer");
    refuseProactive = refusal;
    await tab("routines");
    await page.getByText("Réglage refusé", { exact: true }).waitFor();
    assert.equal(await modeGroup.count(), 0);
    assert.equal(await page.evaluate(() => window.harness.SEEN.has("/api/agents/a2/proactif")), false);
    refuseProactive = 0;
    await tab("computer");
    await tab("routines");
    await modeGroup.waitFor();
  }
  console.log("12. proactivité : 401 et 403 effacent le réglage affiché et son cache, puis une lecture autorisée le rétablit");

  const cachedScreens = () => page.evaluate(() => [...window.harness.SEEN.keys()].filter((key) => key.endsWith("/screen-url")));
  await page.evaluate(() => Promise.all([window.harness.screenUrl("a1"), window.harness.screenUrl("a2")]));
  assert.equal((await cachedScreens()).length, 2);
  await page.evaluate(() => window.harness.request("/api/pairing/flow/poll")); // 200 : nouvelle connexion, sans forgetSeen préalable
  assert.deepEqual(await cachedScreens(), [], "le changement d'epoch local purge tous les liens");
  await page.evaluate(() => window.harness.screenUrl("a2"));
  assert.equal((await cachedScreens()).length, 1);
  await page.evaluate(() => {
    localStorage.setItem("noah-auth-epoch", String(Number(localStorage.getItem("noah-auth-epoch")) + 1));
    window.dispatchEvent(new StorageEvent("storage", { key: "noah-auth-epoch" }));
  });
  assert.deepEqual(await cachedScreens(), [], "une connexion dans un autre onglet purge aussi les liens");
  assert.deepEqual(errors, []);
  console.log("13. chaque nouvel epoch, dans cet onglet ou un autre, purge réellement tous les liens sensibles de SEEN");

  await tab("computer");
  await frame.waitFor({ state: "visible" });
  await advance(0);
  // Deux séries séparées par un vrai document noVNC : le compteur doit repartir à zéro.
  for (let round = 0; round < 2; round++) {
    wrongFrame = true;
    await frame.evaluate((el) => el.contentWindow.location.reload());
    await wait(() => frame.evaluate((el) => !!el.contentDocument?.getElementById("screen-error")));
    const beforeWrong = frameNavigations;
    const beforeWrongLinks = count("/screen-url");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await advance(3000);
      await wait(() => frameNavigations === beforeWrong + attempt);
      assert.equal(await page.getByText("Écran injoignable", { exact: true }).count(), attempt === 3 ? 1 : 0);
    }
    await page.getByRole("button", { name: "Réessayer", exact: true }).waitFor();
    assert.equal(count("/screen-url"), beforeWrongLinks, "un document 200 invalide ne refuse pas le lien");
    for (const [delay, extra] of [[3000, 1], [6000, 2], [12_000, 3]]) {
      const beforeDelay = frameNavigations;
      await advance(delay - 1);
      assert.equal(frameNavigations, beforeDelay, "les rechargements respectent le délai de reprise");
      await advance(1);
      await wait(() => frameNavigations === beforeWrong + 3 + extra);
      await page.getByText("Écran injoignable", { exact: true }).waitFor();
    }
    wrongFrame = false;
    await advance(12_000);
    await wait(() => frame.evaluate((el) => !!el.contentDocument?.getElementById("noVNC_setting_view_only")));
    await advance(12_000); // la relève qui confirme le rétablissement garde encore le délai de reprise
    await frame.waitFor({ state: "visible" });
  }
  console.log("14. document 200 sans noVNC : injoignable au troisième rechargement, délais 3/6/12 s, retour automatique et compteur réinitialisé");

  for (const stopped of ["paused", "dead", "restarting"]) {
    state = "veille";
    await advance(3000);
    await page.getByText("Le navigateur est en veille", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Redémarrer le navigateur", exact: true }).count(), 0);
    containerState = stopped;
    await advance(3000);
    await advance(3000);
    await page.getByText("Écran injoignable", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Réessayer", exact: true }).click();
    await advance(0);
    await page.getByText("Écran injoignable", { exact: true }).waitFor();
    const beforeRestart = count("/browser/restart", "POST");
    const beforeWake = count("/browser/wake", "POST");
    const beforeRestartLoads = frameNavigations;
    const restart = page.getByRole("button", { name: "Redémarrer le navigateur", exact: true });
    assert.equal(await restart.isEnabled(), true, `${stopped} : redémarrage accessible même avec awake=false`);
    await restart.click();
    await frame.waitFor({ state: "visible" });
    assert.equal(count("/browser/restart", "POST"), beforeRestart + 1);
    assert.equal(count("/browser/wake", "POST"), beforeWake);
    assert.equal(frameNavigations, beforeRestartLoads, "le redémarrage ne recharge pas le document noVNC existant");
  }
  assert.deepEqual(errors, []);
  console.log("15. états paused/dead/restarting simulés : Réessayer reste disponible, Redémarrer appelle la route existante et rétablit l'écran");
  console.log("écran dans Chromium : tout est vert");
} finally {
  await browser?.close();
  await server.close();
}
