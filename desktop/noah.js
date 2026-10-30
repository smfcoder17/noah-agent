// Démarrage de Noah Agent sur l'ordinateur : Docker, fichier .env, services, puis attente que l'interface réponde.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Lit le .env du projet (clé=valeur, une par ligne). */
function readEnv(home) {
  const file = path.join(home, ".env");
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Autorise le partage des dossiers du dossier personnel de l'utilisateur, s'il n'a encore rien choisi.
 * Docker Desktop accepte les chemins Windows avec des barres obliques (C:/Users/…).
 */
function ensureShareRoots(home) {
  const env = readEnv(home);
  if (env.NOAH_SHARE_ROOTS !== undefined) return false;
  const root = os.homedir().replace(/\\/g, "/");
  fs.appendFileSync(path.join(home, ".env"), `\n# Dossiers que tu peux partager avec tes agents (Détails > Dossiers), séparés par « ; ».\nNOAH_SHARE_ROOTS=${root}\n`);
  return true;
}

function run(cmd, args, cwd, timeout = 600000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().split(/\r?\n/).slice(-3).join(" ")));
      else resolve(stdout);
    });
  });
}

async function dockerReady() {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], undefined, 15000);
    return true;
  } catch {
    return false;
  }
}

async function reachable(url) {
  try {
    const r = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Lance (ou relance) Noah et rend l'adresse de l'interface. `step(texte)` décrit ce qui se passe à l'écran.
 * `restart` : relance les services même s'ils tournent (après un changement des dossiers autorisés).
 */
async function start(home, step, restart = false) {
  const env = readEnv(home);
  const url = `http://127.0.0.1:${env.APOLLO_PORT || 8080}`;
  if (!restart && (await reachable(url))) return url;
  step("Vérification de Docker…");
  if (!(await dockerReady())) {
    throw new Error("Docker n'est pas démarré. Ouvre Docker Desktop, puis réessaie.");
  }
  step("Démarrage de Noah…");
  await run("docker", ["compose", "up", "-d"], home);
  step("Noah se réveille…");
  for (let i = 0; i < 90; i++) {
    if (await reachable(url)) return url;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Noah ne répond pas. Regarde « docker compose logs server » dans le dossier de Noah.");
}

/** Écrit (ou remplace) une ligne CLÉ=valeur du .env. */
function setEnv(home, key, value) {
  const file = path.join(home, ".env");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join("\n"));
}

/** Adresse de l'ordinateur sur le réseau local (Wi-Fi ou Ethernet), sans les cartes virtuelles. */
function lanAddress() {
  const skip = /vEthernet|VirtualBox|VMware|Loopback|WSL|Docker|Hyper-V|Tailscale|ZeroTier|vpn/i;
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

/** Noah joignable par les appareils du réseau local (téléphone) : le serveur écoute sur toutes les interfaces. */
async function openToLan(home) {
  setEnv(home, "APOLLO_BIND", "0.0.0.0");
  await run("docker", ["compose", "up", "-d", "server"], home);
}

module.exports = { start, ensureShareRoots, readEnv, lanAddress, openToLan };
