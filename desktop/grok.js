// Grok depuis cet ordinateur : la CLI officielle de xAI, « Grok Build » (binaire `grok`), lancée telle quelle, connectée par la personne
// avec son abonnement SuperGrok ou X Premium+. C'est la voie que xAI documente pour un programme local : `grok -p` sans interface,
// sortie `--output-format streaming-messages-json` (mêmes événements que Claude Code : system/init avec le modèle, puis result).
// Sources : https://docs.x.ai/build/overview (installation, `grok login`, `/usage`) ; documentation de la CLI, « Headless mode »
// (https://github.com/xai-org/grok-build, crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md) ;
// « Authentication » (même dossier, 02-authentication.md : connexion OAuth2 par auth.x.ai, jetons dans ~/.grok/auth.json).
// Noah ne lit ni ne copie jamais ces jetons et n'emprunte l'identifiant client d'aucune autre application (Hermes, OpenCode…) :
// la CLI se connecte elle-même, et Noah ne fait que la lancer. Un jeton n'est donc jamais au serveur, ni ici.
//
// Ce que xAI ne dit pas, et que ce module ne devine pas : la CLI sans interface ne rend ni pourcentage ni remise à zéro de
// l'abonnement (la commande `/usage` n'existe que dans une session interactive), et aucune commande documentée ne dit si la
// personne est connectée ni ne liste ses modèles. L'état « connecté » vient donc de la connexion faite d'ici, ou d'un tour réussi ;
// les modèles sont ceux que la CLI a annoncés (`init`). Pour l'utilisation : les tours et les jetons comptés, rien de plus.
const { execFile, spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const usage = require("./usage");
const claude = require("./claude");

const DETECT_TIMEOUT = 15000;
const LOGIN_MINUTES = 10;
const TURN_MINUTES = 10;
const MAX_PROMPT = 2_000_000;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const LIMIT_WORDS = /usage limit|rate limit|limit reached|quota|too many requests|credits? (?:exhausted|depleted)/i;
const AUTH_WORDS = /not (?:logged|signed) in|unauthori[sz]ed|login required|please (?:log|sign) in|authentication (?:required|failed)|invalid (?:token|credentials)/i;

let configured = null; // { cmd, prefix } : imposé par les tests (faux binaire)
let authFile = null; // fichier de connexion de la CLI : imposé par les tests ; sinon ~/.grok/auth.json, hors faux binaire
let minuteMs = 60000;
let last = { installe: false, connecte: false };
let known = []; // les modèles annoncés par la CLI à ses tours
let onChange = () => {};
let queue = Promise.resolve();
let running = null;

/** program, minute : changés par les tests. connected : l'état gardé par l'app (config.json) ; onChange : il change, l'app le garde. */
function configure({ program, minute, connected, models, changed, auth } = {}) {
  configured = program || null;
  if (auth !== undefined) authFile = auth || null;
  if (minute) minuteMs = minute;
  if (typeof connected === "boolean") last = { ...last, connecte: connected };
  if (Array.isArray(models)) known = models.filter((m) => typeof m === "string" && MODEL.test(m)).slice(0, 20);
  if (typeof changed === "function") onChange = changed;
}

// Une variable XAI_* posée sur le PC (clé d'API…) ferait facturer l'API au lieu de l'abonnement : elle ne passe jamais à la CLI.
function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^xai_/i.test(k)));
}

function locate() {
  if (configured) return configured;
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const names = process.platform === "win32" ? ["grok.exe"] : ["grok"];
  for (const dir of [...dirs, path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".grok", "bin")]) {
    for (const name of names) if (exists(path.join(dir, name))) return { cmd: path.join(dir, name), prefix: [] };
  }
  return null;
}

function setConnected(value) {
  const next = Boolean(value);
  if (last.connecte === next) return;
  last = { ...last, connecte: next };
  if (!next) usage.forget("grok");
  onChange();
}

