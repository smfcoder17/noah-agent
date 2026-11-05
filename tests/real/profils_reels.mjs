// Parcours G8.1, G12.3 et G12.5 sur de vrais conteneurs Hermes et Camofox : base neuve, faux modèle qui facture (faux_services.py),
// aucune clé, aucune donnée de l'utilisateur. Chaque vérification regarde ce qui est arrivé (requête reçue par le modèle, message
// déchiffré par le téléphone, sortie de la commande dans la machine), jamais ce que l'interface en dit.
//   MSYS_NO_PATHCONV=1 node tests/real/profils_reels.mjs [--local] [--neuf] [--garder] [g123] [g81] [g125]
// --local : monte server/noah et launcher/ (sinon le code figé des images). --garder : laisse la pile en place, pour rejouer vite.
// --neuf : efface d'abord ce qu'un passage --garder a laissé.
// Les conteneurs d'essai sont effacés à la fin ; le volume de l'installation de l'utilisateur n'est jamais monté.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const LOCAL = args.includes("--local");
const KEEP = args.includes("--garder");
const WANTED = args.filter((a) => !a.startsWith("--"));
const wants = (name) => !WANTED.length || WANTED.includes(name);
process.env.MSYS_NO_PATHCONV = "1";

const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const FAUX = "http://127.0.0.1:11599";
const SECRET_KEY = "essai-secret-serveur-0123456789abcdef0123456789abcdef";
const LAUNCHER_KEY = "essai-lanceur-0123456789abcdef0123456789abcdef";
const PROVIDER_KEY = "CLE-FOURNISSEUR-ESSAI-7f3a";
const PASSWORD = "motdepasse-essai";
const STACK_ENV = {
  ...process.env, NOAH_SECRET_KEY: SECRET_KEY, LAUNCHER_KEY, NOAH_PORT: String(PORT), NOAH_BIND: "127.0.0.1",
  ...(LOCAL ? { NOAH_ESSAI_CODE_SERVEUR: "./server/noah", NOAH_ESSAI_CIBLE_SERVEUR: "/app/noah", NOAH_ESSAI_CODE_LANCEUR: "./launcher", NOAH_ESSAI_CIBLE_LANCEUR: "/app" } : {}),
};
const COMPOSE = ["compose", "-p", "noah", "-f", "docker-compose.yml", "-f", "tests/real/compose.essai.yml"];

const docker = (...a) => execFileSync("docker", a, { maxBuffer: 1 << 26, env: STACK_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, Boolean(ok)]);
  console.log(ok ? "OK   " : "ÉCHEC", name, detail ? `: ${String(detail).slice(0, 500)}` : "");
};
const note = (text) => console.log("     " + text);

// --- API de Noah ---------------------------------------------------------------------------------------------------------
// Connexion gardée ouverte puis fermée par uvicorn après 5 s de silence : la requête n'est jamais arrivée, on la renvoie.
const post = async (url, options) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      if (attempt >= 5 || !/other side closed|ECONNRESET|socket hang up/.test(`${e.cause?.message} ${e.cause?.code}`)) {
        throw new Error(`${options.method} ${url} : ${e.cause?.message || e.message}`);
      }
      await sleep(200 * attempt);
    }
  }
};
const api = async (token, method, path, body) => {
  const r = await post(BASE + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  // Connexion navigateur : le jeton n'est que dans le cookie (tests/exposition/public_test.py).
  const session = /noah_session=([^;]+)/.exec(r.headers.get("set-cookie") || "")?.[1];
  if (session && json && !json.token) json.token = session;
  return { status: r.status, json, text };
};

/** Une phrase à l'agent, jusqu'à la fin du tour. Rend les événements, le texte final, l'erreur et le temps passé. */
const say = async (token, agent, text, { seconds = 180, conversation, approve = true } = {}) => {
  const started = Date.now();
  const r = await post(BASE + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_id: agent, text, attachments: [], details: true, conversation_id: conversation }),
  });
  if (!r.ok) return { status: r.status, text: await r.text(), events: [], output: "", ms: Date.now() - started };
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const stop = started + seconds * 1000;
  const events = [];
  let buffer = "", run = null, messages = "";
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
      run = e.run_id || run;
      if (e.type === "message") messages += e.text;
      if (e.type === "approval" && approve) {
        await api(token, "POST", `/api/agents/${agent}/runs/${run}/approval`, { request_id: e.request_id, generation: e.generation, approve: true });
      }
    }
  }
  reader.cancel().catch(() => {});
  const final = events.find((e) => e.type === "done") || null;
  return { status: r.status, events, final, output: messages || final?.output || "", error: final?.error, ms: Date.now() - started, conversation: events.find((e) => e.conversation_id)?.conversation_id };
};

