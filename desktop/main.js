// Noah Agent, application de bureau : démarre Noah (Docker) sur l'ordinateur, ouvre son interface dans une fenêtre,
// reste dans la zone de notification pour que les routines continuent, et donne le vrai sélecteur de dossier.
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const noah = require("./noah");
const actions = require("./actions");

let win = null;
let tray = null;
let origin = "";
let quitting = false;

const configFile = () => path.join(app.getPath("userData"), "config.json");
const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
};
const isNoahHome = (dir) => !!dir && fs.existsSync(path.join(dir, "docker-compose.yml")) && fs.existsSync(path.join(dir, "launcher"));

/** Dossier où Noah est installé : mémorisé, sinon celui du projet (développement), sinon demandé une fois. */
async function noahHome() {
  const saved = readConfig().home;
  if (isNoahHome(saved)) return saved;
  const dev = path.resolve(__dirname, "..");
  if (isNoahHome(dev)) return dev;
  const r = await dialog.showOpenDialog({
    title: "Où est installé Noah Agent ?",
    message: "Choisis le dossier qui contient docker-compose.yml (celui créé par install.sh).",
    properties: ["openDirectory"],
  });
  const dir = r.filePaths[0];
  if (!isNoahHome(dir)) throw new Error("Ce dossier ne contient pas Noah Agent (docker-compose.yml introuvable).");
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ ...readConfig(), home: dir }, null, 1));
  return dir;
}

const LOADING = `<!doctype html><meta charset="utf-8"><title>Noah Agent</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;font:15px system-ui,sans-serif;background:#faf8f5;color:#3a3530}
@media (prefers-color-scheme:dark){body{background:#1c1a18;color:#e8e2da}}
div{text-align:center;max-width:420px;padding:24px}p{opacity:.75;line-height:1.5}button{font:inherit;padding:8px 16px;border-radius:10px;border:1px solid #c9bfb3;background:transparent;color:inherit;cursor:pointer}</style>
<div><h2>Noah Agent</h2><p id="s">Démarrage…</p><button id="r" hidden onclick="location.hash='retry'">Réessayer</button></div>`;

function status(text, failed = false) {
  if (!win || win.isDestroyed()) return;
  const js = `document.getElementById('s').textContent=${JSON.stringify(text)};document.getElementById('r').hidden=${!failed};`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

async function boot() {
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`);
  try {
    const home = await noahHome();
    // Premier lancement : on autorise le partage du dossier personnel ; le lanceur doit alors être relancé.
    const changed = noah.ensureShareRoots(home);
    const url = await noah.start(home, status, changed);
    origin = new URL(url).origin;
    await win.loadURL(url);
  } catch (e) {
    status(e.message, true);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    title: "Noah Agent",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Liens externes : dans le navigateur de l'utilisateur, jamais dans la fenêtre de Noah.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("data:") || (origin && url.startsWith(origin))) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  // « Réessayer » de l'écran de démarrage.
  win.webContents.on("did-navigate-in-page", (_e, url) => {
    if (url.endsWith("#retry")) boot();
  });
  // Fermer la fenêtre la cache : Noah continue (routines, fils de travail). Quitter depuis la zone de notification.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  boot();
}

function show() {
  if (!win) return createWindow();
  win.show();
  win.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Noah Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Ouvrir Noah", click: show },
      { type: "separator" },
      { label: "Quitter", click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on("click", show);
}

// Seuls deux gestes sont permis à la page : choisir un dossier (sélecteur du système) et ouvrir un dossier.
ipcMain.handle("noah:pick-folder", async (e) => {
  if (!origin || !e.senderFrame.url.startsWith(origin)) return null;
  const r = await dialog.showOpenDialog(win, { title: "Dossier à confier à Noah", properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("noah:open-path", async (e, p) => {
  if (!origin || !e.senderFrame.url.startsWith(origin)) return;
  // Dossiers seulement : ouvrir un fichier pourrait lancer un programme.
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) await shell.openPath(p);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", show);
  app.whenReady().then(() => {
    // Micro (dictée, mode vocal) : accordé à l'interface de Noah, refusé à toute autre page.
    session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
      done(permission === "media" && !!origin && wc.getURL().startsWith(origin));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === "media" && !!origin && !!wc && wc.getURL().startsWith(origin));
    createTray();
    createWindow();
    // Demandes de l'agent (ouvrir, notifier, lancer, commande), confirmées par l'utilisateur.
    actions.listen(() => origin);
  });
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => {}); // reste dans la zone de notification
}
