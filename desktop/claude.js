// Claude Code installé sur cet ordinateur : le binaire officiel `claude`, lancé tel quel, connecté par la personne avec son abonnement.
// Noah ne lit, ne copie et ne relaie jamais ses identifiants : il demande l'état de la connexion à la CLI elle-même
// (`claude auth status --json`) et n'en garde que trois champs, puis lui confie une tâche entière (`claude -p`) dans un dossier confié.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DETECT_TIMEOUT = 15000;
const MAX_LINES = 400; // lignes de progression gardées pour le résultat
const STOP_GRACE = 3000; // SIGINT, puis SIGTERM 3 s plus tard (hors Windows : taskkill d'emblée, avec les sous-processus)
const MAX_TEXT = 20000;
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Les outils permis à la CLI sont fixés ici, jamais par la consigne. « fichiers » : lire et modifier dans le dossier confié,
// en mode restreint (aucun outil qui lance du code, aucune page web, réglages de la personne ignorés, fichiers enfermés dans le dossier).
const PROFILES = {
  fichiers: { tools: ["Read", "Glob", "Grep", "Edit", "Write"], restricted: true },
  complet: { tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "WebFetch"], restricted: false },
};

let configured = null; // { cmd, prefix } : imposé par les tests (faux binaire)
let minuteMs = 60000; // raccourci par les tests pour éprouver le délai
let last = { installe: false, connecte: false, offre: "", methode: "" };
let current = null; // une tâche à la fois sur cet ordinateur

function configure({ program, minute } = {}) {
  configured = program || null;
  if (minute) minuteMs = minute;
}

/** Le binaire officiel : claude.exe dans le PATH, celui que l'installation npm enveloppe, ou l'installation native. */
function locate() {
  if (configured) return configured;
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (process.platform === "win32") {
    for (const dir of dirs) {
      if (exists(path.join(dir, "claude.exe"))) return { cmd: path.join(dir, "claude.exe"), prefix: [] };
      // npm : claude.cmd lance node_modules\@anthropic-ai\claude-code\bin\claude.exe. Un .cmd demanderait un shell : on prend l'exe.
      const wrapped = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (exists(path.join(dir, "claude.cmd")) && exists(wrapped)) return { cmd: wrapped, prefix: [] };
    }
    const native = path.join(os.homedir(), ".local", "bin", "claude.exe");
    return exists(native) ? { cmd: native, prefix: [] } : null;
  }
  for (const dir of [...dirs, path.join(os.homedir(), ".local", "bin")]) {
    if (exists(path.join(dir, "claude"))) return { cmd: path.join(dir, "claude"), prefix: [] };
  }
  return null;
}

/** L'état de la connexion, dit par la CLI. Seuls connecté, offre et méthode sortent : ni e-mail, ni organisation, ni jeton. */
function detect() {
  const bin = locate();
  if (!bin) return Promise.resolve((last = { installe: false, connecte: false, offre: "", methode: "" }));
  return new Promise((resolve) => {
    execFile(bin.cmd, [...bin.prefix, "auth", "status", "--json"], { timeout: DETECT_TIMEOUT, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err && err.code === "ENOENT") return resolve((last = { installe: false, connecte: false, offre: "", methode: "" }));
      let data = {};
      try { data = JSON.parse(String(stdout)); } catch { /* sortie illisible : installée, état inconnu */ }
      const word = (v) => (typeof v === "string" && /^[a-z0-9._-]{1,20}$/i.test(v) ? v.toLowerCase() : "");
      resolve((last = { installe: true, connecte: data.loggedIn === true, offre: word(data.subscriptionType), methode: word(data.authMethod) }));
    });
  });
}

const status = () => ({ ...last, occupe: Boolean(current) });
const busy = () => Boolean(current);

/** Les arguments exacts de la CLI, montrés dans l'accord tels qu'ils partent. La consigne arrive par l'entrée standard :
 * un texte qui commence par « -- » ne devient jamais une option. */
function argsFor(profile) {
  const p = PROFILES[profile] || PROFILES.fichiers;
  return ["-p", "--output-format", "stream-json", "--verbose", ...(p.restricted ? ["--restricted"] : []), "--strict-mcp-config",
    "--tools", p.tools.join(","), "--allowedTools", p.tools.join(","), "--permission-mode", "acceptEdits", "--permission-prompts", "none"];
}

