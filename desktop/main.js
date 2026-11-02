// Noah Agent, application de bureau : relie l'ordinateur à Noah, sur un serveur (VPS) ou démarré ici avec Docker,
// ouvre son interface dans une fenêtre,
// reste dans la zone de notification pour que les routines continuent, et donne le vrai sélecteur de dossier.
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session, shell, Tray } = require("electron");
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

// Serveur injoignable (démarrage, ou coupé pendant l'usage) : nouvel essai toutes les 5 s, sans redemander
// l'appairage (la session reste dans le trousseau). G3.6 : reconnecté moins de 30 s après le retour du serveur.
const RECONNECT_MS = 5000;
let reconnect = null;
function reconnectLater() {
  clearTimeout(reconnect);
  reconnect = setTimeout(() => {
    reconnect = null;
    if (readConfig().mode === "remote") boot();
  }, RECONNECT_MS);
}

async function boot() {
  clearTimeout(reconnect);
  reconnect = null;
  const config = readConfig();
  // Premier lancement (et pas une copie de développement avec Docker sous la main) : où vit Noah ?
  if (!config.mode && !isNoahHome(path.resolve(__dirname, ".."))) {
    origin = "";
    return win.loadFile(path.join(__dirname, "setup.html"));
  }
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`);
  if (config.mode === "remote") {
    if (serverOrigin(config.server || "") !== config.server) {
      // Adresse en http vers un serveur public (relié par une ancienne version) : on ne renvoie surtout pas la session
      // en clair pour la révoquer. On l'oublie ici ; l'écran de connexion dit de la déconnecter depuis Réglages.
      await forgetServer({ revoke: false });
      win.webContents.once("did-finish-load", () =>
        win.webContents.executeJavaScript(`document.getElementById("error").textContent = ${JSON.stringify(
          "Ton serveur était relié en http (non chiffré). Relie-le en https, puis déconnecte l'ancienne session dans Réglages → Appareils.",
        )}`).catch(() => {}),
      );
      return;
    }
    return openRemote(config.server);
  }
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
  const generation = pairingGeneration;
  const token = storedToken(); // capturé avec son serveur, avant toute attente
  const stale = () => generation !== pairingGeneration || readConfig().server !== server;
  status("Connexion à ton serveur…");
  try {
    const r = await fetch(`${server}/api/status`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    if (stale()) return;
    status(`Ton serveur (${server}) ne répond pas. Nouvel essai automatique toutes les 5 secondes…`, true);
    return reconnectLater();
  }
  if (stale()) return; // serveur changé pendant l'attente : ce démarrage ne pose plus rien
  if (token) await useToken(server, token);
  if (stale()) {
    // Serveur oublié pendant la pose du cookie : on le retire, rien de l'ancien serveur ne se rouvre.
    await session.defaultSession.cookies.remove(server, "apollo_session").catch(() => {});
    return;
  }
  origin = new URL(server).origin;
  await win.loadURL(server);
}

/**
 * Adresse du serveur. HTTPS obligatoire : en http, la session passerait en clair sur le réseau. Seule exception, une
 * adresse locale ou privée (Noah sur ce PC ou sur la box de la maison), comme l'app mobile.
 */
function serverOrigin(raw) {
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    const local = /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return u.origin;
  } catch {
    return null;
  }
}
const BAD_ADDRESS = { error: "Indique une adresse en https:// (exemple : https://noah.exemple.com). Le http n'est accepté que sur ton réseau local." };
const deviceName = () => `Ordinateur ${os.hostname()}`;
/** Même origine exacte que le serveur de Noah (un préfixe accepterait https://noah.exemple.com.evil.net). */
function sameOrigin(url) {
  try {
    return !!origin && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

const jsonHeaders = () => ({ "Content-Type": "application/json", "X-Noah-Version": app.getVersion() });

/** Session de cet appareil : chiffrée par le système (safeStorage : DPAPI sous Windows, Trousseau sous macOS,
 * libsecret sous Linux) dans config.json. Jamais en clair sur le disque. */
function storedToken() {
  const sealed = readConfig().jeton;
  if (!sealed || !secureStorage()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(sealed, "base64"));
  } catch {
    return null;
  }
}

/**
 * Chiffrement vraiment protégé par le système. Sous Linux sans trousseau (ni GNOME Keyring ni KWallet), Electron se
 * rabat sur « basic_text », une clé écrite en dur dans Chromium : autant dire en clair. On refuse alors de ranger.
 */
function secureStorage() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return !(process.platform === "linux" && safeStorage.getSelectedStorageBackend?.() === "basic_text");
}

/** Cookie de session de la fenêtre, sans date d'expiration : Chromium ne l'écrit pas sur le disque. */
async function useToken(server, token) {
  await session.defaultSession.cookies.set({
    url: server, name: "apollo_session", value: token, httpOnly: true, secure: server.startsWith("https:"), sameSite: "lax",
  });
}

const NO_KEYRING = { error: "Le trousseau du système n'est pas disponible : impossible de ranger la session en sécurité. "
  + "Sous Linux, installe et déverrouille GNOME Keyring (gnome-keyring) ou KWallet, puis relance l'app." };

async function adopt(server, token) {
  if (!secureStorage()) {
    await revokeOrQueue(server, token); // trousseau perdu entre-temps : la session ne reste pas ouverte
    return NO_KEYRING;
  }
  writeConfig({ mode: "remote", server, jeton: safeStorage.encryptString(token).toString("base64") });
  boot();
  return { ok: true };
}

/** Flux navigateur (Nextcloud Login Flow v2) : l'app ouvre Noah dans le navigateur, l'utilisateur autorise
 * l'appareil, l'app sonde jusqu'à recevoir sa session. Le mot de passe n'est jamais tapé dans l'app. */
async function authorize(rawServer) {
  const server = serverOrigin(rawServer);
  if (!server) return BAD_ADDRESS;
  if (!secureStorage()) return NO_KEYRING; // vérifié avant : le serveur ne crée pas une session qu'on ne pourrait ranger
  const generation = ++pairingGeneration; // un « Changer de serveur » pendant la requête suivante l'annule
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
  if (generation !== pairingGeneration) return { error: "Appairage annulé." };
  // N'ouvrir que la page d'accord de ce serveur : jamais une adresse arbitraire choisie par le serveur (file:, ms-msdt:…).
  if (typeof start.adresse !== "string" || !start.adresse.startsWith(`${server}/#autoriser=`)) {
    return { error: "Réponse inattendue du serveur." };
  }
  shell.openExternal(start.adresse);
  win?.webContents.send("noah:setup-ask-number");
  return waitForApproval(server, start.sondage, start.expire, "", generation, true);
}


