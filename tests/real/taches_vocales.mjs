// Banc de réussite des tâches vocales (G10.5) : quand on parle à Noah, la tâche est-elle réellement faite ?
// Vraie synthèse vocale dans un faux micro, vrai composant, vrais agents, vrai serveur MCP qui écrit ce qu'il reçoit.
// Ce script joue les appels et écrit ce qu'il a observé ; taches_juges.mjs note. Agents Noah et Rita démarrés.
//   NOAH_PLAYWRIGHT=<chemin> node tests/real/taches_vocales.mjs <travail|garde|tout|reserve|T04,T07> <étiquette> <dossier>
// Lot réservé : scénarios et observations restent dans /data/bench-voix/ ; rien n'en est affiché.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { validate, wordErrorRate } from "./taches_verif.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [which = "travail", label = "essai", outDir = "."] = process.argv.slice(2);
const RESERVE = which === "reserve";
const log = RESERVE ? (i, m) => console.log(`appel ${i} : ${m.split(" ")[0]}`) : (_, m) => console.log(m);
process.env.MSYS_NO_PATHCONV = "1";
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = "http://localhost:8080";
const docker = (...args) => execFileSync("docker", args, { maxBuffer: 1 << 28 }).toString();
const py = (code) => docker("exec", "-w", "/app", "-e", "PYTHONPATH=/app", "apollo-server", "python", "-c", code).trim();
const q = (sql, ...args) => JSON.parse(py(`import json
from apollo import db
with db.connect() as c: print(json.dumps([dict(r) for r in c.execute(${JSON.stringify(sql)}, ${JSON.stringify(args).replace(/^\[/, "(").replace(/\]$/, args.length ? ",)" : ")")})]))`));

let scenarios;
if (RESERVE) {
  scenarios = JSON.parse(docker("exec", "apollo-server", "cat", "/data/bench-voix/taches-reserve.json")).scenarios;
} else {
  const all = JSON.parse(readFileSync(join(HERE, "taches_vocales.json"), "utf8")).scenarios;
  scenarios = which === "tout" ? all : ["travail", "garde"].includes(which) ? all.filter((s) => s.lot === which) : all.filter((s) => which.split(",").includes(s.id));
}
const errors = validate(scenarios);
if (errors.length) throw new Error(RESERVE ? `${errors.length} défauts dans le lot réservé` : errors.join("\n"));

const MCP = "noah-mcp-essai";
const TOOL = "outil-192-168-65-254";
const startTool = () => {
  try { docker("rm", "-f", MCP); } catch {}
  docker("run", "-d", "--name", MCP, "-p", "127.0.0.1:9911:9911", "-v", resolve(HERE, "../tools") + ":/t:ro", "-w", "/t", "apollo-server", "python", "-c",
    "import json, mcp_server, os, time\ns = mcp_server.Server(port=9911, session=False, fiches={'12': 'Fiche 12 : bail de la rue Verte, loyer de 840 euros.', '47': 'Fiche 47 : commande de trois cartons, livraison lundi matin.'}).start()\nwhile True:\n    open('/tmp/c.tmp', 'w').write(json.dumps([{'nom': c[0], 'args': c[1], 'reponse': s.fiches.get(str(c[1].get('id')), 'Fiche introuvable.') if c[0] == 'lire_fiche' else 'fait'} for c in s.calls]))\n    os.replace('/tmp/c.tmp', '/tmp/calls.json')\n    time.sleep(0.3)");
};
const toolCalls = () => {
  try { return JSON.parse(docker("exec", MCP, "cat", "/tmp/calls.json")); } catch { return []; }
};
const token = py(`from apollo import auth, db
print(auth.new_session(db.owner_id(), "Banc des tâches vocales"))`);
const agents = Object.fromEntries(q("SELECT id, name FROM agents").map((a) => [a.name, a.id]));

const speak = (text) => py(`import asyncio, base64
from apollo import bench_voice
print(base64.b64encode(asyncio.run(bench_voice._fixture(${JSON.stringify(agents.Noah)}, ${JSON.stringify(text)}))[0]).decode())`);

