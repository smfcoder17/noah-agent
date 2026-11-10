// Actions de l'agent sur l'ordinateur : les accords restent dans le bandeau local de l'app, jamais dans la page du serveur.
// Les fichiers d'un dossier confié passent sans fenêtre, selon le droit donné (voir dossiers.js).
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, createHash } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { BrowserWindow, clipboard, Notification, session, shell } = require("electron");
const dossiers = require("./dossiers");
const bandeau = require("./bandeau");

// Ce que « ouvrir » peut ouvrir : des documents et des médias. Un programme, un script ou un document à macros passent par « commande », confirmée.
const OPENABLE = /\.(pdf|txt|md|rtf|csv|tsv|log|json|xml|yaml|yml|toml|ini|sql|css|html?|png|jpe?g|gif|webp|bmp|svg|heic|ico|tiff?|psd|ai|mp3|wav|m4a|flac|ogg|mp4|mov|mkv|webm|avi|wmv|ts|docx?|xlsx?|pptx?|odt|ods|odp|pages|numbers|key|epub|eml|msg|ics|kml|dwg|zip|7z|gz)$/i;
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+-]{0,79}$/u;
const MAX_SHOWN = 2000; // ce que l'accord montre en entier : on ne valide pas ce qu'on ne voit pas
const MAX_LINES = 30;
const ANSWER_WITHIN = 280000; // la demande expire à 300 s côté serveur : la fenêtre se ferme avant
const MAX_RUNNING = 8;
const MAX_FILES_RUNNING = 2; // au plus deux gros fichiers en mémoire à la fois
const UNC = /^[\\/]{2}/; // un chemin réseau contacte l'hôte dès qu'on le touche, avant tout accord
const CUT = { coupe: true, erreur: "L'utilisateur a coupé l'accès depuis l'application de bureau." };
const expired = { erreur: "Cette demande a expiré avant ton accord : rien n'a été fait." };
const modified = { erreur: "L'action a été modifiée depuis son affichage : rien n'a été fait." };
const interrupted = { erreur: "Cette demande a été annulée : rien n'a été fait." };
const unavailable = { erreur: "La vérification de l'accord a échoué trois fois de suite : connexion au serveur indisponible, rien n'a été fait." };

let dialogs = Promise.resolve(); // un seul bandeau d'accord à la fois, sans bloquer le reste
const approvalContext = new AsyncLocalStorage();
const actionContext = new AsyncLocalStorage();
// Les seuls appelants de configure sont le processus principal et les tests : aucun IPC de la page web.
let getAutonomy = () => "prudent";
const configure = ({ autonomy }) => { getAutonomy = autonomy; };
const grants = new Map(); // jetons conservés uniquement dans ce processus
const fingerprint = (state, plan = state.plan) => createHash("sha256").update(JSON.stringify({ request: state.req, plan })).digest("hex");
function approvalFailure(consume = false, plan) {
  const state = actionContext.getStore();
  if (state && !state.isCurrent()) return interrupted;
  if (!state?.approval) return null;
  const { token, hash, until } = state.approval;
  if (fingerprint(state, plan) !== hash) return modified;
  if (Date.now() >= until) return expired;
  if ((!state.consumed && grants.get(token) !== hash) || (consume && state.consumed)) return { erreur: "Cet accord a déjà été utilisé : rien n'a été fait." };
  if (consume) { grants.delete(token); state.consumed = true; }
  return null;
}

/** Ce qui s'affiche dans une fenêtre d'accord : sur une ligne, sans caractère qui ferait lire autre chose. */
const clean = (text, max = 40, exact = false) => {
  const visible = String(text ?? "").replace(new RegExp(dossiers.DECEIVING.source, "g"), (c) => exact ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : " ");
  return (exact ? visible : visible.replace(/\s+/g, " ").trim()).slice(0, max);
};

/** Ce qu'on montre doit tenir dans la fenêtre : sinon on refuse au lieu de faire valider une partie. */
const tooLong = (text) => text.length > MAX_SHOWN || text.split(/\r\n|\r|\n/).length > MAX_LINES;

