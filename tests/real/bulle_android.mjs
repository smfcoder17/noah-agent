// Le mode flottant de bout en bout sur un émulateur : droits depuis l'écran, bulle au-dessus d'une autre app, cycle complet de dictée.
// Pas au-dessus de Paramètres : Android y masque toute superposition d'une app, exprès. La bulle réapparaît en sortant. L'Horloge sert ici d'autre app.
//
//   1. Lance le serveur d'essai (voir tests/real/android_essai_serveur.py), interface construite (frontend/dist), sur 127.0.0.1:18099.
//   2. Construis l'APK : cd mobile/android && ./gradlew.bat assembleGithubDebug
//   3. NOAH_APK=<chemin de app-github-debug.apk> NOAH_CAPTURES=<dossier> node tests/real/bulle_android.mjs
//
// Le son est le vrai micro de l'émulateur, reçu tel quel par le serveur ; seule la transcription est simulée.
import { mkdirSync } from "node:fs";
import { adb, APP, clickText, essai, page, screenshot, SERVER_FROM_PHONE, sleep, tapNative, until } from "./bulle_android_outils.mjs";

const OUT = process.env.NOAH_CAPTURES || "bulle-captures";
const APK = process.env.NOAH_APK || "mobile/android/app/build/outputs/apk/github/debug/app-github-debug.apk";
mkdirSync(OUT, { recursive: true });
const shot = (name) => screenshot(`${OUT}/${name}.png`);
const say = (...a) => console.log(...a);
const check = (ok, text) => {
  if (!ok) throw new Error("ÉCHEC : " + text);
  say("ok :", text);
};
const focused = () => adb("shell", "dumpsys", "window", "displays").match(/mCurrentFocus=.*|mFocusedApp=.*/)?.[0] ?? "";
const bubbleRunning = () => adb("shell", "dumpsys", "activity", "services", APP).includes("NoahBubble");
const logs = () => adb("logcat", "-d", "-s", "NoahBulle:*");

async function openSettings(tab) {
  await until(`!!document.querySelector('[aria-label*="églages"], button')`, "interface");
  if (!(await page(`!!document.querySelector('[role=dialog]')`))) {
    await page(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.textContent).includes('Menu')); b?.click(); return true; })()`);
    await sleep(500);
    await clickText("Réglages", "button");
    await until(`!!document.querySelector('[role=dialog] [role=tab]')`, "fenêtre des réglages");
  }
  await clickText(tab, "[role=tab]");
  await sleep(800);
}

// --- 1. Une app neuve ne demande rien à l'ouverture -------------------------------------------------------------------------
if (process.env.NOAH_APK_GARDER !== "1") {
  try {
    adb("uninstall", APP);
  } catch {
    /* pas encore installée */
  }
  say(adb("install", APK));
}
adb("shell", "cmd", "statusbar", "collapse");
adb("logcat", "-c");
adb("shell", "am", "start", "-n", `${APP}/.MainActivity`);
const { jeton } = await essai("POST", "/_essai/jeton");
for (let i = 0; i < 20; i++) { // une app neuve met du temps à ouvrir sa première page, surtout sur un émulateur
  const on = await page(`location.href + "|" + !!window.Capacitor?.Plugins?.NoahShell`).catch(() => "");
  if (on.startsWith(SERVER_FROM_PHONE)) break;
  if (on.endsWith("true")) await page(`Capacitor.Plugins.NoahShell.connect({server: ${JSON.stringify(SERVER_FROM_PHONE)}, token: ${JSON.stringify(jeton)}}).then(()=>true)`).catch(() => {});
  await sleep(4000);
}
await until(`location.href.startsWith(${JSON.stringify(SERVER_FROM_PHONE)}) && document.body.innerText.includes('Noah')`, "page du serveur", 60000);
await sleep(4000);
check(!/permissioncontroller/i.test(focused()), "aucune fenêtre de droit à l'ouverture de l'app : " + focused().slice(0, 80));
const granted = adb("shell", "dumpsys", "package", APP);
check(!/RECORD_AUDIO: granted=true|ACCESS_FINE_LOCATION: granted=true|POST_NOTIFICATIONS: granted=true/.test(granted), "ni micro, ni position, ni notifications accordés d'office");
shot("01-ouverture-sans-demande");

// --- 2. Réglages > Téléphone, Notifications ---------------------------------------------------------------------------------
await openSettings("Notifications");
shot("02-reglages-notifications");
check((await page(`document.querySelector('[role=dialog]').innerText`)).includes("toujours actives"), "Réglages > Notifications dit que la sécurité reste active");
await openSettings("Téléphone");
shot("03-reglages-telephone");
await sleep(500);

// --- 3. Superposition et micro, demandés depuis cet écran -------------------------------------------------------------------
check(await clickText("Autoriser la superposition", "button"), "bouton de superposition");
await sleep(4000);
shot("04-ecran-systeme-superposition");
check(/Settings|settings/.test(focused()), "l'écran d'Android s'ouvre : " + focused().slice(0, 90));
adb("shell", "appops", "set", APP, "SYSTEM_ALERT_WINDOW", "allow"); // ce que fait l'interrupteur de cet écran
adb("shell", "input", "keyevent", "KEYCODE_BACK");
await sleep(2500);
await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Autoriser le micro'))`, "état relu au retour");
check(await clickText("Autoriser le micro", "button"), "bouton du micro");
await sleep(2500);
shot("05-fenetre-micro");
tapNative("While using the app");
await sleep(1500);
await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Lancer la bulle'))`, "micro accordé");

