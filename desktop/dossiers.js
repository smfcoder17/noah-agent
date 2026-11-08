// Dossiers de l'ordinateur confiés à un agent qui tourne ailleurs. C'est ici que les droits vivent et s'appliquent : le
// serveur ne reçoit jamais le chemin d'un de ces dossiers, et un serveur compromis ne peut pas en élargir un. Node pur, testable sans Electron.
// (Le mode « Noah sur l'ordinateur » garde ses propres montages, choisis sur la même machine : ce fichier ne les concerne pas.)
//
// Limites connues : entre la vérification d'un chemin et son usage, un lien posé sur le disque pourrait détourner l'opération,
// et un lien physique vers un fichier du dehors ne se voit pas. Poser l'un ou l'autre exige déjà un programme lancé sur
// l'ordinateur, donc une commande que la personne a acceptée.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE = 50 * 1024 * 1024;
const MAX_LIST = 1000;
const JOURNAL_DAYS = 14; // le serveur garde un fichier 7 jours au plus : passé ce délai, il ne peut plus le redonner
const MAX_VARIANTS = 50;

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// Caractères de contrôle, sens d'écriture forcé, invisibles : ils font lire autre chose que ce qui est. (Les liants des emoji restent permis.)
const DECEIVING = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const SENSITIVE_DIR = /^(\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.electrum|\.bitcoin|\.ethereum|secrets?|wallets?|user data)$/i;
const SENSITIVE_FILE = new RegExp([
  "^\\.env", "\\.env$", // .env, .env.local, .envrc, prod.env
  "^\\.(npmrc|pypirc|netrc|pgpass|git-credentials|vault-token|bash_history|zsh_history|python_history|node_repl_history)$", "^_netrc$",
  "^id_(rsa|dsa|ecdsa|ed25519)", // id_ed25519_github, id_rsa.bak
  "(^|[._-])(secrets?|tokens?|credentials?|passwords?|passwd|kubeconfig|mnemonic|seed)([._-]|$)",
  "(^|[._ -])(mots?[ _-]de[ _-]passe|mdp)([._ -]|$)",
  "(^|[._-])history\\.txt$",
  "^(authorized_keys|known_hosts|wallet\\.\\w+|login data|web data|local state|cookies|logins\\.json|key[34]\\.db|cookies\\.sqlite|terraform\\.tfstate.*|login\\.keychain.*)$",
  "\\.(pem|key|p12|pfx|kdbx|keystore|keychain|jks|ppk|gpg|asc|ovpn)$",
].join("|"), "i");
// Ce qui s'écrit sans déranger : des documents et des médias, qui ne font rien tant qu'on ne les ouvre pas avec leur programme.
// Tout le reste peut agir (programme, raccourci, script, fichier de réglages lu par un outil) et demande un accord.
const SAFE_WRITE = /\.(txt|md|rtf|csv|tsv|log|pdf|png|jpe?g|gif|webp|bmp|heic|tiff?|mp3|wav|m4a|flac|ogg|mp4|mov|mkv|webm|avi|docx|xlsx|pptx|odt|ods|odp|json|yaml|yml)$/i;
const TOOL_READS = /^(package|composer|tsconfig|jsconfig|tasks|launch|settings|devcontainer)\.json$/i;
const TOOL_DIR = /^(\.vscode|\.idea|\.github|\.devcontainer)$/i;
const needsConsent = (target, parts) => !SAFE_WRITE.test(target) || path.basename(target).startsWith(".") || TOOL_READS.test(path.basename(target)) || parts.some((p) => TOOL_DIR.test(p));
const TEMPORARY = /^\.noah-[0-9a-f]{16}\.tmp$/;

class Refus extends Error {}

function isSensitive(parts) {
  return parts.some((p, i) => (i < parts.length - 1 ? SENSITIVE_DIR.test(p) : SENSITIVE_DIR.test(p) || SENSITIVE_FILE.test(p)));
}