/** Le fichier où la CLI range sa connexion existe-t-il ? Seule sa présence compte : il n'est jamais lu. null : on ne sait pas. */
function authPresent() {
  const file = authFile || (configured ? null : path.join(os.homedir(), ".grok", "auth.json"));
  if (!file) return null;
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

/**
 * La CLI est-elle là ? `grok --version` répond sans connexion, et la CLI ne dit pas si elle est connectée. Son fichier de connexion
 * le dit : une personne connectée hors de l'app (`grok login` dans un terminal, ou une autre installation de Noah) l'est aussi ici
 * (0.4.3 : Grok restait « non connecté » dans l'app installée).
 */
function detect() {
  const bin = locate();
  if (!bin) return Promise.resolve((last = { ...last, installe: false, connecte: false }));
  return new Promise((resolve) => {
    execFile(bin.cmd, [...bin.prefix, "--version"], { timeout: DETECT_TIMEOUT, windowsHide: true, maxBuffer: 64 * 1024, env: cleanEnv() }, (err) => {
      last = { ...last, installe: !(err && err.code === "ENOENT") };
      const present = last.installe ? authPresent() : null;
      if (present !== null && present !== last.connecte) setConnected(present);
      resolve(last);
    });
  });
}

const status = () => ({ ...last, occupe: Boolean(running) });
const models = () => (last.connecte ? known.map((slug) => ({ slug, nom: `Grok · ${slug}` })) : []);

/**
 * Ce que `grok login` affiche en mode « code d'appareil » (celui par défaut de la CLI 1.0.x) : l'adresse de vérification, chez xAI
 * (domaine x.ai exactement, en HTTPS), et le code à y recopier. Rend { url, code } (l'un ou l'autre peut manquer) ou null.
 * Un jeton ou une clé qui passerait dans la sortie n'est jamais retenu : seuls un code court et une adresse x.ai sortent d'ici.
 */
function deviceInfo(text) {
  const clean = String(text ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  let url = "", code = "";
  for (const m of clean.matchAll(/https:\/\/[^\s"'<>)]+/g)) {
    try {
      const u = new URL(m[0].replace(/[.,;]+$/, ""));
      if (u.protocol === "https:" && (u.hostname === "x.ai" || u.hostname.endsWith(".x.ai")) && !u.username && !u.password) {
        url = url || u.toString();
        const q = u.searchParams.get("user_code");
        if (q && /^[A-Za-z0-9-]{4,16}$/.test(q)) code = code || q;
      }
    } catch { /* pas une adresse */ }
  }
  const byLabel = clean.match(/\bcode\b[^A-Za-z0-9\r\n]{0,6}([A-Z0-9]{3,5}-[A-Z0-9]{3,5}|[A-Z0-9]{6,10})\b/);
  const bare = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  code = code || byLabel?.[1] || bare?.[1] || "";
  return url || code ? { url, code } : null;
}

/**
 * Connexion : `grok login` (code d'appareil par défaut). Sa sortie est invisible sans terminal : on la lit pour en tirer l'adresse
 * et le code, qu'on rend par onInfo({ url, code }) pour les montrer à la personne et ouvrir l'adresse dans son navigateur.
 * Le retour n'est PAS supposé automatique : la commande rend la main quand xAI a validé le code, et c'est elle seule qui compte.
 */
function login({ minutes = LOGIN_MINUTES, onInfo } = {}) {
  const bin = locate();
  if (!bin) return Promise.resolve({ erreur: "Grok Build n'est pas installé sur cet ordinateur." }); // i18n-ignore : lu par le serveur
  return new Promise((resolve) => {
    const child = spawn(bin.cmd, [...bin.prefix, "login"], { env: cleanEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let seen = "", sent = "";
    const take = (chunk) => {
      seen = (seen + chunk).slice(-4000);
      const info = deviceInfo(seen);
      const key = info ? `${info.url}|${info.code}` : "";
      if (info && key !== sent && info.url && info.code) { sent = key; try { onInfo?.(info); } catch { /* l'affichage ne doit pas casser la connexion */ } }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* déjà fini */ } }, minutes * minuteMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ erreur: String(e.message).slice(0, 200) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) { setConnected(true); return resolve({ ok: true }); }
      // Adresse ou code vus seulement à la fin (sortie sans saut de ligne) : on les rend avec l'échec, pour les montrer quand même.
      const info = deviceInfo(seen);
      if (info && !sent) try { onInfo?.(info); } catch { /* idem */ }
      resolve({ erreur: `La connexion à Grok ne s'est pas terminée (code ${code}).` }); // i18n-ignore : lu par la personne
    });
  });
}
/** Déconnexion : on demande à la CLI (`grok logout`) ; quoi qu'elle réponde, Noah cesse de s'en servir. */
function logout() {
  const bin = locate();
  setConnected(false);
  if (!bin) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    execFile(bin.cmd, [...bin.prefix, "logout"], { timeout: DETECT_TIMEOUT, windowsHide: true, env: cleanEnv() }, (err) => resolve({ ok: true, cli: !err }));
  });
}