/** Demande l'accord de l'utilisateur : la demande vient d'un agent, qu'une page web a pu tromper. Rend l'index du bouton. */
function ask(message, detail, buttons, refuseIndex) {
  if (String(detail).length > 12000) return Promise.resolve(refuseIndex); // ne jamais faire valider un texte tronqué
  const sync = approvalContext.getStore();
  const state = actionContext.getStore();
  const token = randomBytes(32).toString("hex");
  const hash = state ? fingerprint(state) : "";
  const shownText = { message: clean(message, MAX_SHOWN), detail: String(detail).split(/\r\n|\r|\n/).map((line) => clean(line, 12000, true)).join("\n"), buttons: buttons.map((b) => clean(b, 100)), refuseIndex };
  if (shownText.detail.length > 12000) return Promise.resolve(refuseIndex);
  const shown = dialogs.then(async () => {
    let accord, reason, closeAttempted = false;
    let until;
    const cancel = new AbortController();
    let watching, checking = false, failures = 0;
    const fail = (reason) => { if (state) state.failure = reason; return refuseIndex; };
    try {
      if (state && !state.isCurrent()) return fail(interrupted);
      if (state && !(await state.stillWanted())) return fail({ erreur: "Cette demande a expiré sans avoir été affichée : rien n'a été fait." });
      accord = sync ? await sync.open(shownText.message, shownText.detail) : null;
      // Les 280 secondes commencent à la présentation, après la file et la publication.
      until = Date.now() + ANSWER_WITHIN;
      if (state) {
        watching = setInterval(async () => {
          if (checking) return;
          checking = true;
          try {
            if (!state.isCurrent()) return cancel.abort(interrupted);
            const wanted = await state.stillWanted();
            failures = 0;
            if (!wanted) cancel.abort(expired);
          } catch { if (++failures >= 3) cancel.abort(unavailable); }
          finally { checking = false; }
        }, 1000);
      }
      const response = await bandeau.request(shownText, until, cancel.signal);
      reason = cancel.signal.aborted ? cancel.signal.reason : Date.now() >= until ? expired
        : state && !state.isCurrent() ? interrupted : state && fingerprint(state) !== hash ? modified : null;
      const accepted = Number.isInteger(response) && response >= 0 && response < buttons.length && response !== refuseIndex
        && !reason;
      if (accord) { closeAttempted = true; await sync.close(accord.id, accepted); }
      if (reason) return fail(reason);
      if (cancel.signal.aborted) return fail(cancel.signal.reason);
      if (Date.now() >= until) return fail(expired);
      if (!accepted) return refuseIndex;
      if (state) {
        if (state.approval) grants.delete(state.approval.token);
        grants.set(token, hash);
        state.approval = { token, hash, until };
        state.consumed = false;
      }
      return response;
    } catch (e) {
      // Une expiration ou une vue fermée doit également retirer l'accord des autres appareils.
      if (accord && !closeAttempted) {
        try { await sync.close(accord.id, false); } catch { /* Le serveur l'expirera si la connexion reste coupée. */ }
      }
      return fail(reason || (cancel.signal.aborted ? cancel.signal.reason : { erreur: e.message || "L'accord n'a pas pu être synchronisé : rien n'a été fait." }));
    } finally {
      clearInterval(watching);
    }
  });
  dialogs = shown.catch(() => {});
  return shown;
}

async function confirm(message, detail) {
  return (await ask(message, detail, ["Autoriser", "Refuser"], 1)) === 0;
}

function run(cmd, args, cwd, env) {
  // Dernière vérification, sans attente entre l'empreinte et execFile.
  const blocked = approvalFailure(true, { program: cmd, args, path: cwd, env });
  if (blocked) return Promise.resolve({ code: 1, erreurs: blocked.erreur, sortie: "" });
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, sortie: String(stdout).slice(-6000), erreurs: String(stderr).slice(-3000) });
    });
  });
}

function folderOf(req, store) {
  if (!store) return null;
  return store.find(String(req.dossierId || ""));
}

