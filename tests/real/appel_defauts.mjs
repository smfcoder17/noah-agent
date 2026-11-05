// L'appel vocal dans un vrai navigateur : micro, transcription et son simulés, vraie interface, vrai serveur, Hermes simulé
// (appel_defauts_serveur.py). Aucune clé.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/appel_defauts.mjs [filtre]
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = process.env.NOAH_URL || "http://127.0.0.1:8097";
const only = process.argv[2] || "";
const bad = [];
const check = (name, ok, detail = "") => {
  console.log(ok ? "  OK   " : "  ÉCHEC", name, detail);
  if (!ok) bad.push(name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await wait(100);
  }
  return false;
};
const server = async (path, body) =>
  (await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

/** Un son muet de `ms` millisecondes : l'élément audio joue vraiment, sans dépendre d'une synthèse. */
function wav(ms) {
  const data = Buffer.alloc(Math.floor((8000 * ms) / 1000), 128);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(8000, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });

/** Une page connectée, sur un agent neuf, avec tout ce qui est voix simulé. */
async function open(agent, { init } = {}) {
  await server(`/_essai/agent/${agent}`, {});
  await server("/_essai/regler", { start_delay: 0, output: "" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"], serviceWorkers: "block", acceptDownloads: true });
  const page = await context.newPage();
  const v = { texts: [], transcribeCalls: 0, answer: null, read: [], replies: [], action: true, audioMs: 300, errors: [], chats: [], aborted: 0, ended: [] };
  page.on("pageerror", (e) => {
    // Le script de Playwright pour serviceWorkers: "block" lit navigator.serviceWorker jusque dans les aperçus en bac à sable.
    if (!String(e).includes("Service worker is disabled because the context is sandboxed")) v.errors.push(`${e} [cadres : ${page.frames().map((f) => f.url()).join(" ")}]`);
  });
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/chat/.test(r.url())) v.chats.push({ url: new URL(r.url()).pathname, body: r.postDataJSON() });
  });
  page.on("requestfailed", (r) => {
    if (new URL(r.url()).pathname === "/api/chat") v.aborted++;
  });
  await page.route(/\/api\/voice\/ready/, (r) => r.fulfill({ json: { dictation: null, call: null } }));
  await page.route(/\/api\/voice\/(prepare|cancel)/, (r) => r.fulfill({ json: { ok: true } }));
  await page.route(/\/api\/voice\/transcribe/, async (r) => {
    const n = ++v.transcribeCalls;
    const custom = v.answer?.(r.request().postDataBuffer()?.length ?? 0);
    if (custom) return r.fulfill(custom);
    r.fulfill({ json: { text: v.texts.shift() ?? `phrase ${n}` } });
  });
  await page.route(/\/api\/voice\/say/, (r) => {
    v.read.push(r.request().postDataJSON().text);
    r.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/voice\/reply/, async (r) => {
    const body = r.request().postDataJSON();
    if (body.mode === "result") v.read.push(body.text);
    else v.replies.push(body.text);
    r.fulfill({ json: { dire: "D'accord.", action: v.action } });
  });
  await page.route(/\/api\/voice\/audio\//, (r) => r.fulfill({ status: 200, contentType: "audio/wav", body: wav(v.audioMs) }));
  await page.addInitScript(() => {
    // Micro simulé : un son dont on règle le niveau, et une piste qu'on peut perdre.
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.connect(gain).connect(dest);
    osc.start();
    const tracks = [];
    navigator.mediaDevices.getUserMedia = async () => {
      await ctx.resume();
      const stream = dest.stream.clone();
      tracks.push(...stream.getTracks());
      return stream;
    };
    window.__level = (a) => (gain.gain.value = a);
    window.__lost = () => {
      for (const t of tracks.splice(0)) {
        t.stop();
        t.dispatchEvent(new Event("ended"));
      }
    };
  });
  if (init) await page.addInitScript(init);
  await page.goto(BASE);
  await page.locator("input:not([type=password])").first().fill("alice");
  await page.locator('input[type="password"]').first().fill("motdepasse-essai");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: new RegExp(agent) }).first().click({ timeout: 20000 });
  await page.getByRole("button", { name: "Mode vocal" }).waitFor({ timeout: 20000 });
  const call = page.getByRole("region", { name: "Appel vocal" });
  const talk = async (ms = 900, level = 0.3) => {
    await page.evaluate((a) => window.__level(a), level);
    await wait(ms);
    await page.evaluate(() => window.__level(0));
  };
  const hangUp = async () => {
    await call.getByRole("button", { name: "Raccrocher" }).click();
    await wait(300);
  };
  const startCall = async () => {
    await page.getByRole("button", { name: "Mode vocal" }).click();
    await call.waitFor({ timeout: 10000 });
    await wait(600);
  };
  return { page, context, call, v, talk, hangUp, startCall };
}

