// Plugin bureau : Openbox, tint2 et PCManFM sur l'écran de Camofox, sous un compte sans droits.
import { spawn } from "node:child_process";
import fs from "node:fs";

const HOME = "/home/bureau";
const APPS = [["openbox", []], ["tint2", []], ["pcmanfm", ["--desktop"]]];
const [W, H] = (process.env.VNC_RESOLUTION || "1920x1080").split("x").map(Number); // l'écran X

// Un gestionnaire de fenêtres réduit toute fenêtre plus grande que l'écran X. Sans bureau, une empreinte 2560x1440 donne
// une fenêtre 2560 coupée à l'écran mais cohérente ; avec Openbox, innerWidth tombe à 1918 pour un outerWidth de 2560,
// ce qui se lit depuis n'importe quelle page. On ramène donc les empreintes trop grandes au profil 1920x1080.
function borneEmpreinte(env, log) {
  const cles = Object.keys(env || {}).filter((k) => k.startsWith("CAMOU_CONFIG_"))
    .sort((a, b) => +a.split("_")[2] - +b.split("_")[2]);
  if (!cles.length) return;
  const c = JSON.parse(cles.map((k) => env[k]).join(""));
  const avant = [c["screen.width"], c["screen.height"], c["window.outerWidth"], c["window.outerHeight"]];
  if (avant.every((v, i) => !v || v <= (i % 2 ? H : W))) return log("info", "bureau: empreinte gardée", { avant });
  const dh = (c["window.outerHeight"] - c["window.innerHeight"]) || 56, dw = (c["window.outerWidth"] - c["window.innerWidth"]) || 0;
  Object.assign(c, { "screen.width": W, "screen.height": H, "screen.availWidth": W, "screen.availHeight": H, "screen.availLeft": 0, "screen.availTop": 0,
    "window.outerWidth": W, "window.outerHeight": H - 40, "window.innerWidth": W - dw, "window.innerHeight": H - 40 - dh, "window.screenX": 0, "window.screenY": 0 });
  if ("document.body.clientWidth" in c) c["document.body.clientWidth"] = W - dw;
  if ("document.body.clientHeight" in c) c["document.body.clientHeight"] = H - 40 - dh;
  for (const k of cles) delete env[k];
  const s = JSON.stringify(c);
  for (let i = 0, n = 1; i < s.length; i += 32767, n++) env[`CAMOU_CONFIG_${n}`] = s.slice(i, i + 32767);
  log("info", "bureau: empreinte ramenée à l'écran", { avant });
}

// Écran permanent : un seul Xvfb pour la vie du conteneur. Le navigateur peut s'endormir, le bureau et ses fenêtres restent.
// On garde le plugin VNC de Camofox (donc /vnc/status et /sessions/:id/storage_state) et on rend juste son écran durable.
function ecranPermanent(VD, quandIlMeurt) {
  const get0 = VD.prototype.get;
  let courant = null;
  VD.prototype.get = function () {
    if (!courant) {
      const inst = this;
      courant = get0.call(this).then((d) => { inst.proc.once("exit", () => { courant = null; quandIlMeurt(); }); return d; })
        .catch((e) => { courant = null; throw e; });
    }
    return courant;
  };
  VD.prototype.kill = function () {};
}

export default function register(app, ctx) {
  if (process.env.BUREAU_OFF === "1") return ctx.log("info", "bureau: coupé (BUREAU_OFF=1)");
  // Le compte du bureau ne doit pas lire les cookies du navigateur : storage-state.json est en 644 dans /data.
  try { fs.chmodSync("/data", 0o700); } catch (e) { ctx.log("warn", `bureau: /data (${e.message})`); }
  let tour = 0, ecran = null; // tour change quand l'écran meurt : les relances de l'ancien s'arrêtent d'elles-mêmes
  ecranPermanent(ctx.VirtualDisplay, () => { tour++; ecran = null; });
  ctx.events.on("browser:launching", ({ options }) => borneEmpreinte(options.env, ctx.log));
  const lance = (cmd, args, env, t) => {
    const p = spawn(cmd, args, { env, cwd: HOME, uid: 1001, gid: 1001, stdio: "ignore", detached: true });
    p.on("error", (e) => ctx.log("warn", `bureau: ${cmd} (${e.message})`));
    p.on("exit", () => { if (t === tour) setTimeout(() => t === tour && lance(cmd, args, env, t), 2000); });
    p.unref();
  };
  ctx.events.on("browser:launched", ({ display }) => {
    if (!display || display === ecran) return;
    ecran = display;
    const t = ++tour;
    // Environnement vidé : ni clé d'API, ni mot de passe VNC, ni clé privée chez les applications du bureau.
    const env = { DISPLAY: display, PATH: "/usr/bin:/bin", HOME, LANG: "C.UTF-8", TZ: process.env.TZ || "UTC", XDG_RUNTIME_DIR: "/tmp/bureau-run" };
    for (const [cmd, args] of APPS) lance(cmd, args, env, t);
    ctx.log("info", "bureau: démarré", { display });
  });
}
