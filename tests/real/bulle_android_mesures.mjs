// Suite de bulle_android.mjs, mêmes prérequis (app déjà reliée au serveur d'essai, droits donnés) : ce que coûte la bulle, le micro une fois
// l'app retirée des récentes, la position, la fin de tâche quand l'app passe derrière, et le redémarrage du téléphone.
//
//   NOAH_MINUTES=3 NOAH_CAPTURES=<dossier> node tests/real/bulle_android_mesures.mjs
import { adb, APP, clickText, essai, page, screenshot, sleep, tapNative, until } from "./bulle_android_outils.mjs";

const OUT = process.env.NOAH_CAPTURES || "bulle-captures";
const MINUTES = Number(process.env.NOAH_MINUTES || 3);
const shot = (name) => screenshot(`${OUT}/${name}.png`);
const say = (...a) => console.log(...a);
const bubbleRunning = () => adb("shell", "dumpsys", "activity", "services", APP).includes("NoahBubble");
const uid = adb("shell", "pm", "list", "packages", "-U", APP).match(/uid:(\d+)/)[1];

function network() {
  adb("shell", "dumpsys", "netstats", "--poll");
  const dump = adb("shell", "dumpsys", "netstats", "detail");
  let rx = 0, tx = 0;
  const lines = dump.split("\n");
  let mine = false, section = false;
  for (const line of lines) {
    if (/^\S.*UID stats/.test(line) || /^UID stats/.test(line.trim())) section = true;
    if (/^UID tag stats/.test(line.trim())) section = false;
    if (/ident=/.test(line)) mine = section && new RegExp(`uid=${uid}\\b`).test(line);
    const m = mine && line.match(/rb=(\d+).*tb=(\d+)/);
    if (m) {
      rx += Number(m[1]);
      tx += Number(m[2]);
    }
  }
  return { rx, tx };
}
function cpu() {
  const pid = adb("shell", "pidof", APP);
  const stat = adb("shell", "run-as", APP, "cat", `/proc/${pid}/stat`).split(") ")[1].split(" ");
  return Number(stat[11]) + Number(stat[12]); // utime + stime, en 1/100 s
}

async function measure(name) {
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(5000);
  const [n0, c0] = [network(), cpu()];
  const t0 = Date.now();
  await sleep(MINUTES * 60000);
  const [n1, c1] = [network(), cpu()];
  const s = (Date.now() - t0) / 1000;
  say(`${name} : ${s.toFixed(0)} s, ${n1.rx - n0.rx} octets reçus, ${n1.tx - n0.tx} octets envoyés, processeur ${((c1 - c0) / 100).toFixed(2)} s (${(((c1 - c0) / 100 / s) * 100).toFixed(2)} %)`);
}

