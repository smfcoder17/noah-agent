// Temps entendu dans le vrai composant Voice.tsx : une voix enregistrée entre par un faux micro, on chronomètre depuis
// la fin de la parole jusqu'à l'événement « playing » de l'élément Audio. L'envoi à l'agent est intercepté : aucun
// travail réel, aucune écriture dans la conversation.
//     node tools/eval/voice_browser.mjs <étiquette> <répétitions> [travail|garde|reserve]
// Il faut Playwright et Chrome sur le poste (variable NOAH_PLAYWRIGHT : dossier du paquet playwright).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const [label = "mesure", reps = "3", lot = "travail"] = process.argv.slice(2);
const BASE = process.env.NOAH_URL || "http://localhost:8080";
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT || "playwright");
const exec = (code) => execFileSync("docker", ["exec", "apollo-server", "python", "-c", code], { maxBuffer: 1 << 28 }).toString();
const corpus = (name) => JSON.parse(execFileSync("docker", ["exec", "apollo-server", "python", "-m", "apollo.bench_voice", "corpus", name], { maxBuffer: 1 << 28 }).toString());

const token = exec(`from apollo import auth, db
with db.connect() as c: u = c.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()["id"]
print(auth.new_session(u, "Banc vocal"))`).trim();
const drop = () => exec(`from apollo import auth; auth.drop_session(${JSON.stringify(token)})`);

const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.round(q * (values.length - 1)))];
const median = (values) => percentile(values, 0.5);

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: "apollo_session", value: token, url: BASE }]);
  const page = await context.newPage();
  await page.route("**/api/chat", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' }));
  await page.addInitScript(() => {
    const ctx = new AudioContext();
    const mic = ctx.createMediaStreamDestination();
    const marks = (window.__marks = { played: [], paused: [], replies: [] });
    navigator.mediaDevices.getUserMedia = async () => mic.stream.clone();
    const Native = window.Audio;
    window.Audio = function (src) {
      const a = new Native(src);
      a.addEventListener("playing", () => marks.played.push(performance.now()));
      return a;
    };
    // Sur la méthode et non sur l'événement : Voice.tsx enchaîne pause() et load(), qui annule l'événement « pause ».
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      if (!this.paused) marks.paused.push(performance.now());
      return pause.call(this);
    };
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input.url || input).includes("/api/voice/reply")) marks.replies.push(performance.now());
      return nativeFetch(input, init);
    };
    /** Dit une voix dans le faux micro. Rend l'heure de la fin de la parole, sans le silence de queue du fichier. */
    window.__say = async (b64) => {
      await ctx.resume();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      const data = buffer.getChannelData(0);
      let last = data.length - 1;
      while (last > 0 && Math.abs(data[last]) < 0.02) last--;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(mic);
      const started = performance.now();
      source.start();
      await new Promise((resolve) => (source.onended = resolve));
      return started + (last / buffer.sampleRate) * 1000;
    };
    /** Démarre une voix sans attendre sa fin. Rend l'heure du premier son, sans le silence de tête du fichier. */
    window.__start = async (b64) => {
      await ctx.resume();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      const data = buffer.getChannelData(0);
      let first = 0;
      while (first < data.length - 1 && Math.abs(data[first]) < 0.02) first++;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(mic);
      const started = performance.now();
      source.start();
      return started + (first / buffer.sampleRate) * 1000;
    };
  });
  await page.goto(BASE);
  await page.getByRole("button", { name: "Mode vocal" }).click({ timeout: 30000 });
  await page.getByText("Je t'écoute").waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);

  const count = (key) => page.evaluate((k) => window.__marks[k].length, key);
  const waitFor = async (key, n, timeout) => {
    await page.waitForFunction(([k, x]) => window.__marks[k].length > x, [key, n], { timeout });
    return page.evaluate(([k, i]) => window.__marks[k][i], [key, n]);
  };
  /** Laisse finir la voix de l'agent, puis un silence qui ferme le tour. */
  const settle = async () => {
    await page.getByText("Je t'écoute").waitFor({ timeout: 45000 });
    await page.waitForTimeout(600);
  };

  const rows = [];
  const cases = corpus(lot);
  for (let run = 0; run < Number(reps); run++) {
    for (const [i, [voice]] of cases.entries()) {
      const played = await count("played");
      const replies = await count("replies");
      const end = await page.evaluate((b) => window.__say(b), voice);
      try {
        const reply = await waitFor("replies", replies, 20000);
        const sound = await waitFor("played", played, 20000);
        rows.push({ case: `c${i}`, run, entendu: Math.round(sound - end), envoi: Math.round(reply - end), voix: Math.round(sound - reply) });
      } catch {
        rows.push({ case: `c${i}`, run, echec: true });
      }
      await settle();
    }
  }

  // Couper la parole : une question à la réponse longue, puis on parle dessus une fois le son parti.
  const interrupts = [];
  const [talk] = corpus("travail")[7];
  for (let i = 0; i < 5; i++) {
    const played = await count("played");
    await page.evaluate((b) => window.__say(b), talk);
    try {
      await waitFor("played", played, 20000);
      await page.waitForTimeout(400);
      const paused = await count("paused");
      const speech = await page.evaluate((b) => window.__start(b), talk);
      const stop = await waitFor("paused", paused, 5000);
      interrupts.push(Math.round(stop - speech));
    } catch {
      interrupts.push(null);
    }
    await page.waitForTimeout(5000);
    await settle();
  }

  // Une pause de 1,5 s en pleine phrase : l'agent ne doit pas répondre à la première moitié.
  let cuts = 0;
  let tries = 0;
  for (const [first, second] of corpus("pauses")) {
    for (let i = 0; i < 3; i++) {
      tries++;
      const replies = await count("replies");
      await page.evaluate((b) => window.__say(b), first);
      await page.waitForTimeout(1500);
      if ((await count("replies")) > replies) cuts++;
      await page.evaluate((b) => window.__say(b), second);
      await page.waitForFunction((x) => window.__marks.replies.length > x, replies, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1000);
      await settle();
    }
  }

  const good = rows.filter((r) => !r.echec);
  const heard = good.map((r) => r.entendu);
  const stops = interrupts.filter((x) => x !== null);
  console.log(JSON.stringify({
    etiquette: label, date: new Date().toISOString(), version: 2, lot, tours: rows.length, echecs: rows.length - good.length,
    entendu_mediane: median(heard), entendu_p95: percentile(heard, 0.95),
    jusqua_envoi_mediane: median(good.map((r) => r.envoi)), voix_mediane: median(good.map((r) => r.voix)),
    interruption_mediane: stops.length ? median(stops) : null, interruptions_ratees: interrupts.length - stops.length,
    coupures: `${cuts} sur ${tries}`,
  }, null, 1));
  if (lot !== "reserve") console.log(JSON.stringify(good.map((r) => ({ case: r.case, run: r.run, score: r.entendu }))));
} finally {
  await browser.close();
  drop();
}
