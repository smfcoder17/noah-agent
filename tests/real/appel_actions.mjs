// Ce qu'on demande en appel est vraiment fait : vraie voix dans un faux micro, vrai agent, et la preuve dans la conversation et le fichier.
//   NOAH_URL, NOAH_TOKEN, NOAH_PLAYWRIGHT, NOAH_DOSSIER
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.NOAH_URL;
const TOKEN = process.env.NOAH_TOKEN;
const OUT = process.env.NOAH_DOSSIER || ".";
mkdirSync(OUT, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Origin: BASE };
const api = async (path, init = {}) => fetch(BASE + path, { ...init, headers: { ...headers, ...init.headers } });
const agents = await (await api("/api/agents")).json();
const agent = (process.env.NOAH_AGENT && agents.find((a) => a.id === process.env.NOAH_AGENT)) || agents[0];
const bad = [];
const check = (name, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", name, detail);
  if (!ok) bad.push(name);
};
const speak = async (text) => {
  const r = await api("/api/voice/speak", { method: "POST", body: JSON.stringify({ text, agent_id: agent.id }) });
  if (!r.ok) throw new Error(`synthèse ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer()).toString("base64");
};
const conversation = async () => {
  const list = await (await api(`/api/agents/${agent.id}/conversations`)).json();
  const main = list.find((c) => c.main) || list[0];
  return (await (await api(`/api/conversations/${main.id}/messages`)).json()).map((m) => ({ role: m.role, text: String(m.text) }));
};
const until = async (test, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
await context.addCookies([{ name: "noah_session", value: TOKEN, url: BASE }]);
const page = await context.newPage();
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
page.on("pageerror", (e) => log("ERREUR PAGE", String(e).slice(0, 200)));
page.on("request", (r) => {
  if (r.method() === "POST" && /\/api\/(chat|voice\/reply)/.test(r.url())) log("→", r.url().replace(BASE, ""), (r.postData() || "").slice(0, 160));
});
page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("/api/voice/transcribe")) log("transcrit :", r.status(), await r.text().then((x) => x.slice(0, 160), () => "?"));
  else if (u.includes("/api/voice/reply")) log("voix rapide :", r.status(), await r.text().then((x) => x.slice(0, 220), () => "?"));
  else if (u.includes("/api/chat")) log("chat :", r.status());
});
await page.addInitScript(() => {
  const ctx = new AudioContext();
  const mic = ctx.createMediaStreamDestination();
  navigator.mediaDevices.getUserMedia = async () => mic.stream.clone();
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
const shot = (name) => page.screenshot({ path: `${OUT}/actions-${name}.png` });
const voice = async (text) => page.evaluate((b64) => window.__say(b64), await speak(text));
const call = page.getByRole("region", { name: "Appel vocal" });
const callText = async () => (await call.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 260);

try {
  await page.goto(BASE);
  await page.getByRole("button", { name: "Mode vocal" }).click({ timeout: 60000 });
  await call.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const mark = Date.now() % 100000;

  // 1. Une demande simple.
  const before = (await conversation()).length;
  await voice(`Crée le fichier outputs/appel-${mark}.txt avec le texte ${mark}, puis dis-moi que c'est fait.`);
  const sent = await until(async () => (await conversation()).slice(before).some((m) => m.role === "user"), 40000);
  log("écran :", await callText());
  await shot("1-envoye");
  check("la demande arrive à l'agent", sent);
  const done = await until(async () => (await conversation()).slice(before).some((m) => m.role !== "user"), 180000);
  check("l'agent répond dans la conversation", done);
  const reply = (await conversation()).slice(before);
  for (const m of reply) log(m.role, ":", m.text.slice(0, 240).replace(/\n/g, " "));
  const files = await (await api(`/api/agents/${agent.id}/files?path=outputs`)).text();
  check("le fichier existe vraiment", files.includes(String(mark)), files.slice(0, 120));
  await page.waitForTimeout(12000);
  log("écran :", await callText());
  await shot("2-fait");

  // 2. La demande suivante part aussi : l'appel ne reste pas coincé après le premier tour.
  const mark2 = mark + 1;
  const before2 = (await conversation()).length;
  await voice(`Maintenant crée le fichier outputs/appel-${mark2}.txt avec le texte ${mark2}.`);
  const sent2 = await until(async () => (await conversation()).slice(before2).some((m) => m.role === "user"), 40000);
  log("écran :", await callText());
  await shot("3-deuxieme");
  check("la deuxième demande arrive à l'agent", sent2);
  const done2 = await until(async () => (await conversation()).slice(before2).some((m) => m.role !== "user"), 180000);
  check("l'agent répond à la deuxième demande", done2);
  const files2 = await (await api(`/api/agents/${agent.id}/files?path=outputs`)).text();
  check("le deuxième fichier existe", files2.includes(String(mark2)));

  // 3. Une demande pendant qu'il travaille, puis on raccroche : elle ne doit pas se perdre.
  const mark3 = mark + 2;
  const mark4 = mark + 3;
  const before3 = (await conversation()).length;
  await voice(`Crée le fichier outputs/appel-${mark3}.txt avec le texte ${mark3}, attends vingt secondes avec une commande sleep, puis dis que c'est fait.`);
  await until(async () => (await conversation()).slice(before3).some((m) => m.role === "user"), 40000);
  await page.waitForTimeout(3000);
  await voice(`Ensuite crée aussi le fichier outputs/appel-${mark4}.txt avec le texte ${mark4}.`);
  await page.waitForTimeout(9000);
  log("écran :", await callText());
  await shot("4-pendant");
  await call.getByRole("button", { name: "Raccrocher" }).click();
  log("raccroché");
  const lastOne = await until(async () => (await conversation()).some((m) => m.role === "user" && m.text.includes(String(mark4))), 120000);
  check("ce qui attendait part quand même après avoir raccroché", lastOne);
  const fourth = await until(async () => (await (await api(`/api/agents/${agent.id}/files?path=outputs`)).text()).includes(String(mark4)), 150000);
  check("et c'est fait", fourth);
} finally {
  await browser.close();
}
const tail = (await conversation()).slice(-8);
for (const m of tail) console.log(" ", m.role, ":", m.text.slice(0, 200).replace(/\n/g, " "));
const diag = await (await api("/api/diagnostic")).json().catch(() => null);
if (diag?.erreurs) for (const e of diag.erreurs.slice(0, 6)) console.log("DIAG", e.quand, e.ou, e.texte.slice(-400).replace(/\n/g, " "));
if (bad.length) process.exit(1);
console.log("OK");
