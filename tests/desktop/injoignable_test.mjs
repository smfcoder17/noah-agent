// Serveur injoignable (capture de Franck : adresse fausse, « nouvel essai toutes les 5 secondes » sans issue).
// Vrai main.js, surfaces Electron simulées : l'écran propose « Changer de serveur », les essais s'espacent (5, 15, 30,
// puis 60 s), le retour à l'accueil efface l'adresse et le jeton, et l'ancien jeton ne part jamais vers la nouvelle adresse.
//   node tests/desktop/injoignable_test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { fakeElectron } from "./electron_factice.mjs";

const require = createRequire(import.meta.url);
const mainPath = require.resolve("../../desktop/main.js");
const OLD = "http://localhost:8080", NEW = "https://noah.exemple.com";
const base = mkdtempSync(join(tmpdir(), "noah-injoignable-"));
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((ok) => setImmediate(ok)); };

try {
  const ui = fakeElectron(), loaded = [], scripts = [], fetches = [], cookies = [], removed = [], dialogs = [];
  ui.win.contentView.children.clear();
  const seal = (s) => Buffer.from(`scelle:${s}`);
  writeFileSync(join(base, "config.json"), JSON.stringify({ mode: "remote", server: OLD, jeton: seal("jeton-ancien").toString("base64") }));
  ui.app = { getPath: () => base, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => "0.0.0" };
  ui.nativeTheme = { shouldUseDarkColors: false };
  ui.BrowserWindow = class { constructor() { return ui.win; } };
  ui.win.getNormalBounds = () => ({ width: 1200, height: 820 });
  ui.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => seal(s),
    decryptString: (b) => b.toString().replace(/^scelle:/, ""),
  };
  ui.dialog = { showMessageBox: async (_w, options) => { dialogs.push(options); return { response: 0 }; } };
  ui.shell = { openExternal: () => {} };
  const FakeView = ui.WebContentsView;
  ui.WebContentsView = class extends FakeView {
    constructor(options) {
      super(options);
      this.webContents.loadURL = async (url) => { loaded.push(url); this.webContents.mainFrame.url = url; this.webContents.emit("did-finish-load"); };
      this.webContents.setUserAgent = () => {};
      this.webContents.executeJavaScript = async (js) => { scripts.push(js); };
    }
  };
  Object.assign(ui.session.defaultSession, {
    getUserAgent: () => "Noah test", setUserAgent() {}, webRequest: { onBeforeRequest() {} },
    clearStorageData: async () => {},
    cookies: {
      get: async ({ url }) => (url === OLD ? [{ value: "jeton-ancien" }] : []),
      set: async (c) => { cookies.push(c); },
      remove: async (url, name) => { removed.push([url, name]); },
    },
  });
  // Réseau : l'ancienne adresse ne répond jamais ; la nouvelle accepte l'appairage.
  const fetch = async (url, options = {}) => {
    fetches.push({ url, method: options.method || "GET", headers: options.headers || {}, body: options.body || "" });
    if (url.startsWith(OLD)) throw new TypeError("fetch failed");
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url === `${NEW}/api/pairing/flow`) return json({ adresse: `${NEW}/#autoriser=abc`, sondage: "s1", expire: 60 });
    if (url === `${NEW}/api/pairing/flow/poll`) return json({ token: "jeton-nouveau" });
    if (url === `${NEW}/api/status`) return json({});
    throw new Error(`requête inattendue : ${url}`);
  };
  // Minuteries : les nouveaux essais (≥ 5 s) sont retenus et déclenchés à la main ; les autres partent tout de suite.
  const timers = new Map();
  let nextId = 1;
  const fakeSetTimeout = (fn, ms = 0) => {
    const id = nextId++;
    if (ms >= 5000) timers.set(id, { fn, ms });
    else setTimeout(fn, 0);
    return id;
  };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const fire = async () => {
    const [[id, timer]] = [...timers];
    timers.delete(id);
    timer.fn();
    await settle();
  };
  const view = () => [...ui.win.contentView.children].find((v) => v.options?.webPreferences?.preload);
  const lastStatus = () => scripts.filter((s) => s.includes("getElementById('s')")).at(-1) || "";
  const readConfig = () => JSON.parse(readFileSync(join(base, "config.json"), "utf8"));
  const modules = {
    electron: ui, "./fichiers": {}, "./noah": {}, "./actions": { configure() {} }, "./dossiers": {},
    "./bandeau": { create() {} }, "./autonomie": require("../../desktop/autonomie.js"),
    "./config": require("../../desktop/config.js"), "./demarrage": require("../../desktop/demarrage.js"),
    "./permissions": require("../../desktop/permissions.js"), "./textes": require("../../desktop/textes.js"),
    "./claude": require("../../desktop/claude.js"), "./chatgpt": require("../../desktop/chatgpt.js"), "./grok": require("../../desktop/grok.js"), "./usage": require("../../desktop/usage.js"), "./liens": require("../../desktop/liens.js"), "./maj": require("../../desktop/maj.js"),
  };
  modules["./textes"].choisir("fr");
  runInNewContext(`${readFileSync(mainPath, "utf8")}\ncreateWindow();`, {
    require: (id) => modules[id] ?? require(id), __dirname: join(mainPath, ".."),
    process, URL, Buffer, AbortSignal, fetch, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  });
  await settle();

  // 1. L'écran d'attente porte les deux boutons ; en échec, les deux sont visibles et le texte dit quoi faire.
  const html = decodeURIComponent(loaded[0].replace(/^data:text\/html;charset=utf-8,/, ""));
  assert.match(html, /<button id="r" hidden[^>]*>Réessayer<\/button>/);
  assert.match(html, /<button id="c" hidden onclick="location.hash='changer-'\+Date.now\(\)">Changer de serveur<\/button>/);
  assert.match(lastStatus(), /ne répond pas : nouvel essai dans 5 s\. Si cette adresse n'est pas la bonne, choisis « Changer de serveur »/);
  assert.match(lastStatus(), /getElementById\('r'\)\.hidden=false/);
  assert.match(lastStatus(), /getElementById\('c'\)\.hidden=false/);
  console.log("OK serveur injoignable : « Réessayer » et « Changer de serveur » visibles, la phrase dit quoi faire");

  // 2. Les essais s'espacent : 5 s, 15 s, 30 s, puis 60 s, et plus jamais une boucle à 5 s.
  const delays = [[...timers.values()][0].ms];
  for (let i = 0; i < 5; i++) {
    await fire();
    assert.equal(timers.size, 1, "un seul essai prévu à la fois");
    delays.push([...timers.values()][0].ms);
  }
  assert.deepEqual(delays, [5000, 15000, 30000, 60000, 60000, 60000]);
  assert.match(lastStatus(), /nouvel essai dans 60 s/);
  console.log(`OK nouveaux essais espacés : ${delays.map((d) => d / 1000).join(", ")} s`);

  // 3. Une page du serveur ne déclenche pas le changement par son adresse ; l'écran local, si.
  view().webContents.emit("did-navigate-in-page", {}, `${OLD}/#changer-1`);
  await settle();
  assert.equal(dialogs.length, 0);
  view().webContents.emit("did-navigate-in-page", {}, `${loaded.at(-1)}#changer-1731600000000`);
  await settle();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].detail, /Tes agents et leurs données ne bougent pas/);

  // 4. Retour à l'accueil : adresse et jeton effacés, plus aucun essai prévu, écran « Sur mon serveur / Sur cet ordinateur ».
  const config = readConfig();
  assert.equal(config.mode, null);
  assert.equal(config.server, null);
  assert.equal(config.jeton, null);
  assert.equal(timers.size, 0, "plus de nouvel essai vers l'adresse oubliée");
  assert.ok(view().file.endsWith("setup.html"), view().file);
  assert.deepEqual(removed, [[OLD, "noah_session"]]);
  // La révocation de l'ancienne session n'a pu partir : gardée, chiffrée, pour l'ancienne adresse seulement.
  assert.deepEqual(config.a_revoquer.map((r) => r.server), [OLD]);
  assert.ok(!JSON.stringify(config).includes("jeton-ancien"), "jamais en clair sur le disque");
  console.log("OK « Changer de serveur » : adresse et jeton effacés, essais arrêtés, écran de départ affiché");

  // 5. Nouvelle adresse : l'ancien jeton n'y part jamais, ni en en-tête, ni en cookie, ni dans un corps.
  const fromSetup = { senderFrame: { url: view().webContents.mainFrame.url } };
  const result = await ui.handlers.get("noah:setup-authorize")(fromSetup, NEW);
  await settle();
  assert.equal(result.ok, true, JSON.stringify(result));
  const toNew = fetches.filter((f) => f.url.startsWith(NEW));
  assert.ok(toNew.length >= 3);
  for (const f of toNew) {
    assert.ok(!JSON.stringify(f.headers).includes("jeton-ancien") && !f.body.includes("jeton-ancien"), f.url);
    assert.equal(f.headers.Authorization, undefined, f.url);
  }
  assert.ok(fetches.filter((f) => JSON.stringify(f.headers).includes("jeton-ancien")).every((f) => f.url.startsWith(OLD)));
  assert.deepEqual(cookies.map((c) => [c.url, c.value]), [[NEW, "jeton-nouveau"]]);
  assert.equal(loaded.at(-1), NEW);
  assert.equal(readConfig().server, NEW);
  console.log("OK nouvelle adresse : l'ancien jeton n'y est jamais envoyé, seule la nouvelle session est posée");
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log("Serveur injoignable : tout tient.");