/** Dit une phrase et attend que le tour parte à l'agent. */
async function sayTurn(s, text) {
  const before = s.v.chats.length;
  s.v.texts.push(text);
  await s.talk();
  return until(() => s.v.chats.length > before, 12000);
}

async function scenario(name, fn) {
  if (only && !name.includes(only)) return;
  console.log(name);
  try {
    await fn();
  } catch (e) {
    check(`${name} : se déroule jusqu'au bout`, false, String(e).slice(0, 300));
  }
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC";

await scenario("1. L'instantané de l'appel suit la conversation créée", async () => {
  const s = await open("defaut1");
  await s.startCall();
  check("appel lancé sans conversation", !(await server("/_essai/messages/defaut1")).length);
  check("le tour part", await sayTurn(s, "Travaille longtemps ?"));
  check("le travail a démarré", await until(async () => (await server("/_essai/etat")).started.includes("Travaille longtemps ?")));
  await wait(500);
  await s.page.getByRole("button", { name: "Réduire l'appel" }).click();
  await s.page.getByRole("button", { name: /Ailleurs/ }).first().click();
  await wait(1000);
  check("en naviguant, le flux du tour n'est pas coupé", s.v.aborted === 0, `coupés : ${s.v.aborted}`);
  // Ce qu'il dit ensuite vise la même conversation, et attend que le travail finisse au lieu de lancer un second travail par-dessus.
  await sayTurn(s, "Ajoute une annexe ?");
  await wait(1500);
  const during = (await server("/_essai/etat")).started;
  check("pas de second travail lancé par-dessus le premier", !during.includes("Ajoute une annexe ?"), JSON.stringify(during));
  await server("/_essai/finir", {});
  check("le résultat du premier tour est lu", await until(() => s.v.read.some((t) => t.includes("Fini : Travaille longtemps"))), JSON.stringify(s.v.read));
  const rows = await server("/_essai/messages/defaut1");
  check("une seule fois dans la conversation", rows.filter((m) => m.text === "Travaille longtemps ?").length === 1);
  await s.page.getByRole("button", { name: /defaut1/ }).first().click();
  check("au retour, la conversation est là", await s.page.getByText("Fini : Travaille longtemps").first().waitFor({ timeout: 8000 }).then(() => true, () => false));
  check("aucune erreur de page", !s.v.errors.length, s.v.errors.join(" | ").slice(0, 200));
  await s.context.close();
});

await scenario("2. Première demande d'une conversation vide, Hermes lent à démarrer", async () => {
  const s = await open("defaut2");
  await server("/_essai/regler", { start_delay: 8 }); // la liste des conversations (toutes les 4 s) la voit avant l'événement « start »
  await s.startCall();
  check("le tour part", await sayTurn(s, "Première demande ?"));
  check("la conversation apparaît pendant l'attente", await until(async () => (await server("/_essai/messages/defaut2")).length > 0));
  await wait(6000);
  check("l'envoi en cours n'est pas coupé", s.v.aborted === 0, `coupés : ${s.v.aborted}`);
  check("le résultat est lu à voix haute", await until(() => s.v.read.some((t) => t.includes("Fini : Première demande")), 12000), JSON.stringify(s.v.read));
  check("une seule demande", (await server("/_essai/etat")).started.filter((t) => t === "Première demande ?").length === 1);
  await server("/_essai/regler", { start_delay: 0 });
  await s.context.close();
});

await scenario("3. Un lien d'artefact qui répond 502 pendant l'appel", async () => {
  const s = await open("defaut3");
  await server("/_essai/regler", { output: "Voici /opt/data/workspace/panne.zip et /opt/data/workspace/bon.zip et /opt/data/workspace/panne.pdf" });
  await s.startCall();
  check("le tour part", await sayTurn(s, "Prépare les fichiers ?"));
  const broken = s.call.getByRole("button", { name: "Ouvrir panne.zip" });
  check("la carte arrive", await broken.waitFor({ timeout: 10000 }).then(() => true, () => false));
  const here = s.page.url();
  await broken.click();
  await wait(1500);
  check("la page ne quitte pas l'application", s.page.url() === here, s.page.url());
  check("l'appel continue", await s.call.isVisible().catch(() => false));
  check("l'échec se dit", await s.page.getByRole("dialog").getByText("Fichier indisponible").isVisible().catch(() => false));
  await s.page.keyboard.press("Escape");
  await wait(300);
  // Un fichier disponible se télécharge toujours.
  const download = s.page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await s.call.getByRole("button", { name: "Ouvrir bon.zip" }).click();
  check("un fichier disponible se télécharge", !!(await download));
  await wait(500);
  check("toujours dans l'application après le téléchargement", s.page.url() === here && (await s.call.isVisible().catch(() => false)));
  // Depuis l'aperçu : son bouton Télécharger non plus ne quitte pas la page.
  await s.call.getByRole("button", { name: "Ouvrir panne.pdf" }).click();
  await s.page.getByRole("link", { name: "Télécharger" }).click();
  await wait(1500);
  check("le bouton Télécharger de l'aperçu ne quitte pas l'application", s.page.url() === here, s.page.url());
  await s.page.keyboard.press("Escape");
  await wait(300);
  // Et dans la conversation, le même lien.
  await s.page.getByRole("button", { name: "Réduire l'appel" }).click();
  await s.page.locator("button.text-accent", { hasText: "panne.zip" }).click({ timeout: 5000 });
  await wait(1200);
  check("le lien de la conversation ne quitte pas l'application", s.page.url() === here, s.page.url());
  check("et l'échec se dit aussi", await s.page.getByRole("dialog").getByText("Fichier indisponible").isVisible().catch(() => false));
  check("aucune erreur de page", !s.v.errors.length, s.v.errors.join(" | ").slice(0, 600));
  await s.context.close();
});

await scenario("4a. Retransmission du premier tour après une coupure", async () => {
  const s = await open("defaut4a");
  await s.startCall();
  const cookies = await s.context.cookies();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  // Le serveur reçoit le tour, puis le réseau tombe avant la réponse. Il revient d'abord pour /api/status.
  let down = false;
  let first = true;
  const gone = new AbortController();
  await s.page.route(/\/api\/chat$/, async (r) => {
    if (!first) return r.continue();
    first = false;
    void fetch(BASE + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: BASE }, body: r.request().postData(), signal: gone.signal }).catch(() => {});
    await until(async () => (await server("/_essai/etat")).started.includes("Ne pars qu'une fois longtemps ?"), 5000);
    down = true;
    r.abort("connectionreset");
  });
  await s.page.route(/\/api\/(conversations|agents)\b/, (r) => (down ? r.abort("connectionreset") : r.continue()));
  check("le tour part", await sayTurn(s, "Ne pars qu'une fois longtemps ?"));
  check("il est reparti une deuxième fois vers le serveur", await until(() => s.v.chats.filter((c) => c.url === "/api/chat").length >= 2, 15000), `${s.v.chats.length}`);
  await wait(800);
  down = false;
  const sent = s.v.chats.filter((c) => c.url === "/api/chat");
  check("la retransmission porte le même identifiant", !!sent[0]?.body.client_id && sent[0]?.body.client_id === sent[1]?.body.client_id, JSON.stringify(sent.map((c) => c.body.client_id)));
  await wait(1000);
  const twice = (await server("/_essai/etat")).started.filter((t) => t === "Ne pars qu'une fois longtemps ?").length;
  check("un seul travail côté serveur", twice === 1, `${twice} travaux`);
  await server("/_essai/finir", {});
  check("le résultat est lu", await until(() => s.v.read.some((t) => t.includes("Fini : Ne pars")), 20000), JSON.stringify(s.v.read));
  const rows = await server("/_essai/messages/defaut4a");
  check("une seule fois dans la conversation", rows.filter((m) => m.text === "Ne pars qu'une fois longtemps ?").length === 1, JSON.stringify(rows.map((m) => m.text)));
  gone.abort();
  await s.context.close();
});

