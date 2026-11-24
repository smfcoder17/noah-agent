// Le bureau du navigateur démarre avec l'isolement du lanceur : Openbox, tint2 et PCManFM tournent sous le compte 1001, et
// la fenêtre de Firefox remplit l'écran. Sans les bonnes capacités, ces programmes ne démarraient jamais (EPERM au
// changement de compte, EACCES sur /home/bureau en 700) : l'écran montrait Firefox seul, entouré de bandes noires.
//     BROWSER_IMAGE=noah-browser:bureau node tests/navigateur/bureau_reel.mjs
// Il faut l'image du navigateur en local (docker build -t noah-browser:bureau launcher/camofox-bureau) et example.com.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RUN = randomBytes(3).toString("hex");
const KEY = randomBytes(16).toString("hex");
const IMAGE = process.env.BROWSER_IMAGE || "ghcr.io/smfcoder17/noah-browser:stable";
const NAME = `noah-bureau-${RUN}`;
const PORT = 39000 + (parseInt(RUN, 16) % 900);
const W = 1920, H = 1080;
let fails = 0;

const docker = (...args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} : ${r.stderr}`);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "OK " : "ÉCHEC"} ${label}${ok ? "" : ` : ${detail}`}`);
  if (!ok) fails++;
};

// Les capacités du navigateur, lues dans le lanceur : l'essai suit ce que le lanceur donne vraiment.
const source = readFileSync(join(ROOT, "launcher/launcher.py"), "utf8");
const caps = JSON.parse(source.match(/^BROWSER_CAPS: list\[str\] = (\[.*\])$/m)[1].replace(/'/g, '"'));
check("le lanceur garde le navigateur en cap_drop ALL et no-new-privileges",
  /cap_drop=\["ALL"\],\s*\n\s*cap_add=list\(BROWSER_CAPS\)/.test(source) && /security_opt=\["no-new-privileges"\]/.test(source));

async function api(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} : ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const inside = (cmd) => spawnSync("docker", ["exec", NAME, "sh", "-c", cmd], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).stdout || "";

try {
  // Comme le lanceur (launcher.py, _ensure_browser) : isolement, mêmes variables d'écran, plugin Noah posé avant le démarrage.
  docker("create", "--name", NAME, "-p", `127.0.0.1:${PORT}:9377`, "--shm-size", "1g",
    "--cap-drop", "ALL", ...caps.flatMap((c) => ["--cap-add", c]), "--security-opt", "no-new-privileges", "--pids-limit", "2048",
    "-e", "CAMOFOX_PROFILE_DIR=/data/profiles", "-e", "CAMOFOX_COOKIES_DIR=/data/cookies", "-e", `CAMOFOX_API_KEY=${KEY}`,
    "-e", `CAMOFOX_ACCESS_KEY=${KEY}`, "-e", `NOAH_PRIVATE_KEY=${KEY}`, "-e", "CAMOFOX_DISABLE_DEFAULT_ADDONS=1",
    "-e", "ENABLE_VNC=1", "-e", `VNC_RESOLUTION=${W}x${H}`, "-e", `VNC_PASSWORD=${KEY.slice(0, 8)}`, IMAGE);
  docker("cp", join(ROOT, "launcher/camofox-noah"), `${NAME}:/app/plugins/noah`);
  docker("cp", join(ROOT, "launcher/camofox-noah/camofox.config.json"), `${NAME}:/app/camofox.config.json`);
  docker("start", NAME);
  for (let i = 0; ; i++) {
    try { await api("GET", "/health"); break; } catch (e) {
      if (i > 90) throw new Error(`le navigateur ne démarre pas : ${e.message}`);
      await sleep(1000);
    }
  }
  await api("POST", "/tabs", { userId: "noah", sessionKey: "noah", url: "https://example.com/" });

  // Les relances du plugin bureau ont 2 s d'écart : 20 s suffisent pour qu'un programme qui échoue soit absent.
  let procs = "";
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    procs = inside("ps -eo uid=,comm=");
    if (["openbox", "tint2", "pcmanfm"].every((p) => new RegExp(`^\\s*1001\\s+${p}\\b`, "m").test(procs))) break;
  }
  for (const p of ["openbox", "tint2", "pcmanfm"])
    check(`${p} tourne sous le compte 1001`, new RegExp(`^\\s*1001\\s+${p}\\b`, "m").test(procs), procs.replace(/\s+/g, " ").slice(0, 300));
  check("aucun programme du bureau en root", !/^\s*0\s+(openbox|tint2|pcmanfm|mousepad)\b/m.test(procs), procs.replace(/\s+/g, " ").slice(0, 300));
  const warn = docker("logs", NAME).split("\n").filter((l) => /bureau: (openbox|tint2|pcmanfm)/.test(l));
  check("aucune erreur de lancement du bureau dans le journal", !warn.length, warn.slice(0, 3).join(" | "));

  // Openbox gère l'écran, et la fenêtre de Firefox le remplit en largeur (pas de bande noire sur les côtés).
  const display = (inside("for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep '^DISPLAY='; done | sort -u | head -1").trim().split("=")[1]) || ":99";
  const wm = inside(`DISPLAY=${display} xprop -root _NET_SUPPORTING_WM_CHECK`);
  check("un gestionnaire de fenêtres tient l'écran", /window id/.test(wm), wm.trim());
  const tree = inside(`DISPLAY=${display} xwininfo -root -tree`);
  const fenetres = [...tree.matchAll(/"([^"]*)": \("([^"]*)" "([^"]*)"\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/g)]
    .filter((m) => /firefox|camoufox/i.test(m[2] + m[3]) && +m[4] > 400);
  const f = fenetres.sort((x, y) => +y[4] * +y[5] - +x[4] * +x[5])[0];
  const [large, haut] = f ? [+f[4], +f[5]] : [0, 0];
  const vue = f ? f[0].trim() : tree.slice(0, 300);
  check(`la fenêtre de Firefox remplit la largeur de l'écran (${W} px)`, large >= W - 4, `${large} px ; ${vue}`);
  check(`et sa hauteur, au-dessus de la barre du bureau (${H - 40} px)`, haut >= H - 70 && haut <= H, `${haut} px ; ${vue}`);
} catch (e) {
  check("l'essai va jusqu'au bout", false, e.message);
} finally {
  spawnSync("docker", ["rm", "-f", NAME], { encoding: "utf8" });
}
console.log(fails ? `${fails} échec(s)` : "bureau du navigateur : tout est bon");
process.exit(fails ? 1 : 0);
