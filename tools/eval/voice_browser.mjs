// Temps entendu dans le vrai composant Voice.tsx : une voix enregistrée entre par un faux micro, on chronomètre depuis
// la fin de la parole jusqu'à l'événement « playing » de l'élément Audio. L'envoi à l'agent est intercepté : aucun
// travail réel, aucune écriture dans la conversation.
//     node tools/eval/voice_browser.mjs <étiquette> <répétitions> [travail|garde|reserve]
// Il faut Playwright et Chrome sur le poste (variable NOAH_PLAYWRIGHT : dossier du paquet playwright).
// NOAH_PARTIES (tours,interruptions,courts,pauses) limite les parties jouées, pour filtrer sans solliciter le fournisseur.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const VERSION = 3;
const [label = "mesure", reps = "3", lot = "travail"] = process.argv.slice(2);
const BASE = process.env.NOAH_URL || "http://localhost:8080";
const parts = new Set((process.env.NOAH_PARTIES || "tours,interruptions,courts,pauses").split(","));
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
    const marks = (window.__marks = { played: [], paused: [], replies: [], chats: [], calls: 0, speaking: 0, last: 0 });
    const live = (window.__live = new Set()); // voix ouvertes : ni finies, ni coupées
    const touch = () => (marks.last = performance.now());
    navigator.mediaDevices.getUserMedia = async () => mic.stream.clone();
    const Native = window.Audio;
    window.Audio = function (src) {
      const a = new Native(src);
      live.add(a);
      touch();
      const gone = () => {
        live.delete(a);
        touch();
      };
      a.addEventListener("playing", () => {
        marks.played.push(performance.now());
        touch();
      });
      for (const e of ["ended", "error", "emptied"]) a.addEventListener(e, gone);
      return a;
    };
    // Sur la méthode et non sur l'événement : Voice.tsx enchaîne pause() et load(), qui annule l'événement « pause ».
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      if (!this.paused) marks.paused.push(performance.now());
      live.delete(this);
      touch();
      return pause.call(this);
    };
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = String(input.url || input);
      if (url.includes("/api/voice/reply")) marks.replies.push(performance.now());
      if (url.endsWith("/api/chat")) marks.chats.push(performance.now());
      if (!url.includes("/api/voice/")) return nativeFetch(input, init);
      marks.calls++;
      touch();
      return nativeFetch(input, init).finally(() => {
        marks.calls--;
        touch();
      });
    };
    const load = async (b64) => {
      await ctx.resume();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return ctx.decodeAudioData(bytes.buffer);
    };
    const source = (buffer) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.connect(mic);
      marks.speaking++;
      touch();
      const ended = new Promise((resolve) => (s.onended = resolve)).then(() => {
        marks.speaking--;
        touch();
      });
      return { s, ended };
    };
    /** Dit une voix dans le faux micro. Rend l'heure de la fin de la parole, sans le silence de queue du fichier. */
    window.__say = async (b64) => {
      const buffer = await load(b64);
      const data = buffer.getChannelData(0);
      let last = data.length - 1;
      while (last > 0 && Math.abs(data[last]) < 0.02) last--;
      const { s, ended } = source(buffer);
      const started = performance.now();
      s.start();
      await ended;
      return started + (last / buffer.sampleRate) * 1000;
    };
    /** Démarre une voix sans attendre sa fin. Rend l'heure du premier son, sans le silence de tête du fichier. */
    window.__start = async (b64) => {
      const buffer = await load(b64);
      const data = buffer.getChannelData(0);
      let first = 0;
      while (first < data.length - 1 && Math.abs(data[first]) < 0.02) first++;
      const { s } = source(buffer);
      const started = performance.now();
      s.start();
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
  /**
   * Attend que tout soit retombé : personne ne parle, aucune transcription ni réponse en cours, aucune voix ouverte,
   * depuis `ms`. Le libellé « Je t'écoute » ne suffit pas : il s'affiche aussi pendant que la voix se prépare, et l'essai
   * suivant partait alors sur la réponse du précédent. `ms` doit dépasser la plus longue attente de fin de tour tant qu'il
   * reste de la parole non traitée.
   */
  const settle = async (ms = 1500) => {
    await page
      .waitForFunction((d) => {
        const m = window.__marks;
        return !m.calls && !m.speaking && !window.__live.size && performance.now() - m.last > d;
      }, ms, { timeout: 60000 })
      .catch(() => console.error("Le calme n'est pas revenu en 60 s"));
  };

  const rows = [];
  const cases = parts.has("tours") ? corpus(lot) : [];
  for (let run = 0; run < Number(reps); run++) {
    for (const [i, [voice]] of cases.entries()) {
      const played = await count("played");
      const replies = await count("replies");
      const chats = await count("chats");
      const end = await page.evaluate((b) => window.__say(b), voice);
      try {
        const reply = await waitFor("replies", replies, 20000);
        const chat = await waitFor("chats", chats, 20000);
        const sound = await waitFor("played", played, 20000);
        rows.push({ case: `c${i}`, run, entendu: Math.round(sound - end), envoi: Math.round(chat - end), voix: Math.round(sound - reply) });
      } catch {
        rows.push({ case: `c${i}`, run, echec: true });
      }
      await settle();
    }
  }

  const [talk] = corpus("travail")[7]; // une question à la réponse longue

  // Couper la parole : on parle dessus une fois le son parti.
  const interrupts = [];
  if (parts.has("interruptions")) {
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
      await settle(3000);
    }
  }

  // Un mot bref par-dessus la voix (« mm-hm », « oui », le « Bonjour » du lot garde) : l'agent doit continuer de parler.
  const shorts = [];
  if (parts.has("courts")) {
    const words = [...corpus("courts").map(([v]) => v), corpus("garde")[0][0]];
    for (const [w, word] of words.entries()) {
      for (let i = 0; i < 2; i++) {
        const played = await count("played");
        await page.evaluate((b) => window.__say(b), talk);
        try {
          await waitFor("played", played, 20000);
          await page.waitForTimeout(400);
          const paused = await count("paused");
          await page.evaluate((b) => window.__say(b), word); // jusqu'à la fin du fichier
          await page.waitForTimeout(800);
          shorts.push({ mot: w, arret: (await count("paused")) > paused });
        } catch {
          shorts.push({ mot: w, echec: true });
        }
        await settle(3000);
      }
    }
  }

  // Une pause de 1,5 s en pleine phrase : l'agent ne doit ni prendre la parole, ni envoyer la première moitié.
  // Une réponse préparée en silence n'est pas une coupure : seuls comptent le son entendu et le tour envoyé.
  let cuts = 0;
  let tries = 0;
  for (const [first, second] of parts.has("pauses") ? corpus("pauses") : []) {
    for (let i = 0; i < 3; i++) {
      tries++;
      const chats = await count("chats");
      const played = await count("played");
      await page.evaluate((b) => window.__say(b), first);
      await page.waitForTimeout(1500);
      const early = (await count("chats")) > chats || (await count("played")) > played;
      await page.evaluate((b) => window.__say(b), second);
      await page.waitForFunction((x) => window.__marks.chats.length > x, chats, { timeout: 20000 }).catch(() => {});
      await settle(3000);
      if (early || (await count("chats")) > chats + 1) cuts++;
    }
  }

  const good = rows.filter((r) => !r.echec);
  const heard = good.map((r) => r.entendu);
  const stops = interrupts.filter((x) => x !== null);
  const replies = await count("replies");
  const chats = await count("chats");
  console.log(JSON.stringify({
    etiquette: label, date: new Date().toISOString(), version: VERSION, lot, tours: rows.length, echecs: rows.length - good.length,
    ...(heard.length && {
      entendu_mediane: median(heard), entendu_p95: percentile(heard, 0.95),
      jusqua_envoi_mediane: median(good.map((r) => r.envoi)), voix_mediane: median(good.map((r) => r.voix)),
    }),
    ...(interrupts.length && { interruption_mediane: stops.length ? median(stops) : null, interruptions_ratees: interrupts.length - stops.length, interruptions: interrupts }),
    ...(shorts.length && { arrets_a_tort: `${shorts.filter((s) => s.arret || s.echec).length} sur ${shorts.length}`, courts: shorts }),
    ...(tries && { coupures: `${cuts} sur ${tries}` }),
    reponses_demandees: replies, tours_envoyes: chats, reponses_jetees: Math.max(0, replies - chats),
  }));
  if (lot !== "reserve") console.log(JSON.stringify(good.map((r) => ({ case: r.case, run: r.run, score: r.entendu }))));
} finally {
  await browser.close();
  drop();
}