await scenario("4b. Pendant le travail : la précision part tout de suite, la demande une seule fois après", async () => {
  const s = await open("defaut4b");
  await s.startCall();
  check("le tour part", await sayTurn(s, "Rédige longtemps ?"));
  await until(async () => (await server("/_essai/etat")).started.includes("Rédige longtemps ?"));
  await wait(800);
  s.v.texts.push("Plutôt en anglais ?");
  await s.talk();
  check("la précision arrive au travail en cours", await until(async () => (await server("/_essai/etat")).steered.includes("Plutôt en anglais ?"), 10000), JSON.stringify((await server("/_essai/etat")).steered));
  s.v.texts.push("Fais un résumé ?");
  await s.talk();
  await wait(4000);
  check("la demande suivante attend la fin", !(await server("/_essai/etat")).started.includes("Fais un résumé ?"));
  await server("/_essai/finir", {});
  check("le résultat du premier tour est lu", await until(() => s.v.read.some((t) => t.includes("Fini : Rédige"))), JSON.stringify(s.v.read));
  check("la demande suivante part ensuite", await until(async () => (await server("/_essai/etat")).started.includes("Fais un résumé ?"), 15000));
  check("son résultat est lu", await until(() => s.v.read.some((t) => t.includes("Fini : Fais un")), 15000), JSON.stringify(s.v.read));
  await wait(1000);
  const { started } = await server("/_essai/etat");
  check("chaque demande part une seule fois", started.filter((t) => t === "Fais un résumé ?").length === 1, JSON.stringify(started));
  check("la précision ne relance pas un travail", !started.includes("Plutôt en anglais ?"), JSON.stringify(started));
  await s.context.close();
});