const short = (text, max) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Une ligne lisible par événement du flux : l'agent et la personne suivent l'avancement sans tout le texte. */
function describe(event, cwd) {
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    return event.message.content.map((part) => {
      if (part.type === "text" && part.text) return short(part.text, 200);
      if (part.type === "tool_use") {
        const input = part.input || {};
        const target = input.file_path ? path.relative(cwd, String(input.file_path)) || "." : input.pattern || input.command || input.url || input.query || "";
        return short(`${part.name} ${target}`, 200);
      }
      return "";
    }).filter(Boolean);
  }
  return [];
}

/** Lance une tâche : rend { ok, texte, fichiers, cout_estime_usd, session, tours, duree_ms, arret?, limite?, erreur? }. */
function run({ consigne, cwd, profile = "fichiers", minutes = 30, onLine = () => {}, signal } = {}) {
  if (current) return Promise.resolve({ erreur: "Une tâche Claude Code tourne déjà sur cet ordinateur : attends sa fin." }); // i18n-ignore : lu par le serveur
  const bin = locate();
  if (!bin) return Promise.resolve({ erreur: "Claude Code n'est pas installé sur cet ordinateur." }); // i18n-ignore : lu par le serveur
  const started = Date.now();
  const files = new Set();
  const lines = [];
  let final = null, buffer = "", stderr = "", stopped = null;
  const child = spawn(bin.cmd, [...bin.prefix, ...argsFor(profile)], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const job = { child, stop: (why) => stop(why) };
  current = job;
  const stop = (why) => {
    if (stopped || child.exitCode !== null) return;
    stopped = why;
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    } else {
      child.kill("SIGINT");
      setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, STOP_GRACE).unref();
    }
  };
  const timer = setTimeout(() => stop("delai"), Math.max(1, minutes) * minuteMs);
  const onAbort = () => stop(signal.reason === "coupe" ? "coupe" : "annule");
  signal?.addEventListener("abort", onAbort, { once: true });
  const take = (raw) => {
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (event.type === "result") final = event;
    if (event.type === "assistant") {
      for (const part of event.message?.content || []) {
        if (part.type === "tool_use" && FILE_TOOLS.has(part.name) && part.input?.file_path) {
          const rel = path.relative(cwd, path.resolve(cwd, String(part.input.file_path)));
          if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) files.add(rel.split(path.sep).join("/"));
        }
      }
    }
    for (const line of describe(event, cwd)) {
      lines.push(line);
      if (lines.length > MAX_LINES) lines.shift();
      onLine(line);
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, i).trim());
      buffer = buffer.slice(i + 1);
    }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-3000); });
  child.stdin.on("error", () => {});
  child.stdin.end(String(consigne));
  return new Promise((resolve) => {
    let finished = false;
    const done = (code, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (buffer.trim()) take(buffer.trim());
      current = null;
      const out = {
        ok: !stopped && !spawnError && code === 0 && Boolean(final) && !final.is_error,
        texte: String(final?.result ?? "").trim().slice(0, MAX_TEXT) || undefined,
        fichiers: [...files].slice(0, 200),
        cout_estime_usd: typeof final?.total_cost_usd === "number" ? final.total_cost_usd : undefined,
        session: typeof final?.session_id === "string" ? final.session_id.slice(0, 80) : undefined,
        tours: typeof final?.num_turns === "number" ? final.num_turns : undefined,
        duree_ms: Date.now() - started,
        etapes: lines.slice(-12),
      };
      if (stopped) out.arret = stopped;
      const why = `${final?.result ?? ""} ${final?.subtype ?? ""} ${stderr}`;
      if (/usage limit|rate limit|limit reached|5-hour limit|weekly limit/i.test(why)) out.limite = true;
      if (!out.ok && !stopped) out.erreur = short(spawnError?.message || (final?.is_error ? final.result : "") || stderr || `Claude Code s'est arrêté (code ${code}).`, 600); // i18n-ignore : lu par le serveur
      resolve(out);
    };
    child.on("error", (e) => done(null, e));
    child.on("close", (code) => done(code));
  });
}

/** « Couper l'accès » ou fermeture de l'app : la tâche en cours s'arrête. */
function stopAll(why = "coupe") {
  current?.stop(why);
}

module.exports = { configure, locate, detect, status, busy, run, stopAll, argsFor, PROFILES };
