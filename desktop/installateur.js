// Installer la CLI d'un abonnement quand elle manque : Claude Code (Anthropic) ou Grok Build (xAI).
// Seuls les installateurs OFFICIELS, en HTTPS, sur le domaine de l'éditeur :
//   - Claude Code : https://claude.ai/install.ps1 (Windows PowerShell), https://claude.ai/install.sh (macOS, Linux)
//     (documentation d'Anthropic : https://code.claude.com/docs/en/setup, « Native Install (Recommended) ») ;
//   - Grok Build : https://x.ai/cli/install.ps1 (Windows), https://x.ai/cli/install.sh (macOS, Linux)
//     (documentation de xAI : https://docs.x.ai/build/overview).
// Rien n'est téléchargé si la CLI est déjà là, ni sans l'accord de la personne dans une fenêtre claire. Le script est téléchargé
// dans un dossier temporaire, lancé tel quel avec un environnement sans clé ni jeton, puis supprimé. Noah ne lit rien de ce que
// l'installateur écrit ailleurs que pour retrouver le binaire (emplacements par défaut, même si le PATH du processus est ancien).
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INSTALL_MINUTES = 15;
const MAX_SCRIPT = 512 * 1024;

const SOURCES = {
  claude: { nom: "Claude Code", editeur: "Anthropic", site: "claude.ai", mo: 370, ps1: "https://claude.ai/install.ps1", sh: "https://claude.ai/install.sh" },
  grok: { nom: "Grok", editeur: "xAI", site: "x.ai", mo: 260, ps1: "https://x.ai/cli/install.ps1", sh: "https://x.ai/cli/install.sh" },
};

let overrides = null; // { sources, runner, minute } : imposés par les tests (faux installateur sur 127.0.0.1)
let minuteMs = 60000;

function configure({ sources, runner, minute } = {}) {
  overrides = sources || runner ? { sources: sources || null, runner: runner || null } : null;
  if (minute) minuteMs = minute;
}

const source = (which) => ({ ...SOURCES[which], ...(overrides?.sources?.[which] || {}) });

/** Un secret ne s'écrit jamais au journal : tout ce qui y ressemble est masqué. */
function scrub(line) {
  return String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/(bearer\s+|[?&](?:key|token|code)=|(?:token|key|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"'&]+/gi, "$1[masqué]")
    .replace(/\b(sk|xai|oaiapp|ghp|gho)[-_][A-Za-z0-9_-]{8,}/g, "[masqué]").replace(/\s+/g, " ").trim().slice(0, 240);
}

/** L'adresse doit être en HTTPS (HTTP seulement vers 127.0.0.1 pour les essais), sans identifiants, sur le domaine exact de l'éditeur. */
function checkUrl(raw, site) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  const local = overrides?.sources && u.protocol === "http:" && u.hostname === "127.0.0.1";
  return (local || (u.protocol === "https:" && u.hostname === site)) && !u.username && !u.password;
}

async function download(url, site) {
  let r;
  try {
    r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60000) });
    // Une redirection n'est suivie que si elle reste sur le même domaine et en HTTPS.
    if (r.status >= 300 && r.status < 400) {
      const next = new URL(r.headers.get("location") || "", url).toString();
      if (!checkUrl(next, site)) return { erreur: "adresse" };
      r = await fetch(next, { redirect: "error", signal: AbortSignal.timeout(60000) });
    }
  } catch {
    return { erreur: "reseau" };
  }
  if (!r.ok) return { erreur: "reseau", statut: r.status };
  const text = await r.text().catch(() => "");
  if (!text || text.length > MAX_SCRIPT || /^\s*<(!doctype|html)/i.test(text)) return { erreur: "installateur" }; // une page de blocage, pas un script
  return { text };
}

/** L'environnement de l'installateur : sans clé d'API ni jeton (rien de la personne n'a à y passer). */
function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/(key|token|secret|password|credential)/i.test(k) && !/^(anthropic|claude|xai|grok|openai)_/i.test(k)));
}

/** Lance le script avec l'interpréteur du système ; rend le code de sortie. Les lignes de sortie (masquées) vont à onLine. */
function runScript(file, onLine, signal) {
  if (overrides?.runner) return overrides.runner(file, onLine, signal);
  const win = process.platform === "win32";
  const [program, args] = win ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file]] : ["bash", [file]];
  return new Promise((resolve) => {
    const child = spawn(program, args, { env: cleanEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    const take = (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.search(/[\r\n]/)) >= 0) { const line = scrub(buffer.slice(0, i)); buffer = buffer.slice(i + 1); if (line) onLine(line); }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const stop = () => { if (win && child.pid) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {}); else child.kill(); };
    const timer = setTimeout(() => { stop(); resolve({ code: null, delai: true }); }, INSTALL_MINUTES * minuteMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, absent: true }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code }); });
  });
}

/**
 * S'assure que la CLI est là. which : "claude" | "grok". locate : la fonction du module de la CLI (rend null si absente).
 * confirm(titre, detail) : la fenêtre d'accord (vrai si la personne accepte). onProgress(étape, ligne) : « accord », « telechargement »,
 * « installation », « verification », puis les lignes de l'installateur. Rend { ok, deja? } ou { refuse } ou { erreur, detail? }.
 */
async function ensure(which, { locate, confirm, onProgress = () => {}, log = () => {} }) {
  if (!SOURCES[which]) return { erreur: "inconnu" };
  if (locate()) return { ok: true, deja: true }; // déjà là : aucun téléchargement, aucune question
  const src = source(which);
  const win = process.platform === "win32";
  const url = win ? src.ps1 : src.sh;
  if (!checkUrl(url, src.site)) return { erreur: "adresse" };
  onProgress("accord");
  const accepted = await confirm(src, url);
  if (!accepted) { log(`${which} : installation refusée par la personne`); return { refuse: true }; } // i18n-ignore : journal
  onProgress("telechargement");
  log(`${which} : téléchargement de l'installateur officiel ${new URL(url).host}${new URL(url).pathname}`); // i18n-ignore : journal
  const got = await download(url, src.site);
  if (got.erreur) { log(`${which} : échec du téléchargement (${got.erreur}${got.statut ? ` ${got.statut}` : ""})`); return { erreur: got.erreur }; } // i18n-ignore : journal
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-install-"));
  try {
    const file = path.join(dir, win ? "install.ps1" : "install.sh");
    fs.writeFileSync(file, got.text, { mode: 0o700 });
    onProgress("installation");
    const result = await runScript(file, (line) => { log(`${which} : ${line}`); onProgress("installation", line); }); // i18n-ignore : journal
    if (result.delai) return { erreur: "delai" };
    if (result.absent) return { erreur: "plateforme" };
    if (result.code !== 0) { log(`${which} : l'installateur s'est arrêté (code ${result.code})`); return { erreur: "installateur", code: result.code }; } // i18n-ignore : journal
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  onProgress("verification");
  // Le PATH de ce processus peut être ancien : locate() cherche aussi les emplacements par défaut de l'installateur.
  if (!locate()) { log(`${which} : binaire introuvable après l'installation`); return { erreur: "introuvable" }; } // i18n-ignore : journal
  log(`${which} : installé`); // i18n-ignore : journal
  return { ok: true };
}

module.exports = { configure, ensure, scrub, checkUrl, SOURCES, cleanEnv };