await scenario("4c. Raccrocher pendant le travail, sans crypto.randomUUID (page hors HTTPS)", async () => {
  const s = await open("defaut4c", { init: () => void delete Crypto.prototype.randomUUID });
  await s.startCall();
  check("le tour part", await sayTurn(s, "Travaille encore longtemps ?"));
  await until(async () => (await server("/_essai/etat")).started.includes("Travaille encore longtemps ?"));
  await wait(800);
  s.v.action = true;
  await s.page.route(/\/api\/chat\/pendant/, (r) => r.abort("connectionreset")); // le tri injoignable : la demande reste ici
  s.v.texts.push("Puis un bilan ?");
  await s.talk();
  await wait(3500);
  await s.hangUp();
  check("la demande part au raccroché", await until(() => s.v.chats.some((c) => c.url === "/api/chat/ensuite")), JSON.stringify(s.v.chats.map((c) => c.url)));
  const left = s.v.chats.find((c) => c.url === "/api/chat/ensuite");
  check("avec un identifiant accepté par le serveur", /^[A-Za-z0-9_-]{8,64}$/.test(left?.body.client_id ?? ""), left?.body.client_id);
  check("aucune erreur de page", !s.v.errors.length, s.v.errors.join(" | ").slice(0, 200));
  await server("/_essai/finir", {});
  check("elle part quand il a fini", await until(async () => (await server("/_essai/etat")).started.includes("Puis un bilan ?"), 15000));
  await s.context.close();
});

await scenario("5. Micro perdu pendant que l'agent parle", async () => {
  const s = await open("defaut5");
  s.v.audioMs = 6000;
  await s.startCall();
  check("le tour part", await sayTurn(s, "Raconte quelque chose ?"));
  check("l'agent parle", await s.call.getByText("defaut5 parle").waitFor({ timeout: 8000 }).then(() => true, () => false));
  await wait(400);
  const before = s.v.transcribeCalls;
  // Sa voix revient dans le micro, assez fort pour compter comme de la voix, pas assez pour une interruption.
  await s.page.evaluate(() => window.__level(0.057));
  await wait(1000);
  await s.page.evaluate(() => {
    window.__lost();
    window.__level(0);
  });
  await wait(1500);
  check("sa voix n'est pas transcrite", s.v.transcribeCalls === before, `${s.v.transcribeCalls - before} morceau(x) envoyé(s)`);
  s.v.audioMs = 300;
  await s.context.close();
});

await scenario("5bis. Micro perdu pendant que la personne parle : ce qu'elle a dit part", async () => {
  const s = await open("defaut5b");
  await s.startCall();
  const before = s.v.transcribeCalls;
  await s.page.evaluate(() => window.__level(0.3));
  await wait(900);
  await s.page.evaluate(() => {
    window.__lost();
    window.__level(0);
  });
  check("son morceau part à la transcription", await until(() => s.v.transcribeCalls > before, 5000));
  await wait(800);
  await s.talk();
  check("le micro est revenu tout seul", await until(() => s.v.transcribeCalls > before + 1, 5000));
  await s.context.close();
});

