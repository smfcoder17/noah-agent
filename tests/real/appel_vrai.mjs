// L'appel avec un vrai agent : on lui demande à la voix de produire une image, on lui parle pendant qu'il travaille, il la présente dans l'appel.
// Vraie synthèse dans un faux micro, vrai composant, vrai modèle, vrai fichier. Il faut la pile locale avec Noah démarré.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/appel_vrai.mjs <dossier des captures>
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = "http://localhost:8080";
const OUT = resolve(process.argv[2] || "captures");
mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";
const py = (code) => execFileSync("docker", ["exec", "-w", "/app", "-e", "PYTHONPATH=/app", "noah-server", "python", "-c", code], { maxBuffer: 1 << 28 }).toString().trim();
const speak = (agent, text) => py(`import asyncio, base64
from noah import media
print(base64.b64encode(asyncio.run(media.speak(${JSON.stringify(agent)}, ${JSON.stringify(text)}))[0]).decode())`);
const token = py(`from noah import auth, db
print(auth.new_session(db.owner_id(), "Appel vrai"))`);
const agent = py(`from noah import db
with db.connect() as c: print(c.execute("SELECT id FROM agents WHERE name = 'Noah'").fetchone()[0])`);
const bad = [];
const check = (name, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", name, detail);
  if (!ok) bad.push(name);
};
const seconds = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
await context.addCookies([{ name: "noah_session", value: token, url: BASE }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const said = [];
page.on("response", async (r) => {
  if (!r.url().includes("/api/voice/transcribe")) return;
  said.push(await r.json().then((j) => j.text, () => "?"));
});
await page.addInitScript(() => {
  const ctx = new AudioContext();
  const mic = ctx.createMediaStreamDestination();
  window.__heard = [];
  navigator.mediaDevices.getUserMedia = async () => mic.stream.clone();
  const Native = window.Audio;
  window.Audio = function (src) {
    const a = new Native(src);
    a.addEventListener("playing", () => window.__heard.push(performance.now()));
    return a;
  };
  window.__say = async (b64) => {
    await ctx.resume();
    const buffer = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.connect(mic);
    const ended = new Promise((r) => (s.onended = r));
    s.start();
    await ended;
  };
});
const shot = (name) => page.screenshot({ path: `${OUT}/vrai-${name}.png` });
const voice = (text) => page.evaluate((b64) => window.__say(b64), speak(agent, text));
const heard = () => page.evaluate(() => window.__heard.length);
const call = page.getByRole("region", { name: "Appel vocal" });
try {
  await page.goto(BASE);
  await page.getByRole("button", { name: /^Noah/ }).first().click({ timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Mode vocal" }).click({ timeout: 30000 });
  await call.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);

  // Une tâche qui prend du temps et produit un fichier.
  const mark = Date.now() % 100000;
  const t0 = Date.now();
  await voice(`Crée-moi une image d'un petit robot bleu qui lit un rapport dans un bureau, et montre-la-moi. Ceci est l'essai ${mark}.`);
  const steps = call.getByRole("region", { name: "Ce que fait l'agent" }).or(call.getByLabel("Ce que fait l'agent"));
  check("le travail de l'agent se voit dans l'appel", await steps.waitFor({ timeout: 90000 }).then(() => true, () => false), `${seconds(t0)} s`);
  await shot("travail");
  const before = await heard();

  // On lui parle pendant qu'il travaille.
  await voice("Pendant que tu y es, c'est quoi la capitale de l'Italie ?");
  const answered = await page.waitForFunction((n) => window.__heard.length > n, before, { timeout: 30000 }).then(() => true, () => false);
  check("il répond pendant qu'il travaille", answered, `${seconds(t0)} s`);

  // L'image produite arrive dans l'appel, et elle est vraie.
  const image = call.getByRole("button", { name: /^Ouvrir / }).first();
  const arrived = await image.waitFor({ timeout: 240000 }).then(() => true, () => false);
  check("l'image produite arrive dans l'appel", arrived, `${seconds(t0)} s`);
  await page.waitForTimeout(2000);
  await shot("image");
  if (arrived) {
    const size = await call.locator("img").first().evaluate((i) => i.naturalWidth).catch(() => 0);
    check("c'est un vrai fichier affiché", size > 100, `${size} px de large`);
    await image.click();
    check("elle s'ouvre d'un clic", await page.getByRole("dialog").waitFor({ timeout: 5000 }).then(() => true, () => false));
    await page.waitForTimeout(1000);
    await shot("ouverte");
    await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(25000);
  check("il a parlé pendant l'appel", (await heard()) >= 2, `${await heard()} prises de parole`);
  console.log("entendu par la transcription :", JSON.stringify(said));
  const texts = await page.evaluate(async (a) => {
    const convs = await (await fetch(`/api/conversations?agent_id=${a}`)).json();
    const id = (convs[0] || convs.conversations?.[0])?.id;
    return id ? (await (await fetch(`/api/conversations/${id}/messages`)).json()).slice(-6).map((m) => `${m.role} : ${String(m.text).replace(/\n/g, " ").slice(0, 220)}`) : [];
  }, agent);
  for (const t of texts) console.log(" ", t);
  await shot("fin");
  await call.getByRole("button", { name: "Raccrocher" }).click();
  check("aucune erreur dans la page", errors.length === 0, errors.join(" | ").slice(0, 300));
} finally {
  await browser.close();
}
if (bad.length) process.exit(1);
console.log("OK");
