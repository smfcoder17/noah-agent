// #35 : vrais actions.js, bandeau.js et stockage local ; seules les surfaces Electron sont simulées.
//   node tests/desktop/accord_test.mjs
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeElectron } from "./electron_factice.mjs";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const electron = fakeElectron();
const originalLoad = Module._load;
const launches = [], copies = [];
electron.clipboard.writeText = (text) => copies.push(text);
Module._load = function (id, ...rest) {
  if (id === "electron") return electron;
  if (id === "node:child_process") return { execFile: (cmd, args, options, done) => { launches.push({ cmd, args, options }); done(null, "fait", ""); } };
  return originalLoad.call(this, id, ...rest);
};
const actions = require("../../desktop/actions.js");
const bandeau = require("../../desktop/bandeau.js");
const dossiers = require("../../desktop/dossiers.js");
bandeau.create(electron.win);
Module._load = originalLoad;
const accept = (shown) => queueMicrotask(() => electron.answer(shown.id, 0));
const base = mkdtempSync(join(tmpdir(), "noah-accord-"));
const now = Date.now;
const nativeTimeout = globalThis.setTimeout;
try {
  const view = electron.view, wc = view.webContents;
  assert.deepEqual(view.options.webPreferences, {
    preload: join(require.resolve("../../desktop/bandeau.js"), "..", "bandeau-preload.js"),
    sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "bandeau",
  });
  assert.equal(wc.session.cleared, true);
  for (const url of ["https://noah.test", "http://noah.test", "wss://noah.test", "file:///autre.html"]) {
    wc.session.beforeRequest({ url }, (answer) => assert.equal(answer.cancel, true));
  }
  wc.session.beforeRequest({ url: wc.mainFrame.url }, (answer) => assert.equal(answer.cancel, false));
  assert.equal(wc.session.checkPermission(), false);
  assert.deepEqual(view.openHandler({ url: "https://noah.test" }), { action: "deny" });
  let prevented = false;
  wc.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "https://noah.test");
  assert.equal(prevented, true);
  console.log("OK #35 : fichier local, sandbox, isolation, partition sans cookie, réseau et navigation bloqués");

  const page = [...electron.win.contentView.children].find((v) => v.webContents === electron.win.webContents);
  assert.ok(page);
  assert.deepEqual(page.bounds, { x: 0, y: 0, width: 1000, height: 800 });
  for (const end of ["autoriser", "refuser", "annuler", "interrompre"]) {
    let shown;
    electron.onRequest = (state) => { shown = state; };
    const cancel = new AbortController();
    const pending = bandeau.request({ message: "Essai", detail: "Chemin exact", buttons: ["Autoriser", "Refuser"], refuseIndex: 1 }, Date.now() + 60000, cancel.signal);
    assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1000, height: 300 });
    assert.deepEqual(page.bounds, { x: 0, y: 300, width: 1000, height: 500 });
    electron.win.size = [760, 520];
    electron.win.emit("resize");
    assert.deepEqual(view.bounds, { x: 0, y: 0, width: 760, height: 300 });
    assert.deepEqual(page.bounds, { x: 0, y: 300, width: 760, height: 220 });
    // Changement de surface sans événement resize (menu, par exemple).
    electron.win.size = [380, 250];
    electron.win.contentView.emit("bounds-changed");
    assert.deepEqual(view.bounds, { x: 0, y: 0, width: 380, height: 250 });
    assert.deepEqual(page.bounds, { x: 0, y: 250, width: 380, height: 0 });
    if (end === "interrompre") {
      wc.emit("render-process-gone");
      await assert.rejects(pending, /interrompu/);
    } else {
      if (end === "annuler") cancel.abort();
      else electron.answer(shown.id, end === "autoriser" ? 0 : 1);
      assert.equal(await pending, end === "autoriser" ? 0 : 1);
    }
    assert.equal(view.visible, false);
    assert.deepEqual(page.bounds, { x: 0, y: 0, width: 380, height: 250 });
    electron.win.size = [1000, 800];
    electron.win.emit("resize");
    assert.deepEqual(page.bounds, { x: 0, y: 0, width: 1000, height: 800 });
  }
  console.log("OK #35 suite 4 : page décalée et réduite de la hauteur du bandeau ; redimensionnement, accord, refus, annulation et interruption rendent toute la place");

  // String.raw évite que le script d'essai consomme lui-même les antislashs.
  const windowsPath = String.raw`C:\Users\Franck\Documents\Noah`;
  let windowsShown;
  electron.onRequest = (shown) => {
    windowsShown = shown;
    assert.equal(shown.message, `Dossier : ${windowsPath}`);
    assert.equal(shown.detail, windowsPath);
    queueMicrotask(() => electron.answer(shown.id, shown.refuseIndex));
  };
  assert.equal(await actions.confirm(`Dossier : ${windowsPath}`, windowsPath), false);
  console.log("OK #35 suite 4 : clean() et IPC conservent exactement C:\\Users\\Franck\\Documents\\Noah");

  let first;
  electron.onRequest = (shown) => {
    first = shown;
    // Même URL dans une autre frame, autre webContents, page du serveur, suffixe trompeur.
    assert.equal(electron.answer(shown.id, 0, { sender: wc, senderFrame: { url: wc.mainFrame.url } }), false);
    assert.equal(electron.answer(shown.id, 0, { sender: wc, senderFrame: null }), false);
    assert.equal(electron.answer(shown.id, 0, { sender: {}, senderFrame: wc.mainFrame }), false);
    const saved = wc.mainFrame.url;
    wc.mainFrame.url = "https://noah.test";
    assert.equal(electron.answer(shown.id, 0), false);
    wc.mainFrame.url = `${saved}?faux`;
    assert.equal(electron.answer(shown.id, 0), false);
    wc.mainFrame.url = saved;
    assert.equal(copies.length, 0);
    assert.deepEqual(Object.keys(shown).sort(), ["buttons", "detail", "id", "message", "refuseIndex"]);
    queueMicrotask(() => {
      assert.equal(electron.answer(shown.id, 0), true);
      assert.equal(electron.answer(shown.id, 0), false);
    });
  };
  assert.equal((await actions.perform({ action: "presse_papiers", texte: "une fois" })).ok, true);
  assert.deepEqual(copies, ["une fois"]);
  electron.onRequest = (shown) => {
    assert.equal(electron.answer(first.id, 0), false);
    queueMicrotask(() => electron.answer(shown.id, shown.refuseIndex));
  };
  assert.equal((await actions.perform({ action: "presse_papiers", texte: "deuxième" })).refuse, true);
  assert.deepEqual(copies, ["une fois"]);
  console.log("OK #35 : autre frame refusée, jeton réservé au processus principal, double réponse et rejeu refusés");

  electron.onRequest = accept;
  const changed = { action: "presse_papiers", texte: "avant" };
  let checks = 0;
  assert.match((await actions.perform(changed, { stillWanted: async () => { if (++checks === 2) changed.texte = "après"; return true; } })).erreur, /modifiée/);
  assert.deepEqual(copies, ["une fois"]);
  // L'empreinte est aussi revérifiée dans run(), après la dernière attente.
  const fp = dossiers.fingerprint;
  for (const field of ["action", "programme", "arguments", "chemin"]) {
    const req = { action: "commande", cible: "whoami", dossierId: "d" };
    let reads = 0;
    const args = ["--version"];
    dossiers.fingerprint = async () => {
      if (++reads === 2) {
        if (field === "action") req.action = "lancer";
        if (field === "arguments") args.push("--autre");
        if (field === "chemin") req.dossier = "ailleurs";
      }
      return { exe: field === "programme" && reads === 2 ? "autre-programme" : "programme-local", args, sha256: "a", commande: "whoami" };
    };
    const store = { isCut: () => false, find: () => ({ id: "d", chemin: base }), always: () => [] };
    const result = await actions.perform(req, { store });
    assert.notEqual(result.ok, true, field);
    assert.match(result.erreurs || result.erreur, /modifiée/);
  }
  dossiers.fingerprint = fp;
  assert.equal(launches.length, 0);
  console.log("OK #35 : empreinte différente refusée, y compris juste avant run() ; aucun programme lancé");

  const clock = now();
  Date.now = () => clock; // le début du délai reste fixe, même si le disque ou la machine ralentit
  electron.onRequest = (shown) => { Date.now = () => clock + 280001; accept(shown); };
  assert.match((await actions.perform({ action: "presse_papiers", texte: "expiré" })).erreur, /expiré/);
  Date.now = now;
  assert.deepEqual(copies, ["une fois"]);
  electron.onRequest = accept;
  let lateChecks = 0;
  const late = await actions.perform({ action: "commande", cible: "echo bonjour" }, {
    stillWanted: async () => { if (++lateChecks === 2) Date.now = () => now() + 280001; return true; },
  });
  Date.now = now;
  assert.match(late.erreur, /expiré/);
  assert.equal(launches.length, 0);
  console.log("OK #35 : expiration à 280 secondes, avant réponse et après réponse ; aucun effet");

  // Expiration sans aucun clic : on déclenche le vrai rappel du bandeau avec une horloge avancée.
  let expire;
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay > 279000 && delay <= 280000) expire = fn;
    return nativeTimeout(fn, delay, ...args);
  };
  electron.onRequest = () => {};
  const silent = actions.perform({ action: "presse_papiers", texte: "sans réponse" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof expire, "function");
  Date.now = () => now() + 280001;
  expire();
  assert.match((await silent).erreur, /expiré/);
  globalThis.setTimeout = nativeTimeout; Date.now = now;
  assert.equal(view.visible, false);
  assert.deepEqual(page.bounds, { x: 0, y: 0, width: 1000, height: 800 });
  const cancelled = await actions.perform({ action: "presse_papiers", texte: "annulé" }, { stillWanted: async () => false });
  assert.match(cancelled.erreur, /expiré.*sans avoir été affichée/); assert.equal(view.visible, false);
  assert.deepEqual(copies, ["une fois"]);
  console.log("OK #35 : sans clic, expiration et annulation ferment le bandeau sans effet");
  await assert.rejects(bandeau.request({ refuseIndex: 1 }, Date.now() - 1), /expiré sans avoir été affichée/);
  assert.equal(view.visible, false);

  // La seconde demande attend plus de 280 s, puis dispose encore de son délai complet.
  let held, displayed = 0, time = now();
  Date.now = () => time;
  electron.onRequest = (shown) => {
    if (++displayed === 1) held = shown;
    else { time += 279000; accept(shown); }
  };
  const inFront = actions.perform({ action: "presse_papiers", texte: "première en file" });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = actions.perform({ action: "presse_papiers", texte: "seconde en file" });
  time += 280001;
  electron.answer(held.id, held.refuseIndex);
  assert.match((await inFront).erreur, /expiré/);
  assert.equal((await queued).ok, true);
  assert.equal(displayed, 2);
  Date.now = now;
  displayed = 0;
  electron.onRequest = (shown) => { displayed++; held = shown; };
  const front = actions.perform({ action: "presse_papiers", texte: "en tête" });
  await new Promise((resolve) => setImmediate(resolve));
  const stale = actions.perform({ action: "presse_papiers", texte: "déjà expirée côté serveur" }, { stillWanted: async () => false });
  electron.answer(held.id, held.refuseIndex);
  assert.equal((await front).refuse, true);
  const staleResult = await stale;
  assert.match(staleResult.erreur, /expiré.*sans avoir été affichée/);
  assert.equal(staleResult.refuse, undefined);
  assert.equal(displayed, 1);
  console.log("OK #35 GLM 3/5 : 280 s à l'affichage après une longue file ; expiration sans affichage distincte du refus");

  const configFile = join(base, "config.json");
  writeFileSync(configFile, "{}");
  const read = () => JSON.parse(readFileSync(configFile, "utf8"));
  const write = (patch) => writeFileSync(configFile, JSON.stringify({ ...read(), ...patch }));
  const settings = require("../../desktop/autonomie.js").create(read, write);
  assert.equal(settings.get(), "prudent");
  settings.set("auto");
  assert.equal(require("../../desktop/autonomie.js").create(read, write).get(), "auto");
  settings.set("prudent");
  actions.configure({ autonomy: settings.get });
  const folderPath = join(base, "confie"); mkdirSync(folderPath);
  const store = dossiers.createStore(join(base, "dossiers.json"));
  const folder = store.add(folderPath); store.setWrite(folder.id, true);
  let requests = 0;
  electron.onRequest = (shown) => { requests++; queueMicrotask(() => electron.answer(shown.id, shown.refuseIndex)); };
  const req = { id: "c7", action: "ecrire", chemin: "page.html", dossierId: folder.id, autonomie: "auto", autonomy: "auto", juge_mode: "auto" };
  let result = await actions.perform(req, { store, download: async () => Buffer.from("<p>test</p>") });
  assert.equal(result.refuse, true); assert.equal(requests, 1); assert.equal(settings.get(), "prudent");
  assert.equal(existsSync(join(folderPath, "page.html")), false);
  writeFileSync(join(folderPath, "a.txt"), "à garder");
  for (const [action, chemin, vers] of [["creer_dossier", "neuf"], ["deplacer", "a.txt", "b.txt"], ["corbeille", "a.txt"]]) {
    const before = requests;
    const result = await actions.perform({ action, chemin, vers, dossierId: folder.id, autonomie: "auto" }, { store });
    assert.equal(result.refuse, true); assert.equal(requests, before + 1);
    assert.equal(readFileSync(join(folderPath, "a.txt"), "utf8"), "à garder");
  }
  assert.equal(existsSync(join(folderPath, "neuf")), false);
  const prudentRequests = requests;
  assert.equal((await actions.perform({ action: "lister", dossierId: folder.id }, { store })).ok, true);
  assert.equal(requests, prudentRequests);
  settings.set("auto");
  result = await actions.perform(req, { store, download: async () => Buffer.from("<p>test</p>") });
  assert.equal(result.ok, true); assert.equal(requests, prudentRequests);
  assert.equal(readFileSync(join(folderPath, "page.html"), "utf8"), "<p>test</p>");
  console.log("OK #35 C7 : Auto du serveur ignoré, Prudent local conservé et demande ; Auto local écrit sans demander");

  electron.onRequest = (shown) => { assert.ok(shown.detail.includes("echo   bonjour")); accept(shown); };
  assert.equal((await actions.perform({ action: "commande", cible: "echo   bonjour" })).ok, true);
  assert.equal(launches.length, 1); assert.equal(launches[0].options.windowsHide, true);
  assert.equal(launches[0].args.at(-1), "echo   bonjour");
  console.log("OK #35 : commande acceptée lancée une fois, arguments affichés et exécutés inchangés, windowsHide activé");

  // Vraies empreintes et vrai stockage local ; seul execFile est remplacé.
  const bin = join(base, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "whoami"), "programme témoin");
  dossiers.fingerprint = (text, store, folder) => fp(text, store, folder, { PATH: bin }, "linux");
  let alwaysRequests = 0;
  electron.onRequest = (shown) => {
    alwaysRequests++;
    assert.equal(shown.buttons[1], "Toujours autoriser cette commande");
    queueMicrotask(() => electron.answer(shown.id, 1));
  };
  const beforeAlways = launches.length;
  const alwaysReq = { action: "commande", cible: "whoami --version", dossierId: folder.id };
  assert.equal((await actions.perform({ ...alwaysReq }, { store })).ok, true);
  assert.equal(launches.length, beforeAlways + 1);
  assert.equal(store.always().length, 1);
  const reloadedStore = dossiers.createStore(join(base, "dossiers.json"));
  assert.equal((await actions.perform({ ...alwaysReq }, { store: reloadedStore })).ok, true);
  assert.equal(alwaysRequests, 1);
  assert.equal(launches.length, beforeAlways + 2);
  assert.deepEqual(launches.at(-1), launches.at(-2));
  dossiers.fingerprint = fp;
  console.log("OK #35 GLM 4 : Toujours autoriser mémorisé ; deuxième commande sans bandeau, un seul lancement à chaque fois");

  electron.onRequest = accept;
  await actions.perform({ action: "presse_papiers", texte: "notification" });
  const notification = electron.notices.at(-1);
  notification.emit("click"); // une ancienne notification ne fait qu'afficher la fenêtre
  let answer;
  electron.onRequest = (shown) => { answer = shown; };
  const work = actions.perform({ action: "presse_papiers", texte: "focus" });
  await new Promise((resolve) => setImmediate(resolve));
  electron.notices.at(-1).emit("click");
  assert.equal(electron.win.shown, true); assert.equal(view.focused, true);
  electron.answer(answer.id, answer.refuseIndex); await work;
  assert.equal(view.visible, false);
  for (const file of ["actions.js", "bandeau.js", "bandeau-preload.js"]) assert.doesNotMatch(readFileSync(require.resolve(`../../desktop/${file}`), "utf8"), /\bdialog\b|showMessageBox|showOpenDialog|showSaveDialog/);
  const preload = readFileSync(require.resolve("../../desktop/bandeau-preload.js"), "utf8");
  const domEvents = {}, ipcEvents = {}, sent = [];
  const elements = Object.fromEntries(["message", "detail", "buttons"].map((id) => [id, {
    textContent: "", children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
  }]));
  runInNewContext(preload, {
    require: () => ({ ipcRenderer: {
      on: (name, fn) => { ipcEvents[name] = fn; },
      invoke: async (...args) => { if (args[0] === "noah:accord") sent.push(args); return null; },
    } }),
    window: { addEventListener: (name, fn) => { domEvents[name] = fn; } },
    document: { getElementById: (id) => elements[id], querySelectorAll: () => [], createElement: () => ({ addEventListener() {} }) },
  });
  domEvents.DOMContentLoaded();
  ipcEvents["noah:bandeau"]({}, windowsShown);
  assert.equal(elements.detail.textContent, windowsPath);
  assert.equal(elements.message.textContent, `Dossier : ${windowsPath}`);
  assert.deepEqual(elements.buttons.children.map((b) => b.className), ["primary", "secondary"]);
  ipcEvents["noah:bandeau"]({}, { ...windowsShown, buttons: ["Autoriser", "Toujours autoriser cette commande", "Refuser"], refuseIndex: 2 });
  assert.deepEqual(elements.buttons.children.map((b) => b.className), ["primary", "discreet", "secondary"]);
  console.log("OK #35 suite 4 : chemin Windows inchangé jusqu'au texte du rendu ; boutons principal, discret et secondaire avec deux ou trois choix");
  const rendered = { id: 77, message: "<img src=https://piege.test>", detail: "echo   bonjour", buttons: ["Autoriser", "Refuser"], refuseIndex: 1 };
  ipcEvents["noah:bandeau"]({}, rendered);
  assert.equal(elements.message.textContent, rendered.message); // du texte, jamais du HTML
  assert.equal(elements.detail.textContent, "echo   bonjour");
  domEvents.keydown({ isTrusted: false, ctrlKey: true, altKey: true, key: "a" });
  assert.equal(sent.length, 0);
  domEvents.keydown({ isTrusted: true, ctrlKey: true, altKey: true, key: "a", preventDefault() {} });
  assert.deepEqual(sent[0], ["noah:accord", 77, 0]);
  ipcEvents["noah:bandeau"]({}, { ...rendered, id: 78 });
  domEvents.keydown({ isTrusted: true, ctrlKey: true, altKey: true, key: "r", preventDefault() {} });
  assert.deepEqual(sent[1], ["noah:accord", 78, 1]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.message.textContent, rendered.message); // l'état initial arrivé tard ne remplace pas le plus récent
  console.log("OK #35 : notification vers Noah, raccourcis accepter/refuser exécutés, texte sans HTML, aucun appel à dialog");

  // Le focus reste sur la page principale : la voie native ne dépend pas du preload du bandeau.
  for (const [key, accepted] of [["a", true], ["r", false]]) {
    let shown, prevented = 0;
    electron.onRequest = (state) => { shown = state; };
    const before = copies.length;
    const work = actions.perform({ action: "presse_papiers", texte: `raccourci ${key}` });
    await new Promise((resolve) => setImmediate(resolve));
    const event = { preventDefault: () => { prevented++; } };
    const input = { type: "keyDown", control: true, alt: true, key, isAutoRepeat: false };
    for (const patch of [{ type: "keyUp" }, { isAutoRepeat: true }, { control: false }, { alt: false }, { key: "z" }]) {
      electron.win.webContents.emit("before-input-event", event, { ...input, ...patch });
      assert.equal(view.visible, true);
    }
    electron.win.webContents.emit("before-input-event", event, input);
    const result = await work;
    assert.equal(accepted ? result.ok : result.refuse, true);
    assert.equal(copies.length, before + (accepted ? 1 : 0));
    assert.equal(prevented, 1);
    assert.equal(electron.answer(shown.id, 0), false);
    electron.win.webContents.emit("before-input-event", event, input);
    assert.equal(prevented, 1); // rien en dehors d'un accord
  }
  console.log("OK #35 GLM 6 : accepter/refuser depuis la page principale ; répétitions et touches hors accord ignorées");

  electron.onRequest = () => {};
  const replaced = actions.perform({ action: "presse_papiers", texte: "ancien bandeau" });
  await new Promise((resolve) => setImmediate(resolve));
  bandeau.create(electron.win); // la doublure interdit maintenant les handlers en double, comme Electron
  assert.match((await replaced).erreur, /interrompu/);
  assert.equal(view.closed, true);
  assert.equal(electron.win.contentView.children.size, 2); // page conservée, bandeau remplacé
  assert.equal([...electron.win.contentView.children].filter((v) => v.webContents === electron.win.webContents).length, 1);
  assert.equal(electron.win.webContents.listenerCount("before-input-event"), 1);
  const replacement = electron.view;
  const nextWindow = electron.createWindow();
  bandeau.create(nextWindow);
  assert.equal(replacement.closed, true);
  assert.equal(electron.win.contentView.children.size, 1); // l'ancienne page retrouve tout le viewport
  assert.deepEqual(page.bounds, { x: 0, y: 0, width: 1000, height: 800 });
  electron.win.size = [800, 600];
  electron.win.emit("resize");
  assert.deepEqual(page.bounds, { x: 0, y: 0, width: 800, height: 600 });
  assert.equal(electron.win.webContents.listenerCount("before-input-event"), 0);
  electron.win.emit("closed"); // ne doit pas effacer la nouvelle instance
  electron.onRequest = accept;
  assert.equal((await actions.perform({ action: "presse_papiers", texte: "nouvelle fenêtre" })).ok, true);
  assert.equal(electron.handlers.has("noah:accord"), true);
  console.log("OK #35 GLM 2 : seconde création sans doublon, ancienne vue libérée, fermeture ancienne sans effet sur la nouvelle");
  electron.onRequest = () => {};
  const closing = actions.perform({ action: "presse_papiers", texte: "fermeture" });
  await new Promise((resolve) => setImmediate(resolve));
  const copiesBeforeClose = copies.length, launchesBeforeClose = launches.length;
  const closingView = electron.view, notice = electron.notices.at(-1);
  assert.equal(closingView.visible, true);
  const send = closingView.webContents.send;
  closingView.webContents.send = (...args) => {
    assert.equal(nextWindow.isDestroyed(), false, "aucun envoi après la destruction de la fenêtre");
    return send(...args);
  };
  assert.doesNotThrow(() => nextWindow.destroy());
  assert.equal(nextWindow.isDestroyed(), true);
  const closedResult = await closing;
  assert.match(closedResult.erreur, /interrompu.*rien n'a été fait/);
  assert.equal(closedResult.refuse, undefined);
  assert.equal(copies.length, copiesBeforeClose);
  assert.equal(launches.length, launchesBeforeClose);
  assert.equal(electron.view.closed, true); assert.equal(electron.handlers.has("noah:accord"), false);
  assert.equal(nextWindow.webContents.listenerCount("before-input-event"), 0);
  assert.equal(notice.closed, true);
  assert.doesNotThrow(() => {
    nextWindow.emit("resize");
    nextWindow.contentView.emit("bounds-changed");
    closingView.webContents.emit("render-process-gone");
    notice.emit("click");
    bandeau.focus();
    nextWindow.destroy();
  });
  await assert.rejects(bandeau.request({ refuseIndex: 1 }, Date.now() + 60000), /rien n'a été fait/);
  console.log("OK #35 suite 5 : fenêtre détruite avec bandeau ouvert, aucune exception ni effet ; demande interrompue, vue et handlers libérés, rappels tardifs ignorés");

  // L'ordre de destruction des contenus ne doit pas rendre les rappels dangereux.
  for (const firstDestroyed of ["bandeau", "page"]) {
    const window = electron.createWindow();
    const instance = bandeau.create(window), banner = electron.view;
    let shown;
    electron.onRequest = (state) => { shown = state; };
    const before = copies.length;
    const work = actions.perform({ action: "presse_papiers", texte: `fermeture ${firstDestroyed}` });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(shown);
    assert.doesNotThrow(() => {
      if (firstDestroyed === "bandeau") banner.webContents.close();
      else window.webContents.destroyed = true;
      window.emit("resize");
      window.contentView.emit("bounds-changed");
      instance.focus();
      if (firstDestroyed === "page") assert.equal(electron.answer(shown.id, 0), false);
      window.destroy();
      instance.dispose();
    });
    assert.match((await work).erreur, /interrompu.*rien n'a été fait/);
    assert.equal(copies.length, before);
    assert.equal(electron.handlers.has("noah:accord"), false);
    assert.equal(banner.closed, true);
    console.log(`OK #35 suite 5 : contenu ${firstDestroyed} détruit avant closed, rappels sans exception et action interrompue sans effet`);
  }

  // Vrai createWindow()/boot() de main.js : le serveur charge dans la vue que
  // le bandeau redimensionne, avec son preload et toutes les gardes de navigation.
  const ui = fakeElectron(), loaded = [];
  ui.win.contentView.children.clear(); // une vraie BrowserWindow n'expose pas sa vue interne ici
  const profile = join(base, "main-profile"); mkdirSync(profile);
  writeFileSync(join(profile, "config.json"), JSON.stringify({ mode: "local", home: join(require.resolve("../../desktop/main.js"), "../..") }));
  ui.app = { getPath: () => profile, requestSingleInstanceLock: () => false, quit() {} };
  ui.nativeTheme = { shouldUseDarkColors: false };
  ui.BrowserWindow = class { constructor(options) { ui.win.options = options; return ui.win; } };
  const FakeView = ui.WebContentsView;
  ui.WebContentsView = class extends FakeView {
    constructor(options) {
      super(options);
      this.webContents.loadURL = async (url) => { loaded.push(url); this.webContents.emit("did-finish-load"); };
      this.webContents.setUserAgent = () => {};
      this.webContents.executeJavaScript = async () => {};
    }
  };
  Object.assign(ui.session.defaultSession, {
    getUserAgent: () => "Noah test", setUserAgent() {}, webRequest: { onBeforeRequest() {} },
  });
  let mainView;
  const mainModules = {
    electron: ui, "./fichiers": {}, "./noah": { ensureShareRoots: () => false, start: async () => "http://localhost:8080" },
    "./actions": { configure() {} }, "./dossiers": {},
    "./bandeau": { create: (win, view) => { assert.equal(win, ui.win); mainView = view; } },
    "./autonomie": require("../../desktop/autonomie.js"),
  };
  runInNewContext(`${readFileSync(require.resolve("../../desktop/main.js"), "utf8")}\ncreateWindow();`, {
    require: (id) => mainModules[id] ?? require(id), __dirname: join(require.resolve("../../desktop/main.js"), ".."),
    process, URL, setTimeout, clearTimeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded.length, 2);
  assert.match(loaded[0], /^data:text\/html/);
  assert.equal(loaded[1], "http://localhost:8080");
  assert.ok(ui.win.contentView.children.has(mainView));
  assert.notEqual(mainView.webContents, ui.win.webContents);
  assert.equal(mainView.options.webPreferences.preload, join(require.resolve("../../desktop/main.js"), "..", "preload.js"));
  for (const flag of ["sandbox", "contextIsolation"]) assert.equal(mainView.options.webPreferences[flag], true);
  assert.equal(mainView.options.webPreferences.nodeIntegration, false);
  for (const event of ["will-navigate", "will-redirect", "context-menu", "did-fail-load", "did-navigate-in-page"]) {
    assert.equal(mainView.webContents.listenerCount(event), 1, event);
    assert.equal(ui.win.webContents.listenerCount(event), 0, event);
  }
  assert.equal(ui.win.shown, true);
  ui.win.emit("closed");
  assert.equal(mainView.closed, true);
  console.log("OK #35 suite 4 : vrai main.js, démarrage et serveur dans la vue redimensionnable, preload et gardes conservés, vue fermée avec la fenêtre");
} finally {
  Date.now = now;
  globalThis.setTimeout = nativeTimeout;
  Module._load = originalLoad;
  rmSync(base, { recursive: true, force: true });
}
console.log("Accords du bureau : tout tient.");
