// Connexions gardées, sur le vrai Firefox : une page pose un cookie de connexion, puis le conteneur est tué net (comme un
// serveur qui redémarre ou une panne). Avant notre sauvegarde régulière, le cookie était perdu ; il doit revenir.
//     node tests/navigateur/sessions_reel.mjs
// Il faut l'image du navigateur en local et un accès à example.com. Aucune clé.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ID = randomBytes(3).toString("hex");
const NAME = `noah-sessions-${ID}`;
const VOLUME = `noah-sessions-${ID}`;
const PORT = 39000 + (parseInt(ID, 16) % 900);
const KEY = randomBytes(16).toString("hex");
const IMAGE = process.env.BROWSER_IMAGE || "ghcr.io/smfcoder17/noah-browser:stable";
const USER = { userId: "agent", sessionKey: "agent" };

const docker = (...args) => {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} : ${r.stderr}`);
  return r.stdout.trim();
};
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} : ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function ready() {
  for (let i = 0; i < 90; i++) {
    try {
      await api("GET", "/health");
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("le navigateur ne démarre pas");
}
async function cookieAfterRestart() {
  docker("kill", NAME); // arrêt brutal : aucune fermeture propre, aucune sauvegarde de Camofox
  docker("start", NAME);
  await ready();
  const tab = await api("POST", "/tabs", { ...USER, url: "https://example.com/" });
  const r = await api("POST", `/tabs/${tab.tabId}/evaluate`, { userId: USER.userId, expression: "document.cookie" });
  return String(r.result ?? r.value ?? JSON.stringify(r));
}

let failed = false;
try {
  docker("volume", "create", VOLUME);
  docker("create", "--name", NAME, "-p", `127.0.0.1:${PORT}:9377`, "-v", `${VOLUME}:/data`,
    "-e", "CAMOFOX_PROFILE_DIR=/data/profiles", "-e", "CAMOFOX_COOKIES_DIR=/data/cookies", "-e", `CAMOFOX_API_KEY=${KEY}`,
    "-e", `CAMOFOX_ACCESS_KEY=${KEY}`, "-e", `NOAH_PRIVATE_KEY=${KEY}`, "-e", `NOAH_SESSION_SAVE_MS=${process.env.NOAH_TEST_SAVE_MS || 5000}`, IMAGE); // témoin : NOAH_TEST_SAVE_MS=3600000 doit échouer
  // Comme le lanceur : notre extension et sa déclaration, posées avant le démarrage.
  docker("cp", join(ROOT, "launcher/camofox-noah"), `${NAME}:/app/plugins/noah`); // le dossier : docker cp ne crée pas un dossier absent
  docker("cp", join(ROOT, "launcher/camofox-noah/camofox.config.json"), `${NAME}:/app/camofox.config.json`);
  docker("start", NAME);
  await ready();
  const tab = await api("POST", "/tabs", { ...USER, url: "https://example.com/" });
  await api("POST", `/tabs/${tab.tabId}/evaluate`, { userId: USER.userId, expression: "document.cookie = 'connexion=gardee; max-age=99999; path=/'" });
  await sleep(12_000); // deux passages de la sauvegarde régulière (5 s ici, 60 s en vrai)
  const kept = await cookieAfterRestart();
  if (!kept.includes("connexion=gardee")) throw new Error(`cookie perdu après un arrêt brutal : ${kept}`);
  console.log("OK    vrai Firefox : une connexion posée par la page revient après un arrêt brutal du conteneur");
} catch (e) {
  failed = true;
  console.error(`ECHEC ${e.message}`);
  try {
    console.error(docker("logs", "--tail", "30", NAME));
  } catch {
    /* rien à montrer */
  }
} finally {
  spawnSync("docker", ["rm", "-f", NAME]);
  spawnSync("docker", ["volume", "rm", VOLUME]);
}
process.exit(failed ? 1 : 0);