/** Le chemin relatif demandé, découpé. Refuse tout ce qui n'est pas une simple descente dans le dossier. */
function pieces(relative) {
  const text = String(relative ?? "").replace(/\\/g, "/");
  if (/^\//.test(text) || /^[A-Za-z]:/.test(text) || text.includes("\0") || text.length > 1000) throw new Refus("Ce chemin n'est pas relatif au dossier.");
  const parts = text.split("/").filter((p) => p && p !== ".");
  for (const part of parts) {
    if (part === "..") throw new Refus("Ce chemin remonte hors du dossier.");
    if (DECEIVING.test(part)) throw new Refus("Ce nom contient des caractères invisibles ou de contrôle.");
    if (part.length > 200 || part.includes(":") || /[<>"|?*]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part)) throw new Refus(`Ce nom n'est pas permis : ${part.slice(0, 80)}`);
  }
  return parts;
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const real = (p) => fs.realpathSync.native(p);

/** Résout un chemin du dossier, liens et jonctions compris. Rend { root, target, exists } ; refuse ce qui sort du dossier. */
function resolve(folderPath, relative) {
  const parts = pieces(relative);
  let root;
  try {
    root = real(folderPath);
  } catch {
    throw new Refus("Ce dossier n'existe plus sur l'ordinateur.");
  }
  if (root.split(path.sep).some((p) => SENSITIVE_DIR.test(p))) throw new Refus("Ce dossier contient des clés : refusé d'office, quel que soit le droit.");
  if (!fs.statSync(root).isDirectory()) throw new Refus("Ce dossier n'existe plus sur l'ordinateur.");
  let probe = path.join(root, ...parts);
  const missing = [];
  let existing;
  for (;;) {
    try {
      existing = real(probe);
      break;
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      // Un lien dont la cible n'existe pas encore : écrire à travers lui sortirait peut-être du dossier.
      let dangling = false;
      try {
        dangling = fs.lstatSync(probe).isSymbolicLink();
      } catch {
        /* rien à ce nom */
      }
      if (dangling) throw new Refus("Ce chemin passe par un lien qui ne mène nulle part.");
      missing.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
  }
  if (!inside(root, existing)) throw new Refus("Ce chemin mène hors du dossier.");
  const target = path.join(existing, ...missing);
  // Sur le chemin réel aussi : un nom court Windows ou un lien ne cache pas un fichier sensible.
  if (isSensitive(parts) || isSensitive(path.relative(root, target).split(path.sep))) throw new Refus("Fichier sensible : refusé d'office, quel que soit le droit.");
  return { root, target, exists: missing.length === 0 };
}

function list(folderPath, relative = "") {
  const { root, target, exists } = resolve(folderPath, relative);
  if (!exists) throw new Refus("Introuvable dans ce dossier.");
  if (!fs.statSync(target).isDirectory()) throw new Refus("Ce n'est pas un dossier.");
  const elements = [];
  let cachés = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (elements.length >= MAX_LIST) return { elements, tronque: true, caches: cachés };
    const full = path.join(target, entry.name);
    try {
      const finale = real(full);
      const stat = fs.statSync(finale);
      if (TEMPORARY.test(entry.name)) continue;
      const sensible = stat.isDirectory() ? SENSITIVE_DIR.test(entry.name) : SENSITIVE_DIR.test(entry.name) || SENSITIVE_FILE.test(entry.name);
      if (!inside(root, finale) || sensible) {
        cachés += 1;
        continue;
      }
      elements.push({ nom: entry.name, type: stat.isDirectory() ? "dossier" : "fichier", taille: stat.isDirectory() ? undefined : stat.size, modifie: stat.mtime.toISOString() });
    } catch {
      /* lien mort, fichier parti : rien à montrer */
    }
  }
  return { elements, caches: cachés };
}

async function read(folderPath, relative) {
  const { target, exists } = resolve(folderPath, relative);
  if (!exists) throw new Refus("Introuvable dans ce dossier.");
  const file = await fs.promises.open(target, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Refus("Ce n'est pas un fichier.");
    if (stat.size > MAX_FILE) throw new Refus("Ce fichier dépasse 50 Mo : il ne passe pas en une fois.");
    const data = await file.readFile();
    return { data, nom: path.basename(target), sha256: await hashOf(data) };
  } finally {
    await file.close();
  }
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Empreinte d'un gros contenu, par morceaux : la fenêtre de l'application ne se fige pas. */
async function hashOf(data) {
  const hash = crypto.createHash("sha256");
  for (let at = 0; at < data.length; at += 4 * 1024 * 1024) {
    hash.update(data.subarray(at, at + 4 * 1024 * 1024));
    await new Promise((done) => setImmediate(done));
  }
  return hash.digest("hex");
}

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Une erreur du système : jamais son texte, qui contient le chemin complet. Rend le message, et si un nouvel essai a un sens. */
function explain(error) {
  const later = { EPERM: "Écriture refusée sur l'ordinateur : le fichier ou le dossier est protégé.", EACCES: "Accès refusé sur l'ordinateur : le fichier ou le dossier est protégé.", EBUSY: "Ce fichier est ouvert par un autre programme.", ENOSPC: "Le disque de l'ordinateur est plein.", EROFS: "Ce disque est en lecture seule.", EMFILE: "L'ordinateur est occupé.", EIO: "Le disque de l'ordinateur ne répond pas." };
  const final = { ENOTDIR: "Un élément de ce chemin est un fichier, pas un dossier.", EEXIST: "Un élément de ce chemin est un fichier, pas un dossier.", EISDIR: "Ce nom est celui d'un dossier.", ENAMETOOLONG: "Ce chemin est trop long pour l'ordinateur.", ENOENT: "Introuvable dans ce dossier.", EINVAL: "Ce nom n'est pas permis sur cet ordinateur." };
  if (later[error.code]) return { message: later[error.code], later: true };
  return { message: final[error.code] ?? "Le système de l'ordinateur a refusé cette opération.", later: false };
}

/** Marque le fichier comme venu d'ailleurs, comme un navigateur le fait : Windows et Office s'en méfient à l'ouverture. */
function markFromInternet(file, platform = process.platform) {
  if (platform !== "win32") return;
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  } catch {
    /* disque sans flux alternatifs : rien de plus à faire */
  }
}

function variant(target, n) {
  if (n <= 1) return target;
  const { dir, name, ext } = path.parse(target);
  return path.join(dir, `${name} (${n})${ext}`);
}

/** Publie d'un coup : le fichier apparaît entier, et jamais par-dessus un autre. Rend le chemin retenu. */
function publish(temporary, target) {
  for (let n = 1; n <= MAX_VARIANTS; n += 1) {
    const candidate = variant(target, n);
    try {
      fs.linkSync(temporary, candidate); // échoue d'un coup si le nom existe
      return candidate;
    } catch (e) {
      if (e.code === "EEXIST") continue;
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EMLINK", "EINVAL"].includes(e.code)) throw e;
      // Disque sans lien physique (exFAT, certains partages) : le nom se réserve d'abord, puis le contenu arrive d'un coup.
      // Le temporaire est alors déplacé : l'appelant le sait à ce qu'il n'existe plus.
      try {
        fs.closeSync(fs.openSync(candidate, "wx"));
      } catch (taken) {
        if (taken.code === "EEXIST") continue;
        throw taken;
      }
      fs.renameSync(temporary, candidate);
      return candidate;
    }
  }
  throw new Refus("Trop de fichiers portent déjà ce nom.");
}

/** Écrit `data` dans le dossier. `ask(message, détail)` demande l'accord de la personne pour remplacer ou écrire un programme. */
async function write(folder, relative, data, { remplacer = false, attendu = "", id = "", journal = null, ask = async () => false, recheck = () => null, trash = null } = {}) {
  if (!folder.ecriture) throw new Refus(`Le dossier « ${folder.nom} » est en lecture seule.`);
  if (data.length > MAX_FILE) throw new Refus("Ce fichier dépasse 50 Mo.");
  const hash = await hashOf(data);
  if (attendu && attendu !== hash) throw new Refus("Le fichier reçu ne correspond pas à celui envoyé.");
  const { target, exists } = resolve(folder.chemin, relative);
  if (exists && fs.statSync(target).isDirectory()) throw new Refus("Ce nom est celui d'un dossier.");

  // Livraison déjà faite (l'accusé de réception s'est perdu) : on rend le même fichier, sans seconde copie.
  const known = id && journal ? journal.find(id) : null;
  if (known) {
    for (let n = 1; n <= MAX_VARIANTS; n += 1) {
      const candidate = variant(target, n);
      if (!fs.existsSync(candidate)) continue;
      if ((await hashFile(candidate)) === hash) return { ok: true, chemin: path.relative(real(folder.chemin), candidate).split(path.sep).join("/"), deja: true };
    }
  }
  const shown = pieces(relative).join("/");
  if (needsConsent(target, pieces(relative)) && !(await ask(`Un agent veut enregistrer un fichier qui peut agir dans « ${folder.nom} ».`, `${shown}\n\nCe type de fichier peut lancer quelque chose quand on l'ouvre, ou être lu par un outil. Accepte seulement si tu l'attendais.`))) {
    return { refuse: true, message: "L'utilisateur a refusé d'enregistrer ce fichier." };
  }
  // Avec une corbeille, remplacer se défait : l'ancienne version y part, et rien n'est demandé. Sans corbeille, l'ancien contenu serait perdu.
  const replacing = remplacer && exists && (trash ? true : await ask(`Un agent veut remplacer un fichier de « ${folder.nom} ».`, `${shown}\n\nL'ancien contenu sera perdu. Sans ton accord, une copie est créée à côté.`));
  // Une fenêtre a pu rester ouverte longtemps : l'accès a peut-être été coupé, ou le dossier retiré, entre-temps.
  const blocked = recheck();
  if (blocked) return blocked;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const again = resolve(folder.chemin, relative); // le dossier parent vient peut-être d'être créé
  const temporary = path.join(path.dirname(again.target), `.noah-${crypto.randomBytes(8).toString("hex")}.tmp`);
  const file = await fs.promises.open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    const lastLook = recheck(); // l'écriture a pris du temps
    if (lastLook) return lastLook;
    if (id && journal) journal.note(id, hash); // avant de publier : une coupure entre les deux ne donne pas deux copies
    let final;
    if (replacing) {
      if (trash && fs.existsSync(again.target)) await trash(again.target);
      const late = recheck(); // la corbeille a pris du temps
      if (late) return late;
      // Sans écraser : si un autre ordre a pris le nom entre-temps, le nouveau contenu arrive à côté.
      final = trash ? publish(temporary, again.target) : (fs.renameSync(temporary, again.target), again.target);
    } else {
      final = publish(temporary, again.target);
    }
    markFromInternet(final);
    return { ok: true, chemin: path.relative(real(folder.chemin), final).split(path.sep).join("/"), taille: data.length, sha256: hash, copie: final !== again.target };
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* déjà déplacé */
    }
  }
}

// --- Ranger : déplacer, renommer, créer un dossier, mettre à la corbeille ---------------------------------------------
// Tout reste dans le dossier confié en écriture, et tout se défait : rien n'est écrasé, ce qu'on retire part à la corbeille du système.

function writable(folder) {
  if (!folder.ecriture) throw new Refus(`Le dossier « ${folder.nom} » est en lecture seule.`);
}

function notRoot(root, target) {
  if (path.relative(root, target) === "") throw new Refus("C'est le dossier confié lui-même : choisis un élément dedans.");
}

/** Déplace ou renomme `from` vers `to`, deux chemins du même dossier. `ask` : un nom qui ferait agir le fichier demande l'accord. */
/** Les fichiers d'un dossier, chemins relatifs à lui (au plus `max` : au-delà, null). */
function filesUnder(dir, max = 2000) {
  const out = [];
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length > max) return;
      const r = [...rel, entry.name];
      if (entry.isDirectory()) walk(path.join(d, entry.name), r);
      else out.push(r);
    }
  };
  walk(dir, []);
  return out.length > max ? null : out;
}