await scenario("6. Un morceau qui reçoit un 500", async () => {
  const s = await open("defaut6");
  await s.startCall();
  // Ce morceau-là reçoit toujours un 500 (reconnu à sa taille), le suivant passe.
  let failing = 0;
  let size = 0;
  s.v.answer = (bytes) => {
    size ||= bytes;
    if (bytes !== size) return null;
    failing++;
    return { status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Internal Server Error" }) };
  };
  await s.talk();
  await wait(9000);
  const attempts = failing;
  check("les essais sont bornés", attempts === 3, `${attempts} essais en 9 s`);
  await wait(3000);
  check("puis ils s'arrêtent", failing === attempts, `${attempts} puis ${failing}`);
  check("la perte se dit", await s.call.getByText("Un passage n'a pas pu être transcrit").isVisible().catch(() => false));
  s.v.texts.push("La suite passe ?");
  const before = s.v.chats.length;
  await s.talk(1500);
  check("le morceau suivant n'est pas bloqué", await until(() => s.v.chats.length > before, 12000), JSON.stringify(s.v.chats));
  check("avec seulement ce qui a pu être transcrit", s.v.chats.at(-1)?.body.text === "La suite passe ?", s.v.chats.at(-1)?.body.text);
  await s.context.close();
});

await scenario("6bis. Serveur qui redémarre (503) : le son attend son retour", async () => {
  const s = await open("defaut6b");
  await s.startCall();
  let tries = 0;
  s.v.answer = () => {
    if (++tries <= 6) return { status: 503, contentType: "application/json", body: JSON.stringify({ detail: "Redémarrage" }) };
    return { json: { text: "Toujours là ?" } };
  };
  const before = s.v.chats.length;
  await s.talk();
  check("il repasse au-delà de trois essais", await until(() => s.v.chats.length > before, 30000), `${tries} essais`);
  check("et rien n'est perdu", s.v.chats.at(-1)?.body.text === "Toujours là ?", s.v.chats.at(-1)?.body.text);
  await s.context.close();
});

await scenario("6ter. Réseau coupé pour de bon : le son finit par abandonner", async () => {
  // Attente divisée par 50 : seules les attentes entre deux essais tombent sur ces valeurs (multiples de 700 ms, ou 10 s).
  const s = await open("defaut6t", {
    init: () => {
      const real = window.setTimeout;
      window.setTimeout = (fn, ms, ...rest) => real(fn, ms >= 700 && (ms % 700 === 0 || ms === 10000) ? ms / 50 : ms, ...rest);
    },
  });
  await s.startCall();
  let tries = 0;
  await s.page.route(/\/api\/voice\/transcribe/, (r) => {
    if (s.v.freed) return r.fallback();
    tries++;
    return r.abort("connectionreset");
  });
  await s.talk();
  await wait(12000);
  const atEnd = tries;
  await wait(3000);
  check("il finit par s'arrêter", tries === atEnd && tries === 40, `${atEnd} puis ${tries}`);
  s.v.freed = true;
  s.v.texts.push("Et ensuite ?");
  const before = s.v.chats.length;
  await s.talk();
  check("et le morceau suivant passe", await until(() => s.v.chats.length > before, 12000));
  await s.context.close();
});

await scenario("7. Image en data: dans la vue d'appel", async () => {
  const s = await open("defaut7");
  await server("/_essai/regler", {
    output: `Voici ![pixel](data:image/png;base64,${PNG}) et [sans-point](data:image/jpeg;base64,${PNG}) et ![piege-html](data:text/html;base64,PHNjcmlwdD5kb2N1bWVudC50aXRsZT0nUElFR0UnPC9zY3JpcHQ+) et ![piege-svg](data:image/svg+xml;base64,PHN2Zy8+) et [piege-lien](data:text/html,x)`,
  });
  await s.startCall();
  check("le tour part", await sayTurn(s, "Fais une image ?"));
  const card = s.call.getByRole("button", { name: "Ouvrir pixel" });
  check("l'image a sa carte", await card.waitFor({ timeout: 10000 }).then(() => true, () => false));
  check("elle s'affiche vraiment", await until(() => card.locator("img").evaluate((i) => i.naturalWidth > 0).catch(() => false), 3000));
  check("sans image de garde : un lien vers une image aussi", (await s.call.getByRole("button", { name: "Ouvrir sans-point" }).count()) === 1);
  for (const trap of ["piege-html", "piege-svg", "piege-lien"]) check(`pas de carte pour ${trap}`, !(await s.call.getByRole("button", { name: `Ouvrir ${trap}` }).count()));
  await card.click();
  check("elle s'ouvre", await s.page.getByRole("dialog").waitFor({ timeout: 5000 }).then(() => true, () => false));
  check("aucune erreur de page", !s.v.errors.length, s.v.errors.join(" | ").slice(0, 200));
  await s.context.close();
});

await browser.close();
if (bad.length) {
  console.log(`\n${bad.length} ÉCHEC(S)\n - ${bad.join("\n - ")}`);
  process.exit(1);
}
console.log("\nOK");