/** Une adresse montrée telle qu'elle sera ouverte, ou null si elle pourrait tromper. */
function safeUrl(target) {
  if (/\s/.test(target) || dossiers.DECEIVING.test(target)) return null;
  try {
    const url = new URL(target);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

async function perform(req, ctx = {}) {
  const binding = ctx.store?.binding?.();
  const state = { req, plan: null,
    stillWanted: ctx.stillWanted || (async () => true),
    isCurrent: () => !ctx.store?.isCut() && ctx.store?.binding?.() === binding,
  };
  return actionContext.run(state, async () => {
    try {
      const result = await performAction(req, ctx);
      // Une coupure locale annule le bandeau ; elle garde sa réponse distincte d'un refus volontaire.
      return result.refuse && ctx.store?.isCut() ? CUT : result.refuse && state.failure ? state.failure : result;
    }
    finally { if (state.approval) grants.delete(state.approval.token); }
  });
}

async function performAction(req, ctx) {
  const who = clean(req.agent) || "Noah";
  const store = ctx.store;
  const stillWanted = ctx.stillWanted || (async () => true);
  const refused = { refuse: true, message: "L'utilisateur a refusé cette action." };
  if (store?.isCut() && req.action !== "notifier") return CUT;
  /** Après une attente (fenêtre, téléchargement) : l'accès a pu être coupé, la demande a pu expirer. */
  const stop = async () => {
    if (store?.isCut()) return CUT;
    return (await stillWanted()) ? approvalFailure() : expired;
  };
  switch (req.action) {
    case "notifier": {
      const n = new Notification({ title: clean(req.titre, 120) || who, body: String(req.texte || "").slice(0, 400) });
      n.on("click", () => BrowserWindow.getAllWindows()[0]?.show());
      n.show();
      return { ok: true };
    }
    case "presse_papiers": {
      // Un texte glissé là peut être une commande, collée plus tard sans la relire.
      const text = req.texte || "";
      if (tooLong(text)) return { erreur: "Texte trop long pour être montré en entier avant l'accord : enregistre-le dans un fichier." };
      if (!(await confirm(`${who} veut remplacer le contenu de ton presse-papiers.`, text))) return refused;
      const blocked = await stop();
      if (blocked) return blocked;
      const approval = approvalFailure(true);
      if (approval) return approval;
      clipboard.writeText(text);
      return { ok: true };
    }
    case "ouvrir": {
      const target = String(req.cible || "");
      if (/^https?:\/\//i.test(target)) {
        const url = safeUrl(target);
        if (!url) return { erreur: "Cette adresse contient des caractères qui pourraient tromper : elle n'est pas ouverte." };
        if (!(await confirm(`${who} veut ouvrir une page dans ton navigateur.`, url))) return refused;
        const blocked = await stop();
        if (blocked) return blocked;
        const approval = approvalFailure(true);
        if (approval) return approval;
        await shell.openExternal(url);
        return { ok: true };
      }
      if (UNC.test(target)) return { erreur: "Les chemins réseau ne s'ouvrent pas ainsi." };
      if (!path.isAbsolute(target)) return { erreur: "Donne le chemin complet du fichier." };
      if (/(^|[\\/])\.\.([\\/]|$)/.test(target)) return { erreur: "Ce chemin remonte dans les dossiers : donne le chemin complet." };
      let finale;
      try {
        finale = fs.realpathSync.native(target);
      } catch {
        return { erreur: "Introuvable sur l'ordinateur." };
      }
      if (UNC.test(finale)) return { erreur: "Les chemins réseau ne s'ouvrent pas ainsi." };
      if (dossiers.DECEIVING.test(finale)) return { erreur: "Ce chemin contient des caractères invisibles : il n'est pas ouvert." };
      const isDir = fs.statSync(finale).isDirectory();
      if (!isDir && !OPENABLE.test(finale)) return { erreur: "Noah n'ouvre pas ce type de fichier directement : utilise « commande », qui demande un accord." };
      if (!(await confirm(`${who} veut ouvrir ${isDir ? "un dossier" : "un fichier"}.`, finale))) return refused;
      const blocked = await stop();
      if (blocked) return blocked;
      const approval = approvalFailure(true);
      if (approval) return approval;
      const err = await shell.openPath(finale);
      return err ? { erreur: "Le système n'a pas pu l'ouvrir." } : { ok: true };
    }
    case "lancer": {
      const name = String(req.cible || "").trim();
      if (!APP_NAME.test(name)) return { erreur: "Donne seulement le nom de l'application, sans chemin ni symbole." };
      let program, args, env;
      if (process.platform === "win32") {
        // Par son exécutable (« notepad », « code ») ou, à défaut, par son nom dans le menu Démarrer (« Calculatrice »).
        // Le nom reste une donnée : il arrive par l'environnement, jamais dans le texte du script.
        const script =
          "$n = $env:NOAH_APP; try { Start-Process -FilePath $n -ErrorAction Stop } catch { " +
          '$a = Get-StartApps | Where-Object { $_.Name -like "*$n*" } | Select-Object -First 1; ' +
          'if ($a) { Start-Process ("shell:AppsFolder\\" + $a.AppID) } else { throw "Application introuvable : $n" } }';
        program = "powershell.exe";
        args = ["-NoProfile", "-NonInteractive", "-Command", script];
        env = { ...process.env, NOAH_APP: name };
      } else { program = process.platform === "darwin" ? "open" : name; args = process.platform === "darwin" ? ["-a", name] : []; }
      actionContext.getStore().plan = { program, args, path: undefined, env };
      if (!(await confirm(`${who} veut ouvrir l'application « ${name} ».`, `Programme : ${program}\nArguments : ${JSON.stringify(args)}\nApplication : ${name}`))) return refused;
      const blocked = await stop();
      if (blocked) return blocked;
      const r = await run(program, args, undefined, env);
      return r.code === 0 ? { ok: true } : { erreur: r.erreurs || "Application introuvable." };
    }
    case "commande":
      return command(req, who, store, stop, refused);
    case "lister":
    case "lire":
    case "ecrire":
    case "deplacer":
    case "creer_dossier":
    case "corbeille":
      return files(req, ctx, store);
    default:
      return { erreur: `Action inconnue : ${clean(req.action)}` };
  }
}

/** La corbeille du système : ce qui y part se récupère. */
const trash = (target) => shell.trashItem(target);

// Changer de dossier ou demander où l'on est ne fait rien : aucune fenêtre pour si peu.
const NO_EFFECT = /^\s*(cd|chdir|set-location|sl|pwd|get-location|gl)(\s+("[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&<>`$(){}]+))?\s*$/i;

async function command(req, who, store, stop, refused) {
  const text = String(req.cible || "");
  if (NO_EFFECT.test(text)) {
    return { ok: true, code: 0, sortie: "", erreurs: "", note: "Rien à faire : chaque commande part du dossier de travail ou de --dossier. Pour ranger un dossier confié : ordinateur deplacer, creer-dossier ou corbeille." };
  }
  if (tooLong(text) || dossiers.DECEIVING.test(text.replace(/[\r\n\t]/g, " "))) return { erreur: "Commande trop longue ou illisible pour être montrée avant l'accord : fais-en une plus simple." };
  const folder = folderOf(req, store);
  if (req.dossierId && !folder) return { erreur: "Ce dossier n'est plus confié à l'agent." };
  if (!folder && UNC.test(String(req.dossier || ""))) return { erreur: "Une commande ne part pas d'un chemin réseau." };
  const cwd = folder ? folder.chemin : req.dossier && fs.existsSync(req.dossier) ? req.dossier : os.homedir();
  let usable = false;
  try {
    usable = fs.statSync(cwd).isDirectory();
  } catch {
    /* parti */
  }
  if (!usable) return { erreur: "Ce dossier n'existe plus sur l'ordinateur." };
  if (dossiers.DECEIVING.test(cwd)) return { erreur: "Ce dossier a un nom illisible : rien n'est lancé." };
  const print = store ? await dossiers.fingerprint(text, store, folder?.id) : null;
  const program = print ? print.exe : process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = print ? print.args : process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", text] : ["-c", text];
  actionContext.getStore().plan = { program, args, path: cwd, env: undefined };
  // Le dossier et le programme d'abord : le texte de la commande ne peut pas les imiter.
  const detail = `Dans : ${cwd}\nProgramme : ${program}\nArguments : ${JSON.stringify(args)}\nCe dossier n'enferme pas la commande : elle a les mêmes droits que toi sur tout l'ordinateur.\n\nCommande :\n${text}`;
  if (!print || !dossiers.alwaysAllowed(print, store)) {
    const buttons = print ? ["Autoriser", "Toujours autoriser cette commande", "Refuser"] : ["Autoriser", "Refuser"];
    const answer = await ask(`${who} veut exécuter une commande.`, detail, buttons, buttons.length - 1);
    if (answer === buttons.length - 1) return refused;
    const blocked = await stop();
    if (blocked) return blocked;
    if (print && answer === 1) {
      const { args: _args, ...kept } = print;
      store.remember(kept);
    }
  }
  if (store?.isCut()) return CUT;
  if (req.dossierId && !folderOf(req, store)) return { erreur: "Ce dossier n'est plus confié à l'agent." };
  // Sans interpréteur quand c'est possible : ce qui a été montré est exactement ce qui part.
  if (print) {
    const now = await dossiers.fingerprint(text, store, folder?.id);
    if (!now || now.exe !== print.exe || now.sha256 !== print.sha256) return modified;
  }
  const r = await run(program, args, cwd);
  return { ok: r.code === 0, ...r, dossier: folder ? folder.nom : undefined };
}

async function files(req, ctx, store) {
  if (!store) return { erreur: "Cette application ne gère pas de dossiers." };
  const folder = folderOf(req, store);
  if (!folder) return { refuse: true, message: `Ce dossier n'est pas confié à l'agent : ${clean(req.dossierId) || "aucun"}.` };
  try {
    if (req.action === "lister") return { ok: true, dossier: folder.nom, ecriture: folder.ecriture, ...dossiers.list(folder.chemin, req.chemin) };
    if (req.action === "lire") {
      const { data, nom, sha256 } = await dossiers.read(folder.chemin, req.chemin);
      // La lecture a pris du temps : l'accès a pu être coupé, ou le dossier retiré. Rien ne part alors.
      if (store.isCut()) return CUT;
      if (folderOf(req, store)?.id !== folder.id) return { refuse: true, message: "Ce dossier n'est plus confié à l'agent." };
      await ctx.upload(req.id, data, nom);
      return { ok: true, nom, taille: data.length, sha256 };
    }
    // Ce qui suit écrit : on repart de l'état présent du dossier, et chaque attente (fenêtre, corbeille, livraison) se revérifie.
    if (!folder.ecriture) throw new dossiers.Refus(`Le dossier « ${folder.nom} » est en lecture seule.`);
    const recheck = () => {
      if (store.isCut()) return CUT;
      const approval = approvalFailure();
      if (approval) return approval;
      const now = folderOf(req, store);
      return now?.id === folder.id && now.ecriture ? null : { refuse: true, message: "Ce dossier n'est plus confié à l'agent en écriture." };
    };
    actionContext.getStore().plan = { program: null, args: [], path: folder.chemin };
    if (getAutonomy() !== "auto") {
      const detail = `Dossier : ${folder.chemin}\nChemin : ${req.chemin || ""}${req.vers ? `\nVers : ${req.vers}` : ""}`;
      if (!(await confirm(`${clean(req.agent) || "Noah"} veut ${req.action === "ecrire" ? "écrire un fichier" : req.action === "deplacer" ? "déplacer un élément" : req.action === "corbeille" ? "mettre un élément à la corbeille" : "créer un dossier"}.`, detail))) return { refuse: true, message: "L'utilisateur a refusé cette action." };
      const blocked = recheck();
      if (blocked) return blocked;
      if (ctx.stillWanted && !(await ctx.stillWanted())) return expired;
      const late = recheck();
      if (late) return late;
      const approval = approvalFailure(true);
      if (approval) return approval;
    }
    // Ranger un dossier confié en écriture : la personne l'a permis en le confiant, et tout se défait (rien d'écrasé, corbeille).
    if (req.action === "deplacer") return await dossiers.move(folder, req.chemin, req.vers, { recheck });
    if (req.action === "creer_dossier") return dossiers.makeDir(folder, req.chemin);
    if (req.action === "corbeille") return await dossiers.toTrash(folder, req.chemin, ctx.trash || trash);
    const data = await ctx.download(req.id);
    const before = recheck();
    if (before) return before;
    return await dossiers.write(folder, req.chemin, data, { remplacer: Boolean(req.remplacer), attendu: req.sha256 || "", id: req.id, journal: store.journal, ask: confirm, recheck, trash: ctx.trash || trash });
  } catch (e) {
    if (e instanceof dossiers.Refus) return { refuse: true, message: e.message };
    if (e.plusTard) return { erreur: e.message, plus_tard: true };
    const { message, later } = dossiers.explain(e);
    return later ? { erreur: message, plus_tard: true } : { refuse: true, message };
  }
}

/** État présent des dossiers, pour le serveur : jamais le chemin. Un partage réseau qui ne répond pas ne bloque pas le battement. */
async function shownFolders(store) {
  const present = (chemin) => Promise.race([
    fs.promises.stat(chemin).then((s) => s.isDirectory(), () => false),
    new Promise((res) => setTimeout(() => res(true), 1500)),
  ]);
  const all = store.all();
  const states = await Promise.all(all.map((d) => present(d.chemin)));
  return all.map((d, i) => ({ id: d.id, nom: d.nom, ecriture: d.ecriture, absent: !states[i] }));
}

/** Boucle d'écoute : tant que l'application tourne, elle attend les demandes de l'agent. Le battement tient la présence à part :
 * une fenêtre d'accord restée ouverte ne fait pas croire que l'application est fermée. */
function listen(getOrigin, store) {
  let stopped = false;
  let attachedTo = ""; // serveur et session pour lesquels les droits locaux ont été vérifiés
  let legacy = false; // serveur d'avant les dossiers : il ne connaît ni le battement, ni « encore »
  const auth = async () => {
    const origin = getOrigin();
    const cookie = origin && (await session.defaultSession.cookies.get({ url: origin, name: "noah_session" }))[0];
    return cookie ? { origin, token: cookie.value, headers: { Authorization: `Bearer ${cookie.value}` } } : null;
  };
  /** Rend vrai quand les droits locaux valent pour ce serveur et ce compte. Rien ne se récupère avant. */
  const beat = async () => {
    const link = await auth().catch(() => null);
    if (!link || stopped) return false;
    // Un autre serveur : tout s'efface avant même de lui parler.
    if (store) store.attach(link.origin, null);
    try {
      const r = await fetch(`${link.origin}/api/desktop/battement`, {
        method: "POST",
        headers: { ...link.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ os: process.platform, dossiers: store ? await shownFolders(store) : [], coupe: store ? store.isCut() : false }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404) {
        legacy = true;
        attachedTo = `${link.origin}|${link.token}`;
        return true;
      }
      if (!r.ok) return false;
      legacy = false;
      const { compte } = await r.json();
      if (store && store.attach(link.origin, compte)) await beat();
      attachedTo = `${link.origin}|${link.token}`;
      return true;
    } catch {
      return false; // Noah redémarre
    }
  };
  const running = new Set();
  const inFlight = new Set(); // une demande redonnée par le serveur n'ouvre pas une seconde fenêtre
  let filesRunning = 0;
  const slots = [];
  const fileSlot = async (work) => {
    if (filesRunning >= MAX_FILES_RUNNING) await new Promise((res) => slots.push(res));
    filesRunning += 1;
    try {
      return await work();
    } finally {
      filesRunning -= 1;
      slots.shift()?.();
    }
  };
  const handle = async (req, link) => {
    const approval = {
      open: async (message, detail) => {
        const r = await fetch(`${link.origin}/api/desktop/accords/${req.id}`, {
          method: "POST", headers: { ...link.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ message, detail }), signal: AbortSignal.timeout(10000),
        });
        if (r.status === 404 || r.status === 410) throw new Error("Cette demande a expiré sans avoir été affichée : rien n'a été fait.");
        if (!r.ok) throw new Error("L'accord n'a pas pu être synchronisé.");
        return r.json();
      },
      close: async (id, approve) => {
        const r = await fetch(`${link.origin}/api/desktop/accords/${req.id}/reponse`, {
          method: "POST", headers: { ...link.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ id, approve }), signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error("L'accord n'a pas été pris en compte.");
      },
    };
    const ctx = {
      store,
      stillWanted: async () => {
        if (stopped) return false;
        const current = await auth();
        if (!current) throw new Error("Session du bureau indisponible : rien n'a été fait.");
        if (current.origin !== link.origin || current.token !== link.token) return false;
        if (legacy) return true;
        const r = await fetch(`${link.origin}/api/desktop/encore/${req.id}`, { headers: link.headers, signal: AbortSignal.timeout(10000) });
        if (r.status === 404 || r.status === 410) return false;
        if (!r.ok) throw new Error("Vérification de la demande indisponible : rien n'a été fait.");
        return true;
      },
      upload: async (id, data) => {
        const r = await fetch(`${link.origin}/api/desktop/piece/${id}`, {
          method: "POST",
          headers: { ...link.headers, "Content-Type": "application/octet-stream" },
          body: data,
        });
        if (!r.ok) throw Object.assign(new Error("Le serveur n'a pas pris ce fichier."), { plusTard: true });
      },
      download: async (id) => {
        let r;
        try {
          r = await fetch(`${link.origin}/api/desktop/piece/${id}`, { headers: link.headers });
          if (!r.ok) throw Object.assign(new Error("Le fichier n'est plus sur le serveur."), { plusTard: r.status >= 500 });
          return Buffer.from(await r.arrayBuffer());
        } catch (e) {
          throw e.message === "Le fichier n'est plus sur le serveur." ? e : Object.assign(new Error("Le réseau a coupé pendant la livraison."), { plusTard: true });
        }
      },
    };
    let result;
    try {
      const heavy = req.action === "lire" || req.action === "ecrire";
      result = await approvalContext.run(approval, () => heavy ? fileSlot(() => perform(req, ctx)) : perform(req, ctx));
    } catch (e) {
      result = { erreur: dossiers.explain(e).message };
    }
    await fetch(`${link.origin}/api/desktop/result/${req.id}`, { method: "POST", headers: { ...link.headers, "Content-Type": "application/json" }, body: JSON.stringify(result) });
  };
  let received = "";
  const loop = async () => {
    while (!stopped) {
      const link = await auth().catch(() => null);
      if (!link) {
        await new Promise((r) => setTimeout(r, 3000)); // pas encore connecté à Noah
        continue;
      }
      // Rien n'arrive avant que le serveur et le compte soient vérifiés : un autre serveur n'hérite d'aucun droit.
      if (attachedTo !== `${link.origin}|${link.token}` && !(await beat())) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      try {
        const r = await fetch(`${link.origin}/api/desktop/next?os=${process.platform}&fichiers=1&recu=${encodeURIComponent(received)}`, { headers: link.headers, signal: AbortSignal.timeout(35000) });
        if (r.status !== 200) {
          if (r.status !== 204) await new Promise((res) => setTimeout(res, 3000));
          continue;
        }
        const req = await r.json();
        received = String(req.id);
        if (inFlight.has(req.id)) continue;
        inFlight.add(req.id);
        const job = handle(req, link).catch(() => {}).finally(() => {
          running.delete(job);
          inFlight.delete(req.id);
        });
        running.add(job);
        if (running.size >= MAX_RUNNING) await Promise.race(running);
      } catch {
        await new Promise((res) => setTimeout(res, 3000)); // Noah redémarre
      }
    }
  };
  loop();
  const beating = setInterval(beat, 15000);
  return {
    beat,
    stop: () => {
      stopped = true;
      clearInterval(beating);
    },
  };
}

module.exports = { configure, confirm, listen, perform };
