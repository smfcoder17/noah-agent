// Empreinte gardée, sur le vrai Firefox : l'empreinte lue dans une page (navigator.userAgent, écran, cœurs, rendu WebGL,
// polices) reste la même après un redémarrage du conteneur et après sa recréation (mise à jour de Noah ou de l'image), avec
// les cookies. Un autre agent en a une autre ; une nouvelle identité demandée en tire une autre, cookies gardés.
//     BROWSER_IMAGE=noah-browser:empreinte node tests/navigateur/empreinte_reel.mjs
// Il faut l'image du navigateur en local (docker build -t noah-browser:empreinte launcher/camofox-bureau) et example.com.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = randomBytes(3).toString("hex");
const KEY = randomBytes(16).toString("hex");
const IMAGE = process.env.BROWSER_IMAGE || "ghcr.io/smfcoder17/noah-browser:stable";
const USER = { userId: "noah", sessionKey: "noah" };
const made = [];

const docker = (...args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} : ${r.stderr}`);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Une page ordinaire lit ce qu'un site lit de la machine.
const READ = `(() => {
  const g = document.createElement("canvas").getContext("webgl");
  const dbg = g && g.getExtension("WEBGL_debug_renderer_info");
  const c = document.createElement("canvas").getContext("2d");
  const largeur = (f) => { c.font = "32px " + f; return Math.round(c.measureText("Noah mesure les polices 0123456789 mmmWWWiii").width * 100) / 100; };
  return JSON.stringify({
    ua: navigator.userAgent, ecran: [screen.width, screen.height], fenetre: [outerWidth, outerHeight],
    coeurs: navigator.hardwareConcurrency, webgl: g ? (dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : null,
    polices: ["serif", "sans-serif", "monospace", "Arial", "DejaVu Sans"].map(largeur), langue: navigator.language,
  });
})()`;

function agent(name) {
  const box = { name: `noah-empreinte-${name}-${RUN}`, volume: `noah-empreinte-${name}-${RUN}`, port: 39000 + ((parseInt(RUN, 16) + made.length * 7) % 900) };
  made.push(box);
  docker("volume", "create", box.volume);
  return box;
}
function create(box) {
  // Comme le lanceur (launcher.py, _ensure_browser) : mêmes variables, même volume, plugin Noah posé avant le démarrage.
  docker("create", "--name", box.name, "-p", `127.0.0.1:${box.port}:9377`, "-v", `${box.volume}:/data`, "--shm-size", "1g",
    "-e", "CAMOFOX_PROFILE_DIR=/data/profiles", "-e", "CAMOFOX_COOKIES_DIR=/data/cookies", "-e", `CAMOFOX_API_KEY=${KEY}`,
    "-e", `CAMOFOX_ACCESS_KEY=${KEY}`, "-e", `NOAH_PRIVATE_KEY=${KEY}`, "-e", "NOAH_SESSION_SAVE_MS=3000",
    "-e", "CAMOFOX_DISABLE_DEFAULT_ADDONS=1", "-e", "ENABLE_VNC=1", "-e", "VNC_RESOLUTION=1920x1080", "-e", `VNC_PASSWORD=${KEY.slice(0, 8)}`,
    "-e", "CAMOFOX_LOCALE=fr-CA", "-e", "CAMOFOX_TIMEZONE=America/Toronto", "-e", "TZ=America/Toronto", IMAGE);
  docker("cp", join(ROOT, "launcher/camofox-noah"), `${box.name}:/app/plugins/noah`);
  docker("cp", join(ROOT, "launcher/camofox-noah/camofox.config.json"), `${box.name}:/app/camofox.config.json`);
  docker("start", box.name);
}
async function api(box, method, path, body) {
  const r = await fetch(`http://127.0.0.1:${box.port}${path}`, {
    method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} : ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function read(box) {
  for (let i = 0; ; i++) {
    try {
      await api(box, "GET", "/health");
      break;
    } catch (e) {
      if (i > 90) throw new Error(`le navigateur ne démarre pas : ${e.message}`);
      await sleep(1000);
    }
  }
  const tab = await api(box, "POST", "/tabs", { ...USER, url: "https://example.com/" });
  const ev = async (expression) => {
    const r = await api(box, "POST", `/tabs/${tab.tabId}/evaluate`, { userId: USER.userId, expression });
    return r.result ?? r.value;
  };
  return { fp: JSON.parse(await ev(READ)), cookie: String(await ev("document.cookie")), ev };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (label, fp) => console.log(`${label.padEnd(24)} ${JSON.stringify(fp)}`);

let failed = false;
try {
  const a = agent("a");
  create(a);
  const first = await read(a);
  show("A, lancement 1", first.fp);
  await first.ev("document.cookie = 'connexion=gardee; max-age=99999; path=/'");
  await sleep(8000); // la sauvegarde régulière (3 s ici, 60 s en vrai)
  const kept = docker("exec", a.name, "sh", "-c", "ls /data/empreinte.json /data/profiles/*/storage-state.json");
  console.log(`volume de A :\n  ${kept.split("\n").join("\n  ")}`);

  docker("restart", "-t", "20", a.name); // veille, arrêt, plantage : Firefox repart de zéro
  const restarted = await read(a);
  show("A, après redémarrage", restarted.fp);
  if (!same(restarted.fp, first.fp)) throw new Error("empreinte changée après un redémarrage");
  if (!restarted.cookie.includes("connexion=gardee")) throw new Error(`cookie perdu après un redémarrage : ${restarted.cookie}`);

  docker("rm", "-f", a.name); // mise à jour de Noah ou de l'image : conteneur recréé, volume gardé
  create(a);
  const recreated = await read(a);
  show("A, conteneur recréé", recreated.fp);
  if (!same(recreated.fp, first.fp)) throw new Error("empreinte changée après la recréation du conteneur");
  if (!recreated.cookie.includes("connexion=gardee")) throw new Error(`cookie perdu après la recréation : ${recreated.cookie}`);
  console.log("OK    même empreinte et même cookie après redémarrage et recréation");

  const b = agent("b");
  create(b);
  const other = await read(b);
  show("B, autre agent", other.fp);
  if (same(other.fp, first.fp)) throw new Error("deux agents ont la même empreinte");
  docker("rm", "-f", b.name);
  console.log("OK    un autre agent a sa propre empreinte");

  // Nouvelle identité, comme POST /agents/{id}/browser/restart?new_identity=true du lanceur.
  docker("exec", a.name, "rm", "-f", "/data/empreinte.json");
  docker("restart", "-t", "20", a.name);
  const fresh = await read(a);
  show("A, nouvelle identité", fresh.fp);
  if (same(fresh.fp, first.fp)) throw new Error("nouvelle identité demandée, empreinte inchangée");
  if (!fresh.cookie.includes("connexion=gardee")) throw new Error("nouvelle identité : cookies perdus");
  docker("restart", "-t", "20", a.name);
  const freshAgain = await read(a);
  if (!same(freshAgain.fp, fresh.fp)) throw new Error("la nouvelle empreinte n'est pas gardée");
  console.log("OK    nouvelle identité : une autre empreinte, gardée à son tour, cookies gardés");
  console.log(docker("logs", a.name).split("\n").filter((l) => /empreinte/.test(l)).map((l) => l.slice(0, 220)).join("\n"));
} catch (e) {
  failed = true;
  console.error(`ECHEC ${e.message}`);
  for (const box of made) {
    try {
      console.error(docker("logs", "--tail", "30", box.name));
    } catch {
      /* rien à montrer */
    }
  }
} finally {
  for (const box of made) {
    spawnSync("docker", ["rm", "-f", box.name]);
    spawnSync("docker", ["volume", "rm", box.volume]);
  }
}
process.exit(failed ? 1 : 0);
