// Plugin Noah pour Camofox : l'écran partagé et l'agent utilisent les mêmes cookies.
//
// Chaque session Camofox (celle de l'agent) est un « conteneur » Firefox. Sans réglage, un onglet que
// l'utilisateur ouvre à la main dans l'écran (Ctrl+T, bouton +, nouvelle fenêtre) s'ouvre hors de ce conteneur :
// il s'y connecte à un site, mais l'agent, lui, reste déconnecté. Ces préférences gardent tout nouvel onglet dans
// le conteneur de l'onglet courant, et ouvrent les nouvelles fenêtres en onglets.
//
// Après un redémarrage du navigateur, Camofox répond 410 pour un ancien onglet. L'outil navigateur d'Hermes ne
// recrée son onglet que sur un 404 : il restait bloqué, et l'agent contournait par des commandes curl, bien plus
// lentes. Pour « navigate », le 410 devient un 404 (Hermes ouvre alors un nouvel onglet à la bonne adresse).
//
// Prise en main par l'utilisateur (connexion, code 2FA, CAPTCHA) : aucune capture d'écran n'est faite tant qu'elle
// dure, ni par l'agent ni par personne (G7.7, comme le mode « takeover » de ChatGPT agent). Noah Agent l'ouvre et la
// ferme par POST /noah/prive?secondes=N, avec une clé à part (NOAH_PRIVATE_KEY) : l'agent a la clé d'API du
// navigateur, pas celle-ci, il ne peut donc pas couper la protection. L'échéance est gardée sur le disque : un
// redémarrage du navigateur pendant la prise en main ne rouvre pas les captures.
//
// Joindre un fichier à une page (photo d'une publication) : l'agent et le navigateur sont deux conteneurs sans dossier
// commun, et le « input[type=file] » que Camofox choisit seul est le premier de la page, qui peut être celui de la photo
// de profil. POST /noah/fichier reçoit le fichier ; POST /noah/joindre le met dans le champ visé, sans jamais deviner :
// celui de la fenêtre ouverte, le seul de la page, ou celui que l'agent désigne. Plusieurs candidats : refus, avec la liste.
//
// Se connecter à un site (voir server/noah/coffre.py) : la personne donne ses identifiants à Noah Agent, qui les pose ici par
// POST /noah/remplir, avec la clé que l'agent n'a pas. L'agent ne les reçoit donc à aucun moment. L'origine exacte est vérifiée
// avant, puis dans le script même qui écrit, sans attente entre les deux. Le formulaire part aussitôt ; s'il reste affiché,
// le champ est vidé. Pendant ce temps, personne ne lit l'onglet (423). Si l'agent a lancé un script dans l'onglet, la page est
// rechargée avant d'écrire : un script posé là pour écouter la saisie ne survit pas. Rien de ce corps de requête ne va au journal.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const STATE = "/data/noah-prive.json";
const OUTBOX = "/data/envois";
const MAX_FILE = 300 * 2 ** 20;
const MAX_TOTAL = 2 ** 30;
const KEEP_MS = 3600 * 1000;
const TRIGGER_MS = 12000;
const FILE_INPUT = 'input[type="file"]';
const MAX_LOGIN_BODY = 8192;
const LOGIN_FILL_MS = 6000; // le temps qu'une page en cours de chargement montre son formulaire
const LOGIN_NEXT_MS = 8000; // identifiant d'abord, mot de passe sur l'écran suivant
const LOGIN_LEFT_MS = 6000; // au-delà, le formulaire est resté là : le champ est vidé
const TAB_READS = /^\/(?:tabs\/[^/]+\/.+|snapshot|act|navigate)$/;
let filling = 0;
const scripted = new Set(); // onglets où un script a tourné depuis le dernier remplissage
const reserved = new Map(); // dossier d'un envoi en cours → octets qu'il peut encore prendre
let receiving = 0;
let privateUntil = 0;
try {
  privateUntil = Number(JSON.parse(fs.readFileSync(STATE, "utf8")).jusqua) || 0;
} catch {}