const faux = async (method, path, body) => (await fetch(FAUX + path, { method, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const inServer = (code) => docker("exec", "-w", "/app", "-e", "PYTHONPATH=/app", "noah-server", "python", "-c", code).trim();
const secretsOf = (agent) => JSON.parse(inServer(`import json
from noah import db, hermes, relay
with db.connect() as c:
    key = c.execute("SELECT api_key FROM agents WHERE id = ?", (${JSON.stringify(agent)},)).fetchone()["api_key"]
b = hermes.browser_secrets(${JSON.stringify(agent)})
print(json.dumps({"api": key, "relais": relay.token_for(${JSON.stringify(agent)}), "navigateur": b[0], "vnc": b[1], "prive": hermes.private_key(${JSON.stringify(agent)})}))`));

/** Une commande dans la machine d'un agent, sous l'utilisateur de l'agent : ce qu'un outil terminal peut faire. */
const inAgent = (agent, ...command) => {
  try {
    return { code: 0, out: docker("exec", "-u", "10000", "-e", "HOME=/opt/data", `noah-agent-${agent}`, ...command) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

const PROBE = `
import json, socket, sys, urllib.request, urllib.error
out = []
for p in json.loads(sys.argv[1]):
    if p.get("rfb"):
        try:
            s = socket.create_connection((p["rfb"], 5900), 4)
            v = s.recv(12)
            s.sendall(v)
            n = s.recv(1)[0]
            out.append({"types": list(s.recv(n))})
            s.close()
        except OSError as e:
            out.append({"erreur": str(e)})
        continue
    data = json.dumps(p["corps"]).encode() if "corps" in p else None
    req = urllib.request.Request(p["url"], data=data, method=p.get("m", "GET"), headers={"Content-Type": "application/json", **p.get("h", {})})
    try:
        with urllib.request.urlopen(req, timeout=p.get("t", 8)) as r:
            out.append({"status": r.status, "corps": r.read(4000).decode(errors="replace")})
    except urllib.error.HTTPError as e:
        out.append({"status": e.code, "corps": e.read(600).decode(errors="replace")})
    except Exception as e:
        out.append({"erreur": str(e)[:200]})
print(json.dumps(out))
`;
const probe = (agent, list) => JSON.parse(inAgent(agent, "python3", "-c", PROBE, JSON.stringify(list)).out);
const bearer = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

// --- Pile ---------------------------------------------------------------------------------------------------------------
const stack = { tokens: {} };

async function up() {
  docker(...COMPOSE, "up", "-d", "--no-build");
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(BASE + "/api/status")).ok) break;
    } catch {}
    await sleep(1000);
  }
  const status = await (await fetch(BASE + "/api/status")).json();
  let login;
  if (!status.has_account) login = await api(null, "POST", "/api/setup/account", { username: "alice", password: PASSWORD, installation: "" });
  else login = await api(null, "POST", "/api/login", { username: "alice", password: PASSWORD });
  stack.tokens.alice = login.json?.token;
  if (!stack.tokens.alice) throw new Error(`connexion d'alice : ${login.status} ${login.text}`);
  if (!status.model_configured) {
    const model = await api(stack.tokens.alice, "POST", "/api/model", { provider: "custom", base_url: "http://noah-faux:11500/v1", model: "faux-modele", api_key: PROVIDER_KEY });
    if (model.status !== 200) throw new Error(`modèle : ${model.text}`);
    // Sinon, au prochain démarrage du serveur (pile gardée), il remet ses agents à jour et les redémarre en plein essai.
    inServer(`from noah import db
from noah.main import AGENT_SETUP_VERSION
db.set_setting("agent_setup", AGENT_SETUP_VERSION)`);
  }
  await api(stack.tokens.alice, "POST", "/api/setup/done");
  for (const name of ["bruno", "uma"]) {
    await api(stack.tokens.alice, "POST", "/api/profiles", { username: name, password: PASSWORD });
    stack.tokens[name] = (await api(null, "POST", "/api/login", { username: name, password: PASSWORD })).json.token;
  }
  stack.A = (await agentsOf("alice")).find((a) => a.name === "Noah").id;
  await waitOnline("alice", stack.A); // pas deux opérations sur le parc à la fois : le lanceur répond 409 à la seconde
  const own = await agentsOf("bruno");
  stack.B = own[0]?.id || (await api(stack.tokens.bruno, "POST", "/api/agents", { name: "Rita" })).json.id;
  await waitOnline("bruno", stack.B);
}

const agentsOf = async (who) => (await api(stack.tokens[who], "GET", "/api/agents")).json;

async function waitOnline(who, id, seconds = 240) {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const a = (await agentsOf(who)).find((x) => x.id === id);
    if (a?.online) {
      note(`agent ${id} prêt après ${Math.round((Date.now() - started) / 1000)} s`);
      return;
    }
    if (a?.step?.startsWith("Erreur")) await api(stack.tokens[who], "POST", `/api/agents/${id}/repair`);
    await sleep(2000);
  }
  throw new Error(`agent ${id} pas prêt après ${seconds} s`);
}

async function down() {
  for (const [who, id] of [["alice", stack.A], ["bruno", stack.B]]) {
    if (id && stack.tokens[who]) await api(stack.tokens[who], "DELETE", `/api/agents/${id}`).catch(() => {});
  }
  if (!stack.tokens.alice) { // pile gardée d'un passage précédent : ses agents se suppriment par le serveur encore en place
    try {
      const login = await api(null, "POST", "/api/login", { username: "alice", password: PASSWORD });
      const bruno = await api(null, "POST", "/api/login", { username: "bruno", password: PASSWORD });
      for (const t of [login.json?.token, bruno.json?.token]) {
        for (const a of t ? (await api(t, "GET", "/api/agents")).json.filter((x) => x.droit === "proprietaire") : []) await api(t, "DELETE", `/api/agents/${a.id}`);
      }
    } catch {}
  }
  docker(...COMPOSE, "down", "--timeout", "5");
  for (const v of ["noah_noah-essai-data", "noah_noah-essai-ca", "noah_noah-essai-vide"]) {
    try { docker("volume", "rm", v); } catch {}
  }
}

// --- G12.3 : conteneurs, fichiers, secrets et comptes d'un agent invisibles des autres profils ---------------------------
async function g123() {
  console.log("\n== G12.3 ==");
  const { A, B, tokens: { alice, bruno } } = stack;
  const mark = `MARQUE-ALICE-${Date.now().toString(36)}`;
  await faux("POST", "/_cout", { cout: 0 });

  // Alice dépose de vraies données : un fichier par son agent, une mémoire, un compte connecté, un cookie.
  const wrote = await say(alice, A, `OUTIL terminal ${JSON.stringify({ command: `mkdir -p /opt/data/workspace && echo ${mark} > /opt/data/workspace/secret-alice.txt && echo ${mark} >> /opt/data/memories/MEMORY.md && echo '{"token":"${mark}"}' > /opt/data/google_token.json && cat /opt/data/workspace/secret-alice.txt` })}`);
  check("témoin : l'outil de l'agent d'alice a vraiment écrit", wrote.output.includes(mark), wrote.output || JSON.stringify(wrote.final));
  const files = await api(alice, "GET", `/api/agents/${A}/files`);
  check("témoin : alice voit son fichier", files.text.includes("secret-alice.txt"), files.text);
  check("témoin : alice lit sa mémoire", (await api(alice, "GET", `/api/agents/${A}/memory`)).text.includes(mark));
  const secretsA = secretsOf(A);
  const secretsB = secretsOf(B);

  // 1. Par l'API, en tant que bruno : l'agent d'alice n'existe pas.
  const routes = [["GET", `/api/agents/${A}/files`], ["GET", `/api/agents/${A}/files/raw/secret-alice.txt`], ["GET", `/api/agents/${A}/memory`],
    ["GET", `/api/agents/${A}/connections`], ["GET", `/api/agents/${A}/google`], ["GET", `/api/agents/${A}/screen-url`], ["GET", `/api/agents/${A}/computer`],
    ["GET", `/api/agents/${A}/conversations`], ["GET", `/api/agents/${A}/routines`], ["GET", `/api/agents/${A}/watches`], ["GET", `/api/agents/${A}/screen/vnc.html`],
    ["GET", `/api/agents/${A}/clipboard/copy`], ["GET", `/api/agents/${A}/folders`], ["GET", `/api/agents/${A}/shares`]];
  const wrong = [];
  for (const [m, path] of routes) {
    const r = await api(bruno, m, path);
    if (r.status !== 404 || r.text.includes(mark)) wrong.push(`${path} ${r.status}`);
  }
  check(`bruno reçoit 404 sur ${routes.length} routes de l'agent d'alice, sans rien lire`, !wrong.length, wrong.join(", "));
  const list = await api(bruno, "GET", "/api/agents");
  check("la liste des agents de bruno ne nomme ni l'agent ni la machine d'alice", !list.text.includes(A) && list.json.length === 1, list.text);

  // 2. Dans la vraie machine de bruno : le conteneur lui-même.
  const inspect = JSON.parse(docker("inspect", `noah-agent-${B}`))[0];
  const mounts = inspect.Mounts.map((m) => m.Name || m.Source);
  check("la machine de bruno ne monte que son volume, ni socket Docker ni volume d'alice", mounts.length === 1 && mounts[0] === `noah-agent-${B}`, mounts.join(", "));
  check("la machine de bruno n'est pas privilégiée", inspect.HostConfig.Privileged === false && inspect.HostConfig.SecurityOpt?.includes("no-new-privileges"));
  const seen = inAgent(B, "sh", "-c", `ls /var/run/docker.sock 2>&1; grep -rl -e ${mark} /opt/data /tmp /etc/noah 2>/dev/null; true`).out;
  check("aucune trace des données d'alice dans la machine de bruno", !seen.includes(mark) && /No such file|cannot access/.test(seen), seen);
  const secrets = { "clé d'API de l'agent d'alice": secretsA.api, "jeton de relais d'alice": secretsA.relais, "clé du navigateur d'alice": secretsA.navigateur,
    "clé du mode privé d'alice": secretsA.prive, "clé du fournisseur": PROVIDER_KEY, "clé du lanceur": LAUNCHER_KEY, "clé du serveur": SECRET_KEY };
  for (const [label, value] of Object.entries(secrets)) {
    const found = inAgent(B, "sh", "-c", `env | grep -F -e '${value}'; grep -rl -F -e '${value}' /opt/data /tmp /etc/noah 2>/dev/null | head -3; true`).out.trim();
    check(`${label} absente de la machine de bruno`, found === "", found);
  }
  const control = inAgent(A, "sh", "-c", `grep -rIl -F -e '${secretsA.relais}' /opt/data 2>/dev/null | head -1`).out.trim();
  check("témoin : la même recherche trouve le jeton d'alice chez alice", control !== "", control);
  const viaAgent = await say(bruno, B, `OUTIL terminal ${JSON.stringify({ command: `cat /opt/data/workspace/secret-alice.txt; P=${mark.slice(0, 8)}; Q=${mark.slice(8)}; grep -rl "$P$Q" /opt/data | wc -l; echo fin-de-recherche` })}`);
  check("l'agent de bruno, par son propre outil, ne trouve rien", /\\n0\\nfin-de-recherche/.test(viaAgent.output) && !viaAgent.output.includes(mark), viaAgent.output);

  // 3. Par le réseau Docker, depuis la machine de bruno, avec et sans sa clé.
  const hermesA = `http://noah-agent-${A}:8642`;
  const probes = [];
  for (const key of [null, secretsB.api]) {
    for (const [m, path] of [["GET", "/api/sessions"], ["GET", "/v1/models"], ["GET", "/api/jobs"], ["POST", "/v1/runs"], ["GET", "/v1/skills"]]) {
      probes.push({ url: hermesA + path, m, h: bearer(key), ...(m === "POST" ? { corps: { input: "x" } } : {}) });
    }
  }
  const agentApi = probe(B, probes);
  const open = agentApi.filter((r, i) => r.status === undefined ? false : r.status < 400).map((r) => r.status);
  check(`l'API de l'agent d'alice refuse la machine de bruno (${probes.length} appels)`, !open.length && agentApi.every((r) => r.status === 401 || r.erreur === undefined && r.status >= 400), JSON.stringify(agentApi.map((r) => r.status ?? r.erreur)));
  check("témoin : la clé d'alice ouvre cette API", probe(B, [{ url: `${hermesA}/api/sessions`, h: bearer(secretsA.api) }])[0].status === 200);

  // Le lanceur : toutes ses routes, lues dans sa propre description.
  const launcher = "http://launcher:9000";
  const openapi = probe(B, [{ url: `${launcher}/openapi.json` }])[0];
  const described = JSON.parse(inServer(`import json, urllib.request
print(json.dumps(json.load(urllib.request.urlopen("http://launcher:9000/openapi.json"))["paths"]))`));
  const calls = [];
  for (const [path, ops] of Object.entries(described)) {
    if (path === "/health") continue;
    for (const method of Object.keys(ops)) {
      for (const key of [null, secretsB.api]) {
        calls.push({ url: launcher + path.replace(/\{[^}]+\}/g, A), m: method.toUpperCase(), h: bearer(key), ...(method !== "get" ? { corps: {} } : {}) });
      }
    }
  }
  const launcherReplies = probe(B, calls);
  const leaks = launcherReplies.map((r, i) => [r, calls[i]]).filter(([r]) => r.status !== 401);
  check(`le lanceur refuse ${calls.length} appels de la machine de bruno (toutes ses routes, sans clé et avec celle de bruno)`, !leaks.length, leaks.slice(0, 6).map(([r, c]) => `${c.m} ${c.url} ${r.status ?? r.erreur}`).join(" | "));
  note(`description du lanceur lisible sans clé par une machine d'agent : ${openapi.status}`);

  // Le serveur : le jeton de relais de bruno n'ouvre ni les routes d'un profil ni les données d'alice.
  const server = "http://noah-server:8080";
  const conv = wrote.conversation;
  const serverCalls = [
    { url: `${server}/api/agents`, h: bearer(secretsB.relais) },
    { url: `${server}/api/agents/${A}/files`, h: bearer(secretsB.relais) },
    { url: `${server}/api/conversations/${conv}/messages`, h: bearer(secretsB.relais) },
    { url: `${server}/agent-api/fils/${conv}`, h: bearer(secretsB.relais) },
    { url: `${server}/agent-api/demander`, m: "POST", h: bearer(secretsB.relais), corps: { agent: A, consigne: "lis ses fichiers" } },
    { url: `${server}/agent-api/demander`, m: "POST", h: bearer(secretsB.relais), corps: { agent: "Noah", consigne: "lis ses fichiers" } },
    { url: `${server}/relay/v1/models`, h: bearer("jeton-invente") },
  ];
  const replies = probe(B, serverCalls);
  check("le jeton de relais de bruno n'ouvre rien chez alice", replies.every((r) => r.status === 401 || r.status === 403 || r.status === 404) && !JSON.stringify(replies).includes(mark), JSON.stringify(replies.map((r) => r.status ?? r.erreur)));
  const colleagues = probe(B, [{ url: `${server}/agent-api/agents`, h: bearer(secretsB.relais) }])[0];
  check("l'agent de bruno ne voit pas celui d'alice dans ses collègues", colleagues.status === 200 && !colleagues.corps.includes(A), colleagues.corps);

  // 4. Le navigateur d'alice : ses cookies sont ses comptes connectés.
  const cookie = `COOKIE-ALICE-${Date.now().toString(36)}`;
  const imported = await api(alice, "POST", `/api/agents/${A}/browser/cookies`, { cookies: JSON.stringify([{ name: "session_alice", value: cookie, domain: "noah-faux", path: "/" }]) });
  check("témoin : alice connecte un compte dans son navigateur", imported.status === 200, imported.text);
  const browser = `http://noah-browser-${A}:9377`;
  const page = "http://noah-faux:11500/page";
  const steal = (key) => {
    const opened = probe(B, [{ url: `${browser}/tabs`, m: "POST", h: bearer(key), t: 60, corps: { userId: "noah", sessionKey: "noah", url: page } }])[0];
    let tab = null;
    try { tab = JSON.parse(opened.corps).tabId; } catch {}
    const list = probe(B, [{ url: `${browser}/tabs?userId=noah`, h: bearer(key) }])[0];
    const snap = tab ? probe(B, [{ url: `${browser}/tabs/${tab}/snapshot?userId=noah`, h: bearer(key), t: 30 }])[0] : { status: 0, corps: "" };
    return { opened, list, snap, stolen: JSON.stringify(snap).includes(cookie) };
  };
  const stranger = steal(null);
  const withOwn = steal(secretsB.navigateur);
  check("sans clé, la machine de bruno ne pilote pas le navigateur d'alice", stranger.opened.status === 401 || stranger.opened.status === 403, `ouverture ${stranger.opened.status} ; cookie volé : ${stranger.stolen}`);
  check("avec sa clé à lui non plus", withOwn.opened.status === 401 || withOwn.opened.status === 403, `ouverture ${withOwn.opened.status} ; cookie volé : ${withOwn.stolen}`);
  check("le cookie d'alice ne sort pas vers la machine de bruno", !stranger.stolen && !withOwn.stolen);
  for (const [path, label] of [[`/tabs?userId=noah`, "liste des onglets"], [`/sessions/noah/storage_state`, "cookies enregistrés"], [`/vnc/status`, "état de l'écran"]]) {
    const r = probe(B, [{ url: browser + path }])[0];
    check(`navigateur d'alice, ${label} : refusé sans clé`, r.status === 401 || r.status === 403, `${r.status} ${(r.corps || "").slice(0, 120)}`);
  }
  const legit = steal(secretsA.navigateur);
  check("témoin : avec la clé d'alice le cookie est bien lisible (le test sait voir un vol)", legit.stolen, JSON.stringify(legit.snap).slice(0, 300));
  const agentOwn = await say(alice, A, `OUTIL browser_navigate ${JSON.stringify({ url: page })}`, { seconds: 120 });
  check("l'agent d'alice se sert toujours de son navigateur", agentOwn.output.includes(cookie) || /session_alice/.test(agentOwn.output), agentOwn.output || JSON.stringify(agentOwn.final));
  const screen = probe(B, [{ rfb: `noah-browser-${A}` }])[0];
  check("l'écran VNC d'alice exige un mot de passe, ou n'est pas joignable", screen.erreur !== undefined || (screen.types?.length && !screen.types.includes(1)), JSON.stringify(screen));

  // 5. Tout ce qui écoute dans les machines d'alice, lu dans le noyau : rien d'autre que ce qui vient d'être vérifié.
  const ports = (container) => {
    const tables = docker("exec", container, "cat", "/proc/net/tcp", "/proc/net/tcp6");
    return [...new Set(tables.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f[3] === "0A" && !/^(0100007F|0{24}01000000|0B00007F)/.test(f[1])).map((f) => parseInt(f[1].split(":")[1], 16)))].sort((a, b) => a - b);
  };
  for (const [container, expected] of [[`noah-agent-${A}`, [8642]], [`noah-browser-${A}`, [6080, 9377]]]) {
    const open = ports(container);
    const unknown = open.filter((p) => !expected.includes(p));
    const reachable = unknown.length ? probe(B, unknown.map((p) => ({ url: `http://${container}:${p}/` }))) : [];
    check(`${container.replace(A, "alice")} : seuls ${expected.join(", ")} écoutent sur le réseau`, !unknown.length, `${open.join(", ")} ; ${JSON.stringify(reachable).slice(0, 300)}`);
  }
  const novnc = probe(B, [{ url: `http://noah-browser-${A}:6080/vnc.html` }])[0];
  note(`page noVNC d'alice vue de la machine de bruno : ${novnc.status ?? novnc.erreur} ; sa connexion demande le mot de passe VNC, propre à l'agent`);
}