/** Ce déplacement rend-il actif quelque chose qui ne l'était pas (un programme, un dossier lu par un outil comme .github) ? */
function becomesActive(source, dest, from, to) {
  if (fs.statSync(source).isFile()) return needsConsent(dest, pieces(to)) && !needsConsent(source, pieces(from));
  const inner = filesUnder(source);
  if (!inner) return true; // trop gros pour tout regarder : la personne décide
  return inner.some((rel) => needsConsent(path.join(dest, ...rel), [...pieces(to), ...rel]) && !needsConsent(path.join(source, ...rel), [...pieces(from), ...rel]));
}

const identity = (target) => {
  const st = fs.statSync(target);
  return `${st.dev}:${st.ino}:${st.isDirectory()}`;
};

/** Déplace ou renomme `from` vers `to`, deux chemins du même dossier. Ce qui deviendrait actif demande l'accord (`ask`) ;
 * après l'attente, tout se revérifie : droits (`recheck`), chemin et identité de la source, place libre à l'arrivée. */
async function move(folder, from, to, { ask = async () => false, recheck = () => null } = {}) {
  writable(folder);
  const source = resolve(folder.chemin, from);
  if (!source.exists) throw new Refus("Introuvable dans ce dossier.");
  notRoot(source.root, source.target);
  const dest = resolve(folder.chemin, to);
  notRoot(dest.root, dest.target);
  if (dest.exists) throw new Refus("Un élément porte déjà ce nom à l'arrivée : choisis un autre nom, rien n'est écrasé.");
  if (inside(source.target, dest.target)) throw new Refus("Un dossier ne se range pas dans lui-même.");
  const before = identity(source.target);
  if (becomesActive(source.target, dest.target, from, to)) {
    const asked = await ask(`Un agent veut déplacer dans « ${folder.nom} » quelque chose qui pourra agir.`, `${pieces(from).join("/")} → ${pieces(to).join("/")}

Accepte seulement si tu l'attendais.`);
    if (!asked) return { refuse: true, message: "L'utilisateur a refusé ce déplacement." };
  }
  const blocked = recheck();
  if (blocked) return blocked;
  writable(folder);
  // Pendant l'attente, un autre ordre a pu déplacer ou remplacer la source : on repart de zéro et on vérifie que c'est la même.
  const now = resolve(folder.chemin, from);
  if (!now.exists || identity(now.target) !== before || now.target !== source.target) throw new Refus("Cet élément a changé pendant l'attente : rien n'est déplacé.");
  fs.mkdirSync(path.dirname(dest.target), { recursive: true });
  const again = resolve(folder.chemin, to); // le parent vient peut-être d'être créé
  if (again.exists) throw new Refus("Un élément porte déjà ce nom à l'arrivée : choisis un autre nom, rien n'est écrasé.");
  if (inside(now.target, again.target)) throw new Refus("Un dossier ne se range pas dans lui-même.");
  fs.renameSync(now.target, again.target);
  return { ok: true, de: pieces(from).join("/"), vers: path.relative(real(folder.chemin), again.target).split(path.sep).join("/") };
}