const fail = (status, message) => Object.assign(new Error(message), { status });

function agentKeyGiven(req) {
  const key = process.env.CAMOFOX_API_KEY;
  if (!key) return false;
  const hash = (text) => crypto.createHash("sha256").update(text).digest();
  return crypto.timingSafeEqual(hash(req.headers.authorization || ""), hash(`Bearer ${key}`));
}

function serverKeyGiven(req) {
  const key = process.env.NOAH_PRIVATE_KEY;
  if (!key) return false;
  const hash = (text) => crypto.createHash("sha256").update(text).digest();
  return crypto.timingSafeEqual(hash(req.headers.authorization || ""), hash(`Bearer ${key}`));
}

// Le nom seul, lisible par le site : l'extension compte pour lui. Le dossier au nom aléatoire protège du reste.
function safeName(raw) {
  const name = String(raw || "").split(/[/\\]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/^\.+/, "").trim();
  return name.slice(-120) || "fichier";
}

// Retire les envois de plus d'une heure ; rend ce qui reste sur le disque.
function sweepOutbox() {
  fs.mkdirSync(OUTBOX, { recursive: true });
  let used = 0;
  for (const id of fs.readdirSync(OUTBOX)) {
    const dir = path.join(OUTBOX, id);
    if (reserved.has(dir)) continue;
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > KEEP_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      for (const name of fs.readdirSync(dir)) used += fs.statSync(path.join(dir, name)).size;
    } catch {}
  }
  return used;
}

async function receiveFile(req, res) {
  if (receiving >= 2) return res.status(429).json({ error: "Deux fichiers sont déjà en cours d'envoi : réessaie dans un instant." });
  receiving++;
  const id = crypto.randomBytes(12).toString("hex");
  const dir = path.join(OUTBOX, id);
  const tooBig = () => fail(413, "Fichier trop lourd pour le navigateur (300 Mo au plus, 1 Go d'envois en attente).");
  try {
    const used = sweepOutbox();
    const announced = Number(req.headers["content-length"]) || 0;
    if (announced > MAX_FILE) throw tooBig();
    const limit = announced || MAX_FILE;
    const others = [...reserved.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (used + others + limit > MAX_TOTAL) throw tooBig();
    reserved.set(dir, limit); // réservé avant toute attente : deux envois simultanés ne dépassent pas le plafond à eux deux
    fs.mkdirSync(dir);
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > limit) done(tooBig());
        else done(null, chunk);
      },
    });
    const nom = safeName(req.query.nom);
    await pipeline(req, meter, fs.createWriteStream(path.join(dir, nom), { flags: "wx" }));
    if (!size) throw fail(400, "Fichier vide.");
    res.json({ id, nom, octets: size });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!res.headersSent) {
      res.set?.("Connection", "close");
      res.status(e.status || 500).json({ error: e.status ? e.message : "Fichier non reçu : réessaie." });
    }
  } finally {
    reserved.delete(dir);
    receiving--;
  }
}

// L'onglet demandé, sinon le dernier du groupe de l'agent (même nom que son identité) : pas celui d'une connexion en cours à côté.
function findAgentTab(session, wanted, user) {
  if (wanted) {
    for (const group of session?.tabGroups?.values() || []) {
      if (group.has(wanted)) return group.get(wanted);
    }
    return null;
  }
  const own = session?.tabGroups?.get(user);
  let last = null;
  for (const group of own ? [own] : session?.tabGroups?.values() || []) {
    for (const tabState of group.values()) {
      if (!tabState.page?.isClosed?.()) last = tabState;
    }
  }
  return last;
}

// Comme Camofox lit ses références (e12) : le rôle, le nom et le rang vus dans la dernière lecture de la page.
function locateRef(tabState, ref) {
  const info = tabState.refs?.get(ref);
  if (!info) throw fail(409, `La référence ${ref} n'existe plus : relis la page, puis réessaie.`);
  const frame = (info.frameName && tabState.page.frame({ name: info.frameName }))
    || (info.frameUrl && tabState.page.frames().find((f) => f.url() === info.frameUrl))
    || tabState.page;
  return frame.getByRole(info.role, info.name ? { name: info.name } : undefined).nth(info.nth);
}

