// Noah Agent, application de bureau : relie l'ordinateur à Noah, sur un serveur (VPS) ou démarré ici avec Docker,
// ouvre son interface dans une fenêtre,
// reste dans la zone de notification pour que les routines continuent, et donne le vrai sélecteur de dossier.
const fichiers = require("./fichiers");
const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, session, shell, Tray } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const noah = require("./noah");
const actions = require("./actions");
const dossiers = require("./dossiers");
const bandeau = require("./bandeau");
const permissions = require("./permissions");

let win = null;
let page = null;
let tray = null;
let origin = "";
let quitting = false;

// config.json : lu une fois, écrit d'un bloc (config.js). Une seule instance de l'app tourne, la mémoire fait donc foi.
let configStore = null;
const config = () => (configStore ??= require("./config").create(path.join(app.getPath("userData"), "config.json")));
const readConfig = () => config().read();
const writeConfig = (patch) => config().write(patch);
const autonomy = require("./autonomie").create(readConfig, writeConfig);
actions.configure({ autonomy: autonomy.get });
// Démarrage avec l'ordinateur : coupé tant que la personne ne l'a pas choisi dans le menu (demarrage.js).
const startup = require("./demarrage").create(app, readConfig, writeConfig);
function startupMenu() {
  if (!startup.available()) return [];
  return [{
    label: "Lancer Noah au démarrage de l'ordinateur", type: "checkbox", checked: startup.get(),
    click: (item) => { startup.set(item.checked); createMenu(); createTrayMenuState(); },
  }];
}
function autonomyMenu() {
  return { label: "Autonomie de cet ordinateur", submenu: [
    ...[["auto", "Auto — agir dans les dossiers confiés"], ["prudent", "Prudent — demander avant d'écrire ou ranger"]].map(([value, label]) => ({
      label, type: "radio", checked: autonomy.get() === value,
      click: () => { autonomy.set(value); createMenu(); createTrayMenuState(); },
    })),
  ] };
}
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
  page.webContents.executeJavaScript(js).catch(() => {});
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
    return page.webContents.loadFile(path.join(__dirname, "setup.html"));
  }
  await page.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`);
  if (config.mode === "remote") {
    if (serverOrigin(config.server || "") !== config.server) {
      // Adresse en http vers un serveur public (relié par une ancienne version) : on ne renvoie surtout pas la session
      // en clair pour la révoquer. On l'oublie ici ; l'écran de connexion dit de la déconnecter depuis Réglages.
      await forgetServer({ revoke: false });
      page.webContents.once("did-finish-load", () =>
        page.webContents.executeJavaScript(`document.getElementById("error").textContent = ${JSON.stringify(
          "Ton serveur était relié en http (non chiffré). Relie-le en https, puis déconnecte l'ancienne session dans Réglages → Appareils.",
        )}`).catch(() => {}),
      );
      return;
    }
    return openRemote(config.server);
  }
  announceWindow(false);
  try {
    home = await noahHome();
    // Premier lancement : on autorise le partage du dossier personnel ; le lanceur doit alors être relancé.
    const changed = noah.ensureShareRoots(home);
    const url = await noah.start(home, status, changed);
    origin = new URL(url).origin;
    await page.webContents.loadURL(url);
  } catch (e) {
    status(e.message, true);
  }
}

/**
 * Reliée à un serveur, la fenêtre s'annonce comme celle de l'app (mêmes mots que l'app Android). Une session ouverte par la
 * page elle-même (lien de QR ouvert ici, compte créé ici) reçoit alors une session de fenêtre, sans durée de vie : jamais
 * le cookie de 30 jours d'un navigateur, que Chromium écrirait en clair dans le profil. En local, rien ne change : le compte
 * n'a pas de jeton rangé pour renouveler une session courte, et sa session ne sert que sur cet ordinateur.
 */
function announceWindow(remote) {
  plainAgent ??= session.defaultSession.getUserAgent();
  const agent = remote ? `${plainAgent} NoahApp/${app.getVersion()} Desktop` : plainAgent;
  session.defaultSession.setUserAgent(agent); // service worker
  page?.webContents.setUserAgent(agent); // la fenêtre garde sinon celui qu'elle avait à sa création
}
let plainAgent = null;

/** Noah sur un serveur : la fenêtre ouvre son adresse ; la session (cookie) a été posée à l'appairage. */
async function openRemote(server) {
  announceWindow(true);
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
    await session.defaultSession.cookies.remove(server, "noah_session").catch(() => {});
    return;
  }
  origin = new URL(server).origin;
  await page.webContents.loadURL(server);
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
    url: server, name: "noah_session", value: token, httpOnly: true, secure: server.startsWith("https:"), sameSite: "lax",
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
  page?.webContents.send("noah:setup-ask-number");
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
  if (!askNumber) page?.webContents.send("noah:setup-waiting", String(verification || ""));
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
    const cookie = (await session.defaultSession.cookies.get({ url: server, name: "noah_session" }).catch(() => []))[0]?.value;
    const tokens = [...new Set([token, cookie].filter(Boolean))];
    // Notifications et marqueur de session de la page : rien de l'ancien compte ne reste lisible ici.
    await page?.webContents.executeJavaScript(
      "navigator.serviceWorker?.getRegistration().then((r) => r?.getNotifications()).then((l) => (l || []).forEach((n) => n.close())).catch(() => {})",
    ).catch(() => {});
    await session.defaultSession.clearStorageData({ origin: server, storages: ["cachestorage", "serviceworkers"] }).catch(() => {});
    for (const t of revoke ? tokens : []) await revokeOrQueue(server, t); // sans réponse : gardée pour plus tard
    await session.defaultSession.cookies.remove(server, "noah_session");
  }
  // Un nouvel appairage a pu se terminer pendant les révocations : sa configuration n'est pas celle qu'on oublie.
  const now = readConfig();
  if (now.server !== server || now.jeton !== sealedToken) return;
  writeConfig({ mode: null, server: null, jeton: null });
  origin = "";
  show();
  page.webContents.loadFile(path.join(__dirname, "setup.html"));
}

let firstWindow = true; // seule la fenêtre du lancement peut rester cachée
let crashes = []; // dates des derniers plantages du rendu
let asking = false; // une seule boîte « ne répond plus » à la fois

function createWindow() {
  const saved = readConfig().fenetre || {};
  win = new BrowserWindow({
    width: saved.largeur || 1200,
    height: saved.hauteur || 820,
    minWidth: 380,
    minHeight: 500,
    title: "Noah Agent",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    show: false, // montrée au premier chargement de la vue de Noah
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1a18" : "#faf8f5",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // La page et le bandeau ont chacun leur vue native : le bandeau réduit le vrai
  // viewport de la page, sans injection de CSS dans le contenu du serveur.
  page = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  win.contentView.addChildView(page);
  bandeau.create(win, page);
  const contents = page.webContents;
  win.once("closed", () => { if (!contents.isDestroyed()) contents.close(); });
  if (saved.agrandie) win.maximize();
  // Lancée par le système à l'ouverture de session : pas de fenêtre, l'icône de la zone de notification suffit.
  // Sauf si rien n'est encore relié : l'écran de connexion doit se voir.
  const quiet = firstWindow && startup.discreet() && !!readConfig().mode;
  firstWindow = false;
  contents.once("did-finish-load", () => { if (!quiet) win.show(); });
  // Rendu planté (mémoire, pilote graphique) : sans ceci la fenêtre reste blanche jusqu'à « Quitter ».
  // Au troisième plantage en une minute, on arrête de relancer et on laisse le bouton « Réessayer ».
  contents.on("render-process-gone", (_e, details) => {
    if (details?.reason === "clean-exit" || quitting || contents.isDestroyed()) return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60000).concat(now);
    contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`).then(() => {
      if (crashes.length >= 3) return status("L'affichage de Noah s'est arrêté plusieurs fois de suite. Tes agents continuent sur le serveur.", true);
      return boot();
    }).catch(() => {});
  });
  win.on("unresponsive", async () => {
    if (asking || quitting) return;
    asking = true;
    try {
      const r = await dialog.showMessageBox(win, {
        type: "warning", title: "Noah Agent", message: "Noah ne répond plus.", detail: "Tu peux recharger la fenêtre, ou attendre encore un peu.",
        buttons: ["Recharger", "Attendre"], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (r.response === 0 && !contents.isDestroyed()) {
        contents.forcefullyCrashRenderer(); // un rendu figé n'obéit pas à « recharger » : render-process-gone le relève
      }
    } finally {
      asking = false;
    }
  });
  // Le titre de la barre reste le nom de l'app, quoi que dise la page ouverte.
  win.on("page-title-updated", (e) => e.preventDefault());
  page.webContents.on("context-menu", contextMenu);
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
  page.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  const stayHome = (e, url) => {
    if (url.startsWith("data:") || url.startsWith("file:") || sameOrigin(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  };
  page.webContents.on("will-navigate", stayHome);
  page.webContents.on("will-redirect", stayHome); // une redirection du serveur ne passe pas par will-navigate
  // Page du serveur qui ne charge plus (serveur coupé, réseau perdu) : écran d'attente, puis reconnexion seule.
  page.webContents.on("did-fail-load", (_e, code, _desc, url, mainFrame) => {
    if (!mainFrame || code === -3 || readConfig().mode !== "remote" || !sameOrigin(url)) return; // -3 : navigation annulée
    page.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`).then(() => {
      status("Connexion au serveur perdue. Reconnexion automatique…", true);
      reconnectLater();
    }).catch(() => {});
  });
  // « Réessayer » de l'écran de démarrage.
  page.webContents.on("did-navigate-in-page", (_e, url) => {
    if (url.endsWith("#retry")) boot();
  });
  // Fermer la fenêtre la cache : Noah continue (routines, fils de travail). Quitter depuis la zone de notification.
  // La taille retrouvée au prochain lancement ; pas la position, qui pourrait tomber sur un écran débranché depuis.
  win.on("close", (e) => {
    const { width, height } = win.getNormalBounds();
    writeConfig({ fenetre: { largeur: width, hauteur: height, agrandie: win.isMaximized() } });
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (!readConfig().bulle_vue && process.platform === "win32") {
        writeConfig({ bulle_vue: true }); // une seule fois : ça surprend la première fois, plus ensuite
        tray?.displayBalloon({ iconType: "info", title: "Noah Agent reste ouvert", content: "Tes routines continuent. Pour quitter : clic droit sur cette icône, Quitter." });
      }
    }
  });
  boot();
}

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  page?.webContents.focus();
}

const quit = () => {
  quitting = true;
  app.quit();
};

// Dossiers de l'ordinateur confiés à un agent, gardés et appliqués ici (dossiers.js) : la page demande, l'application décide.
let foldersStore = null;
const folders = () => (foldersStore ??= dossiers.createStore(path.join(app.getPath("userData"), "dossiers.json")));
let listening = null;

async function askSystem(message, detail, yes) {
  const r = await dialog.showMessageBox(win?.isVisible() ? win : undefined, { type: "warning", title: "Noah Agent", message, detail, buttons: [yes, "Annuler"], defaultId: 1, cancelId: 1, noLink: true });
  return r.response === 0;
}

/** Ce que la page voit. Jamais un chemin : elle vient du serveur. Les noms de dossier des commandes permises remplacent leur identifiant. */
function foldersState() {
  const all = folders().all();
  return {
    dossiers: all.map(({ id, nom, ecriture }) => ({ id, nom, ecriture })),
    coupe: folders().isCut(),
    toujours: folders().always().map((t) => ({ commande: t.commande, dossier: t.dossier, nom: all.find((d) => d.id === t.dossier)?.nom ?? "" })),
  };
}

/** Couper va tout de suite. Rouvrir passe par une fenêtre du système : une page ne rend pas l'accès toute seule. */
async function setCut(cut) {
  if (!cut && folders().isCut() && !(await askSystem("Rendre l'accès à l'agent ?", "Il pourra de nouveau lire et écrire dans les dossiers confiés, et demander à agir sur cet ordinateur.", "Rendre l'accès"))) {
    createTrayMenuState();
    return foldersState();
  }
  folders().setCut(cut);
  createTrayMenuState();
  listening?.beat();
  return foldersState();
}

/** Le menu change, l'icône reste : la détruire la renvoyait dans la zone masquée de Windows. */
function createTrayMenuState() {
  if (!tray) return;
  tray.setContextMenu(trayMenu());
  tray.setToolTip(folders().isCut() ? "Noah Agent — accès de l'agent coupé" : "Noah Agent");
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Ouvrir Noah Agent", click: show },
    autonomyMenu(),
    { label: "Voir l'accord en attente", click: () => bandeau.focus() },
    { label: "Changer de serveur…", click: changeServer },
    ...startupMenu(),
    { type: "separator" },
    { id: "couper", label: "Couper l'accès de l'agent", type: "checkbox", checked: folders().isCut(), click: (item) => setCut(item.checked) },
    { type: "separator" },
    { label: "Quitter", click: quit },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on("click", show);
  createTrayMenuState();
}

/** Menu de l'app, en français (Alt l'affiche sous Windows). Celui d'Electron est en anglais et ouvre les outils de développement. */
function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ label: "Noah Agent", submenu: [{ role: "hide", label: "Masquer Noah Agent" }, { type: "separator" }, { label: "Quitter Noah Agent", accelerator: "Cmd+Q", click: quit }] }] : []),
    { label: "Fichier", submenu: [
      autonomyMenu(),
      { label: "Voir l'accord en attente", accelerator: "CommandOrControl+Shift+Space", click: () => bandeau.focus() },
      { label: "Changer de serveur…", click: changeServer },
      ...startupMenu(),
      { type: "separator" },
      { role: "close", label: "Fermer la fenêtre" },
      ...(process.platform === "darwin" ? [] : [{ label: "Quitter", click: quit }]),
    ] },
    { label: "Édition", submenu: [
      { role: "undo", label: "Annuler" },
      { role: "redo", label: "Rétablir" },
      { type: "separator" },
      { role: "cut", label: "Couper" },
      { role: "copy", label: "Copier" },
      { role: "paste", label: "Coller" },
      { role: "selectAll", label: "Tout sélectionner" },
    ] },
    { label: "Affichage", submenu: [
      { role: "reload", label: "Recharger" },
      { type: "separator" },
      { role: "zoomIn", label: "Agrandir" },
      { role: "zoomOut", label: "Réduire" },
      { role: "resetZoom", label: "Taille normale" },
      { type: "separator" },
      { role: "togglefullscreen", label: "Plein écran" },
    ] },
  ]));
}

/** Clic droit : sans ce menu, une fenêtre Electron n'en a aucun, pas même Copier et Coller. */
function contextMenu(_e, params) {
  const items = [];
  for (const word of params.dictionarySuggestions) items.push({ label: word, click: () => page.webContents.replaceMisspelling(word) });
  if (items.length) items.push({ type: "separator" });
  if (params.linkURL && /^https?:/.test(params.linkURL)) items.push({ label: "Copier le lien", click: () => clipboard.writeText(params.linkURL) }, { type: "separator" });
  if (params.isEditable) {
    items.push({ role: "cut", label: "Couper", enabled: params.editFlags.canCut }, { role: "copy", label: "Copier", enabled: params.editFlags.canCopy },
      { role: "paste", label: "Coller", enabled: params.editFlags.canPaste }, { role: "selectAll", label: "Tout sélectionner" });
  } else if (params.selectionText) {
    items.push({ role: "copy", label: "Copier" });
  }
  while (items.at(-1)?.type === "separator") items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
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
let home = "";
ipcMain.handle("noah:version", () => app.getVersion());

// Page de Noah (app reliée à un serveur) : appareil déconnecté côté serveur, l'utilisateur le relie de nouveau.
ipcMain.handle("noah:forget-server", async (e) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return;
  await forgetServer(); // en mode local aussi : l'écran « Relier de nouveau » doit toujours mener quelque part
});
ipcMain.handle("noah:dossiers", (e) => (origin && sameOrigin(e.senderFrame.url) ? foldersState() : null));
ipcMain.handle("noah:dossier-ajouter", async (e) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return null;
  const asked = folders().binding();
  const r = await dialog.showOpenDialog(win, { title: "Dossier à confier à ton agent", properties: ["openDirectory"] });
  if (r.canceled) return foldersState();
  const chosen = r.filePaths[0];
  if (dossiers.refusedRoot(chosen)) {
    await dialog.showMessageBox(win, { type: "warning", title: "Noah Agent", message: "Ce dossier ne se confie pas.", detail: "Ni un disque entier, ni un dossier de clés. Choisis un dossier précis.", noLink: true });
    return foldersState();
  }
  const ok = await askSystem(
    `Confier « ${path.basename(chosen)} » à tes agents, en lecture seule ?`,
    `${chosen}\n\n${chosen === os.homedir() ? "C'est tout ton dossier personnel : mieux vaut un dossier précis.\n\n" : ""}Tes agents pourront le lire quand l'application est ouverte. Ce qu'ils lisent passe par le modèle que tu as choisi. Les fichiers sensibles (.env, clés, mots de passe, profils de navigateur) restent refusés.`,
    "Confier",
  );
  if (ok && folders().binding() === asked && origin && sameOrigin(e.senderFrame.url)) folders().add(chosen);
  listening?.beat();
  return foldersState();
});
ipcMain.handle("noah:dossier-retirer", (e, id) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return null;
  folders().remove(String(id));
  listening?.beat();
  return foldersState();
});
// Donner le droit d'écrire passe par une fenêtre du système ; le retirer est immédiat.
ipcMain.handle("noah:dossier-droit", async (e, id, ecriture) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return null;
  const folder = folders().find(String(id));
  if (!folder) return foldersState();
  const asked = folders().binding();
  if (ecriture && !(await askSystem(`Permettre à tes agents d'écrire dans « ${folder.nom} » ?`, `${folder.chemin}\n\nIls y créent des documents sans te demander. Ils ne remplacent jamais un fichier sans ton accord.`, "Permettre"))) return foldersState();
  if (folders().binding() !== asked) return foldersState();
  folders().setWrite(folder.id, Boolean(ecriture));
  listening?.beat();
  return foldersState();
});
ipcMain.handle("noah:couper", (e, cut) => (origin && sameOrigin(e.senderFrame.url) ? setCut(Boolean(cut)) : null));
ipcMain.handle("noah:dossier-ouvrir", async (e, id) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return;
  const folder = folders().find(String(id));
  if (folder && fs.existsSync(folder.chemin) && fs.statSync(folder.chemin).isDirectory()) await shell.openPath(folder.chemin);
});
ipcMain.handle("noah:commande-oublier", (e, commande, dossier) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return null;
  folders().forgetAlways(String(commande), String(dossier));
  return foldersState();
});
// Clic droit sur un fichier de l'agent (fichiers.js) : le menu du système, le téléchargement au premier geste.
ipcMain.handle("noah:file-menu", async (e, url, name) => {
  if (!origin || !sameOrigin(e.senderFrame.url) || !sameOrigin(String(url))) return;
  const win = BrowserWindow.fromWebContents(e.sender);
  let saved = null;
  const fetchOnce = async () => (saved ??= await fichiers.download((u) => e.sender.session.fetch(u), String(url), String(name), path.join(app.getPath("downloads"), "Noah")));
  const act = async (id) => {
    try {
      const file = await fetchOnce();
      if (id === "ouvrir") await shell.openPath(file);
      else if (id === "ouvrir-avec") require("node:child_process").execFile("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", file], { windowsHide: false });
      else shell.showItemInFolder(file);
    } catch (err) {
      dialog.showMessageBox(win, { type: "error", message: "Ce fichier n'a pas pu être récupéré.", detail: String(err.message || err) });
    }
  };
  Menu.buildFromTemplate(fichiers.entries(String(name)).map((it) => ({ label: it.label, click: () => act(it.id) }))).popup({ window: win });
});
ipcMain.handle("noah:open-path", async (e, p) => {
  if (!origin || !sameOrigin(e.senderFrame.url)) return;
  // Dossiers seulement : ouvrir un fichier pourrait lancer un programme. Pas de chemin réseau : il contacte l'hôte dès qu'on le touche.
  if (/^[\\/]{2}/.test(String(p))) return;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) await shell.openPath(p);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", show); // aussi au retour d'une connexion : noah://connexion, proposé par le navigateur
  app.setAsDefaultProtocolClient("noah");
  app.on("open-url", (e) => { // macOS : le retour d'une connexion arrive ainsi
    e.preventDefault();
    show();
  });
  // Sous Windows, le nom sur les notifications et le groupe dans la barre des tâches (sinon « electron.app.Noah Agent »).
  app.setAppUserModelId("agent.noah.desktop");
  app.whenReady().then(() => {
    createMenu();
    // Micro (dictée, mode vocal) : accordé à l'interface de Noah, refusé à toute autre page. Écrire une image dans le presse-papiers
    // aussi : la page qui le demande doit être Noah, pas le lecteur d'une vidéo. Le plein écran sert au lecteur, dans la fenêtre de Noah.
    // Notifications : accordées à Noah seulement, sinon Réglages → Notifications mène à une impasse (permissions.js).
    const allowed = (wc, permission, asking) => !!wc && permissions.allowed(origin, wc.getURL(), permission, asking);
    session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
      done(allowed(wc, permission, details?.requestingUrl));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, asking) => allowed(wc, permission, asking));
    createTray();
    // Sessions oubliées hors ligne : révoquées dès que le serveur répond (l'app peut rester des jours ouverte).
    flushRevocations().catch(() => {});
    setInterval(() => flushRevocations().catch(() => {}), 10 * 60 * 1000);
    createWindow();
    // Demandes de l'agent (ouvrir, notifier, lancer, commande, fichiers des dossiers confiés).
    listening = actions.listen(() => origin, folders());
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