function makeDir(folder, relative) {
  writable(folder);
  const { root, target, exists } = resolve(folder.chemin, relative);
  notRoot(root, target);
  if (exists && !fs.statSync(target).isDirectory()) throw new Refus("Un fichier porte déjà ce nom.");
  fs.mkdirSync(target, { recursive: true });
  return { ok: true, chemin: pieces(relative).join("/"), deja: exists };
}

/** Met un élément à la corbeille du système, d'où la personne le récupère. Sans corbeille, rien n'est supprimé. */
async function toTrash(folder, relative, trash) {
  writable(folder);
  if (!trash) throw new Refus("Pas de corbeille sur cet ordinateur : rien n'est supprimé.");
  const { root, target, exists } = resolve(folder.chemin, relative);
  if (!exists) throw new Refus("Introuvable dans ce dossier.");
  notRoot(root, target);
  await trash(target);
  return { ok: true, chemin: pieces(relative).join("/"), corbeille: true };
}

// --- Ce que l'ordinateur retient : dossiers, droits, accès coupé, commandes toujours permises, livraisons ---------------

const EMPTY = () => ({ serveur: "", compte: "", dossiers: [], coupe: false, toujours: [], livraisons: {} });

function createStore(file) {
  let state = EMPTY();
  try {
    state = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    /* premier lancement, ou fichier abîmé : personne n'a plus de droit, ce qui est le bon sens de la panne */
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 1), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const find = (who) => state.dossiers.find((d) => d.id === who) ?? state.dossiers.find((d) => d.nom === who) ?? null;
  return {
    /** À qui valent les droits en ce moment : une fenêtre d'accord vérifie, à son retour, que ce n'a pas changé. */
    binding: () => `${state.serveur}|${state.compte}`,
    /** Les droits valent pour un serveur et un compte : changer de l'un ou de l'autre les efface. */
    attach(serveur, compte) {
      const changed = (state.serveur && serveur && state.serveur !== serveur) || (state.compte && compte && state.compte !== compte);
      // Couper l'accès survit à tout : un serveur ne peut pas le lever en annonçant un autre compte.
      if (changed) state = { ...EMPTY(), coupe: state.coupe };
      if (changed || state.serveur !== serveur || (compte && state.compte !== compte)) {
        state.serveur = serveur;
        state.compte = compte || state.compte;
        save();
      }
      return Boolean(changed);
    },
    forget() {
      state = EMPTY();
      save();
    },
    all: () => state.dossiers.map((d) => ({ ...d })),
    /** Ce que le serveur a le droit de savoir : jamais le chemin. */
    shown: () => state.dossiers.map(({ id, nom, ecriture }) => ({ id, nom, ecriture })),
    find,
    add(chemin) {
      const already = state.dossiers.find((d) => d.chemin === chemin);
      if (already) return already;
      const base = path.basename(chemin) || "dossier";
      let nom = base;
      for (let n = 2; state.dossiers.some((d) => d.nom === nom); n += 1) nom = `${base}-${n}`;
      const folder = { id: crypto.randomBytes(6).toString("hex"), nom, chemin, ecriture: false }; // lecture seule par défaut
      state.dossiers.push(folder);
      save();
      return folder;
    },
    remove(id) {
      state.dossiers = state.dossiers.filter((d) => d.id !== id);
      state.toujours = state.toujours.filter((t) => t.dossier !== id);
      save();
    },
    setWrite(id, allowed) {
      const folder = state.dossiers.find((d) => d.id === id);
      if (folder) {
        folder.ecriture = Boolean(allowed);
        save();
      }
    },
    isCut: () => state.coupe,
    setCut(cut) {
      state.coupe = Boolean(cut);
      save();
    },
    always: () => state.toujours.map((t) => ({ ...t })),
    remember(entry) {
      state.toujours.push(entry);
      save();
    },
    forgetAlways(commande, dossier) {
      state.toujours = state.toujours.filter((t) => !(t.commande === commande && t.dossier === dossier));
      save();
    },
    journal: {
      find: (id) => state.livraisons[id] ?? null,
      note(id, hash) {
        const limit = Date.now() - JOURNAL_DAYS * 86400000;
        for (const [key, entry] of Object.entries(state.livraisons)) if (Date.parse(entry.le) < limit) delete state.livraisons[key];
        state.livraisons[id] = { sha256: hash, le: new Date().toISOString() };
        save();
      },
    },
  };
}