// Le champ sans ambiguïté : celui de la fenêtre ouverte, sinon le seul de la page. Rend null s'il n'y en a aucun.
// Un cadre ou une fenêtre cachés ne comptent pas. Après un clic sur un bouton, seuls comptent les champs apparus depuis.
async function theOnlyInput(page, onlyNew = false) {
  const inOpenDialogs = [];
  const onPage = [];
  for (const frame of page.frames()) {
    if (frame.parentFrame?.() && !(await frame.frameElement().then((el) => el.isVisible()).catch(() => false))) continue;
    const found = frame.locator(FILE_INPUT);
    const count = await found.count();
    for (let i = 0; i < count; i++) {
      const input = found.nth(i);
      const seen = await input.evaluate((el) => {
        const dialog = el.closest('[role="dialog"], dialog');
        const open = dialog && (dialog.checkVisibility ? dialog.checkVisibility() : dialog.getClientRects().length > 0);
        return { place: !dialog ? "page" : open ? "fenetre" : "cachee", before: Boolean(el.__noahAvantClic) };
      }).catch(() => null);
      if (!seen || (onlyNew && seen.before)) continue;
      if (seen.place === "fenetre") inOpenDialogs.push(input);
      if (seen.place === "page") onPage.push(input);
    }
  }
  const candidates = inOpenDialogs.length ? inOpenDialogs : onPage;
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return null;
  const seen = await Promise.all(candidates.slice(0, 8).map((input) =>
    input.evaluate((el) => ({ accept: el.accept, name: el.name, id: el.id, aria: el.getAttribute("aria-label") || "" })).catch(() => ({}))));
  throw Object.assign(fail(409, "Plusieurs champs de fichier sur cette page : désigne le bon avec --selecteur."), { champs: seen });
}

function notTakenOver() {
  if (Date.now() < privateUntil) throw fail(423, "L'utilisateur a la main sur l'écran : attends qu'il ait fini.");
}

// Un champ sans « multiple » refuse plusieurs fichiers : Instagram, pour un carrousel. L'agent doit le savoir pour changer de méthode,
// au lieu de lire une erreur générale et de soupçonner ses images.
async function setFilesOn(input, files) {
  const takesSeveral = files.length < 2 || (await input.evaluate((el) => el.multiple).catch(() => true));
  if (!takesSeveral) {
    throw fail(422, "Ce champ ne prend qu'un fichier à la fois. Envoie le premier, puis ajoute les suivants un par un avec le bouton d'ajout du site (souvent + dans sa galerie).");
  }
  await input.setInputFiles(files, { timeout: 10000 });
}

async function throughTrigger(page, trigger, files) {
  for (const frame of page.frames()) {
    await frame.locator(FILE_INPUT).evaluateAll((all) => all.forEach((el) => {
      const dialog = el.closest('[role="dialog"], dialog');
      const closed = dialog && !(dialog.checkVisibility ? dialog.checkVisibility() : dialog.getClientRects().length > 0);
      el.__noahAvantClic = !closed; // une fenêtre fermée que le bouton ouvre reste une bonne cible
    })).catch(() => {});
  }
  notTakenOver();
  let chooser = null;
  const waited = page.waitForEvent("filechooser", { timeout: TRIGGER_MS }).catch(() => null).then((c) => (chooser = c));
  await trigger.click({ timeout: 4000 }).catch(() => {
    throw fail(422, "Ce bouton n'a pas pu être cliqué : relis la page.");
  });
  const end = Date.now() + TRIGGER_MS;
  while (Date.now() < end) {
    if (chooser) {
      notTakenOver();
      if (files.length > 1 && !chooser.isMultiple()) {
        throw fail(422, "Ce bouton ne prend qu'un fichier à la fois. Envoie le premier, puis ajoute les suivants un par un avec le bouton d'ajout du site (souvent + dans sa galerie).");
      }
      await chooser.setFiles(files);
      return "selecteur";
    }
    const input = await theOnlyInput(page, true);
    if (input) {
      notTakenOver();
      await setFilesOn(input, files);
      return "champ";
    }
    await page.waitForTimeout(300);
  }
  throw fail(422, "Ce bouton n'ouvre pas de choix de fichier.");
}