check(await page(`(() => { const row = [...document.querySelectorAll('p')].find((p) => p.textContent === 'Notifications')?.parentElement?.parentElement; const b = row?.querySelector('button'); b?.click(); return !!b; })()`), "bouton des notifications");
await sleep(2500);
shot("05a-fenetre-notifications");
tapNative("Allow");
await sleep(1500);
await until(`[...document.querySelectorAll('p')].find((p) => p.textContent === 'Notifications')?.parentElement?.innerText.includes('Autorisé')`, "notifications accordées");

// --- 4. La bulle, au-dessus d'une autre app -----------------------------------------------------------------------------------
check(!bubbleRunning(), "la bulle ne tourne pas avant le geste");
check(await clickText("Lancer la bulle", "button"), "lancer");
await sleep(2500);
check(bubbleRunning(), "service au premier plan actif");
const fgs = adb("shell", "dumpsys", "activity", "services", APP);
say("types du service :", fgs.match(/foregroundServiceType=\S+/)?.[0] ?? "?");
const OTHER_APP = "com.google.android.deskclock";
const openOtherApp = () => adb("shell", "monkey", "-p", OTHER_APP, "-c", "android.intent.category.LAUNCHER", "1");
adb("shell", "am", "start", "-a", "android.settings.SETTINGS");
await sleep(3500);
shot("06a-parametres-android-masque-la-bulle");
openOtherApp();
// Machine chargée : le changement d'app peut prendre plusieurs secondes.
for (let i = 0; i < 20 && !focused().includes(OTHER_APP); i++) await sleep(1000);
check(focused().includes(OTHER_APP), "une autre app est au premier plan : " + focused().slice(0, 80));
await sleep(1500);
shot("06-bulle-au-dessus-d-une-autre-app");

const size = adb("shell", "wm", "size").match(/(\d+)x(\d+)/);
const width = Number(size[1]), height = Number(size[2]);
/** Les fenêtres de superposition de l'app : position et taille, telles qu'Android les tient. */
const overlays = () => [...adb("shell", "dumpsys", "window", "windows").matchAll(/Window #\d+ Window\{\w+ u0 agent\.noah\.mobile\}:[\s\S]*?mAttrs=\{\((-?\d+),(-?\d+)\)\((\d+)x(\d+|wrap)\)/g)]
  .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: m[4] }));
const faceAt = () => {
  const face = overlays().find((o) => o.w === 189);
  if (!face) throw new Error("pas de bulle à l'écran");
  return { x: face.x + 94, y: face.y + 63 + 94 }; // 63 : la barre d'état, sous laquelle Android place ces fenêtres
};
const cardAt = () => {
  const card = overlays().find((o) => o.w !== 189 && o.h === "wrap");
  return card ? { x: card.x + card.w / 2, y: card.y + 63 + 40 } : null;
};
let at = faceAt();
say("bulle en", at, "écran", width, height);