/** La synthèse ajoute parfois une suite inventée après la phrase : on ne dit au micro qu'une voix relue une fois, sinon on la refait. */
function prepare(text) {
  const name = createHash("sha1").update(text).digest("hex").slice(0, 16);
  const path = `/data/bench-voix/${name}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const heard = py(`import asyncio, pathlib
from apollo import bench_voice, media
async def run():
    ok = pathlib.Path(${JSON.stringify(path + ".relue")})
    if ok.exists():
        return ok.read_text(encoding="utf-8")
    data, fmt = await bench_voice._fixture(${JSON.stringify(agents.Noah)}, ${JSON.stringify(text)})
    return await media.transcribe(${JSON.stringify(agents.Noah)}, data, fmt)
print(asyncio.run(run()))`);
    if (wordErrorRate(text, heard) <= 0.25) {
      py(`import pathlib; pathlib.Path(${JSON.stringify(path + ".relue")}).write_text(${JSON.stringify(heard)}, encoding="utf-8")`);
      return attempt;
    }
    if (!RESERVE) console.log(`  voix refaite : « ${heard} »`);
    py(`import pathlib; pathlib.Path(${JSON.stringify(path + ".audio")}).unlink(missing_ok=True)`);
  }
  throw new Error("voix impossible à relire");
}

const INIT = () => {
  const ctx = new AudioContext();
  const mic = ctx.createMediaStreamDestination();
  const m = (window.__m = { calls: 0, speaking: 0, last: performance.now(), paroles: [], envoyes: [], transcrits: [], tri: [], trames: [], audios: {}, abandons: [] });
  const touch = () => (m.last = performance.now());
  navigator.mediaDevices.getUserMedia = async () => mic.stream.clone();
  const Native = window.Audio;
  window.Audio = function (src) {
    const a = new Native(src);
    const id = String(src || "").split("/").pop();
    const state = (m.audios[id] = { joue: false, fini: false, erreur: false });
    touch();
    a.addEventListener("playing", () => { state.joue = true; touch(); });
    a.addEventListener("ended", () => { state.fini = true; touch(); });
    a.addEventListener("error", () => { state.erreur = true; touch(); });
    a.addEventListener("timeupdate", touch);
    for (const e of ["pause", "emptied"]) a.addEventListener(e, () => { state.fini = true; touch(); });
    return a;
  };
  const body = (init) => {
    try { return JSON.parse(init?.body); } catch { return {}; }
  };
  const nativeFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = String(input.url || input);
    if (url.endsWith("/api/chat")) {
      m.envoyes.push(body(init).text || "");
      touch();
      return nativeFetch(input, init).then((r) => {
        // Le flux est lu en double pour le diagnostic : quels outils l'agent a lancés, quelle erreur il a vue.
        (async () => {
          const reader = r.clone().body.getReader();
          const dec = new TextDecoder();
          let tail = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            touch();
            tail += dec.decode(value, { stream: true });
            const lines = tail.split("\n");
            tail = lines.pop();
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              try {
                const ev = JSON.parse(line.slice(5));
                if (ev.type === "activity" || ev.label || ev.error || ev.type === "approval") m.trames.push(`${ev.type}: ${ev.label || ev.error || ev.summary || ""}`.slice(0, 300));
                if (ev.type === "done" && ev.status !== "completed") m.trames.push(`fin ${ev.status || ""} ${ev.error || ""}`.slice(0, 300));
              } catch {}
            }
          }
        })().catch(() => {});
        return r;
      });
    }
    if (!url.includes("/api/voice/")) return nativeFetch(input, init);
    m.calls++;
    touch();
    const done = (x) => { m.calls--; touch(); return x; };
    const b = body(init);
    if (url.includes("/api/voice/cancel/")) m.abandons.push(url.split("/").pop());
    if (url.includes("/api/voice/say")) m.paroles.push({ source: "say", audio_id: b.audio_id, texte: b.text });
    const entry = url.includes("/api/voice/reply") ? { source: b.mode === "result" ? "result" : "reply", audio_id: b.audio_id, texte: "", demande: (b.text || "").slice(0, 300) } : null;
    if (entry) m.paroles.push(entry);
    return nativeFetch(input, init).then(async (r) => {
      try {
        if (entry) {
          const j = await r.clone().json();
          entry.statut = r.status;
          entry.texte = j.dire || "";
          entry.action = j.action;
          if (j.annule) entry.annule = true;
        }
        if (url.includes("/api/voice/transcribe")) m.transcrits.push((await r.clone().json()).text);
      } catch {}
      return done(r);
    }, (e) => { if (entry) entry.statut = "réseau"; done(); throw e; });
  };
  window.__say = async (b64) => {
    await ctx.resume();
    const buffer = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.connect(mic);
    m.speaking++;
    touch();
    const ended = new Promise((r) => (s.onended = r));
    s.start();
    await ended;
    m.speaking--;
    touch();
  };
};

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
await context.addCookies([{ name: "apollo_session", value: token, url: BASE }]);
const page = await context.newPage();
await page.addInitScript(INIT);

const api = (method, path, body) =>
  page.evaluate(async ([method, path, body]) => {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null), text: "" };
  }, [method, path, body]);
const button = (name) => page.getByRole("button", { name, exact: true });
const has = async (name) => (await button(name).count()) > 0;
const declineCalls = async () => {
  for (const call of (await api("GET", "/api/calls/pending")).json?.appels || []) await api("POST", `/api/calls/${call.id}/decline`, {});
};
const files = async (id) => Object.fromEntries(((await api("GET", `/api/agents/${id}/files`)).json || []).map((f) => [f.path, f.modified]));
const lastMessage = async (conv) => q("SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE conversation_id = ?", conv)[0].m;
const mainConv = (id) => q("SELECT id FROM conversations WHERE agent_id = ? AND main = 1 LIMIT 1", id)[0]?.id;

/** Une carte d'accord qu'aucune étape n'attendait : la personne ne valide pas ce qu'elle n'a pas demandé. */
async function refuseStray(state) {
  if (!state.expecting && (await has("Autoriser"))) {
    state.vu = true;
    state.refus_auto = (state.refus_auto || 0) + 1;
    await button("Refuser").first().click({ timeout: 5000 }).catch(() => {});
    await sleep(2);
  }
}

/** Tout est retombé : plus de son, plus d'appel de voix, l'écran écoute, et aucun nouveau message depuis `quiet` secondes. */
async function settle(state, conv, quiet = 8, seconds = 240) {
  const t0 = Date.now();
  let stable = 0, seen = -1;
  while (Date.now() - t0 < seconds * 1000) {
    await refuseStray(state);
    const calm = await page.evaluate((d) => {
      const m = window.__m;
      const open = Object.values(m.audios).some((a) => a.joue && !a.fini && !a.erreur);
      return !m.calls && !m.speaking && !open && performance.now() - m.last > d;
    }, 1500).catch(() => false);
    const listening = (await page.getByText("Je t'écoute").count()) > 0;
    if (calm && listening) {
      const last = await lastMessage(conv);
      if (last !== seen) { seen = last; stable = 0; }
      else if (stable >= quiet) return true;
      else stable += 2;
    } else stable = 0;
    await sleep(2);
  }
  return false;
}

async function openCall(agent) {
  await page.goto(BASE);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: new RegExp(`^${agent}`) }).first().click({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Mode vocal" }).click({ timeout: 30000 });
  await page.getByText("Je t'écoute").waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
}

let droitActuel = "lire";
async function play(scn) {
  const agentName = scn.agent || "Noah";
  const agent = agents[agentName];
  const obs = { id: scn.id, debut: new Date().toISOString() };
  const state = { expecting: false, vu: false };
  let conv = mainConv(agent);
  if (!conv) conv = py(`import uuid
from apollo import db
v = uuid.uuid4().hex
with db.connect() as c: c.execute("INSERT INTO conversations (id, user_id, agent_id, title, main, origin) VALUES (?, ?, ?, ?, 1, ?)", (v, db.owner_id(), ${JSON.stringify(agent)}, "Conversation", "user"))
print(v)`);
  const t0 = Number(py("import time; print(time.time())"));
  const beforeFiles = { Noah: await files(agents.Noah), Rita: await files(agents.Rita) };
  const beforeTool = toolCalls().length;
  const beforeMsg = await lastMessage(conv);
  const costBefore = q("SELECT COALESCE(SUM(cost), 0) AS s FROM usage")[0].s;
  const started = Date.now();
  if (scn.droit_outil && scn.droit_outil !== droitActuel) {
    const r = await api("PUT", `/api/agents/${agents.Noah}/connections/tools/${TOOL}/droit`, { droit: scn.droit_outil });
    if (r.status !== 200) obs.erreur_banc = `droit de l'outil : ${r.status}`;
    droitActuel = scn.droit_outil;
    await sleep(75); // Hermes relit la liste de ses outils environ chaque minute : avant, l'agent ne voit pas le nouveau droit
  }
  await declineCalls();
  let m = null;
  try {
    await openCall(agentName);
    for (const [i, step] of scn.plan.entries()) {
      const next = scn.plan[i + 1];
      if (step.dire !== undefined) {
        const before = await page.evaluate(() => window.__m.envoyes.length);
        state.expecting = !!next?.accord || !!step.sans_attente;
        await page.evaluate((b) => window.__say(b), speak(step.dire));
        if (step.sans_attente) continue;
        await page.waitForFunction((n) => window.__m.envoyes.length > n, before, { timeout: 30000 }).catch(() => { obs.tour_perdu = true; });
        if (!next?.accord) {
          await sleep(3);
          if (!(await settle(state, conv))) obs.delai_depasse = true;
        }
      } else if (step.pause) {
        await sleep(step.pause);
      } else if (step.accord) {
        state.expecting = true;
        const t = Date.now();
        await button("Autoriser").first().waitFor({ timeout: 150000 }).catch(() => {});
        const shown = await has("Autoriser");
        state.vu = state.vu || shown;
        obs.accord_delai = shown ? (Date.now() - t) / 1000 : null;
        if (shown && step.accord !== "attendre") {
          await button(step.accord === "autoriser" ? "Autoriser" : "Refuser").first().click({ timeout: 10000 });
          obs.accord_reponse = step.accord === "autoriser" ? "Autoriser" : "Refuser";
          state.expecting = false;
          await sleep(4);
          if (!(await settle(state, conv))) obs.delai_depasse = true;
        }
        if (!shown) state.expecting = false;
      }
    }
    // Une demande en cours chez un autre agent : on attend qu'elle revienne, puis que l'agent en ait parlé.
    const open = () => q("SELECT COUNT(*) AS n FROM delegations WHERE created_at >= ? AND (etat = 'en_cours' OR livre = 0)", t0)[0].n;
    if (q("SELECT COUNT(*) AS n FROM delegations WHERE created_at >= ?", t0)[0].n) {
      const t = Date.now();
      while (open() && Date.now() - t < 300000) await sleep(4);
      if (open()) obs.delai_depasse = true;
      await sleep(4);
      if (!(await settle(state, conv, 12))) obs.delai_depasse = true;
    }
    // Un rappel se prend à l'écran d'appel : il est lu dans le mode vocal.
    if (scn.code?.rappel) {
      const t = Date.now();
      while (Date.now() - t < 120000 && !(await has("Répondre"))) { await refuseStray(state); await sleep(2); }
      if (await has("Répondre")) {
        await button("Répondre").click({ timeout: 10000 });
        await sleep(3);
        if (!(await settle(state, conv))) obs.delai_depasse = true;
      }
    }
    m = await page.evaluate(() => window.__m);
  } catch (e) {
    obs.erreur_banc = String(e.message).split("\n")[0].slice(0, 300);
    m = await page.evaluate(() => window.__m).catch(() => null);
  }
  const dels = q("SELECT d.vers, d.etat, d.consigne, d.rappeler, d.conversation_id, a.name FROM delegations d LEFT JOIN agents a ON a.id = d.vers WHERE d.created_at >= ? ORDER BY d.created_at", t0);
  obs.delegations = dels.map((d) => ({
    vers: d.name, etat: d.etat, consigne: d.consigne.slice(0, 400), rappeler: !!d.rappeler,
    reponse: (q("SELECT text FROM messages WHERE conversation_id = ? AND role = 'agent' ORDER BY id DESC LIMIT 1", d.conversation_id)[0]?.text || "").slice(0, 1500),
  }));
  obs.rappels = q("SELECT texte, etat FROM voice_calls WHERE created_at >= ? ORDER BY created_at", t0).map((c) => ({ texte: c.texte.slice(0, 1500), etat: c.etat }));
  obs.outil = toolCalls().slice(beforeTool);
  obs.fichiers = [];
  for (const [name, snap] of Object.entries(beforeFiles)) {
    const now = await files(agents[name]);
    for (const [path, modified] of Object.entries(now)) {
      if (snap[path] === modified) continue;
      const text = await page.evaluate(async (u) => (await fetch(u)).text(), `/api/agents/${agents[name]}/files/raw/${path.split("/").map(encodeURIComponent).join("/")}`).catch(() => "");
      obs.fichiers.push({ agent: name, chemin: path, contenu: text.slice(0, 2000) });
    }
  }
  const messages = q("SELECT role, text FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id", conv, beforeMsg);
  obs.reponses_agent = messages.filter((x) => x.role !== "user").map((x) => x.text.slice(0, 1500));
  obs.accord_vu = state.vu;
  obs.refus_auto = state.refus_auto || 0;
  if (m) {
    obs.envoyes = m.envoyes;
    obs.transcrits = m.transcrits;
    obs.paroles = m.paroles.map((p) => {
      const a = m.audios[p.audio_id] || {};
      return { source: p.source, texte: p.texte, joue: !!a.joue, fini: !!a.fini, erreur: !!a.erreur, statut: p.statut, action: p.action, abandonne: m.abandons.includes(p.audio_id) || !!p.annule };
    });
    obs.tri = m.paroles.filter((p) => p.source === "reply" && p.action !== undefined && !p.annule && !m.abandons.includes(p.audio_id)).map((p) => !!p.action);
    obs.trames_outil = m.trames;
  }
  await declineCalls();
  obs.duree = Math.round((Date.now() - started) / 1000);
  obs.cout_compteur = q("SELECT COALESCE(SUM(cost), 0) AS s FROM usage")[0].s - costBefore;
  return obs;
}