/** Arguments exacts : aucun outil, aucune recherche web, un seul tour du modèle ; la consigne est un fichier (pas de limite de ligne). */
function brainArgs(model, promptFile, cwd) {
  return ["--prompt-file", promptFile, "--output-format", "streaming-messages-json", "--cwd", cwd,
    ...(model ? ["--model", model] : []), "--tools", "", "--disable-web-search", "--no-subagents", "--no-plan", "--max-turns", "1"];
}

function spawnTurn(bin, args, signal, cwd) {
  return new Promise((resolve) => {
    let final = null, modele = "", buffer = "", stderr = "", stopped = null;
    const child = spawn(bin.cmd, [...bin.prefix, ...args], { cwd, env: cleanEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = (why) => {
      if (stopped || child.exitCode !== null) return;
      stopped = why;
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else { child.kill("SIGINT"); setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000).unref(); }
    };
    running = { stop };
    const timer = setTimeout(() => stop("delai"), TURN_MINUTES * minuteMs);
    const onAbort = () => stop(signal.reason === "coupe" ? "coupe" : "annule");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const take = (raw) => {
      try {
        const e = JSON.parse(raw);
        if (e.type === "result") final = e;
        else if (e.type === "system" && e.subtype === "init" && typeof e.model === "string" && MODEL.test(e.model)) modele = e.model;
      } catch { /* ligne illisible : ignorée */ }
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) { take(buffer.slice(0, i).trim()); buffer = buffer.slice(i + 1); }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-3000); });
    let finished = false;
    const done = (code, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      running = null;
      if (buffer.trim()) take(buffer.trim());
      resolve({ final, modele, stderr, code, spawnError, arret: stopped });
    };
    child.on("error", (e) => done(null, e));
    child.on("close", (code) => done(code));
  });
}

const one = (text, max) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Un tour du cerveau : rend { ok, reponse (Chat Completions), modele, modele_exact } ou { erreur, statut, code }. */
function brain({ body, model, signal } = {}) {
  const turn = queue.then(() => brainTurn({ body, model, signal }));
  queue = turn.catch(() => {});
  return turn;
}

