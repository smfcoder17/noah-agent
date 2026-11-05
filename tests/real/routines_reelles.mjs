// Routines, modèle de décision et mémoire sur de vrais conteneurs Hermes : une pile à part, qui ne gêne pas celle de docker-compose.
//   MSYS_NO_PATHCONV=1 node tests/real/routines_reelles.mjs [faux] [vrai] [--garder]
// faux : faux modèle qui facture, aucune clé. On regarde ce qui est arrivé (requêtes reçues par le modèle, fichiers de l'agent, notification
//        déchiffrée par le téléphone), pas ce que l'interface en dit.
// vrai : les clés du .env local, jamais affichées (OLLAMA_API_KEY, sinon ANTHROPIC_API_KEY avec le petit Haiku comme cerveau, plafond de 20 centimes par jour).
//        L'Ollama de cette machine passe avant les clés : rien ne se paie à l'appel. Phrases d'utilisateur en langage naturel, puis mesures de coût.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const WANTED = args.filter((a) => !a.startsWith("--"));
const wants = (name) => !WANTED.length || WANTED.includes(name);
const KEEP = args.includes("--garder");
process.env.MSYS_NO_PATHCONV = "1";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..").replaceAll("\\", "/");
const P = "noah-routines";
const NET = `${P}-net`;
const PORT = 18190;
const FAUX_PORT = 11699;
const BASE = `http://127.0.0.1:${PORT}`;
const FAUX = `http://127.0.0.1:${FAUX_PORT}`;
const SECRET_KEY = "essai-routines-serveur-0123456789abcdef0123456789abcdef";
const LAUNCHER_KEY = "essai-routines-lanceur-0123456789abcdef0123456789abcd";
const PROVIDER_KEY = "CLE-FOURNISSEUR-ESSAI-ROUTINES";
const SERVER_IMAGE = process.env.NOAH_ESSAI_SERVEUR || "ghcr.io/smfcoder17/noah-server:edge";
const LAUNCHER_IMAGE = process.env.NOAH_ESSAI_LANCEUR || "ghcr.io/smfcoder17/noah-launcher:edge";
const PASSWORD = "motdepasse-essai";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...a) => execFileSync("docker", a, { maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }).toString();
const quiet = (...a) => { try { return docker(...a); } catch { return ""; } };
const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, Boolean(ok)]);
  console.log(ok ? "OK   " : "ÉCHEC", name, detail ? `: ${String(detail).slice(0, 700)}` : "");
};
const note = (text) => console.log("     " + text);

function readEnv() {
  for (const file of [`${ROOT}/.env`, `${ROOT}/../../../.env`]) {
    if (!existsSync(file)) continue;
    const out = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  }
  return {};
}

// --- Pile ---------------------------------------------------------------------------------------------------------------
let token = "";
let agent = "";

function clean() {
  // Les machines d'agents de cette pile, y compris celles d'un passage --garder : seulement celles branchées sur son réseau.
  for (const name of quiet("network", "inspect", NET, "-f", "{{range .Containers}}{{.Name}} {{end}}").split(/\s+/)) {
    if (/^noah-(agent|browser)-/.test(name)) {
      quiet("rm", "-f", name);
      quiet("volume", "rm", name);
    }
  }
  quiet("rm", "-f", `${P}-server`, `${P}-launcher`, `${P}-faux`);
  quiet("volume", "rm", `${P}-data`, `${P}-ca`);
  quiet("network", "rm", NET);
}

