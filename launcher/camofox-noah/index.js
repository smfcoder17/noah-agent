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
    if (announced > MAX_FILE || used + announced > MAX_TOTAL) throw tooBig();
    fs.mkdirSync(dir);
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > MAX_FILE || used + size > MAX_TOTAL) done(tooBig());
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
    receiving--;
  }
}

function findAgentTab(session, wanted) {
  let last = null;
  for (const group of session?.tabGroups?.values() || []) {
    for (const [tabId, tabState] of group) {
      if (tabId === wanted) return tabState;
      if (!tabState.page?.isClosed?.()) last = tabState;
    }
  }
  return wanted ? null : last;
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
async function theOnlyInput(page) {
  const inDialogs = [];
  const everywhere = [];
  for (const frame of page.frames()) {
    const collect = async (selector, list) => {
      const found = frame.locator(selector);
      const count = await found.count();
      for (let i = 0; i < count; i++) list.push(found.nth(i));
    };
    await collect(`[role="dialog"] ${FILE_INPUT}, dialog ${FILE_INPUT}`, inDialogs);
    await collect(FILE_INPUT, everywhere);
  }
  const candidates = inDialogs.length ? inDialogs : everywhere;
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return null;
  const seen = await Promise.all(candidates.slice(0, 8).map((input) =>
    input.evaluate((el) => ({ accept: el.accept, name: el.name, id: el.id, aria: el.getAttribute("aria-label") || "" })).catch(() => ({}))));
  throw Object.assign(fail(409, "Plusieurs champs de fichier sur cette page : désigne le bon avec --selecteur."), { champs: seen });
}

async function throughTrigger(page, trigger, files) {
  let chooser = null;
  const waited = page.waitForEvent("filechooser", { timeout: TRIGGER_MS }).catch(() => null).then((c) => (chooser = c));
  await trigger.click({ timeout: 4000 }).catch(() => {
    throw fail(422, "Ce bouton n'a pas pu être cliqué : relis la page.");
  });
  // Une seconde pour le sélecteur du système : un champ déjà là n'est peut-être pas celui que ce bouton vient d'ouvrir.
  await Promise.race([waited, page.waitForTimeout(1000)]);
  const end = Date.now() + TRIGGER_MS;
  while (Date.now() < end) {
    if (chooser) {
      await chooser.setFiles(files);
      return "selecteur";
    }
    const input = await theOnlyInput(page);
    if (input) {
      await input.setInputFiles(files, { timeout: 10000 });
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
    await input.setInputFiles(files, { timeout: 10000 });
    return "champ";
  }
  const isInput = await target.evaluate((el) => el.matches('input[type="file"]'), null, { timeout: 4000 }).catch(() => {
    throw fail(422, "Rien ne correspond à ce que tu désignes : relis la page.");
  });
  if (!isInput) return throughTrigger(page, target, files);
  await target.setInputFiles(files, { timeout: 10000 });
  return "champ";
}

async function attachFiles(req, res, ctx) {
  try {
    if (Date.now() < privateUntil) throw fail(423, "L'utilisateur a la main sur l'écran : attends qu'il ait fini.");
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
    const tabState = findAgentTab(session, req.query.onglet ? String(req.query.onglet) : "");
    if (!tabState) throw fail(404, "Aucun onglet ouvert : ouvre d'abord la page.");
    session.lastAccess = Date.now();
    const via = await ctx.withUserLimit(String(req.query.userId), async () => {
      const used = await putFiles(tabState, files, { ref: req.query.ref, selector: req.query.selecteur });
      await tabState.page.waitForTimeout(1500); // le temps que la page lise le fichier et montre son aperçu
      return used;
    });
    res.json({ ok: true, via, fichiers: files.map((f) => path.basename(f)) });
  } catch (e) {
    ctx.log?.("info", "noah: fichier non joint", { error: String(e.message).slice(0, 200) });
    res.status(e.status || 500).json({
      error: e.status ? e.message : "La page n'a pas accepté le fichier : relis-la, puis réessaie.",
      ...(e.champs ? { champs: e.champs } : {}),
    });
  }
}

export default function register(app, ctx) {
  app.use((req, res, next) => {
    if (req.method === "POST" && (req.path === "/noah/fichier" || req.path === "/noah/joindre")) {
      if (!agentKeyGiven(req)) return res.status(403).json({ error: "Forbidden" });
      return req.path === "/noah/fichier" ? receiveFile(req, res) : attachFiles(req, res, ctx);
    }
    if (req.method === "POST" && req.path === "/noah/prive") {
      if (!process.env.NOAH_PRIVATE_KEY || req.headers.authorization !== `Bearer ${process.env.NOAH_PRIVATE_KEY}`) {
        return res.status(403).json({ error: "Forbidden" });
      }
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