const openApp = async () => {
  adb("shell", "am", "start", "-n", `${APP}/.MainActivity`);
  await sleep(4000);
};
async function settings(tab) {
  await page(`document.querySelector('[role=dialog]') ? true : (() => { [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent).includes('Menu'))?.click(); return true; })()`);
  await sleep(500);
  if (!(await page(`!!document.querySelector('[role=dialog]')`))) await clickText("Réglages", "button");
  await until(`!!document.querySelector('[role=dialog] [role=tab]')`, "réglages");
  await clickText(tab, "[role=tab]");
  await sleep(800);
}
const startBubble = async () => {
  await settings("Téléphone");
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Lancer la bulle') || b.textContent.includes('Arrêter la bulle'))`, "bouton de la bulle");
  await clickText("Lancer la bulle", "button");
  await sleep(2000);
  await page(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
};

// --- 1. Fin de tâche quand l'app passe derrière : le flux reste ouvert, la notification part quand même ----------------------------
await openApp();
await essai("POST", "/_essai/seuil-notification/1");
const sendChat = (text) => page(`(() => {
  const area = document.querySelector('[data-composer-input]');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(text)});
  area.dispatchEvent(new Event('input', { bubbles: true }));
  setTimeout(() => document.querySelector('button[aria-label="Envoyer"]')?.click(), 200);
  return true;
})()`);
const finishRuns = () => essai("POST", "/_essai/finir");
const sent = async () => (await essai("GET", "/_essai/etat")).envoyes;
await finishRuns();
await sleep(1000);
const seen = (await sent()).length;
await sendChat("Long travail avec l'écran ouvert");
await sleep(3000);
await finishRuns();
await sleep(3000);
say("écran ouvert sur la conversation, tâche finie :", (await sent()).slice(seen).map((n) => n.type));
await sendChat("Long travail, je quitte l'app");
await sleep(2500);
adb("shell", "input", "keyevent", "KEYCODE_HOME");
await sleep(4000);
await finishRuns();
await sleep(3000);
const told = (await sent()).slice(seen);
say("app derrière, tâche finie :", JSON.stringify(told));
if (told.filter((n) => n.type === "fin" && !n.urgent).length !== 1) throw new Error("ÉCHEC : l'app est passée derrière et la fin de tâche n'a pas été notifiée une fois");
await essai("POST", "/_essai/seuil-notification/30");
await openApp();
if (process.env.NOAH_FIN_SEULEMENT) process.exit(0);

// --- 2. Position : demandée à l'usage, écrite dans le message, à relire avant d'envoyer --------------------------------------------
adb("emu", "geo", "fix", "2.3522", "48.8566");
await settings("Téléphone");
await page(`(() => { const row = [...document.querySelectorAll('p')].find((p) => p.textContent === 'Position')?.parentElement?.parentElement; row?.querySelector('button')?.click(); return !!row; })()`);
await sleep(3000);
shot("20-fenetre-position");
tapNative("While using the app");
await sleep(2500);
await page(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await until(`!!document.querySelector('button[aria-label="Joindre ma position"]')`, "bouton de position");
await sleep(500);
adb("emu", "geo", "fix", "2.3522", "48.8566");
await page(`document.querySelector('button[aria-label="Joindre ma position"]').click(), true`);
await until(`document.querySelector('[data-composer-input]').value.includes('Ma position')`, "position dans la zone de saisie", 25000);
say("zone de saisie :", await page(`document.querySelector('[data-composer-input]').value`));
shot("21-position-dans-le-message");
await page(`(() => { const area = document.querySelector('[data-composer-input]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ''); area.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
say("droit de position en arrière-plan demandé :", /ACCESS_BACKGROUND_LOCATION/.test(adb("shell", "dumpsys", "package", APP)));

// --- 3. Le coût ----------------------------------------------------------------------------------------------------------------------
await openApp();
if (bubbleRunning()) {
  await settings("Téléphone");
  await clickText("Arrêter la bulle", "button");
  await sleep(1500);
}
await measure("app derrière, bulle arrêtée");
await openApp();
await startBubble();
say("bulle active :", bubbleRunning());
await measure("app derrière, bulle active   ");

// --- 4. App retirée des récentes : la bulle reste, et le micro aussi ? ---------------------------------------------------------------
const tasks = adb("shell", "am", "stack", "list");
const task = tasks.match(/taskId=(\d+): agent\.noah\.mobile/)?.[1];
if (task) adb("shell", "am", "stack", "remove", task);
await sleep(3000);
say("app retirée des récentes, bulle :", bubbleRunning());
const face = [...adb("shell", "dumpsys", "window", "windows").matchAll(/Window #\d+ Window\{\w+ u0 agent\.noah\.mobile\}:[\s\S]*?mAttrs=\{\((-?\d+),(-?\d+)\)\(189x189\)/g)][0];
adb("logcat", "-c");
if (face) {
  const x = String(Number(face[1]) + 94), y = String(Number(face[2]) + 63 + 94);
  adb("shell", "input", "motionevent", "DOWN", x, y);
  await sleep(2500);
  adb("shell", "input", "motionevent", "UP", x, y);
  await sleep(1500);
  say(adb("logcat", "-d", "-s", "NoahBulle:*").split("\n").filter((l) => /micro|dictée/.test(l)).join("\n"));
}

// --- 5. Redémarrage : elle ne revient pas seule ------------------------------------------------------------------------------------
adb("reboot");
await sleep(20000);
adb("wait-for-device");
for (let i = 0; i < 60 && adb("shell", "getprop", "sys.boot_completed") !== "1"; i++) await sleep(3000);
await sleep(20000);
say("après redémarrage, bulle :", bubbleRunning());
shot("22-apres-redemarrage");