/** Secours : le code court de Réglages → Appareils. */
async function pair(rawServer, rawCode) {
  const server = serverOrigin(rawServer);
  if (!server) return BAD_ADDRESS;
  if (!secureStorage()) return NO_KEYRING;
  const generation = ++pairingGeneration;
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
  if (generation !== pairingGeneration) return { error: "Appairage annulé." };
  if (r.ok && body.attente) return waitForApproval(server, body.sondage, body.expire, body.verification, generation);
  return { error: body.detail || `Le serveur a refusé (${r.status}).` };
}

/**
 * Le serveur rend la session quand l'utilisateur a autorisé cet ordinateur depuis un appareil déjà relié, en recopiant
 * le nombre affiché ici. On sonde jusqu'au refus ou à l'expiration (410) ; une coupure, une mise à jour du serveur (503)
 * ou un ralentissement (429) ne font qu'attendre.
 */
let typedNumber = ""; // voir « noah:setup-number »
let pairingGeneration = 0; // change à chaque appairage et à chaque oubli : une attente plus ancienne n'adopte rien

async function waitForApproval(server, sondage, expire, verification, generation, askNumber = false) {
  if (!askNumber) win?.webContents.send("noah:setup-waiting", String(verification || ""));
  typedNumber = "";
  const until = Date.now() + (expire || 1200) * 1000;
  activePoll = { server, sondage }; // si l'app se ferme pendant l'attente, un dernier sondage récupère et révoque
  try {
    return await pollUntil(server, sondage, until, generation);
  } finally {
    if (activePoll?.sondage === sondage) activePoll = null;
  }
}