async function putFiles(tabState, files, { ref, selector }) {
  const page = tabState.page;
  const target = ref ? locateRef(tabState, ref) : selector ? page.locator(selector).first() : null;
  if (!target) {
    const input = await theOnlyInput(page);
    if (!input) throw fail(422, "Aucun champ de fichier ici : ouvre d'abord la fenêtre d'envoi du site, ou désigne son bouton avec --ref.");
    notTakenOver();
    await setFilesOn(input, files);
    return "champ";
  }
  const isInput = await target.evaluate((el) => el.matches('input[type="file"]'), null, { timeout: 4000 }).catch(() => {
    throw fail(422, "Rien ne correspond à ce que tu désignes : relis la page.");
  });
  if (!isInput) return throughTrigger(page, target, files);
  notTakenOver();
  await setFilesOn(target, files);
  return "champ";
}

async function attachFiles(req, res, ctx) {
  try {
    notTakenOver();
    const ids = String(req.query.fichiers || "").split(",");
    if (ids.length > 10 || !ids.every((id) => /^[0-9a-f]{24}$/.test(id))) throw fail(400, "Fichiers invalides (10 au plus).");
    const files = ids.map((id) => {
      try {
        const dir = path.join(OUTBOX, id);
        return path.join(dir, fs.readdirSync(dir)[0]);
      } catch {
        throw fail(404, "Ce fichier a expiré : renvoie-le.");
      }
    });
    const session = ctx.sessions.get(ctx.normalizeUserId(req.query.userId));
    const tabState = findAgentTab(session, req.query.onglet ? String(req.query.onglet) : "", String(req.query.userId));
    if (!tabState) throw fail(404, "Aucun onglet ouvert : ouvre d'abord la page.");
    session.lastAccess = Date.now();
    const via = await ctx.withUserLimit(String(req.query.userId), async () => {
      const used = await putFiles(tabState, files, { ref: req.query.ref, selector: req.query.selecteur });
      await tabState.page.waitForTimeout(1500); // le temps que la page lise le fichier et montre son aperçu
      return used;
    });
    // Une remise engagée ne s'annule pas : au moins, l'agent ne croit pas que tout s'est passé normalement.
    if (Date.now() < privateUntil) throw fail(423, "L'utilisateur a pris la main pendant l'envoi : le fichier a pu être remis au site. Attends qu'il ait fini, puis regarde l'écran.");
    res.json({ ok: true, via, fichiers: files.map((f) => path.basename(f)) });
  } catch (e) {
    ctx.log?.("info", "noah: fichier non joint", { error: String(e.message).slice(0, 200) });
    res.status(e.status || 500).json({
      error: e.status ? e.message : "La page n'a pas accepté le fichier : relis-la, puis réessaie.",
      ...(e.champs ? { champs: e.champs } : {}),
    });
  }
}

// --- Se connecter à un site ---------------------------------------------------------------------------------------------