async function brainTurn({ body, model, signal }) {
  if (signal?.aborted) return { erreur: "tour annulé", statut: 499, code: "annule" }; // i18n-ignore : lu par le serveur
  const bin = locate();
  if (!bin) return { erreur: "Grok Build n'est pas installé sur cet ordinateur.", statut: 503, code: "absent" }; // i18n-ignore : lu par le serveur
  const chosen = MODEL.test(String(model || "")) ? String(model) : "";
  const tools = claude.toolsOf(body);
  const { system, conversation, token } = claude.brainPrompt(body, tools);
  if (system.length + conversation.length > MAX_PROMPT) return { erreur: "contexte trop long pour Grok", statut: 413, code: "trop_long" }; // i18n-ignore : lu par le serveur
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-grok-"));
  const promptFile = path.join(dir, "consigne");
  const started = Date.now();
  try {
    let tail = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // La CLI n'a pas d'option « consigne système » documentée : tout part dans un seul fichier, la consigne d'abord.
      fs.writeFileSync(promptFile, `${system}\n\n---\n\n${conversation}${tail}`, { mode: 0o600 });
      const run = await spawnTurn(bin, brainArgs(chosen, promptFile, dir), signal, dir);
      if (run.arret === "delai") return { erreur: "Grok n'a pas répondu en 10 minutes", statut: 504, code: "delai" }; // i18n-ignore : lu par le serveur
      if (run.arret) return { erreur: "tour arrêté", statut: 499, code: run.arret }; // i18n-ignore : lu par le serveur
      if (run.spawnError) return { erreur: one(run.spawnError.message, 300), statut: 503, code: "absent" };
      const why = `${run.final?.result ?? ""} ${run.stderr}`;
      if (LIMIT_WORDS.test(why)) {
        usage.record("grok", { modele: run.modele, tour: true, limite: true });
        return { erreur: one(run.final?.result || run.stderr, 300), statut: 429, code: "limite" };
      }
      if (AUTH_WORDS.test(why)) { setConnected(false); return { erreur: "Grok est déconnecté sur cet ordinateur.", statut: 503, code: "deconnecte" }; } // i18n-ignore : lu par le serveur
      if (!run.final || run.final.is_error || run.code !== 0) {
        return { erreur: one(run.final?.result || run.stderr || `Grok s'est arrêté (code ${run.code}).`, 300), statut: 502, code: "echec" }; // i18n-ignore : lu par le serveur
      }
      const u = run.final.usage || {};
      const total = Number(u.total_tokens) || (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.output_tokens) || 0);
      usage.record("grok", { modele: run.modele, tour: true, jetons: total });
      setConnected(true);
      if (run.modele && !known.includes(run.modele)) { known = [...known, run.modele].slice(-20); onChange(); }
      const decision = claude.readDecision({ result: run.final.result ?? run.final.text }, tools);
      if (decision.raison) {
        tail = `\n<<Noah #${token}>>\nTa réponse précédente a été refusée : ${one(decision.raison, 120)}. Réponds seulement par l'objet JSON demandé.\n`; // i18n-ignore : lu par le modèle
        if (attempt === 0) continue;
        return { erreur: `réponse illisible de Grok (${decision.raison})`, statut: 502, code: "illisible" }; // i18n-ignore : lu par le serveur
      }
      const calls = decision.appels.map((c) => ({ id: `call_${randomBytes(9).toString("hex")}`, type: "function", function: { name: c.nom, arguments: JSON.stringify(c.arguments) } }));
      const message = { role: "assistant", content: decision.texte || (calls.length ? null : "") };
      if (calls.length) message.tool_calls = calls;
      const name = run.modele || chosen || "grok";
      return {
        ok: true, modele: chosen || name, modele_exact: run.modele || undefined, duree_ms: Date.now() - started,
        reponse: {
          id: `grok-${randomBytes(6).toString("hex")}`, object: "chat." + "completion", created: Math.floor(Date.now() / 1000), model: name,
          choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0), completion_tokens: Number(u.output_tokens) || 0, total_tokens: total },
        },
      };
    }
    return { erreur: "réponse illisible de Grok", statut: 502, code: "illisible" }; // i18n-ignore : lu par le serveur
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const brainBusy = () => Boolean(running);
const stopAll = (why = "coupe") => running?.stop(why);

module.exports = { configure, locate, detect, status, models, login, deviceInfo, logout, brain, brainArgs, brainBusy, stopAll, setConnected, cleanEnv };