/** Attente d'accord en cours : la fermeture de l'app ne doit pas laisser une session créée au dernier sondage. */
let activePoll = null;

async function pollUntil(server, sondage, until, generation) {
  while (Date.now() < until && generation === pairingGeneration) {
    await new Promise((ok) => setTimeout(ok, 2000));
    let r;
    try {
      r = await fetch(`${server}/api/pairing/flow/poll`, {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ sondage, verification: typedNumber }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      continue;
    }
    if (r.status === 410) return { error: "Demande refusée ou expirée. Recommence." };
    if (r.status === 403) return { error: "Ce nombre ne correspond pas à celui du navigateur. Recommence." };
    if (r.status === 426) return { error: "Cette version de l'app est trop ancienne pour ton serveur Noah : mets-la à jour." };
    if (!r.ok) continue;
    const body = await r.json().catch(() => ({}));
    if (body.token) {
      if (generation !== pairingGeneration) {
        // Serveur oublié ou autre appairage lancé entre-temps : cette session arrive trop tard, on la révoque.
        await revokeOrQueue(server, body.token);
        return { error: "Appairage annulé." };
      }
      return adopt(server, body.token);
    }
  }
  return { error: "Pas d'accord dans les 20 minutes. Recommence." };
}

/** Dernier sondage à la fermeture : une session créée sans qu'on ait lu la réponse est relue puis révoquée. */
async function revokeLastPoll({ server, sondage }) {
  const r = await fetch(`${server}/api/pairing/flow/poll`, {
    method: "POST", headers: jsonHeaders(), body: JSON.stringify({ sondage, verification: typedNumber }),
    signal: AbortSignal.timeout(3000),
  });
  const body = await r.json().catch(() => ({}));
  if (body.token) await revokeOrQueue(server, body.token);
}

/** Révoque une session sur le serveur ; sans réponse, elle est gardée (chiffrée) dans la file rejouée plus tard. */
async function revokeOrQueue(server, token) {
  // Gardée en mémoire dès le début (la fermeture de l'app attend aussi les envois en cours), jusqu'à réussir ou être
  // rangée chiffrée dans la file sur disque.
  const item = { server, token };
  unsealedRevocations.push(item);
  const r = await fetch(`${server}/api/devices/self`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (r && (r.ok || r.status === 401)) return forgetItem(item);
  if (!secureStorage()) return; // trousseau disparu : jamais écrit en clair, reste en mémoire et sera rejouée
  const sealed = safeStorage.encryptString(token).toString("base64");
  writeConfig({ a_revoquer: (readConfig().a_revoquer || []).concat([{ server, jeton: sealed }]) });
  forgetItem(item);
}

/**
 * Sessions à révoquer pas encore rangées sur disque : envoi en cours, ou trousseau perdu (impossible de les chiffrer).
 * Rejouées tant que l'app tourne, et une dernière fois à sa fermeture. Sans trousseau ni réseau jusqu'à la fermeture,
 * la session reste valable sur le serveur : elle se révoque alors depuis Réglages → Appareils sur un autre appareil.
 */
const unsealedRevocations = [];
const forgetItem = (item) => {
  const i = unsealedRevocations.indexOf(item);
  if (i >= 0) unsealedRevocations.splice(i, 1);
};
let lastTry = false; // dernier envoi tenté à la fermeture de l'app

/** Révocations qui n'ont pas pu partir (serveur injoignable) : gardées chiffrées, rejouées jusqu'à réussir. */
let flushing = false;
async function flushRevocations() {
  if (flushing) return;
  flushing = true;
  try {
    await flushOnce();
  } finally {
    flushing = false;
  }
}

async function flushOnce() {
  for (const item of [...unsealedRevocations]) { // copie : un élément ne quitte la liste qu'une fois révoqué
    const r = await fetch(`${item.server}/api/devices/self`, {
      method: "DELETE", headers: { Authorization: `Bearer ${item.token}` }, signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (r && (r.ok || r.status === 401)) forgetItem(item);
  }
  const pending = readConfig().a_revoquer || [];
  const done = new Set();
  for (const item of pending) {
    if (serverOrigin(item.server || "") !== item.server) {
      done.add(item.jeton); // http public : on n'envoie pas la session en clair, on l'abandonne
      continue;
    }
    let ok = false;
    try {
      const token = safeStorage.decryptString(Buffer.from(item.jeton, "base64"));
      const r = await fetch(`${item.server}/api/devices/self`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
      });
      ok = r.ok || r.status === 401; // 401 : la session n'existe déjà plus
    } catch {
      ok = false;
    }
    if (ok) done.add(item.jeton);
  }
  // Relue juste avant d'écrire : un « Oublier » fait pendant les envois ajoute à la file, il ne doit pas se perdre.
  writeConfig({ a_revoquer: (readConfig().a_revoquer || []).filter((item) => !done.has(item.jeton)) });
}

/** Oublie le serveur (ou Docker) choisi : l'écran du premier lancement revient. */
async function changeServer() {
  const r = await dialog.showMessageBox(win, {
    type: "question", title: "Changer de serveur", message: "Relier cette app à un autre Noah ?",
    detail: "Cet ordinateur sera déconnecté du Noah actuel. Tes agents et leurs données ne bougent pas.",
    buttons: ["Changer", "Annuler"], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (r.response !== 0) return;
  await forgetServer();
}

/** Oublie le serveur : la session disparaît aussi côté serveur (si l'appel échoue, on oublie quand même ici). */
let forgetting = Promise.resolve();
/** Un oubli à la fois : un double clic ne lance pas deux oublis qui se marchent dessus. */
function forgetServer(options) {
  // La cible est fixée à la demande : un oubli en file ne révoque pas un appairage fait après lui.
  const { server: asked, jeton: askedToken } = readConfig();
  forgetting = forgetting.then(() => forgetOnce(options, asked, askedToken), () => forgetOnce(options, asked, askedToken));
  return forgetting;
}

async function forgetOnce({ revoke = true } = {}, asked, askedToken) {
  const { server, jeton: sealedToken } = readConfig();
  if (server !== asked || sealedToken !== askedToken) return; // déjà oublié, ou nouvel appairage depuis la demande
  pairingGeneration++; // toute attente d'accord en cours est abandonnée
  const token = storedToken();
  if (server && revoke && sealedToken && !token) {
    // Trousseau indisponible : on ne peut pas la lire maintenant, mais elle reste chiffrée. Gardée telle quelle dans
    // la file, elle sera révoquée quand le trousseau reviendra.
    writeConfig({ a_revoquer: (readConfig().a_revoquer || []).concat([{ server, jeton: sealedToken }]) });
  }
  if (server) {
    // La fenêtre peut utiliser une autre session que celle rangée par l'app (déconnexion puis reconnexion dans
    // l'interface) : on révoque les deux.
    const cookie = (await session.defaultSession.cookies.get({ url: server, name: "apollo_session" }).catch(() => []))[0]?.value;
    const tokens = [...new Set([token, cookie].filter(Boolean))];
    // Notifications et marqueur de session de la page : rien de l'ancien compte ne reste lisible ici.
    await win?.webContents.executeJavaScript(
      "navigator.serviceWorker?.getRegistration().then((r) => r?.getNotifications()).then((l) => (l || []).forEach((n) => n.close())).catch(() => {})",
    ).catch(() => {});
    await session.defaultSession.clearStorageData({ origin: server, storages: ["cachestorage", "serviceworkers"] }).catch(() => {});
    for (const t of revoke ? tokens : []) await revokeOrQueue(server, t); // sans réponse : gardée pour plus tard
    await session.defaultSession.cookies.remove(server, "apollo_session");
  }
  // Un nouvel appairage a pu se terminer pendant les révocations : sa configuration n'est pas celle qu'on oublie.
  const now = readConfig();
  if (now.server !== server || now.jeton !== sealedToken) return;
  writeConfig({ mode: null, server: null, jeton: null });
  origin = "";
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
  // Requêtes (images comprises) vers l'hôte du serveur sur un autre port : bloquées. Le cookie de session ne
  // distingue pas les ports (RFC 6265 §8.5) ; il ne doit partir que vers l'adresse exacte du serveur.
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    let cancel = false;
    try {
      const u = new URL(details.url), home = origin ? new URL(origin) : null;
      // WebSocket compris : sa poignée de main emporte aussi le cookie. wss:443 = https:443 pour la comparaison.
      const scheme = { "ws:": "http:", "wss:": "https:" }[u.protocol] || u.protocol;
      const port = u.port || (scheme === "https:" ? "443" : "80");
      const homePort = home && (home.port || (home.protocol === "https:" ? "443" : "80"));
      cancel = !!home && /^(https?|wss?):$/.test(u.protocol) && u.hostname === home.hostname
        && !(scheme === home.protocol && port === homePort);
    } catch {
      cancel = false;
    }
    done({ cancel });
  });
  // Liens externes : dans le navigateur de l'utilisateur, jamais dans la fenêtre de Noah.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("data:") || url.startsWith("file:") || sameOrigin(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  // Page du serveur qui ne charge plus (serveur coupé, réseau perdu) : écran d'attente, puis reconnexion seule.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, mainFrame) => {
    if (!mainFrame || code === -3 || readConfig().mode !== "remote" || !sameOrigin(url)) return; // -3 : navigation annulée
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`).then(() => {
      status("Connexion au serveur perdue. Reconnexion automatique…", true);
      reconnectLater();
    }).catch(() => {});
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
// Nombre lu dans la page d'accord du navigateur, saisi dans l'écran de connexion de l'app.
ipcMain.handle("noah:setup-number", (e, n) => {
  if (fromSetup(e)) typedNumber = String(n).replace(/\D/g, "").slice(0, 3);
});
ipcMain.handle("noah:setup-connect", async (e, server, code) => (fromSetup(e) ? pair(String(server), String(code)) : null));
ipcMain.handle("noah:setup-authorize", async (e, server) => (fromSetup(e) ? authorize(String(server)) : null));
ipcMain.handle("noah:setup-local", async (e) => {
  if (!fromSetup(e)) return;
  pairingGeneration++; // un accord distant arrivé après ce choix est révoqué, pas adopté
  writeConfig({ mode: "local" });
  boot();
});

// Seuls deux gestes sont permis à la page : choisir un dossier (sélecteur du système) et ouvrir un dossier.
ipcMain.handle("noah:pick-folder", async (e) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return null;
  const r = await dialog.showOpenDialog(win, { title: "Dossier à confier à Noah", properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
// Téléphone : adresse de l'ordinateur sur le réseau local, et ouverture de Noah à ce réseau (après accord).
let home = "";
const lanUrl = () => {
  const ip = noah.lanAddress();
  return ip ? `http://${ip}:${noah.readEnv(home).APOLLO_PORT || 8080}` : null;
};
ipcMain.handle("noah:version", () => app.getVersion());

ipcMain.handle("noah:lan-status", async (e) => {
  if (!origin || !sameOrigin(e.senderFrame.url) || !home) return { open: false, url: null };
  return { open: noah.readEnv(home).APOLLO_BIND === "0.0.0.0", url: lanUrl() };
});
ipcMain.handle("noah:open-lan", async (e) => {
  if (!origin || !sameOrigin(e.senderFrame.url) || !home) return { open: false, url: null };
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
// Page de Noah (app reliée à un serveur) : appareil déconnecté côté serveur, l'utilisateur le relie de nouveau.
ipcMain.handle("noah:forget-server", async (e) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return;
  await forgetServer(); // en mode local aussi : l'écran « Relier de nouveau » doit toujours mener quelque part
});
ipcMain.handle("noah:open-path", async (e, p) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return;
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
      done(permission === "media" && !!origin && sameOrigin(wc.getURL()));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === "media" && !!origin && !!wc && sameOrigin(wc.getURL()));
    createTray();
    // Sessions oubliées hors ligne : révoquées dès que le serveur répond (l'app peut rester des jours ouverte).
    flushRevocations().catch(() => {});
    setInterval(() => flushRevocations().catch(() => {}), 10 * 60 * 1000);
    createWindow();
    // Demandes de l'agent (ouvrir, notifier, lancer, commande), confirmées par l'utilisateur.
    actions.listen(() => origin);
  });
  app.on("before-quit", (e) => {
    quitting = true;
    // Sessions à révoquer gardées en mémoire, ou attente d'accord en cours : dernier essai, 10 s au plus.
    if ((!unsealedRevocations.length && !activePoll) || lastTry) return;
    e.preventDefault();
    lastTry = true;
    const poll = activePoll;
    pairingGeneration++; // l'attente en cours n'adopte plus rien
    if (poll) {
      // La session a pu être créée au sondage dont on n'a pas lu la réponse : elle se relit 30 s, on la révoque.
      revokeLastPoll(poll).catch(() => {});
    }
    if (secureStorage()) {
      // Envois encore en cours : rangés chiffrés tout de suite, rejoués au prochain lancement s'ils échouent.
      const sealed = unsealedRevocations.map(({ server, token }) => ({ server, jeton: safeStorage.encryptString(token).toString("base64") }));
      writeConfig({ a_revoquer: (readConfig().a_revoquer || []).concat(sealed) });
    }
    const flush = (async () => {
      await new Promise((ok) => setTimeout(ok, poll ? 3000 : 0)); // laisse le dernier sondage mettre sa session en file
      await flushOnce();
    })();
    Promise.race([flush, new Promise((ok) => setTimeout(ok, 10000))]).catch(() => {}).finally(() => {
      if (unsealedRevocations.length && secureStorage()) {
        // Pas encore révoquées (y compris celle du dernier sondage) : rangées chiffrées, rejouées au prochain lancement.
        const sealed = unsealedRevocations.map(({ server, token }) => ({ server, jeton: safeStorage.encryptString(token).toString("base64") }));
        writeConfig({ a_revoquer: (readConfig().a_revoquer || []).concat(sealed) });
      } else if (unsealedRevocations.length) {
        // Rien d'écrit en clair : on le dit plutôt que de perdre la révocation en silence.
        dialog.showMessageBoxSync({
          type: "warning", title: "Session non révoquée", noLink: true, buttons: ["Compris"],
          message: "Cet ordinateur n'a pas pu se déconnecter de ton serveur Noah.",
          detail: "Sans trousseau système ni réseau, la session ne peut pas être gardée pour plus tard. "
            + "Sur un autre appareil, ouvre Réglages → Appareils et déconnecte cet ordinateur.",
        });
        unsealedRevocations.length = 0;
      }
      app.quit();
    });
  });
  app.on("window-all-closed", () => {}); // reste dans la zone de notification
}
