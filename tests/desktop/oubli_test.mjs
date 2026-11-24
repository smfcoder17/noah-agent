// 0.4.3 : « Relier de nouveau » ne faisait rien. forgetOnce() attendait executeJavaScript(... getNotifications() ...),
// qui dans Electron ne répond jamais : la file d'oubli restait bloquée et setup.html ne revenait pas.
// Vrai main.js, surfaces Electron simulées, executeJavaScript qui ne se résout jamais.
//   node tests/desktop/oubli_test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { fakeElectron } from "./electron_factice.mjs";

const require = createRequire(import.meta.url);
const mainPath = require.resolve("../../desktop/main.js");
const SERVER = "https://noah.test";
const base = mkdtempSync(join(tmpdir(), "noah-oubli-"));
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((ok) => setImmediate(ok)); };
let sortie = 0;

try {
  const ui = fakeElectron(), loaded = [], files = [], fetches = [], removed = [];
  ui.win.contentView.children.clear();
  const seal = (s) => Buffer.from(`scelle:${s}`);
  writeFileSync(join(base, "config.json"), JSON.stringify({ mode: "remote", server: SERVER, jeton: seal("jeton-appareil").toString("base64") }));
  ui.app = { getPath: () => base, requestSingleInstanceLock: () => false, quit() {}, getVersion: () => "0.0.0" };
  ui.nativeTheme = { shouldUseDarkColors: false };
  ui.BrowserWindow = class { constructor() { return ui.win; } };
  ui.win.getNormalBounds = () => ({ width: 1200, height: 820 });
  ui.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => seal(s),
    decryptString: (b) => b.toString().replace(/^scelle:/, ""),
  };
  ui.dialog = { showMessageBox: async () => ({ response: 0 }) };
  ui.shell = { openExternal: () => {} };
  const FakeView = ui.WebContentsView;
  ui.WebContentsView = class extends FakeView {
    constructor(options) {
      super(options);
      const wc = this.webContents;
      wc.loadURL = async (url) => { loaded.push(url); wc.mainFrame.url = url; wc.emit("did-finish-load"); };
      const loadFile = wc.loadFile;
      wc.loadFile = async (file) => { files.push(file); return loadFile(file); };
      wc.getURL = () => wc.mainFrame.url;
      wc.setUserAgent = () => {};
      // Comme getNotifications() d'un service worker dans Electron : aucune réponse, jamais.
      wc.executeJavaScript = () => new Promise(() => {});
    }
  };
  Object.assign(ui.session.defaultSession, {
    getUserAgent: () => "Noah test", setUserAgent() {}, webRequest: { onBeforeRequest() {} },
    clearStorageData: async () => {},
    cookies: {
      get: async () => [{ value: "jeton-appareil" }],
      set: async () => {},
      remove: async (url, name) => { removed.push([url, name]); },
    },
  });
  // Réseau : le serveur répond vite (statut, révocation).
  const fetch = async (url, options = {}) => {
    fetches.push({ url, method: options.method || "GET" });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const readConfig = () => JSON.parse(readFileSync(join(base, "config.json"), "utf8"));
  const modules = {
    electron: ui, "./fichiers": {}, "./noah": {}, "./actions": { configure() {} }, "./dossiers": {},
    "./bandeau": { create() {} }, "./autonomie": require("../../desktop/autonomie.js"),
    "./config": require("../../desktop/config.js"), "./demarrage": require("../../desktop/demarrage.js"),
    "./permissions": require("../../desktop/permissions.js"), "./textes": require("../../desktop/textes.js"),
    "./claude": require("../../desktop/claude.js"), "./chatgpt": require("../../desktop/chatgpt.js"), "./grok": require("../../desktop/grok.js"), "./codex": require("../../desktop/codex.js"), "./installateur": require("../../desktop/installateur.js"), "./usage": require("../../desktop/usage.js"), "./liens": require("../../desktop/liens.js"), "./maj": require("../../desktop/maj.js"), "./relais": require("../../desktop/relais.js"), "./brancher": require("../../desktop/brancher.js"),
  };
  modules["./textes"].choisir("fr");
  runInNewContext(`${readFileSync(mainPath, "utf8")}\ncreateWindow();`, {
    require: (id) => modules[id] ?? require(id), __dirname: join(mainPath, ".."),
    process, URL, Buffer, AbortSignal, fetch, setTimeout, clearTimeout,
  });
  await settle();
  assert.equal(loaded.at(-1), SERVER, "la fenêtre est reliée au serveur avant l'oubli");
  assert.equal(readConfig().server, SERVER);

  const handler = ui.handlers.get("noah:forget-server");
  assert.equal(typeof handler, "function");
  const debut = Date.now();
  const fini = await Promise.race([
    handler({ senderFrame: { url: `${SERVER}/reglages` } }).then(() => true),
    new Promise((ok) => setTimeout(() => ok(false), 8000)),
  ]);
  const duree = Date.now() - debut;
  assert.equal(fini, true, "« Relier de nouveau » ne rend jamais la main (executeJavaScript bloqué)");
  assert.ok(duree < 8000, `rendu en ${duree} ms`);
  assert.ok(files.some((f) => f.endsWith("setup.html")), "setup.html n'est pas chargé");
  assert.equal(readConfig().server ?? null, null, "config.json garde encore le serveur");
  assert.equal(readConfig().jeton ?? null, null);
  assert.ok(fetches.some((f) => f.method === "DELETE" && f.url === `${SERVER}/api/devices/self`), "session non révoquée côté serveur");
  console.log(`OK oubli du serveur : executeJavaScript sans réponse, écran d'accueil de retour en ${duree} ms, serveur et jeton effacés`);
} catch (e) {
  console.error(e);
  sortie = 1;
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log(sortie ? "Oubli du serveur : ÉCHEC." : "Oubli du serveur : tout tient.");
process.exit(sortie);
