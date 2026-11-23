// Limites du forfait ChatGPT, lues par l'interface OFFICIELLE de Codex : `codex app-server`, protocole JSON-RPC en lignes JSON sur
// l'entrée et la sortie standard. Si Codex est installé et connecté sur cet ordinateur, on lui demande `account/rateLimits/read`
// (et `account/read` pour le nom de l'offre). Source : documentation d'OpenAI, « Codex app-server »
// (https://developers.openai.com/codex/app-server, qui renvoie vers https://learn.chatgpt.com/docs/app-server), sections
// « Check auth state » et « Rate limits (ChatGPT) » ; le journal de ses messages ne sort jamais de ce fichier.
// Noah ne lit JAMAIS les fichiers de Codex ni ses identifiants : c'est Codex qui répond. Il ne garde que des pourcentages, des
// dates de remise à zéro et le nom de l'offre ; l'e-mail que `account/read` rend est jeté sans être lu plus loin.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const usage = require("./usage");

const TIMEOUT = 20000;
let configured = null; // { cmd, prefix } : imposé par les tests (faux Codex)
let timeoutMs = TIMEOUT;

function configure({ program, timeout } = {}) {
  configured = program || null;
  if (timeout) timeoutMs = timeout;
}

// Rien d'OpenAI ni de Codex ne doit changer l'identité du compte : la clé d'API de la personne ne passe pas.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^openai_api_key$/i.test(k)));

/** Le binaire de Codex : codex.exe dans le PATH, celui que l'installation npm enveloppe, ou l'installation native. */
function locate() {
  if (configured) return configured;
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (process.platform === "win32") {
    const triple = process.arch === "arm64" ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"] : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
    for (const dir of dirs) {
      if (exists(path.join(dir, "codex.exe"))) return { cmd: path.join(dir, "codex.exe"), prefix: [] };
      // npm : codex.cmd lance le binaire natif rangé dans node_modules. Un .cmd demanderait un shell : on prend l'exe.
      const wrapped = path.join(dir, "node_modules", "@openai", "codex", "node_modules", "@openai", triple[0], "vendor", triple[1], "bin", "codex.exe");
      if (exists(path.join(dir, "codex.cmd")) && exists(wrapped)) return { cmd: wrapped, prefix: [] };
    }
    return null;
  }
  for (const dir of [...dirs, path.join(os.homedir(), ".local", "bin")]) if (exists(path.join(dir, "codex"))) return { cmd: path.join(dir, "codex"), prefix: [] };
  return null;
}

/** Un échange JSON-RPC avec `codex app-server` : initialize, initialized, puis les requêtes. Rend { réponses par id } ou { erreur }. */
function exchange(requests) {
  const bin = locate();
  if (!bin) return Promise.resolve({ erreur: "absent" });
  return new Promise((resolve) => {
    const child = spawn(bin.cmd, [...bin.prefix, "app-server"], { env: cleanEnv(), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const answers = {};
    let buffer = "", finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (process.platform === "win32" && child.pid) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => done({ erreur: "delai" }), timeoutMs);
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", () => done({ erreur: "absent" }));
    child.on("close", () => done({ erreur: "ferme" }));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 0) { // initialize répondu : on acquitte, puis on pose les questions
          if (msg.error) return done({ erreur: "initialisation" });
          send({ method: "initialized", params: {} });
          requests.forEach((r, n) => send({ method: r.method, id: n + 1, params: r.params }));
        } else if (typeof msg.id === "number" && msg.id >= 1) {
          answers[msg.id] = msg;
          if (Object.keys(answers).length === requests.length) done({ reponses: requests.map((_r, n) => answers[n + 1]) });
        }
      }
    });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "noah_agent", title: "Noah Agent", version: "1.0.0" } } });
  });
}

/** Demande à Codex les limites du forfait de la personne ; les range dans usage.js. Rend { ok, offre, fenetres } ou { erreur }. */
async function readLimits() {
  const out = await exchange([{ method: "account/rateLimits/read" }, { method: "account/read", params: { refreshToken: false } }]);
  if (out.erreur) return { erreur: out.erreur };
  const [limits, account] = out.reponses;
  if (limits?.error || !limits?.result) return { erreur: "non_connecte" };
  const plan = account?.result?.account?.planType;
  const offre = typeof plan === "string" && /^[a-z0-9_-]{1,20}$/i.test(plan) ? plan.toLowerCase() : "";
  const fenetres = usage.fromAppServerLimits(limits.result);
  if (!fenetres.length) return { erreur: "sans_mesure" };
  usage.record("chatgpt", { fenetres, offre });
  return { ok: true, offre, fenetres };
}

const installed = () => Boolean(locate());

module.exports = { configure, locate, readLimits, installed };