// --- 5. Dictée complète depuis l'autre app ---------------------------------------------------------------------------------------
await essai("POST", "/_essai/dictee", { texte: "Résume ma journée, vite" });
const before = (await essai("GET", "/_essai/etat")).dictees.length;
const hold = async (ms, name) => {
  adb("shell", "input", "motionevent", "DOWN", String(at.x), String(at.y));
  await sleep(ms);
  if (name) shot(name);
  adb("shell", "input", "motionevent", "UP", String(at.x), String(at.y));
};
// Le micro de l'émulateur est muet : comme dans une pièce silencieuse, rien ne doit partir (un modèle inventerait un texte).
await hold(2500);
await sleep(1200);
shot("07a-rien-entendu");
check((await essai("GET", "/_essai/etat")).dictees.length === before, "rien entendu : rien n'est parti au serveur");
say(logs().split("\n").filter((l) => /dictée/.test(l)).at(-1));
// Le reste du parcours, avec le seuil de voix levé (APK de débogage) : le son réel, muet ici, suit le vrai chemin.
adb("shell", "am", "start", "-n", `${APP}/.MainActivity`);
await sleep(2500);
await page(`Capacitor.Plugins.NoahShell.bulleEssai({ seuil: 0 }).then(() => true)`);
openOtherApp();
await sleep(2500);
adb("logcat", "-c");
await hold(3500, "07-dictee-en-cours");
const micLine = logs();
say(micLine.split("\n").filter((l) => /micro|dictée/.test(l)).join("\n"));
check(/silencieux=false/.test(micLine), "Android n'a pas coupé le micro de ce service, app derrière");
await sleep(1500);
shot("08-transcription");
await sleep(5000);
shot("09-carte-reponse");
const state = await essai("GET", "/_essai/etat");
say("reçu par le serveur :", state.dictees.at(-1), "| message :", state.started.at(-1));
check(state.dictees.length === before + 1 && state.dictees.at(-1).format === "m4a" && state.dictees.at(-1).debut === "ftyp", "le vrai son est arrivé en m4a");
check(state.started.at(-1) === "Résume ma journée, vite", "le message est parti à l'agent");
check(focused().includes(OTHER_APP), "l'autre app reste au premier plan pendant tout le cycle");
const card = cardAt();
check(!!card, "la réponse courte s'affiche dans une carte");

// Toucher la carte ouvre la conversation.
const openedNoah = async () => {
  for (let i = 0; i < 12; i++) {
    if (focused().includes(APP)) return true;
    await sleep(1000);
  }
  return false;
};
adb("shell", "input", "tap", String(Math.round(card.x)), String(card.y));
check(await openedNoah(), "toucher la carte ouvre Noah : " + focused().slice(0, 80));
await sleep(2500);
await until(`!document.querySelector('[role=dialog]') && document.body.innerText.includes("Résume ma journée, vite")`, "la conversation, sans les réglages par-dessus");
say("ok : sur la conversation");
shot("10-carte-ouvre-la-conversation");

// --- 6. Glisser sur Annuler : rien ne part --------------------------------------------------------------------------------------
openOtherApp();
await sleep(3000);
at = faceAt();
const count = (await essai("GET", "/_essai/etat")).dictees.length;
adb("shell", "input", "motionevent", "DOWN", String(at.x), String(at.y));
await sleep(1500);
adb("shell", "input", "motionevent", "MOVE", String(at.x), String(height - 200));
await sleep(800);
shot("11-glisser-sur-annuler");
adb("shell", "input", "motionevent", "UP", String(at.x), String(height - 200));
await sleep(3000);
check((await essai("GET", "/_essai/etat")).dictees.length === count, "annulé : rien n'est parti");

// --- 7. Déplacer : elle se range au bord. Toucher : elle ouvre Noah. ------------------------------------------------------------
adb("shell", "input", "swipe", String(at.x), String(at.y), "300", "1200", "500");
await sleep(1500);
shot("12-rangee-au-bord");
const moved = faceAt();
say("après déplacement :", moved);
check(moved.x < 200, "rangée sur le bord gauche");
adb("shell", "input", "tap", String(moved.x), String(moved.y));
check(await openedNoah(), "toucher la bulle ouvre Noah");

// --- 8. Arrêter depuis la notification --------------------------------------------------------------------------------------------
adb("shell", "cmd", "statusbar", "expand-notifications");
await sleep(2000);
shot("13-notification-arreter");
tapNative("Arrêter");
await sleep(2500);
adb("shell", "cmd", "statusbar", "collapse");
check(!bubbleRunning(), "« Arrêter » coupe la bulle et son service");
say("\nParcours complet réussi. Captures dans", OUT);