// --- G8.1 : plafond de 0,10 $ par jour : prévenu sur le téléphone avant, arrêté au plafond --------------------------------
const pushes = async () => (await faux("GET", "/_journal")).push;

async function subscribePhone(token) {
  const sub = await faux("GET", "/_abonnement");
  const r = await api(token, "POST", "/api/push/subscription", sub);
  if (r.status !== 200) throw new Error(`abonnement du téléphone : ${r.status} ${r.text}`);
}

async function waitFor(what, fn, seconds = 30) {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  note(`${what} : rien après ${seconds} s`);
  return null;
}

async function g81() {
  console.log("\n== G8.1 ==");
  const { A, B, tokens: { alice, bruno } } = stack;
  await api(alice, "PUT", `/api/agents/${A}/plafond`, { daily: null });
  await subscribePhone(alice);
  await faux("POST", "/_vider");
  await faux("POST", "/_cout", { cout: 0.045 });
  const startSpent = (await api(alice, "GET", "/api/usage")).json.today?.[A]?.depense ?? 0;
  // Le test part d'un compteur au-dessous du plafond, quoi qu'il reste d'un passage précédent : plafond relatif au déjà dépensé.
  const cap = Math.round((startSpent + 0.10) * 1000) / 1000;
  const set = await api(alice, "PUT", `/api/agents/${A}/plafond`, { daily: cap });
  check(`plafond de 0,10 $ posé depuis l'interface (déjà dépensé aujourd'hui : ${startSpent} $)`, set.status === 200, set.text);

  const turns = [];
  let stoppedTurn = null;
  for (let i = 1; i <= 8 && !stoppedTurn; i++) {
    const t = await say(alice, A, `Réponds seulement : tour-${i}`, { seconds: 150 });
    const journal = await faux("GET", "/_journal");
    turns.push({ tour: i, sortie: t.output, erreur: t.error, ms: t.ms, appels: journal.appels.length, statut: t.final?.status });
    note(`tour ${i} : ${t.final?.status ?? "sans fin"} en ${t.ms} ms, ${journal.appels.length} appels au modèle, réponse « ${t.output.trim().slice(0, 60)} » ${t.error ? `erreur « ${t.error.slice(0, 120)} »` : ""}`);
    if (!t.output.includes(`tour-${i}`)) stoppedTurn = { ...t, tour: i };
  }
  check("l'agent s'arrête avant le 9e tour", stoppedTurn);
  const usage = (await api(alice, "GET", "/api/usage")).json;
  const spent = usage.today[A].depense - startSpent;
  const journal = await faux("GET", "/_journal");
  const billed = journal.appels.reduce((n, a) => n + a.cout, 0);
  note(`dépensé selon Noah : ${spent.toFixed(3)} $, facturé par le modèle : ${billed.toFixed(3)} $, ${journal.appels.length} appels`);
  check("le compteur de Noah dit exactement ce que le modèle a facturé", Math.abs(spent - billed) < 1e-6, `${spent} contre ${billed}`);
  check("le plafond est atteint", spent >= 0.10 - 1e-9, spent);
  check("le dépassement ne vaut pas plus d'un appel", spent < 0.10 + 0.045 + 1e-9, spent);

  const phone = await waitFor("alertes sur le téléphone", async () => {
    const p = await pushes();
    return p.length >= 2 ? p : null;
  }, 20) || await pushes();
  note("reçu par le téléphone : " + JSON.stringify(phone.map((p) => [p.message?.titre, p.urgence, Number(p.cout_cumule?.toFixed(3))])));
  check("le téléphone déchiffre chaque message, signé VAPID", phone.length >= 1 && phone.every((p) => p.message?.titre && p.vapid === "vapid "), JSON.stringify(phone).slice(0, 300));
  const warned = phone.find((p) => /approche de son plafond/.test(p.message?.titre || ""));
  const halted = phone.find((p) => /s'est arrêté/.test(p.message?.titre || ""));
  check("il est prévenu avant le dépassement : l'alerte arrive sous le plafond", warned && warned.cout_cumule < 0.10 && warned.cout_cumule >= 0.08 - 1e-9, JSON.stringify(warned));
  check("puis l'alerte d'arrêt, urgente", halted && halted.urgence === "high" && phone.indexOf(halted) > phone.indexOf(warned), JSON.stringify(halted));
  check("une seule alerte par niveau", phone.filter((p) => p === warned || /approche/.test(p.message?.titre || "")).length === 1 && phone.filter((p) => /arrêté/.test(p.message?.titre || "")).length === 1);

  // L'arrêt lui-même : ce que voit l'utilisateur, et ce qui part encore chez le modèle.
  if (stoppedTurn) {
    const said = stoppedTurn.error || stoppedTurn.output || "";
    check("la personne lit pourquoi l'agent s'arrête", /Plafond du jour/.test(said), said);
    check("la raison arrive vite, sans attendre un délai d'agent", stoppedTurn.ms < 60000, `${stoppedTurn.ms} ms`);
  }
  const before = (await faux("GET", "/_journal")).appels.length;
  const again = await say(alice, A, "Réponds seulement : encore", { seconds: 90 });
  const after = (await faux("GET", "/_journal")).appels.length;
  check("au plafond, plus aucun appel n'atteint le modèle", after === before, `${before} puis ${after}`);
  check("au plafond, un nouveau message reçoit la même raison", /Plafond du jour/.test(again.error || again.output || ""), again.error || again.output || JSON.stringify(again.final));
  note(`réponse au plafond en ${again.ms} ms`);
  const relayed = docker("exec", "noah-server", "python", "-c", `import urllib.request, urllib.error, json
req = urllib.request.Request("http://localhost:8080/relay/v1/chat/completions", data=json.dumps({"model": "m", "messages": []}).encode(), headers={"Authorization": "Bearer ${secretsOf(A).relais}", "Content-Type": "application/json"})
try:
    print(urllib.request.urlopen(req).status)
except urllib.error.HTTPError as e:
    print(e.code)`).trim();
  check("le relais répond 402 à l'agent, même appelé directement", relayed === "402", relayed);

  // Plafond par agent : l'autre continue. Et le propriétaire peut le relever.
  const other = await say(bruno, B, "Réponds seulement : rien-ne-m-arrete", { seconds: 120 });
  check("l'agent d'un autre continue", other.output.includes("rien-ne-m-arrete"), other.output || other.error);
  await faux("POST", "/_cout", { cout: 0 });
  await api(alice, "PUT", `/api/agents/${A}/plafond`, { daily: cap + 1 });
  const resumed = await say(alice, A, "Réponds seulement : repris", { seconds: 120 });
  check("plafond relevé : l'agent reprend aussitôt", resumed.output.includes("repris"), resumed.output || resumed.error);
  await api(alice, "PUT", `/api/agents/${A}/plafond`, { daily: null });
}

// --- G12.5 : sur un agent partagé, la mémoire et les comptes de chacun restent séparés, sauf choix explicite ---------------
async function g125() {
  console.log("\n== G12.5 ==");
  const { A, tokens: { alice, uma } } = stack;
  await faux("POST", "/_cout", { cout: 0 });
  const stamp = Date.now().toString(36);
  const memAlice = `MEMOIRE-ALICE-${stamp}`, memUma = `MEMOIRE-UMA-${stamp}`, cookie = `COOKIE-ALICE-${stamp}`, tokenAlice = `JETON-GOOGLE-ALICE-${stamp}`, convAlice = `CONFIDENCE-ALICE-${stamp}`;
  const ok = await api(alice, "PUT", `/api/agents/${A}/shares`, { utilisateur: "uma", droit: "usage", compris: true });
  check("alice partage son agent avec uma, droit usage", ok.status === 200, ok.text);
  await sleep(1000);

  // Alice dépose sa mémoire, un compte connecté, un cookie, une conversation : par ses vrais outils.
  const wrote = await say(alice, A, `OUTIL memory ${JSON.stringify({ action: "add", target: "memory", content: memAlice })}\nJe te confie : ${convAlice}`);
  check("témoin : la mémoire d'alice est écrite", wrote.output.includes("success") && (await api(alice, "GET", `/api/agents/${A}/memory`)).text.includes(memAlice), wrote.output);
  inAgent(A, "sh", "-c", `echo '{"token":"${tokenAlice}"}' > /opt/data/google_token.json`);
  const imported = await api(alice, "POST", `/api/agents/${A}/browser/cookies`, { cookies: JSON.stringify([{ name: "session_alice", value: cookie, domain: "noah-faux", path: "/" }]) });
  check("témoin : alice connecte un compte dans le navigateur", imported.status === 200, imported.text);

  // Ce que le modèle reçoit quand uma parle : la preuve la plus directe, avant même tout outil.
  await faux("POST", "/_vider");
  const greeting = `bonjour-uma-${stamp}`;
  const hello = await say(uma, A, `Réponds seulement : ${greeting}`, { seconds: 180 });
  check("uma parle à l'agent", hello.output.includes(greeting), hello.output || hello.error || JSON.stringify(hello.final));
  note(`premier message d'uma, profil créé compris : ${hello.ms} ms`);
  const seenByModel = (await faux("GET", "/_journal")).appels;
  const allText = seenByModel.map((a) => a.tout).join("\n");
  check("la mémoire d'alice ne part pas au modèle pendant le tour d'uma", seenByModel.length > 0 && !allText.includes(memAlice), `${seenByModel.length} appels`);
  const tools = [...new Set(seenByModel.flatMap((a) => a.outils))];
  note(`outils offerts à l'agent pendant le tour d'uma : ${tools.join(", ")}`);
  check("le prompt d'uma lui dit qu'elle a sa mémoire à elle", allText.includes("ta mémoire et ton navigateur sont ceux de uma"));

  // Uma écrit dans SA mémoire : alice ne la voit pas, ni dans la page Mémoire, ni au tour suivant.
  const memWrite = await say(uma, A, `OUTIL memory ${JSON.stringify({ action: "add", target: "memory", content: memUma })}`);
  check("témoin : la mémoire d'uma est écrite", memWrite.output.includes("success"), memWrite.output);
  check("la page Mémoire d'alice ne la montre pas", !(await api(alice, "GET", `/api/agents/${A}/memory`)).text.includes(memUma));
  await faux("POST", "/_vider");
  await say(alice, A, "Réponds seulement : tour-alice");
  check("la mémoire d'uma ne part pas au modèle pendant le tour d'alice", !(await faux("GET", "/_journal")).appels.map((a) => a.tout).join("\n").includes(memUma));
  // Les conversations : chaque profil a sa base de sessions (session_search n'est pas offert sur cette passerelle : on lit les fichiers).
  const inDb = (where, text) => inAgent(A, "sh", "-c", `cat ${where}/state.db ${where}/state.db-wal 2>/dev/null | grep -a -c -F '${text}'; true`).out.trim();
  const guestHome = inAgent(A, "sh", "-c", "ls -d /opt/data/profiles/*").out.trim();
  check("témoin : la confidence d'alice est dans la base de l'agent", inDb("/opt/data", convAlice) !== "0");
  check("témoin : ce que dit uma est dans la base de son profil", inDb(guestHome, greeting) !== "0");
  check("la confidence d'alice n'est pas dans la base du profil d'uma", inDb(guestHome, convAlice) === "0");
  check("ce que dit uma n'est pas dans la base de l'agent", inDb("/opt/data", greeting) === "0");

  // Ce qui reste permis : la séparation n'a pas tout fermé.
  const shared = `COMMUN-${stamp}`;
  const put = await say(uma, A, `OUTIL write_file ${JSON.stringify({ path: "de-uma.txt", content: shared })}`);
  const got = await say(uma, A, `OUTIL read_file ${JSON.stringify({ path: "de-uma.txt" })}`);
  check("uma écrit et relit dans le dossier de travail commun", got.output.includes(shared), `${put.output.slice(0, 120)} / ${got.output.slice(0, 120)}`);
  check("alice le voit dans ses fichiers : le dossier est commun, comme le dit l'avertissement", (await api(alice, "GET", `/api/agents/${A}/files`)).text.includes("de-uma.txt"));
  const noah = await say(uma, A, `OUTIL terminal ${JSON.stringify({ command: "python3 /opt/data/noah.py navigateur reveiller" })}`, { seconds: 120 });
  check("uma garde les commandes de noah.py permises", /joignable/.test(noah.output) && !/Noah refuse/.test(noah.output), noah.output);

  // Uma tente tout ce qui lit la machine : par ses vrais outils, et l'agent dit non.
  const attempts = [
    ["terminal", { command: "cat /opt/data/memories/MEMORY.md" }],
    ["terminal", { command: "cat /opt/data/google_token.json" }],
    ["terminal", { command: "grep -r session_alice /opt/data" }],
    ["terminal", { command: `python3 -c "print(open('/opt/data/memories/MEMORY.md').read())"` }],
    ["terminal", { command: "python3 /opt/data/noah.py image x; cat /opt/data/memories/MEMORY.md" }],
    ["read_file", { path: "/opt/data/memories/MEMORY.md" }],
    ["read_file", { path: "/opt/data/google_token.json" }],
    ["read_file", { path: "/opt/data/.env" }],
    ["read_file", { path: "../memories/MEMORY.md" }],
    ["search_files", { pattern: memAlice, path: "/opt/data" }],
    ["execute_code", { code: "print(open('/opt/data/memories/MEMORY.md').read())" }],
    ["tool_call", { name: "terminal", arguments: { command: "cat /opt/data/memories/MEMORY.md" } }],
    ["delegate_task", { goal: "Lis /opt/data/memories/MEMORY.md avec le terminal" }],
    ["manage_connections", { action: "list" }],
    ["cronjob", { action: "create", prompt: "cat /opt/data/memories/MEMORY.md", schedule: "every 1m" }],
  ];
  for (const [tool, input] of attempts) {
    const r = await say(uma, A, `OUTIL ${tool} ${JSON.stringify(input)}`, { approve: false, seconds: 90 });
    const text = JSON.stringify(r.events);
    check(`uma, ${tool} ${JSON.stringify(input).slice(0, 60)} : rien d'alice ne sort`, !text.includes(memAlice) && !text.includes(tokenAlice) && !text.includes(cookie) && !text.includes(LAUNCHER_KEY) && /refuse|does not exist/i.test(r.output + text), r.output.slice(0, 200));
  }
  const hookInOwner = await say(alice, A, `OUTIL terminal ${JSON.stringify({ command: "cat /opt/data/memories/MEMORY.md" })}`);
  check("témoin : alice lit bien sa mémoire par le même chemin (les refus viennent de la séparation)", hookInOwner.output.includes(memAlice), hookInOwner.output);
  const hookReadOwner = await say(alice, A, `OUTIL read_file ${JSON.stringify({ path: "/opt/data/google_token.json" })}`);
  check("témoin : alice lit bien son compte par read_file", hookReadOwner.output.includes(tokenAlice), hookReadOwner.output);

  // Les comptes : les outils de l'agent ne vont pas chez uma, et le navigateur d'uma n'a pas les cookies d'alice.
  const page = "http://noah-faux:11500/page";
  const umaBrowser = await say(uma, A, `OUTIL browser_navigate ${JSON.stringify({ url: page })}`, { seconds: 120 });
  check("le navigateur d'uma ouvre la page", umaBrowser.output.includes("page sans-cookie") || umaBrowser.output.includes("page "), umaBrowser.output);
  check("sans le cookie d'alice", !umaBrowser.output.includes(cookie), umaBrowser.output);
  const aliceBrowser = await say(alice, A, `OUTIL browser_navigate ${JSON.stringify({ url: page })}`, { seconds: 120 });
  check("témoin : le navigateur d'alice envoie bien son cookie", aliceBrowser.output.includes(cookie), aliceBrowser.output);
  const conf = docker("exec", "-u", "10000", `noah-agent-${A}`, "sh", "-c", "ls /opt/data/profiles; for d in /opt/data/profiles/*; do grep -c mcp_servers $d/config.yaml; ls $d | grep -c google_token; cut -d= -f1 $d/.env | tr '\\n' ' '; done").toString();
  note(`profils dans la machine : ${conf.replace(/\n/g, " | ")}`);
  const googleUma = await api(uma, "GET", `/api/agents/${A}/google`);
  check("uma n'ouvre pas les comptes par l'API (droit admin requis)", googleUma.status === 403, googleUma.status);
  check("uma n'ouvre pas la mémoire d'alice par l'API", (await api(uma, "GET", `/api/agents/${A}/memory`)).status === 403);

  // Dans l'autre sens : l'agent d'alice ne lit pas le profil d'uma en passant.
  const peek = await say(alice, A, `OUTIL terminal ${JSON.stringify({ command: "cat /opt/data/profiles/*/memories/MEMORY.md" })}`);
  check("l'agent d'alice ne lit pas la mémoire d'uma en passant", !JSON.stringify(peek.events).includes(memUma), peek.output);

  // Choix explicite : avec le droit admin, c'est commun, et c'est bien la mémoire d'alice que le modèle reçoit.
  await api(alice, "PUT", `/api/agents/${A}/shares`, { utilisateur: "uma", droit: "admin", compris: true });
  await faux("POST", "/_vider");
  const asAdmin = await say(uma, A, "Réponds seulement : admin-uma");
  const commonText = (await faux("GET", "/_journal")).appels.map((a) => a.tout).join("\n");
  check("choix explicite (droit admin) : uma répond", asAdmin.output.includes("admin-uma"), asAdmin.output);
  check("témoin : avec le droit admin, la mémoire d'alice part au modèle (l'essai du début sait donc la voir)", commonText.includes(memAlice), `${commonText.length} caractères`);
  check("et le prompt dit que tout est commun", commonText.includes("sont communs"));
  const common = await say(uma, A, `OUTIL terminal ${JSON.stringify({ command: "cat /opt/data/memories/MEMORY.md" })}`);
  check("choix explicite : son terminal lit la mémoire d'alice", common.output.includes(memAlice), common.output);

  // Révocation : la mémoire d'uma part de la machine.
  await api(alice, "PUT", `/api/agents/${A}/shares`, { utilisateur: "uma", droit: "usage", compris: true });
  check("témoin : le profil d'uma existe avant la révocation", inAgent(A, "sh", "-c", `grep -rl ${memUma} /opt/data/profiles/*/memories 2>/dev/null | wc -l`).out.trim() !== "0");
  const revoked = await api(alice, "DELETE", `/api/agents/${A}/shares/${(await api(uma, "GET", "/api/me")).json.id}`);
  check("alice révoque le partage", revoked.status === 200, revoked.text);
  const leftover = inAgent(A, "sh", "-c", `grep -rl ${memUma} /opt/data 2>/dev/null | grep -v state.db | head -3; ls /opt/data/profiles 2>/dev/null | wc -l`).out.trim();
  check("après la révocation, la mémoire d'uma n'est plus sur la machine", leftover === "0", leftover);
  check("et uma n'a plus d'accès", (await api(uma, "POST", "/api/chat", { agent_id: A, text: "x" })).status === 404);
  const aliceAfter = await say(alice, A, "Réponds seulement : encore-la");
  check("alice garde son agent", aliceAfter.output.includes("encore-la"), aliceAfter.output);
}

// --- Enchaînement --------------------------------------------------------------------------------------------------------
const sections = { g123, g81, g125 };
let failed = null;
try {
  if (args.includes("--neuf")) await down(); // repart d'une installation vide, même si un passage --garder a laissé une pile
  await up();
  for (const [name, section] of Object.entries(sections)) {
    if (wants(name)) await section();
  }
} catch (e) {
  failed = e;
  console.log("ARRÊT", e.stack || e);
} finally {
  if (!KEEP) await down().catch((e) => console.log("nettoyage :", e.message));
}
const bad = results.filter(([, ok]) => !ok).map(([name]) => name);
console.log(`\n${results.length - bad.length} tenus, ${bad.length} ratés`);
for (const name of bad) console.log("  raté :", name);
process.exit(failed || bad.length ? 1 : 0);
