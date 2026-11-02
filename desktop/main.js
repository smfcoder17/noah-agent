// Noah Agent, application de bureau : relie l'ordinateur à Noah, sur un serveur (VPS) ou démarré ici avec Docker,
// ouvre son interface dans une fenêtre,
// reste dans la zone de notification pour que les routines continuent, et donne le vrai sélecteur de dossier.
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
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
const writeConfig = (patch) => {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ ...readConfig(), ...patch }, null, 1));
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
  writeConfig({ home: dir });
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
  const config = readConfig();
  // Premier lancement (et pas une copie de développement avec Docker sous la main) : où vit Noah ?
  if (!config.mode && !isNoahHome(path.resolve(__dirname, ".."))) {
    origin = "";
    return win.loadFile(path.join(__dirname, "setup.html"));
  }
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`);
  if (config.mode === "remote") return openRemote(config.server);
  try {
    home = await noahHome();
    // Premier lancement : on autorise le partage du dossier personnel ; le lanceur doit alors être relancé.
    const changed = noah.ensureShareRoots(home);
    const url = await noah.start(home, status, changed);
    origin = new URL(url).origin;
    await win.loadURL(url);
  } catch (e) {
    status(e.message, true);
  }
}

/** Noah sur un serveur : la fenêtre ouvre son adresse ; la session (cookie) a été posée à l'appairage. */
async function openRemote(server) {
  status("Connexion à ton serveur…");
  try {
    const r = await fetch(`${server}/api/status`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    return status(`Ton serveur (${server}) ne répond pas. Vérifie ta connexion à Internet, puis réessaie.`, true);
  }
  origin = new URL(server).origin;
  await win.loadURL(server);
}

function serverOrigin(raw) {
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    return null;
  }
}
const BAD_ADDRESS = { error: "Cette adresse n'est pas valide (exemple : https://noah.exemple.com)." };
const deviceName = () => `Ordinateur ${os.hostname()}`;
const jsonHeaders = () => ({ "Content-Type": "application/json", "X-Noah-Version": app.getVersion() });

/** La session rendue par le serveur devient le cookie de la fenêtre. Chromium le chiffre sur le disque avec la clé du
 * système (DPAPI sous Windows, Trousseau sous macOS, libsecret sous Linux). */
async function adopt(server, token) {
  await session.defaultSession.cookies.set({
    url: server, name: "apollo_session", value: token, httpOnly: true, secure: server.startsWith("https:"),
    sameSite: "lax", expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400,
  });
  writeConfig({ mode: "remote", server });
  boot();
  return { ok: true };
}

/** Flux navigateur (Nextcloud Login Flow v2) : l'app ouvre Noah dans le navigateur, l'utilisateur autorise
 * l'appareil, l'app sonde jusqu'à recevoir sa session. Le mot de passe n'est jamais tapé dans l'app. */
async function authorize(rawServer) {
  const server = serverOrigin(rawServer);
  if (!server) return BAD_ADDRESS;
  let start;
  try {
    const r = await fetch(`${server}/api/pairing/flow`, {
      method: "POST", headers: jsonHeaders(), body: JSON.stringify({ appareil: deviceName(), type: "desktop" }),
      signal: AbortSignal.timeout(20000),
    });
    start = await r.json().catch(() => ({}));
    if (!r.ok) return { error: start.detail || `Le serveur a refusé (${r.status}).` };
  } catch {
    return { error: `Impossible de joindre ${server}. Vérifie l'adresse.` };
  }
  shell.openExternal(start.adresse);
  const until = Date.now() + start.expire * 1000;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 2000));
    try {
      const r = await fetch(`${server}/api/pairing/flow/poll`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ sondage: start.sondage }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) return adopt(server, (await r.json()).token);
      if (r.status === 410) return { error: "Demande refusée ou expirée. Recommence." };
    } catch {
      /* coupure passagère : on continue de sonder */
    }
  }
  return { error: "Pas d'accord dans les 20 minutes. Recommence." };
}