const api = async (method, path, body, who = token) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(BASE + path, {
        method, headers: { "Content-Type": "application/json", ...(who ? { Authorization: `Bearer ${who}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const session = /noah_session=([^;]+)/.exec(r.headers.get("set-cookie") || "")?.[1];
      if (session && json && !json.token) json.token = session;
      return { status: r.status, json, text };
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(300 * attempt);
    }
  }
};
const faux = async (method, path, body) => (await fetch(FAUX + path, { method, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const BUNDLE = "/tmp/certificats.pem";
const inServer = (code) => docker("exec", "-w", "/app", "-e", "PYTHONPATH=/app", "-e", `SSL_CERT_FILE=${BUNDLE}`, `${P}-server`, "python", "-c", code).trim();
const inAgent = (...command) => docker("exec", "-u", "10000", "-e", "HOME=/opt/data", `noah-agent-${agent}`, ...command);

async function waitFor(what, fn, seconds = 60, step = 2000) {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const v = await fn();
    if (v) {
      note(`${what} : ${Math.round((Date.now() - started) / 1000)} s`);
      return v;
    }
    await sleep(step);
  }
  note(`${what} : rien après ${seconds} s`);
  return null;
}

/** Une phrase à l'agent, jusqu'à la fin du tour. */
const say = async (text, seconds = 240) => {
  const r = await fetch(BASE + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_id: agent, text, attachments: [], details: true }),
  });
  if (!r.ok) return { status: r.status, output: await r.text(), events: [] };
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const stop = Date.now() + seconds * 1000;
  const events = [];
  let buffer = "", messages = "";
  while (Date.now() < stop) {
    const { done, value } = await Promise.race([reader.read(), sleep(stop - Date.now()).then(() => ({ done: true }))]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      if (!frame.startsWith("data:")) continue;
      const e = JSON.parse(frame.slice(5));
      events.push(e);
      if (e.type === "message") messages += e.text;
    }
  }
  reader.cancel().catch(() => {});
  const final = events.find((e) => e.type === "done");
  return { status: r.status, events, final, output: messages || final?.output || "", conversation: events.find((e) => e.conversation_id)?.conversation_id };
};

const messagesOf = (conv) => JSON.parse(inServer(`import json
from noah import db
with db.connect() as c:
    print(json.dumps([dict(r) for r in c.execute("SELECT role, text FROM messages WHERE conversation_id = ? ORDER BY rowid", (${JSON.stringify(conv)},))]))`));
const usage = (since = "") => JSON.parse(inServer(`import json
from noah import db
with db.connect() as c:
    print(json.dumps([dict(r) for r in c.execute("SELECT agent_id, model, prompt_tokens, completion_tokens, cached_tokens, cost, created_at, conversation_id FROM usage WHERE created_at >= ? ORDER BY rowid", (${JSON.stringify(since)},))]))`));
const nowSql = () => inServer(`from noah import db
with db.connect() as c:
    print(c.execute("SELECT CURRENT_TIMESTAMP").fetchone()[0])`);

async function up() {
  clean();
  docker("network", "create", NET);
  docker("run", "-d", "--name", `${P}-faux`, "--network", NET, "-e", `FAUX_NOM=${P}-faux`, "-e", "FAUX_PETIT=1", "-p", process.platform === "linux" ? `${FAUX_PORT}:11500` : `127.0.0.1:${FAUX_PORT}:11500`, // sous Linux, la passerelle de Docker ne joint pas 127.0.0.1
    "-v", `${ROOT}/tests/real:/t:ro`, "-v", `${P}-ca:/ca`, SERVER_IMAGE, "python", "/t/faux_services.py");
  docker("run", "-d", "--name", `${P}-launcher`, "--network", NET, "-e", `LAUNCHER_KEY=${LAUNCHER_KEY}`, "-e", "AGENT_IMAGE=nousresearch/hermes-agent@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d",
    "-e", `AGENT_NETWORK=${NET}`, "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${ROOT}/launcher:/app`, LAUNCHER_IMAGE);
  docker("run", "-d", "--name", `${P}-server`, "--network", NET, "--network-alias", "noah-server", "-p", `127.0.0.1:${PORT}:8080`,
    "--add-host", "host.docker.internal:host-gateway",
    "-e", `NOAH_SECRET_KEY=${SECRET_KEY}`, "-e", `LAUNCHER_KEY=${LAUNCHER_KEY}`, "-e", `LAUNCHER_URL=http://${P}-launcher:9000`,
    "-e", "NOAH_DATA_DIR=/data", "-e", "NOAH_WEB_DIR=/app/web", "-e", "NOAH_LOCALE=fr-FR", "-e", "NOAH_TIMEZONE=Europe/Paris", "-e", `NOAH_PUSH_HOSTS=${P}-faux`,
    "-v", `${P}-data:/data`, "-v", `${P}-ca:/ca:ro`, "-v", `${ROOT}/server/noah:/app/noah`,
    ...(existsSync(`${ROOT}/frontend/dist/index.html`) ? ["-v", `${ROOT}/frontend/dist:/app/web:ro`] : []),
    ...(quiet("volume", "inspect", "apollo-agent-assistant-96c7") ? ["-v", "apollo-agent-assistant-96c7:/memoire-essai:ro"] : []),
    // Le code monté, quelle que soit l'image. Les certificats publics (vrais fournisseurs) et celui du faux téléphone.
    SERVER_IMAGE, "sh", "-c", `until [ -s /ca/ca.pem ]; do sleep 0.2; done; cat "$(python -m certifi)" /ca/ca.pem > ${BUNDLE}; SSL_CERT_FILE=${BUNDLE} exec uvicorn noah.main:app --host 0.0.0.0 --port 8080 --no-server-header --no-access-log`);
  await waitFor("serveur", async () => { try { return (await fetch(BASE + "/api/status")).ok; } catch { return false; } }, 90, 1000);
  const login = await api("POST", "/api/setup/account", { username: "alice", password: PASSWORD, installation: "" }, null);
  token = login.json?.token;
  if (!token) throw new Error(`compte : ${login.status} ${login.text}`);
  const model = await api("POST", "/api/model", { provider: "custom", base_url: `http://${P}-faux:11500/v1`, model: "faux-modele", api_key: PROVIDER_KEY });
  if (model.status !== 200) throw new Error(`modèle : ${model.text}`);
  inServer(`from noah import db
from noah.main import AGENT_SETUP_VERSION
db.set_setting("agent_setup", AGENT_SETUP_VERSION)
db.set_setting("onboarded", "1")`);
  const list = (await api("GET", "/api/agents")).json;
  agent = list[0].id;
  await waitFor("agent en ligne", async () => (await api("GET", "/api/agents")).json.find((a) => a.id === agent)?.online, 240);
  const sub = await faux("GET", "/_abonnement");
  const r = await api("POST", "/api/push/subscription", sub);
  if (r.status !== 200) throw new Error(`abonnement du téléphone : ${r.text}`);
  // La page que relèvent les veilles est sur la machine hôte : le réseau interne de Noah est toujours refusé, un réseau privé accepté non.
  const gateway = inServer(`import socket; print(socket.gethostbyname("host.docker.internal"))`);
  const nets = await api("PUT", "/api/mcp/reseaux", { reseaux: [`${gateway}/32`] });
  if (nets.status !== 200) throw new Error(`réseau : ${nets.text}`);
  return `http://${gateway}:${FAUX_PORT}/veille-page`;
}

const PAGE = (extra = "") => `<html><body><h1>Tarifs de la semaine</h1><p>Abonnement Pro à 49 dollars par mois, sans engagement de durée, facturé chaque année.</p>${extra}</body></html>`;

// --- Faux modèle : tout le chemin, sans clé ---------------------------------------------------------------------------------
async function withFake(pageUrl) {
  // 1. Le modèle de décision se choisit seul après la pose de la clé, et Hermes le suit sans redémarrer.
  const chosen = await waitFor("choix du modèle de décision", async () => {
    const d = (await api("GET", "/api/decision")).json;
    return d?.mesure && d.modele === "faux-petit" ? d : null;
  }, 60);
  check("1. modèle de décision choisi parmi ce que la clé offre", chosen?.modele === "faux-petit" && !chosen.secours, JSON.stringify(chosen?.candidats));
  check("   aucune clé dans sa réponse", !JSON.stringify(chosen).includes(PROVIDER_KEY));
  const helpers = await waitFor("relecture de mémoire d'Hermes branchée sur le petit modèle", () => {
    const cfg = inAgent("cat", "/opt/data/config.yaml");
    return /background_review:\s*\n\s*provider: custom\s*\n\s*model: faux-petit/.test(cfg) ? cfg : null;
  }, 30);
  check("   config d'Hermes : relecture et titres passent par le petit modèle, à travers le relais", helpers && /title_generation:\s*\n\s*provider: custom/.test(helpers) && helpers.includes("noah-server:8080/relay"));

  // 2. Routine sans condition, créée par l'outil de l'agent, à l'heure, résultat dans la conversation et sur le téléphone.
  await faux("POST", "/_vider", {});
  const made = await say(`OUTIL terminal ${JSON.stringify({ command: `python3 /opt/data/noah.py routine "Brief essai" "every 1m" "Réponds seulement : BRIEF-ROUTINE-OK"` })}`);
  check("2. l'agent crée une routine par noah.py", made.output.includes("Brief essai"), made.output.slice(0, 300));
  // L'outil d'Hermes (différé derrière tool_call) marche aussi : un modèle peut le trouver seul.
  const bridge = await say(`OUTIL tool_call ${JSON.stringify({ name: "cronjob_manage", arguments: { action: "create", name: "Par outil", prompt: "Réponds seulement : PAR-OUTIL", schedule: "every 7d", deliver: "local" } })}`);
  check("   l'outil d'Hermes marche aussi, derrière tool_call", bridge.output.includes("Par outil"), bridge.output.slice(0, 300));
  const conv = made.conversation;
  const listed = (await api("GET", `/api/agents/${agent}/routines`)).json?.routines || [];
  check("   la routine se voit dans Détails", listed.some((r) => r.name === "Brief essai"), JSON.stringify(listed).slice(0, 300));
  const ran = await waitFor("premier passage de la routine", async () => {
    const r = (await api("GET", `/api/agents/${agent}/routines`)).json.routines.find((x) => x.name === "Brief essai");
    return r?.last_run_at ? r : null;
  }, 200);
  check("   elle tourne toute seule à l'heure", ran?.last_status === "ok", JSON.stringify(ran).slice(0, 300));
  const arrived = await waitFor("résultat dans la conversation", () => messagesOf(conv).find((m) => m.text.includes("BRIEF-ROUTINE-OK") && m.role === "agent" && m.text.includes("Routine « Brief essai »")), 150);
  check("   son résultat arrive dans la conversation", arrived);
  const pushed = await waitFor("notification", async () => (await faux("GET", "/_journal")).push.find((p) => JSON.stringify(p).includes("Brief essai")), 60);
  check("   et en notification sur le téléphone (déchiffrée)", pushed, JSON.stringify(pushed).slice(0, 300));
  for (const x of (await api("GET", `/api/agents/${agent}/routines`)).json.routines) await api("POST", `/api/agents/${agent}/routines/${x.id}/supprimer`, {});

  // 3. Routine à condition, créée par noah.py comme le ferait l'agent : rien de nouveau, aucun modèle.
  await faux("POST", "/_page", { html: PAGE() });
  const asked = await say(`OUTIL terminal ${JSON.stringify({ command: `python3 /opt/data/noah.py routine-si "Page urgente" "${pageUrl}" "un bloc qui parle d'une urgence" "Réponds seulement : REVEIL-CERVEAU-OK" --minutes 15` })}`);
  check("3. une routine à condition se crée par noah.py", asked.output.includes("Page urgente"), asked.output.slice(0, 400));
  let w = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles[0];
  check("   premier relevé fait, source vérifiée", w?.passages === 1 && !w.erreur, JSON.stringify(w));
  await faux("POST", "/_vider", {});
  for (let i = 0; i < 5; i++) await api("POST", `/api/agents/${agent}/watches/${w.id}/verifier`, {});
  let journal = await faux("GET", "/_journal");
  check("   5 passages sans nouveauté : aucun appel de modèle", journal.appels.length === 0, journal.appels.map((a) => a.modele).join(","));

  // Une nouveauté sans rapport : le petit modèle la lit, le cerveau dort.
  await faux("POST", "/_page", { html: PAGE("<p>Nouveau billet de blog sur la météo de la semaine prochaine dans la région.</p>") });
  await api("POST", `/api/agents/${agent}/watches/${w.id}/verifier`, {});
  journal = await faux("GET", "/_journal");
  check("   nouveauté sans rapport : un tri par le petit modèle, pas de réveil", journal.appels.length === 1 && journal.appels[0].modele === "faux-petit", journal.appels.map((a) => a.modele).join(","));

  // Le planificateur seul, à l'heure : on recule la dernière relève au lieu d'attendre 15 minutes.
  await faux("POST", "/_page", { html: PAGE("<p>URGENT : la facture de mars est en retard, il faut la régler aujourd'hui.</p>") });
  const before = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles[0].passages;
  inServer(`from noah import db
with db.connect() as c:
    c.execute("UPDATE watches SET last_check = last_check - 3600")`);
  const woke = await waitFor("le planificateur repasse et réveille le cerveau", async () => {
    const x = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles[0];
    return x.passages > before && x.reveils === 1 ? x : null;
  }, 100);
  check("   le planificateur passe seul à l'heure et réveille le cerveau une fois", woke?.reveils === 1, JSON.stringify(woke));
  const answered = await waitFor("résultat du réveil dans la conversation", () => messagesOf(conv).find((m) => m.text.includes("REVEIL-CERVEAU-OK") && m.text.includes("Routine « Page urgente »")), 120);
  check("   le résultat du cerveau arrive dans la conversation", answered, JSON.stringify(messagesOf(conv).slice(-2)).slice(0, 400));
  journal = await faux("GET", "/_journal");
  const brainCalls = journal.appels.filter((a) => a.modele === "faux-modele");
  check("   le cerveau a reçu le contexte préparé, marqué comme donnée", brainCalls.some((a) => a.tout.includes("<releve>") && a.tout.includes("URGENT") && a.tout.includes("REVEIL-CERVEAU-OK")), brainCalls.length);
  const told = await waitFor("notification du réveil", async () => (await faux("GET", "/_journal")).push.find((p) => JSON.stringify(p).includes("Page urgente")), 30);
  check("   et en notification", told);
  w = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles[0];
  note(`à l'écran : ${w.passages} passages, ${w.reveils} réveil, ${w.cout} $`);
  await api("POST", `/api/agents/${agent}/watches/${w.id}/verifier`, {});
  const again = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles[0];
  check("   passage suivant : rien de nouveau, pas de second réveil", again.reveils === 1, JSON.stringify(again));
  await api("POST", `/api/agents/${agent}/watches/${w.id}/supprimer`, {});
  const gmail = await say(`OUTIL terminal ${JSON.stringify({ command: `python3 /opt/data/noah.py routine-si "Paul" gmail:from:paul "un courriel de Paul" "prépare une réponse"` })}`);
  check("   Gmail sans compte connecté : erreur lisible, relevé lancé dans la vraie machine", gmail.output.includes("Google n'est pas connecté"), gmail.output.slice(0, 500));
  const leftovers = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles;
  for (const x of leftovers) await api("POST", `/api/agents/${agent}/watches/${x.id}/supprimer`, {});

  // 4. Mémoire : une note d'installation n'entre pas, une préférence entre, un vrai Hermes, le vrai plugin.
  await faux("POST", "/_vider", {});
  const junk = await say(`OUTIL memory ${JSON.stringify({ action: "add", target: "memory", content: "Détail d'installation : le client OAuth est dans noah-agent-513216" })}`);
  check("4. note d'installation refusée avant d'entrer", junk.output.includes("n'a pas gardé"), junk.output.slice(0, 400));
  const good = await say(`OUTIL memory ${JSON.stringify({ action: "add", target: "user", content: "Préfère des réponses courtes" })}`);
  const files = (await api("GET", `/api/agents/${agent}/memory`)).json;
  check("   préférence gardée, note refusée absente", files.user.includes("Préfère des réponses courtes") && !JSON.stringify(files).includes("513216"), `${good.output.slice(0, 200)} ${JSON.stringify(files).slice(0, 300)}`);
  journal = await faux("GET", "/_journal");
  check("   jugées par le petit modèle", journal.appels.filter((a) => a.modele === "faux-petit" && a.systeme.startsWith("Une note de mémoire")).length === 2, journal.appels.map((a) => a.modele).join(","));
  const fork = await waitFor("relecture de mémoire d'Hermes après un tour", async () => (await faux("GET", "/_journal")).appels.find((a) => a.outils.length && a.modele === "faux-petit"), 30);
  check("   la relecture d'Hermes après un tour tourne sur le petit modèle, pas sur le cerveau", fork);
  const asked2 = await say(`OUTIL memory ${JSON.stringify({ action: "add", target: "memory", content: "Demandé : Détail d'installation que je veux garder" })}`);
  check("   une note demandée par l'utilisateur passe sans jugement", (await api("GET", `/api/agents/${agent}/memory`)).json.memory.some((n) => n.includes("que je veux garder")), asked2.output.slice(0, 200));
  const review = await api("POST", `/api/agents/${agent}/memory/relire`, {});
  check("   la relecture répond et ne retire rien toute seule", review.status === 200 && (await api("GET", `/api/agents/${agent}/memory`)).json.memory.length === 1, review.text.slice(0, 300));
  const flows = (await api("GET", "/api/flux")).json?.flux || [];
  check("5. /api/flux déclare le modèle de décision", flows.some((f) => f.quoi === "Modèle de décision" && f.detail === "faux-petit"));
  const logs = docker("logs", `${P}-server`, "--tail", "3000");
  check("   aucune clé dans le journal du serveur", !logs.includes(PROVIDER_KEY));
}

// --- Vrais modèles : phrases en langage naturel, puis mesures -------------------------------------------------------------------
async function withReal(pageUrl) {
  const env = readEnv();
  const OLLAMA = env.OLLAMA_API_KEY || process.env.OLLAMA_API_KEY || "";
  const ANTHROPIC = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  const keys = [OLLAMA, ANTHROPIC].filter(Boolean);
  await api("POST", "/api/budget", { monthly: 1, daily: 0.2 }); // quoi qu'il arrive, l'essai s'arrête là
  // D'abord ce qui ne se paie pas à l'appel : l'Ollama de cette machine (ses modèles :cloud compris), sinon la clé Ollama Cloud, sinon le plus petit Claude.
  const local = (await api("POST", "/api/models", { provider: "ollama" })).json?.models?.map((m) => m.id) || [];
  const provider = local.length ? "ollama" : OLLAMA ? "ollama-cloud" : ANTHROPIC ? "anthropic" : "";
  if (!provider) return note("ni Ollama sur cette machine ni clé dans .env : phase réelle sautée");
  const key = provider === "ollama" ? undefined : OLLAMA || ANTHROPIC;
  const offered = local.length ? local : (await api("POST", "/api/models", { provider, api_key: key })).json?.models?.map((m) => m.id) || [];
  note(`${provider} offre ${offered.length} modèles : ${offered.join(", ").slice(0, 300)}`);
  const brain = process.env.NOAH_ESSAI_CERVEAU || offered.find((m) => /glm-5\.3:cloud|gpt-oss/.test(m)) || offered.find((m) => /haiku/.test(m)) || offered[0];
  let set = await api("POST", "/api/model", { provider, model: brain, api_key: key });
  note(`cerveau d'essai : ${brain}`);
  check(`6. vrai modèle : ${provider} accepté`, set.status === 200, set.status === 200 ? "" : set.text.slice(0, 200));
  await sleep(20000);
  await waitFor("agent en ligne", async () => (await api("GET", "/api/agents")).json.find((a) => a.id === agent)?.online, 120);
  const ollama = await waitFor("mesure sur la vraie clé", async () => {
    const d = (await api("GET", "/api/decision")).json;
    return d?.mesure && !d.en_cours ? d : null;
  }, 400, 5000);
  note(`${provider} : ${ollama?.modele}, ${ollama?.raison}, ${ollama?.ms} ms ; essayés : ${(ollama?.candidats || []).map((c) => `${c.modele} ${c.ok ? "ok" : c.erreur} ${c.ms ?? ""}`).join(" | ")}`);
  check("   modèle de décision mesuré sur la vraie clé", ollama && !ollama.secours, ollama?.raison);

  // Langage naturel : « chaque minute » devient une routine, elle tourne, le résultat arrive.
  const start = nowSql();
  const first = await say("Crée une routine qui tourne chaque minute (every 1m) et qui répond simplement le mot TOPAZE. Rien d'autre.", 240);
  const conv = first.conversation;
  const job = await waitFor("routine créée", async () => {
    const list = (await api("GET", `/api/agents/${agent}/routines`)).json?.routines || [];
    return list.find((r) => /TOPAZE/i.test(r.prompt));
  }, 20);
  check("7. langage naturel : la routine se crée", job, first.output.slice(0, 300));
  if (job) {
    const passed = await waitFor("elle tourne seule", async () => {
      const r = (await api("GET", `/api/agents/${agent}/routines`)).json.routines.find((x) => x.id === job.id);
      return r?.last_run_at ? r : null;
    }, 200);
    check("   elle tourne à l'heure", passed && passed.last_status !== "error", JSON.stringify(passed).slice(0, 300));
    const line = await waitFor("résultat dans la conversation", () => messagesOf(conv).find((m) => m.role === "agent" && m.text.startsWith("**Routine «") && /TOPAZE/i.test(m.text)), 200);
    check("   son résultat arrive dans la conversation", line, JSON.stringify(messagesOf(conv).slice(-3)).slice(0, 500));
    const push = await waitFor("notification", async () => (await faux("GET", "/_journal")).push.find((p) => /Topaze|TOPAZE/i.test(JSON.stringify(p))), 90);
    check("   et en notification", push);
    await api("POST", `/api/agents/${agent}/routines/${job.id}/supprimer`, {});
    const spent = usage(start).filter((u) => u.agent_id === agent);
    // Un passage d'une routine sans condition, pour de vrai : ce qu'il faut comparer au tri d'une nouveauté.
    const cronCalls = spent.filter((u) => u.conversation_id !== conv);
    note(`routine sans condition, un passage : ${cronCalls.length} appels, ${cronCalls.reduce((a, u) => a + u.prompt_tokens, 0)} jetons d'entrée, ${cronCalls.reduce((a, u) => a + u.completion_tokens, 0)} de sortie`);
    console.log(`MESURE passage_cron ${JSON.stringify({ appels: cronCalls.length, entree: cronCalls.reduce((a, u) => a + u.prompt_tokens, 0), sortie: cronCalls.reduce((a, u) => a + u.completion_tokens, 0) })}`);
  }

  // « Préviens-moi si » : une veille, pas une routine.
  await faux("POST", "/_page", { html: PAGE() });
  const watchSay = await say(`Préviens-moi si cette page parle d'une promotion : ${pageUrl}`, 240);
  const watches = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles;
  const veille = watches.find((x) => !x.consigne);
  check("8. « préviens-moi si » : une veille, sans réveil du cerveau", veille && veille.source === "page", `${JSON.stringify(watches).slice(0, 300)} ${watchSay.output.slice(0, 200)}`);
  const condSay = await say(`Si un bloc URGENT apparaît sur cette page, réponds-moi par un résumé d'une phrase de ce qu'il dit : ${pageUrl}`, 240);
  const cond = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles.find((x) => x.consigne);
  check("   « si … alors » : une routine à condition", cond, `${condSay.output.slice(0, 300)}`);
  const routines = (await api("GET", `/api/agents/${agent}/routines`)).json.routines;
  check("   aucune routine qui tourne pour vérifier", !routines.length, JSON.stringify(routines).slice(0, 300));
  if (cond) {
    const marker = nowSql();
    await faux("POST", "/_page", { html: PAGE("<p>URGENT : le prix de l'abonnement Pro passera à 89 dollars dès lundi prochain pour tous.</p>") });
    await api("POST", `/api/agents/${agent}/watches/${cond.id}/verifier`, {});
    const done = await waitFor("réveil du vrai cerveau", () => messagesOf(conv).find((m) => m.role === "agent" && m.text.startsWith(`**Routine « ${cond.nom} »`)), 240);
    check("   la condition remplie réveille le vrai cerveau, résultat dans la conversation", done, done?.text?.slice(0, 300));
    const after = usage(marker);
    const small = after.filter((u) => u.model === ollama?.modele);
    const big = after.filter((u) => u.model !== ollama?.modele);
    console.log(`MESURE reveil ${JSON.stringify({ appels_cerveau: big.length, entree: big.reduce((a, u) => a + u.prompt_tokens, 0), sortie: big.reduce((a, u) => a + u.completion_tokens, 0), caches: big.reduce((a, u) => a + u.cached_tokens, 0), appels_tri: small.length, tri_entree: small.reduce((a, u) => a + u.prompt_tokens, 0), tri_sortie: small.reduce((a, u) => a + u.completion_tokens, 0) })}`);
    const shown = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles.find((x) => x.id === cond.id);
    note(`à l'écran : ${shown.passages} passages, ${shown.reveils} réveil, ${shown.cout} $`);
  }
  for (const x of (await api("GET", `/api/agents/${agent}/watches`)).json.veilles) await api("POST", `/api/agents/${agent}/watches/${x.id}/supprimer`, {});

  await measureDecision(pageUrl, ollama?.modele, provider);
  measureMemory();

  // Anthropic : une vraie clé payante, un cerveau plus gros qui n'est jamais appelé ici.
  if (ANTHROPIC) {
    set = await api("POST", "/api/model", { provider: "anthropic", model: "claude-sonnet-4-5", api_key: ANTHROPIC });
    if (set.status !== 200) {
      note(`clé Anthropic du .env refusée (${set.status}) : Haiku et les vrais prix ne sont pas prouvés sur cette machine`);
    } else {
      check("9. Anthropic : clé acceptée", true);
      await sleep(3000);
      const claude = await waitFor("mesure Anthropic", async () => {
        const d = (await api("GET", "/api/decision")).json;
        return d?.mesure && !d.en_cours ? d : null;
      }, 120);
      note(`Anthropic : ${claude?.modele}, ${claude?.raison}, ${claude?.prix_entree} $/M, ${claude?.ms} ms ; essayés : ${(claude?.candidats || []).map((c) => `${c.modele} ${c.ok ? "ok" : c.erreur} ${c.ms ?? ""}`).join(" | ")}`);
      check("   un petit modèle de la clé, avec son prix", claude && !claude.secours && claude.prix_entree > 0, claude?.raison);
      await sleep(25000); // l'agent redémarre après le changement de fournisseur
      await measureDecision(pageUrl, claude?.modele, "anthropic");
    }
  }
  const logs = docker("logs", `${P}-server`);
  check("10. aucune vraie clé dans le journal du serveur", !keys.some((k) => logs.includes(k)));
  const decisionState = inServer(`from noah import db
print(db.get_setting("decision") or "")`);
  check("    ni dans le réglage", !keys.some((k) => decisionState.includes(k)));
  const total = usage("").reduce((a, u) => a + u.cost, 0);
  console.log(`MESURE depense_totale ${total.toFixed(5)} $`);
}

/** Ce que coûte vraiment un tri : une vraie décision sur une vraie nouveauté, sans réveiller le cerveau. */
async function measureDecision(pageUrl, small, provider) {
  await faux("POST", "/_page", { html: PAGE() });
  const w = (await api("POST", `/api/agents/${agent}/watches`, { nom: "Mesure", url: pageUrl, critere: "une hausse de prix de l'abonnement", minutes: 60 })).json;
  await api("POST", `/api/agents/${agent}/watches/${w.id}/verifier`, {});
  const marker = nowSql();
  await sleep(1200);
  await faux("POST", "/_page", { html: PAGE("<p>Le prix de l'abonnement Pro passera à 89 dollars dès lundi prochain pour tous les clients.</p>") });
  const started = Date.now();
  const out = await api("POST", `/api/agents/${agent}/watches/${w.id}/verifier`, {});
  const ms = Date.now() - started;
  const m = (await api("GET", `/api/agents/${agent}/watches`)).json.veilles.find((x) => x.id === w.id);
  check(`   une vraie décision (${small}) juge juste`, out.json?.alerte === true, JSON.stringify(out.json));
  const rows = usage(marker).filter((u) => u.agent_id === agent && u.model === small);
  console.log(`MESURE tri ${JSON.stringify({ provider, modele: small, ms, entree: rows.reduce((a, u) => a + u.prompt_tokens, 0), sortie: rows.reduce((a, u) => a + u.completion_tokens, 0), cout: m.cout_tri, passages: m.passages })}`);
  await api("POST", `/api/agents/${agent}/watches/${w.id}/supprimer`, {});
}

/** La vraie mémoire d'un agent d'essai : ce que le juge en garderait. Seuls des nombres sortent. */
function measureMemory() {
  if (!quiet("exec", `${P}-server`, "ls", "/memoire-essai/memories/MEMORY.md")) return note("pas de volume d'agent d'essai : mémoire non mesurée");
  const code = `import asyncio, json
from pathlib import Path
from noah import decision
sep = "\\n§\\n"
entries = []
for t, f in (("user", "USER.md"), ("memory", "MEMORY.md")):
    p = Path("/memoire-essai/memories") / f
    if p.exists():
        entries += [(t, e.strip()) for e in p.read_text(encoding="utf-8").split(sep) if e.strip()]
text = "\\n".join(f"[{i}] ({decision.TARGETS[t]}) {e[:800]}" for i, (t, e) in enumerate(entries, 1))
a = asyncio.run(decision.ask("routeur", decision.REVIEW, text, max_tokens=900, timeout=90))
refused = decision._refused(a.data, len(entries))
total = sum(len(e) for _, e in entries)
gone = sum(len(entries[k][1]) for k in refused)
print(json.dumps({"entrees": len(entries), "gardees": len(entries) - len(refused), "avant": total, "apres": total - gone, "jetons_avant": round(total / 2.75), "jetons_apres": round((total - gone) / 2.75), "cout": a.cost, "modele": a.model, "par_cible": {t: sum(1 for k in refused if entries[k][0] == t) for t in ("user", "memory")}}))`;
  console.log(`MESURE memoire ${inServer(code)}`);
}

let failed = false;
try {
  const url = await up();
  if (wants("faux")) await withFake(url);
  if (wants("vrai")) await withReal(url);
} catch (e) {
  failed = true;
  console.log("ÉCHEC", e.stack || e);
  console.log(quiet("logs", "--tail", "40", `${P}-server`));
} finally {
  const bad = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length} vérifications, ${bad.length} échec(s)${bad.length ? ` : ${bad.map(([n]) => n).join(" ; ")}` : ""}`);
  if (KEEP) console.log(`pile gardée : ${BASE}`);
  else clean();
  process.exit(failed || bad.length ? 1 : 0);
}