// --- « Toujours autoriser » : une commande exacte, un programme précis, un dossier --------------------------------------

// Seuls ces programmes peuvent être permis pour toujours : ils ne lisent aucune consigne dans un fichier. L'accord porte sur le texte
// de la commande, or un fichier du dossier peut changer ensuite : ffmpeg, par exemple, suit une playlist vers un fichier du dehors.
// Une liste d'interdits oublierait toujours un lanceur (conhost, pcalua, cmstp, hh, osascript…).
const ALWAYS_PROGRAMS = /^(ipconfig|ifconfig|whoami|hostname|systeminfo|tasklist|uname|df|du|ls|ping|nslookup)$/i;
const METACHAR = /[;|&<>$`"'()\r\n{}%^*?[\]~!#=,]/;

/** Découpe une commande simple en programme et arguments. Rend null dès qu'elle sort de ce qu'on sait lire sans interpréteur. */
function simple(command) {
  const text = String(command || "").trim();
  if (!text || text.length > 300 || METACHAR.test(text) || DECEIVING.test(text)) return null;
  const [program, ...args] = text.split(/\s+/);
  if (/[\\/]/.test(program)) return null; // un chemin, « .\ » compris : son contenu peut changer sans que le nom change
  const bare = program.replace(/\.(exe|com)$/i, "");
  return ALWAYS_PROGRAMS.test(bare) ? { program: bare, args } : null;
}

/** Où le système trouverait ce programme, sans jamais regarder le dossier courant. */
function locate(program, env = process.env, platform = process.platform) {
  const names = platform === "win32" ? [`${program}.exe`, `${program}.com`] : [program];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return real(candidate);
      } catch {
        /* pas ici */
      }
    }
  }
  return null;
}

/** L'empreinte de ce qui serait lancé : null si la commande ne peut pas être permise pour toujours.
 * Seulement dans un dossier confié : ailleurs, le dossier de départ viendrait du serveur et ne serait pas lié à l'accord. */
async function fingerprint(command, store, dossier, env, platform) {
  if (!dossier) return null;
  const parsed = simple(command);
  if (!parsed) return null;
  const exe = locate(parsed.program, env, platform);
  if (!exe) return null;
  // Un programme dans un dossier confié : l'agent pourrait l'avoir écrit, ou le réécrire.
  if (store.all().some((d) => {
    try {
      return inside(real(d.chemin), exe);
    } catch {
      return false;
    }
  })) return null;
  return { commande: String(command).trim(), dossier, exe, sha256: await hashFile(exe), args: parsed.args };
}

function alwaysAllowed(print, store) {
  return Boolean(print) && store.always().some((t) => t.commande === print.commande && t.dossier === print.dossier && t.exe === print.exe && t.sha256 === print.sha256);
}

/** Un dossier qu'on ne doit pas confier : un disque entier, ou un dossier de clés. */
function refusedRoot(chemin) {
  return path.parse(chemin).root === chemin || chemin.split(path.sep).some((p) => SENSITIVE_DIR.test(p));
}

module.exports = { DECEIVING, MAX_FILE, Refus, alwaysAllowed, createStore, explain, fingerprint, inside, list, locate, makeDir, move, pieces, read, refusedRoot, resolve, sha256, simple, toTrash, write };