// Tourne dans la page : se suffit à elle-même, et tient tout en une fois (lecture des champs, vérification de l'origine, écriture).
function loginForm({ origine, action, identifiant, motDePasse, code }) {
  if (location.origin !== origine) return { refus: "origine" };
  const shown = (el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const words = (el) => [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete, ...[...(el.labels || [])].map((l) => l.textContent)].join(" ").toLowerCase();
  const inputs = [...document.querySelectorAll("input")].filter(shown);
  const textual = (el) => ["text", "email", "tel", "number", ""].includes(el.type);
  const password = inputs.find((el) => el.type === "password" && !/new-password|one-time-code/.test(el.autocomplete) && !/\b(new|nouveau|confirm|repeat|retape|again)|création|create/.test(words(el)));
  const isCode = (el) => el.autocomplete === "one-time-code" || /otp|one.?time|2fa|totp|verif|\bcode\b/.test(words(el));
  const inScope = inputs.filter((el) => textual(el) && (!password || el.form === password.form) && !/search|recherche/.test(words(el)));
  const before = (el) => Boolean(password && el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
  const login = inScope.find((el) => /^(username|email|tel)/.test(el.autocomplete)) || inScope.find((el) => el.type === "email")
    || inScope.find((el) => !isCode(el) && /user|login|mail|identifiant|utilisateur|phone|t[ée]l[ée]phone|compte|account|pseudo/.test(words(el)))
    || inScope.filter((el) => !isCode(el) && before(el)).pop() || null;
  const boxes = inputs.filter((el) => textual(el) && el.maxLength === 1);
  const codeBoxes = !password && boxes.length >= 4 && boxes.length <= 8 ? boxes : [];
  const codeField = password ? null : inputs.find((el) => textual(el) && el.maxLength !== 1 && isCode(el)) || null;
  const secretField = password || codeField || codeBoxes[0] || null;
  const write = (el, value) => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (action === "lire") return { identifiant: Boolean(login), motDePasse: Boolean(password), code: Boolean(codeField || codeBoxes.length) };
  if (action === "reste") return [password, codeField, ...codeBoxes].some((el) => el && el.value);
  if (action === "vider") {
    for (const el of [password, codeField, ...codeBoxes]) if (el) write(el, "");
    return true;
  }
  if (action === "champ") return secretField || login;
  if (action === "bouton") {
    const form = (secretField || login)?.form;
    const buttons = [...(form || document).querySelectorAll('button, input[type="submit"]')].filter((b) => shown(b));
    return (form && buttons.find((b) => b.type === "submit"))
      || buttons.find((b) => /log.?in|sign.?in|connex|connect|continu|suivant|next|entrer|valider|verif|vérifi/i.test(b.textContent || b.value)) || null;
  }
  // Un formulaire en GET mettrait le mot de passe dans l'adresse, que l'agent lit.
  if (password && password.form?.getAttribute("method")?.toLowerCase() === "get") return { refus: "get" };
  // Sans attribut, la plupart des sites envoient par leur propre script. Si aucun script ne s'en charge, le navigateur partirait en GET : on l'arrête là.
  if (password?.form) {
    const form = password.form;
    window.addEventListener("submit", (e) => {
      if (e.target !== form || e.defaultPrevented || (e.submitter?.formMethod || form.method).toLowerCase() !== "get") return;
      e.preventDefault();
      password.value = "";
    });
  }
  const rempli = [];
  if (code) {
    if (codeField) write(codeField, code);
    else if (codeBoxes.length) [...code].slice(0, codeBoxes.length).forEach((digit, i) => write(codeBoxes[i], digit));
    if (codeField || codeBoxes.length) rempli.push("code");
    return { rempli };
  }
  if (identifiant && login) {
    write(login, identifiant);
    rempli.push("identifiant");
  }
  if (motDePasse && password) {
    write(password, motDePasse);
    rempli.push("motDePasse");
  }
  return { rempli };
}

function sameOriginFrames(page, origine) {
  return page.frames().filter((frame) => {
    try {
      return new URL(frame.url()).origin === origine;
    } catch {
      return false;
    }
  });
}

async function fillWhenReady(page, origine, values, ms) {
  const end = Date.now() + ms;
  do {
    const here = await page.evaluate(() => location.origin).catch(() => null);
    if (here && here !== origine) throw fail(409, "La page a changé de site : rien n'y a été écrit.");
    for (const frame of sameOriginFrames(page, origine)) {
      const done = await frame.evaluate(loginForm, { origine, action: "remplir", ...values }).catch(() => null);
      if (done?.refus === "get") throw fail(422, "Ce formulaire mettrait le mot de passe dans l'adresse de la page : rien n'a été écrit.");
      if (done?.rempli?.length) return { frame, rempli: done.rempli };
    }
    await page.waitForTimeout(250);
  } while (Date.now() < end);
  return null;
}

async function pointAt(frame, origine, action) {
  const handle = await frame.evaluateHandle(loginForm, { origine, action }).catch(() => null);
  return handle?.asElement?.() || null;
}

async function sendForm(frame, origine) {
  await frame.page().waitForTimeout(250); // un bouton s'active souvent juste après la saisie
  const button = await pointAt(frame, origine, "bouton");
  if (button && (await button.click({ timeout: 3000 }).then(() => true, () => false))) return;
  const field = await pointAt(frame, origine, "champ");
  await field?.press("Enter", { timeout: 3000 }).catch(() => {});
}

// Le formulaire est parti : la page a changé, ou le mot de passe resté dans le champ est retiré.
async function afterSending(page, origine) {
  const end = Date.now() + LOGIN_LEFT_MS;
  const stillThere = async () => {
    const left = [];
    for (const frame of sameOriginFrames(page, origine)) {
      if (await frame.evaluate(loginForm, { origine, action: "reste" }).catch(() => false)) left.push(frame);
    }
    return left;
  };
  while (Date.now() < end) {
    await page.waitForTimeout(300);
    if (!(await stillThere()).length) return "changee";
  }
  for (const frame of await stillThere()) await frame.evaluate(loginForm, { origine, action: "vider" }).catch(() => {});
  return "meme";
}

async function connect(page, { origine, identifiant, motDePasse, code }, reload) {
  if (reload) await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
  const values = code ? { code } : { identifiant, motDePasse };
  const first = await fillWhenReady(page, origine, values, LOGIN_FILL_MS);
  if (!first) throw fail(422, reload ? "La page a été rechargée et le formulaire n'y est plus : rouvre-le." : "Aucun champ à remplir sur cette page.");
  const rempli = new Set(first.rempli);
  await sendForm(first.frame, origine);
  let complet = true;
  if (motDePasse && !rempli.has("motDePasse")) {
    const next = await fillWhenReady(page, origine, { motDePasse }, LOGIN_NEXT_MS).catch(() => null);
    if (next) {
      rempli.add("motDePasse");
      await sendForm(next.frame, origine);
    } else {
      complet = false;
    }
  }
  return { rempli: [...rempli], complet, page: await afterSending(page, origine) };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_LOGIN_BODY) throw fail(413, "Demande trop longue.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "Demande illisible.");
  }
}

function agentTab(ctx, userId, wanted) {
  const session = ctx.sessions.get(ctx.normalizeUserId(userId));
  const tabState = findAgentTab(session, wanted, userId);
  if (!tabState) return null;
  session.lastAccess = Date.now();
  for (const group of session.tabGroups.values()) {
    for (const [id, state] of group) if (state === tabState) return { id, tabState };
  }
  return null;
}

// Ce que la page est vraiment : l'origine montrée à la personne vient d'ici, jamais d'un texte de l'agent.
async function readPage(req, res, ctx) {
  try {
    const tab = agentTab(ctx, String(req.query.userId), req.query.onglet ? String(req.query.onglet) : "");
    if (!tab) return res.status(404).json({ error: "Aucun onglet ouvert : ouvre d'abord la page." });
    const page = tab.tabState.page;
    const url = new URL(await page.evaluate(() => location.href));
    if (!["http:", "https:"].includes(url.protocol)) return res.json({ ok: true, onglet: tab.id, origine: null, champs: {} });
    const champs = { identifiant: false, motDePasse: false, code: false };
    for (const frame of sameOriginFrames(page, url.origin)) {
      const seen = await frame.evaluate(loginForm, { origine: url.origin, action: "lire" }).catch(() => null);
      for (const name of Object.keys(champs)) champs[name] ||= Boolean(seen?.[name]);
    }
    res.json({ ok: true, onglet: tab.id, origine: url.origin, champs });
  } catch {
    res.status(500).json({ error: "La page ne répond pas : relis-la, puis réessaie." });
  }
}

async function fillPage(req, res, ctx) {
  filling++;
  try {
    notTakenOver();
    const body = await readBody(req);
    const userId = String(body.userId || "");
    const tab = agentTab(ctx, userId, String(body.onglet || ""));
    if (!tab) throw fail(404, "L'onglet n'existe plus.");
    if (typeof body.origine !== "string" || !/^https?:\/\//.test(body.origine)) throw fail(400, "Origine invalide.");
    const reload = scripted.delete(tab.id);
    res.json({ ok: true, ...(await ctx.withUserLimit(userId, () => connect(tab.tabState.page, body, reload))) });
  } catch (e) {
    ctx.log?.("info", "noah: connexion non remplie", { status: e.status || 500 }); // jamais le message d'un script, qui pourrait citer la valeur
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.status ? e.message : "La page n'a pas accepté la saisie : relis-la, puis réessaie." });
  } finally {
    filling--;
  }
}