const out = { etiquette: label, lot: which, date: new Date().toISOString(), version: JSON.parse(readFileSync(join(HERE, "taches_vocales.json"), "utf8")).version, appels: [] };
const free = () => execFileSync("powershell", ["-c", "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"]).toString().trim();
out.memoire_libre_mo = [Math.round(Number(free()) / 1024)];
console.log(`mémoire libre : ${out.memoire_libre_mo[0]} Mo`);
try {
  // Les lignes de rappel des essais précédents : limite de 6 par heure et par agent.
  py(`import time
from apollo import db
with db.connect() as c: c.execute("DELETE FROM voice_calls WHERE created_at > ?", (time.time() - 3700,))`);
  // Une conversation neuve par série : une série ne lit pas les réponses de la précédente.
  if (process.env.TACHES_CONV_NEUVE && mainConv(agents.Noah)) {
    out.ancienne_conversation = mainConv(agents.Noah);
    py(`from apollo import db
with db.connect() as c: c.execute("UPDATE conversations SET main = 0, archived = 1 WHERE id = ?", (${JSON.stringify(out.ancienne_conversation)},))`);
  }
  // Les fichiers écrits par la série précédente : un agent qui retrouve son fichier ne le récrit pas, et le banc ne verrait rien.
  const leftovers = docker("exec", "apollo-server", "sh", "-c", "cat /data/bench-voix/taches-fichiers.txt 2>/dev/null; true").split(/\r?\n/).filter(Boolean);
  for (const line of leftovers) {
    const [name, path] = line.split(/\t/);
    try { docker("exec", `apollo-agent-${agents[name]}`, "rm", "-f", `/opt/data/workspace/${path}`); } catch {}
  }
  docker("exec", "apollo-server", "sh", "-c", "rm -f /data/bench-voix/taches-fichiers.txt");
  if (scenarios.some((s) => s.droit_outil)) startTool();
  await page.goto(BASE);
  await page.waitForTimeout(1000);
  await declineCalls();
  if (scenarios.some((s) => s.droit_outil)) {
    await api("PUT", "/api/mcp/reseaux", { reseaux: ["192.168.65.0/24"] });
    await api("POST", `/api/agents/${agents.Noah}/connections/tools/${TOOL}/remove`, {});
    const added = await api("POST", `/api/agents/${agents.Noah}/connections/tools`, { url: "http://192.168.65.254:9911/mcp", nom: "", auth: "aucune", jeton: "", droit: "lire" });
    if (added.status !== 200) throw new Error("outil non ajouté : " + added.status);
    await sleep(75); // Hermes relit ses outils environ chaque minute
  }
  out.voix_refaites = 0;
  for (const scn of scenarios) for (const step of scn.plan) if (step.dire) out.voix_refaites += Number(prepare(step.dire));
  for (const [i, scn] of scenarios.entries()) {
    log(i + 1, `${scn.id} ${scn.plan.find((p) => p.dire).dire}`);
    const obs = await play(scn);
    out.appels.push({ ...obs, scenario: RESERVE ? undefined : scn.id });
    if (obs.fichiers.length) execFileSync("docker", ["exec", "-i", "apollo-server", "sh", "-c", "cat >> /data/bench-voix/taches-fichiers.txt"], { input: obs.fichiers.map((f) => `${f.agent}\t${f.chemin}\n`).join("") });
    if (!RESERVE) {
      console.log(`  ${obs.duree} s | envoyé : ${(obs.envoyes || []).join(" / ")}`);
      console.log(`  entendu : ${(obs.paroles || []).filter((p) => p.joue).map((p) => `[${p.source}] ${p.texte}`).join(" ").slice(0, 400)}`);
      const extras = [obs.delegations.length && `demandes ${obs.delegations.map((d) => d.etat)}`, obs.rappels.length && `rappels ${obs.rappels.length}`, obs.outil.length && `outil ${obs.outil.map((t) => t.nom)}`, obs.fichiers.length && `fichiers ${obs.fichiers.map((f) => f.chemin)}`, obs.accord_vu && "accord vu", obs.refus_auto && `refus auto ${obs.refus_auto}`, obs.delai_depasse && "DÉLAI", obs.erreur_banc && `BANC ${obs.erreur_banc}`].filter(Boolean);
      if (extras.length) console.log(`  ${extras.join(" | ")}`);
    }
    // Sauvegarde à chaque appel : une série coupée garde ce qu'elle a vu.
    if (!RESERVE) writeFileSync(join(outDir, `obs-${label}.json`), JSON.stringify(out, null, 1));
    out.memoire_libre_mo.push(Math.round(Number(free()) / 1024));
  }
} finally {
  await browser.close().catch(() => {});
  py(`import httpx
from apollo import auth, db
t = ${JSON.stringify(token)}
w = httpx.Client(base_url="http://localhost:8080", headers={"Authorization": "Bearer " + t}, timeout=60)
w.post("/api/agents/${agents.Noah}/connections/tools/${TOOL}/remove", json={})
w.put("/api/mcp/reseaux", json={"reseaux": []})
auth.drop_session(t)`);
  try { docker("rm", "-f", MCP); } catch {}
}
if (RESERVE) {
  execFileSync("docker", ["exec", "-i", "apollo-server", "sh", "-c", `cat > /data/bench-voix/taches-reserve-obs-${label}.json`], { input: JSON.stringify(out) });
  console.log(`${out.appels.length} appels joués, observations gardées sur le serveur`);
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `obs-${label}.json`), JSON.stringify(out, null, 1));
  console.log(`${out.appels.length} appels, observations : ${join(outDir, `obs-${label}.json`)}`);
}
console.log(`mémoire libre, min : ${Math.min(...out.memoire_libre_mo)} Mo`);
process.exit(0);
