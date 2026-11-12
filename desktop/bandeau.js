// Vue de confiance de l'app. Aucun jeton d'autorisation ne passe dans le rendu.
const { WebContentsView, ipcMain, Notification } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const file = path.join(__dirname, "bandeau.html");
const url = pathToFileURL(file).href;
let current = null;
const pages = new WeakMap();

// La page est créée dans main.js : les webContents d'une BrowserWindow ne peuvent
// pas être adoptés après coup. Sa vue permet de réduire le viewport et les CSS fixes.
function pageFor(win, view) {
  if (pages.has(win)) return pages.get(win);
  if (!view) throw new Error("Le bandeau attend la WebContentsView de la page Noah.");
  const container = win.contentView;
  const page = { offset: 0, layout: () => {
    if (win.isDestroyed() || view.webContents.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: page.offset, width, height: Math.max(0, height - page.offset) });
  } };
  pages.set(win, page);
  win.on("resize", page.layout);
  container.on("bounds-changed", page.layout);
  win.once("closed", () => {
    win.removeListener("resize", page.layout);
    container.removeListener("bounds-changed", page.layout);
    pages.delete(win);
  });
  return page;
}

function create(win, mainPage) {
  if (win.isDestroyed()) throw new Error("Le bandeau a été interrompu : rien n'a été fait.");
  mainPage ??= [...win.contentView.children].find((view) => view.webContents);
  current?.dispose(); // retirer la vue et les handlers de l'ancienne fenêtre avant les nouveaux
  const page = pageFor(win, mainPage);
  const pageContents = mainPage.webContents;
  const container = win.contentView;
  const view = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, "bandeau-preload.js"),
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: "bandeau",
  } });
  const wc = view.webContents;
  // Partition en mémoire, sans session du serveur ni permission, et sans réseau.
  wc.session.clearStorageData().catch(() => {});
  wc.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.session.webRequest.onBeforeRequest((details, done) => done({ cancel: details.url !== url }));
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  const stay = (event) => event.preventDefault();
  wc.on("will-navigate", stay);
  wc.on("will-frame-navigate", stay);
  wc.on("will-redirect", stay);
  wc.on("will-attach-webview", stay);
  let pending = null, serial = 0, disposed = false;
  const alive = () => !disposed && !win.isDestroyed() && !pageContents.isDestroyed() && !wc.isDestroyed();
  const trusted = (e) => alive() && e.senderFrame?.url === url && e.sender === wc && e.senderFrame === wc.mainFrame;
  const layout = () => {
    if (!alive()) return;
    const [width, height] = win.getContentSize();
    page.offset = pending ? Math.min(300, height) : 0;
    page.layout();
    view.setBounds({ x: 0, y: 0, width, height: page.offset });
    view.setVisible(Boolean(pending));
  };
  const state = () => pending?.shown ?? null;
  const update = () => {
    if (!alive()) return;
    layout(); wc.send("noah:bandeau", state());
  };
  const finish = (response, error) => {
    if (!pending) return false;
    const item = pending;
    pending = null; // avant de rendre la main : double clic et ancienne réponse inopérants
    clearTimeout(item.timer);
    item.notification?.close();
    update();
    item.settle(response, error || (Date.now() >= item.until ? new Error("Cette demande a expiré avant ton accord : rien n'a été fait.") : null));
    return true;
  };
  const answer = (id, response) => {
    if (!alive() || !pending || id !== pending.shown.id || !Number.isInteger(response) || response < 0 || response >= pending.shown.buttons.length) return false;
    return finish(response);
  };
  ipcMain.handle("noah:accord", (e, id, response) => trusted(e) && answer(id, response));
  ipcMain.handle("noah:bandeau-etat", (e) => trusted(e) ? state() : null);
  // Reçoit les frappes natives même si le focus est resté dans la page du serveur.
  // Sous Windows, AltGr envoie Ctrl+Alt : sur un clavier AZERTY, AltGr+A tapé dans la page aurait autorisé l'action.
  // Le raccourci ne vaut donc qu'avec la touche Alt de gauche : tant que celle de droite (AltGr) est tenue, rien ne passe.
  let altGr = false;
  const releaseAltGr = () => { altGr = false; };
  win.on("blur", releaseAltGr); // relâchée hors de la fenêtre : la prochaine frappe la signale de nouveau
  const shortcut = (event, input) => {
    if (input.code === "AltRight" || input.key === "AltGraph") altGr = input.type === "keyDown";
    const modifiers = Array.isArray(input.modifiers) ? input.modifiers.map((m) => String(m).toLowerCase()) : [];
    if (altGr || modifiers.includes("altgr") || modifiers.includes("altgraph")) return;
    if (!alive() || !pending || input.type !== "keyDown" || input.isAutoRepeat || !input.control || !input.alt) return;
    const key = input.key.toLowerCase();
    if (key !== "a" && key !== "r") return;
    event.preventDefault();
    answer(pending.shown.id, key === "a" ? 0 : pending.shown.refuseIndex);
  };
  pageContents.on("before-input-event", shortcut);
  const focus = () => {
    if (!alive() || !pending) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus(); wc.focus();
  };
  const request = (shown, until, signal) => {
    if (Date.now() >= until) return Promise.reject(new Error("Cette demande a expiré sans avoir été affichée : rien n'a été fait."));
    if (!alive() || pending || signal?.aborted) return Promise.reject(new Error("Cette demande n'a pas pu être affichée : rien n'a été fait."));
    return new Promise((resolve, reject) => {
      // L'identifiant d'affichage n'est pas le jeton qui autorise l'action dans actions.js.
      const abort = () => finish(shown.refuseIndex);
      pending = { shown: { ...shown, id: ++serial }, until, settle: (answer, error) => {
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(answer);
      } };
      signal?.addEventListener("abort", abort, { once: true });
      pending.timer = setTimeout(() => finish(shown.refuseIndex), until - Date.now());
      update();
      try {
        const n = new Notification({ title: "Noah attend ton accord", body: "Ouvre Noah pour vérifier l'action sur ton ordinateur." });
        pending.notification = n;
        n.on("click", focus); n.show();
      } catch { /* L'accord reste accessible si Windows coupe les notifications. */ }
    });
  };
  container.addChildView(view);
  win.on("resize", layout);
  container.on("bounds-changed", layout);
  layout();
  const lostView = () => finish(null, new Error("Le bandeau a été interrompu : rien n'a été fait."));
  wc.on("render-process-gone", lostView);
  wc.loadFile(file).catch(lostView);
  const dispose = () => {
    if (disposed) return;
    // closed arrive quand la fenêtre native est déjà détruite : finish ne doit
    // plus redessiner ni envoyer d'état, mais doit toujours terminer la demande.
    disposed = true;
    lostView();
    page.offset = 0;
    page.layout();
    // Retirer des écouteurs JS reste possible après la destruction native.
    win.removeListener("resize", layout);
    container.removeListener("bounds-changed", layout);
    win.removeListener("closed", dispose);
    win.removeListener("blur", releaseAltGr);
    pageContents.removeListener("before-input-event", shortcut);
    if (!win.isDestroyed()) container.removeChildView(view);
    ipcMain.removeHandler("noah:accord");
    ipcMain.removeHandler("noah:bandeau-etat");
    if (!wc.isDestroyed()) wc.close();
    if (current === instance) current = null;
  };
  wc.once("destroyed", dispose);
  win.once("closed", dispose);
  const instance = { request, focus, dispose };
  current = instance;
  return current;
}

module.exports = {
  create,
  request: (shown, until, signal) => current ? current.request(shown, until, signal) : Promise.reject(new Error("Cette demande n'a pas pu être affichée : rien n'a été fait.")),
  focus: () => current?.focus(),
};
