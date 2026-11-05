// Ce qui casserait un appel de plusieurs heures, dans un vrai navigateur : long silence, phrase sans pause, réseau coupé, micro perdu.
// Il faut un serveur où tourne un agent dont le modèle répète « Réponds seulement : X » (tests/real/faux_modele.py convient).
// La transcription est remplacée ici pour savoir exactement ce qui part ; le niveau du micro est imposé par le test. Dure environ 3 minutes.
//     NOAH_URL=http://localhost:5173 NOAH_TOKEN=… node tests/real/appel_long.mjs
import { createRequire } from "node:module";

const BASE = process.env.NOAH_URL || "http://localhost:8080";
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT || "playwright");
const bad = [];
const check = (name, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", name, detail);
  if (!ok) bad.push(name);
};
const until = async (fn, seconds) => {
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addCookies([{ name: "apollo_session", value: process.env.NOAH_TOKEN, url: BASE }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(() => {
  // Le niveau du micro vient du test : 0 = silence, 1 = quelqu'un parle.
  window.__voice = 0;
  const read = AnalyserNode.prototype.getByteTimeDomainData;
  AnalyserNode.prototype.getByteTimeDomainData = function (buf) {
    read.call(this, buf);
    buf.fill(128);
    if (window.__voice) for (let i = 0; i < buf.length; i += 2) buf[i] = 170;
  };
  window.__mics = 0;
  window.__tracks = [];
  const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await open(c);
    window.__mics++;
    window.__tracks.push(...s.getAudioTracks());
    return s;
  };
  window.__starts = 0;
  const start = MediaRecorder.prototype.start;
  MediaRecorder.prototype.start = function (...a) {
    window.__starts++;
    return start.apply(this, a);
  };
  window.__locks = 0;
  if (navigator.wakeLock) {
    const lock = navigator.wakeLock.request.bind(navigator.wakeLock);
    navigator.wakeLock.request = (t) => {
      window.__locks++;
      return lock(t);
    };
  }
});

// Chaque morceau reçu : sa taille, et une phrase que le faux modèle répétera, propre à cet essai (la conversation garde les précédents).
const RUN = Date.now() % 100000;
const pieces = [];
let down = false;
let attempts = 0;
await page.route(/\/api\/voice\/transcribe/, async (route) => {
  attempts++;
  if (down) return route.abort("internetdisconnected");
  pieces.push(route.request().postDataBuffer()?.length ?? 0);
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: `Réponds seulement : Morceau ${RUN} ${pieces.length}.` }) });
});
const say = async (ms) => {
  await page.evaluate(() => (window.__voice = 1));
  await page.waitForTimeout(ms);
  await page.evaluate(() => (window.__voice = 0));
};
const call = page.getByRole("region", { name: "Appel vocal" });

await page.goto(BASE);
await page.getByRole("button", { name: /mode vocal|appel/i }).first().click({ timeout: 30000 });
await call.waitFor({ timeout: 10000 });

// Long silence : 16 Ko/s mesurés, donc 20 Mo (la limite du serveur) en 21 minutes si le morceau grandit, et tout ce son envoyé avec la phrase suivante.
const starts = await page.evaluate(() => window.__starts);
await page.waitForTimeout(65_000);
const renewed = (await page.evaluate(() => window.__starts)) - starts;
check("long silence : le morceau est renouvelé, rien ne part", renewed >= 2 && pieces.length === 0, `${renewed} renouvellements, ${pieces.length} envoyés`);
await say(1000);
check("après le silence, la phrase part", await until(() => pieces.length === 1, 15), `${pieces[0]} octets`);
check("sans emporter le silence", pieces[0] < 600_000, `${pieces[0]} octets`);
check("et atteint l'agent", await page.getByText(`Morceau ${RUN} 1.`).nth(1).waitFor({ timeout: 30000 }).then(() => true, () => false));
await page.waitForTimeout(3000);