/** Secours : le code court de Réglages → Appareils. */
async function pair(rawServer, rawCode) {
  const server = serverOrigin(rawServer);
  if (!server) return BAD_ADDRESS;
  let r;
  try {
    r = await fetch(`${server}/api/pairing/claim`, {
      method: "POST", headers: jsonHeaders(),
      body: JSON.stringify({ code: rawCode, appareil: deviceName(), type: "desktop" }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { error: `Impossible de joindre ${server}. Vérifie l'adresse.` };
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.token) return { error: body.detail || `Le serveur a refusé (${r.status}).` };
  return adopt(server, body.token);
}

/** Oublie le serveur (ou Docker) choisi : l'écran du premier lancement revient. */
async function changeServer() {
  const r = await dialog.showMessageBox(win, {
    type: "question", title: "Changer de serveur", message: "Relier cette app à un autre Noah ?",
    detail: "Cet ordinateur sera déconnecté du Noah actuel. Tes agents et leurs données ne bougent pas.",
    buttons: ["Changer", "Annuler"], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (r.response !== 0) return;
  const { server } = readConfig();
  if (server) {
    const cookie = (await session.defaultSession.cookies.get({ url: server, name: "apollo_session" }))[0];
    // « Oublier ce serveur » : la session disparaît aussi côté serveur (si l'appel échoue, on oublie quand même ici).
    if (cookie) await fetch(`${server}/api/devices/self`, { method: "DELETE", headers: { Authorization: `Bearer ${cookie.value}` } }).catch(() => {});
    await session.defaultSession.cookies.remove(server, "apollo_session");
  }
  writeConfig({ mode: null, server: null });
  show();
  win.loadFile(path.join(__dirname, "setup.html"));
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
    if (url.startsWith("data:") || url.startsWith("file:") || (origin && url.startsWith(origin))) return;
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
      { label: "Changer de serveur…", click: changeServer },
      { type: "separator" },
      { label: "Quitter", click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on("click", show);
}

// Écran du premier lancement (fichier local de l'app, jamais une page du serveur).
const fromSetup = (e) => e.senderFrame.url.startsWith("file:") && e.senderFrame.url.endsWith("setup.html");
ipcMain.handle("noah:setup-connect", async (e, server, code) => (fromSetup(e) ? pair(String(server), String(code)) : null));
ipcMain.handle("noah:setup-authorize", async (e, server) => (fromSetup(e) ? authorize(String(server)) : null));
ipcMain.handle("noah:setup-local", async (e) => {
  if (!fromSetup(e)) return;
  writeConfig({ mode: "local" });
  boot();
});

// Seuls deux gestes sont permis à la page : choisir un dossier (sélecteur du système) et ouvrir un dossier.
ipcMain.handle("noah:pick-folder", async (e) => {
  if (!origin || !e.senderFrame.url.startsWith(origin)) return null;
  const r = await dialog.showOpenDialog(win, { title: "Dossier à confier à Noah", properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
// Téléphone : adresse de l'ordinateur sur le réseau local, et ouverture de Noah à ce réseau (après accord).
let home = "";
const lanUrl = () => {
  const ip = noah.lanAddress();
  return ip ? `http://${ip}:${noah.readEnv(home).APOLLO_PORT || 8080}` : null;
};
ipcMain.handle("noah:lan-status", async (e) => {
  if (!origin || !e.senderFrame.url.startsWith(origin) || !home) return { open: false, url: null };
  return { open: noah.readEnv(home).APOLLO_BIND === "0.0.0.0", url: lanUrl() };
});
ipcMain.handle("noah:open-lan", async (e) => {
  if (!origin || !e.senderFrame.url.startsWith(origin) || !home) return { open: false, url: null };
  const r = await dialog.showMessageBox(win, {
    type: "question",
    title: "Ouvrir Noah à ton réseau",
    message: "Rendre Noah joignable par les appareils de ton réseau Wi-Fi ?",
    detail: "Ton téléphone pourra ouvrir Noah. La page de connexion sera visible sur ce réseau : à éviter sur un Wi-Fi public.",
    buttons: ["Ouvrir", "Annuler"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (r.response !== 0) return { open: false, url: lanUrl() };
  await noah.openToLan(home);
  return { open: true, url: lanUrl() };
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