export default function register(app, ctx) {
  app.use((req, res, next) => {
    if (req.method === "POST" && (req.path === "/noah/page" || req.path === "/noah/remplir")) {
      if (!serverKeyGiven(req)) return res.status(403).json({ error: "Forbidden" });
      return req.path === "/noah/page" ? readPage(req, res, ctx) : fillPage(req, res, ctx);
    }
    if (filling && TAB_READS.test(req.path)) {
      return res.status(423).json({ error: "Une connexion est en cours sur cet onglet : réessaie dans quelques secondes." });
    }
    if (req.method === "POST" && (req.path === "/noah/fichier" || req.path === "/noah/joindre")) {
      if (!agentKeyGiven(req)) return res.status(403).json({ error: "Forbidden" });
      return req.path === "/noah/fichier" ? receiveFile(req, res) : attachFiles(req, res, ctx);
    }
    if (req.method === "POST" && req.path === "/noah/prive") {
      if (!serverKeyGiven(req)) return res.status(403).json({ error: "Forbidden" });
      const seconds = Math.max(0, Math.min(Number(req.query.secondes) || 0, 3 * 3600));
      privateUntil = seconds ? Date.now() + seconds * 1000 : 0;
      try {
        fs.writeFileSync(STATE, JSON.stringify({ jusqua: privateUntil }));
      } catch (e) {
        ctx.log("warn", `noah: mode privé non enregistré (${e.message})`);
      }
      return res.json({ prive: seconds > 0 });
    }
    if (Date.now() < privateUntil && (/\/screenshot$/.test(req.path) || req.query.includeScreenshot === "true")) {
      return res.status(423).json({ error: "L'utilisateur a la main sur l'écran : aucune capture pendant ce temps." });
    }
    if (req.method === "POST" && /^\/tabs\/[^/]+\/navigate$/.test(req.path)) {
      const status = res.status.bind(res);
      res.status = (code) => status(code === 410 ? 404 : code);
    }
    next();
  });
  // Les extensions sont chargées après les routes de Camofox : on place celle-ci en tête pour qu'elle passe avant.
  const stack = app.router?.stack || app._router?.stack;
  if (stack) stack.unshift(stack.pop());

  ctx.events.on("tab:evaluate", ({ tabId, expression }) => {
    if (expression !== "window.location.href") scripted.add(tabId); // la seule lecture qu'Hermes fait de lui-même, à chaque étape
  });
  ctx.events.on("browser:launching", ({ options }) => {
    options.firefoxUserPrefs = {
      ...(options.firefoxUserPrefs || {}),
      "privacy.userContext.enabled": true,
      "privacy.userContext.newTabContainerOnLeftClick.enabled": true,
      "browser.link.open_newwindow": 3,
      "browser.link.open_newwindow.restriction": 0,
      // Pas de pages gardées en mémoire pour le bouton Précédent : les consoles (Google Cloud…) pèsent des centaines de Mo.
      "browser.sessionhistory.max_total_viewers": 0,
    };
    ctx.log("info", "noah: nouveaux onglets gardés dans le conteneur de l'agent");
  });
}