// Parole sans aucune pause : le morceau part quand même.
const already = pieces.length;
await say(63_000);
check("parole sans pause : le morceau part à une minute", pieces.length > already, `${pieces.length - already} morceau(x)`);
await page.waitForTimeout(6000);

// Réseau coupé pendant qu'on parle : le son attend, on le dit, et il part au retour.
down = true;
const before = pieces.length;
await say(1000);
check("réseau coupé : c'est dit à l'écran", await call.getByText(/Réseau coupé/).waitFor({ timeout: 15000 }).then(() => true, () => false));
down = false;
check("au retour, ce qui a été dit part", await until(() => pieces.length > before, 20), `${attempts} essais`);
check("l'avertissement disparaît", await call.getByText(/Réseau coupé/).waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false));
await page.waitForTimeout(6000);

// Connexion perdue pendant que l'agent répond : le serveur finit le travail, l'appel prend le résultat au retour et le lit.
const read = [];
page.on("request", (r) => {
  if (r.url().includes("/api/voice/say")) read.push(r.postDataJSON()?.text ?? "");
});
await page.route(/\/api\/chat/, async (route) => {
  await route.fetch().catch((e) => console.log("relais du message :", String(e).slice(0, 200)));
  await route.abort("connectionreset");
}, { times: 1 });
let lostAt = pieces.length;
await say(1000);
check("coupure pendant la réponse : le résultat revient", await page.getByText(new RegExp(`Morceau ${RUN} ${lostAt + 1}\.`)).nth(1).waitFor({ timeout: 30000 }).then(() => true, () => false));
check("et il est lu à voix haute", await until(() => read.some((t) => t.includes(`Morceau ${RUN} ${lostAt + 1}`)), 15), JSON.stringify(read.slice(-1)));
await page.waitForTimeout(6000);

// Coupure avant que le message n'arrive au serveur : il repart au retour, et l'ancienne réponse n'est pas relue.
read.length = 0;
await page.route(/\/api\/chat/, (route) => route.abort("connectionreset"), { times: 1 });
lostAt = pieces.length;
await say(1000);
check("message perdu en route : il repart au retour", await page.getByText(new RegExp(`Morceau ${RUN} ${lostAt + 1}\\.`)).nth(1).waitFor({ timeout: 30000 }).then(() => true, () => false));
check("et sa réponse seule est lue", await until(() => read.some((t) => t.includes(`Morceau ${RUN} ${lostAt + 1}`)), 15) && read.length === 1, JSON.stringify(read));
await page.waitForTimeout(6000);

// L'agent ne peut pas répondre : l'appel le dit, au lieu de rester sur « Je t'écoute ».
await page.route(/\/api\/chat/, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Agent hors ligne." }) }), { times: 1 });
await say(1000);
check("agent indisponible : l'appel le dit", await call.getByText(/n'a pas pu répondre/).waitFor({ timeout: 20000 }).then(() => true, () => false));
await page.waitForTimeout(3000);

// Le micro disparaît (une autre application l'a pris) : l'appel en rouvre un, sans erreur.
const mics = await page.evaluate(() => window.__mics);
await page.evaluate(() => {
  const t = window.__tracks[window.__tracks.length - 1];
  t.stop();
  t.dispatchEvent(new Event("ended"));
});
check("micro perdu : l'appel en rouvre un", await until(() => page.evaluate((m) => window.__mics > m, mics), 5));
const pieceCount = pieces.length;
await say(1000);
check("et il entend de nouveau", await until(() => pieces.length > pieceCount, 15));

check("l'écran reste allumé dans un navigateur", (await page.evaluate(() => window.__locks)) >= 1 || !(await page.evaluate(() => "wakeLock" in navigator)));
check("aucune erreur dans la page", errors.length === 0, errors.join(" | ").slice(0, 300));
await call.getByRole("button", { name: "Raccrocher" }).click();
await browser.close();
if (bad.length) process.exit(1);
console.log("OK");
