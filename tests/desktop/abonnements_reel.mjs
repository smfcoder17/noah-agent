// De bout en bout : le vrai serveur dans Docker, le vrai noah.py de l'agent, la vraie boucle de l'application de bureau (sans sa
// fenêtre), un faux binaire `claude` et un faux serveur OpenAI à la place des vrais.
//   1. L'agent confie une tâche à Claude Code, le bureau l'exécute dans le dossier confié, le résultat revient, l'agent continue
//      (il lit le fichier produit) ; une tâche longue rend « en_cours » et s'arrête sur demande.
//   2. Un tour du cerveau de l'agent passe par le forfait ChatGPT de l'ordinateur ; forfait épuisé ou ordinateur déconnecté,
//      le fournisseur habituel répond à sa place.
//   3. (0.3.0, lot A) « Claude Code (ton ordinateur) » choisi comme fournisseur par l'API de l'écran : un tour du cerveau passe
//      par claude -p sur l'ordinateur, l'appel d'outil revient en tool_calls, l'outil est exécuté, la réponse finale arrive ;
//      ordinateur déconnecté, le cerveau d'avant (le secours) répond.
//   node tests/desktop/abonnements_reel.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeElectron } from "./electron_factice.mjs";
import { fakeOpenAI } from "./faux_openai.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const NAME = `noah-abonnements-${process.pid}`;
const PORT = 19000 + (process.pid % 900);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const echecs = [];
const check = (nom, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", nom, ok ? "" : String(detail).slice(0, 600));
  if (!ok) echecs.push(nom);
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

const base = mkdtempSync(join(tmpdir(), "noah-abo-"));
const projet = join(base, "Projet");
mkdirSync(projet);
writeFileSync(join(projet, "notes.txt"), "pomme\npoire\n");

// Le serveur, un agent et sa conversation, une session d'ordinateur, et un fournisseur habituel dans le même conteneur.
const BOOT = `
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, "/app")
os.environ.update(NOAH_DATA_DIR="/tmp/noah-data", LAUNCHER_KEY="x", NOAH_SECRET_KEY="y" * 32)
os.makedirs("/tmp/noah-data", exist_ok=True)
from noah import auth, db, desktop, hermes, main, relay
db.init()
desktop.TASK_WAIT = 4  # pour éprouver « en_cours » sans attendre 2 min 30
class Upstream(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        data = json.dumps({"id": "u1", "object": "chat.completion", "model": body["model"], "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                           "choices": [{"index": 0, "message": {"role": "assistant", "content": "réponse du fournisseur habituel"}, "finish_reason": "stop"}]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass
threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", 9999), Upstream).serve_forever, daemon=True).start()
user = auth.create_user("alice", "motdepasse-a")
with db.connect() as c:
    c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Nadine', '', 'k', ?)", (user,))
main._new_conversation(user, "a1", "Abonnements", main=True)
db.set_setting("provider", "custom"); db.set_setting("base_url", "http://127.0.0.1:9999/v1"); db.set_setting("model", "habituel")
token = auth.new_session(user, "Bureau", "desktop")
tool = hermes.AGENT_TOOL.replace("http://noah-server:8080/agent-api", "http://127.0.0.1:8080/agent-api").replace("__TOKEN__", relay.token_for("a1"))
open("/tmp/noah.py", "w", encoding="utf8").write(tool)
# Ce que fait Hermes à chaque tour : un appel Chat Completions au relais, avec le jeton de l'agent.
open("/tmp/cerveau.py", "w", encoding="utf8").write('''import json, sys, urllib.request
req = urllib.request.Request("http://127.0.0.1:8080/relay/v1/chat/completions", method="POST", data=json.dumps({"model": "x", "messages": [{"role": "user", "content": sys.argv[1]}]}).encode(),
                             headers={"Authorization": "Bearer %s", "Content-Type": "application/json"})
print(json.dumps(json.load(urllib.request.urlopen(req, timeout=300))))
''' % relay.token_for("a1"))
# Un tour avec outils, comme Hermes : le corps Chat Completions entier en argument.
open("/tmp/tour.py", "w", encoding="utf8").write('''import json, sys, urllib.request
req = urllib.request.Request("http://127.0.0.1:8080/relay/v1/chat/completions", method="POST", data=sys.argv[1].encode(),
                             headers={"Authorization": "Bearer %s", "Content-Type": "application/json"})
print(json.dumps(json.load(urllib.request.urlopen(req, timeout=300))))
''' % relay.token_for("a1"))
open("/tmp/suivi.py", "w", encoding="utf8").write('''import json, sqlite3
c = sqlite3.connect("/tmp/noah-data/noah.db")
print(json.dumps([list(r) for r in c.execute("SELECT model, cost, prompt_tokens, completion_tokens FROM usage ORDER BY id DESC LIMIT 3")]))
''')
json.dump({"token": token, "appareil": auth.device_id(auth.digest(token))}, open("/tmp/ready.json", "w"))
import uvicorn
uvicorn.run(main.app, host="0.0.0.0", port=8080, log_level="warning")
`;
writeFileSync(join(base, "boot.py"), BOOT);
const started = docker("run", "-d", "--rm", "--name", NAME, "-p", `127.0.0.1:${PORT}:8080`, "-v", `${join(ROOT, "server")}:/app:ro`, "-v", `${join(base, "boot.py")}:/boot.py:ro`,
  "-v", "noah-pip-cache:/root/.cache/pip", "python:3.12-slim", "sh", "-c", "pip install -q -r /app/requirements.txt 2>/dev/null; python /boot.py");
if (started.status) {
  console.error(started.stderr);
  process.exit(2);
}

const run = (script, ...args) => new Promise((resolve) => {
  const child = spawn("docker", ["exec", NAME, "python3", script, ...args], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  child.on("close", () => {
    try {
      resolve(JSON.parse(out));
    } catch {
      resolve({ illisible: out });
    }
  });
});
const agent = (...args) => run("/tmp/noah.py", ...args);
const brain = (text) => run("/tmp/cerveau.py", text);

let listening, openai;
let ended = false;
const finish = async (code) => {
  if (ended) return;
  ended = true;
  listening?.stop();
  docker("rm", "-f", NAME);
  await openai?.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  console.log(echecs.length ? `\n${echecs.length} échec(s) : ${echecs.join(" ; ")}` : "\nDe bout en bout : l'agent confie, Claude Code fait, l'agent continue ; ChatGPT passe par l'ordinateur et bascule sans lui.");
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
};
process.on("uncaughtException", (e) => {
  console.error(e);
  echecs.push("exception");
  finish(1);
});

let ready = null;
for (let i = 0; i < 240 && !ready; i += 1) {
  await sleep(1000);
  const out = docker("exec", NAME, "cat", "/tmp/ready.json");
  if (out.status === 0 && out.stdout) {
    try {
      await fetch(`${ORIGIN}/api/status`);
      ready = JSON.parse(out.stdout);
    } catch {
      /* il démarre */
    }
  }
}
if (!ready) {
  console.error(docker("logs", NAME).stderr);
  echecs.push("le serveur ne démarre pas");
  await finish(2);
} else {
  // L'application de bureau, sans sa fenêtre : seules les surfaces Electron sont factices ; claude et OpenAI sont des doublures.
  const electron = fakeElectron();
  electron.session.defaultSession.cookies.get = async () => [{ value: ready.token }];
  const charger = Module._load;
  Module._load = function (demande, ...reste) {
    return demande === "electron" ? electron : charger.call(this, demande, ...reste);
  };
  const require = createRequire(import.meta.url);
  const actions = require(join(ROOT, "desktop/actions.js"));
  require(join(ROOT, "desktop/bandeau.js")).create(electron.win);
  const dossiers = require(join(ROOT, "desktop/dossiers.js"));
  const claude = require(join(ROOT, "desktop/claude.js"));
  const chatgpt = require(join(ROOT, "desktop/chatgpt.js"));
  Module._load = charger;

  claude.configure({ program: { cmd: process.execPath, prefix: [join(HERE, "faux_claude.mjs")] } });
  await claude.detect();
  openai = await fakeOpenAI();
  let sealed = null;
  const config = {};
  chatgpt.configure({ issuer: openai.origin, api: `${openai.origin}/v1`, storage: { read: () => sealed && JSON.parse(sealed), write: (d) => { sealed = d ? JSON.stringify(d) : null; } } });
  await chatgpt.login({ open: (url) => openai.browser(url), read: () => config, write: (p) => Object.assign(config, p), port: 0 });
  actions.configure({ autonomy: () => "auto", rights: () => ({ claude: true, claudeProfil: "fichiers", claudeMinutes: 30, claudeCerveau: true, chatgpt: true, chatgptModele: "" }) });
  const store = dossiers.createStore(join(base, "profil", "dossiers.json"));
  const confie = store.add(projet);
  store.setWrite(confie.id, true);
  listening = actions.listen(() => ORIGIN, store);

  // 0. L'agent voit l'ordinateur et ce que ses abonnements permettent.
  let moi = null;
  for (let i = 0; i < 40 && !moi?.abonnements?.claude?.connecte; i += 1) {
    moi = ((await agent("appareils")).appareils ?? []).find((d) => d.id === ready.appareil);
    if (!moi?.abonnements?.claude?.connecte) await sleep(500);
  }
  check("l'agent voit Claude Code connecté (abonnement max) et ChatGPT connecté", moi?.abonnements?.claude?.offre === "max" && moi.abonnements.claude.permis
    && moi.abonnements.chatgpt.connecte === true, JSON.stringify(moi));
  check("ni e-mail ni jeton côté agent", !JSON.stringify(moi).includes("franck@") && !JSON.stringify(moi).includes("acces-"), JSON.stringify(moi));

  // 1. L'agent confie la tâche, le bureau la fait, le résultat revient.
  let out = await agent("ordinateur", "confier", "Résume notes.txt dans resultat.md.", "--dossier", "Projet");
  check("la tâche confiée aboutit et son compte rendu revient à l'agent", out.ok === true && out.texte === "J'ai écrit resultat.md avec le résumé demandé."
    && JSON.stringify(out.fichiers) === JSON.stringify(["resultat.md"]), JSON.stringify(out));
  check("Claude Code a travaillé dans le dossier confié", existsSync(join(projet, "resultat.md")) && readFileSync(join(projet, "resultat.md"), "utf8").includes("Résume notes.txt"));
  // L'agent continue avec ce résultat : il lit le fichier produit.
  out = await agent("ordinateur", "lire", "Projet", "resultat.md");
  const lu = docker("exec", NAME, "cat", out.fichier ?? "/n-existe-pas");
  check("l'agent continue : il lit le fichier que Claude Code a écrit", out.ok === true && lu.stdout.includes("# Résumé"), JSON.stringify(out) + lu.stderr);

  // 2. Tâche longue : « en_cours », suivie, puis arrêtée.
  out = await agent("ordinateur", "confier", "LENT : analyse tout le projet.", "--dossier", "Projet");
  check("une tâche longue rend « en_cours » avec un id", out.en_cours === true && /confier-attendre/.test(out.conseil ?? ""), JSON.stringify(out));
  const rid = out.id;
  const attente = await agent("ordinateur", "confier-attendre", rid);
  check("l'attente relancée voit la progression", attente.en_cours === true && (attente.progression ?? []).some((l) => /étape/.test(l)), JSON.stringify(attente));
  const t0 = Date.now();
  out = await agent("ordinateur", "confier-arreter", rid);
  for (let i = 0; i < 10 && out.en_cours; i += 1) out = await agent("ordinateur", "confier-attendre", rid);
  check("arrêtée sur demande : la CLI s'arrête sur l'ordinateur", out.arret === "annule" && !claude.busy(), JSON.stringify(out));
  check("arrêt en moins de 10 s", Date.now() - t0 < 10000, String(Date.now() - t0));

  // 3. ChatGPT : le tour du cerveau passe par l'ordinateur.
  out = await brain("Bonjour");
  check("un tour du cerveau passe par le forfait ChatGPT de l'ordinateur", out.choices?.[0]?.message?.content === "réponse du forfait (gpt-essai)", JSON.stringify(out));
  check("la requête est partie de l'ordinateur vers l'API Responses officielle (store:false, stream:true)",
    openai.state.seen.at(-1)?.store === false && openai.state.seen.at(-1)?.stream === true);
  out = await brain("LIMITE");
  check("forfait épuisé : le fournisseur habituel répond sans erreur", out.choices?.[0]?.message?.content === "réponse du fournisseur habituel", JSON.stringify(out));

  // 3 bis. Claude Code choisi comme fournisseur, comme dans Réglages > Modèles : le tour part vers claude -p sur l'ordinateur.
  const api = (path, method, body) => fetch(`${ORIGIN}${path}`, { method, headers: { Authorization: `Bearer ${ready.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  const listed = (await api("/api/fournisseurs", "GET")).data?.find((p) => p.id === "ordinateur:claude-code");
  check("Claude Code (ton ordinateur) est listé, ordinateur prêt", listed?.ordinateur === true && listed.pret === true, JSON.stringify(listed));
  const plugged = await api("/api/fournisseurs/ordinateur:claude-code", "PUT", {});
  const chosen = await api("/api/model", "POST", { provider: "ordinateur:claude-code", model: "sonnet" });
  check("branché sans clé (3 modèles), puis choisi comme cerveau (sonnet)", plugged.data?.models === 3 && chosen.status === 200, JSON.stringify([plugged, chosen]));
  const TOOLS = [{ type: "function", function: { name: "terminal", description: "Lance une commande", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }];
  const asked = [{ role: "system", content: "Tu es Nadine." }, { role: "user", content: "OUTIL_TERMINAL : dis bonjour par le terminal" }];
  out = await run("/tmp/tour.py", JSON.stringify({ model: "sonnet", messages: asked, tools: TOOLS }));
  const call = out.choices?.[0]?.message?.tool_calls?.[0];
  check("le cerveau par Claude Code demande l'outil : tool_calls OpenAI valides", out.choices?.[0]?.finish_reason === "tool_calls" && call?.function?.name === "terminal"
    && JSON.parse(call.function.arguments).command === "echo bonjour", JSON.stringify(out));
  // Hermes exécute l'outil sur la machine de l'agent, puis rend son résultat au cerveau.
  const ran = docker("exec", NAME, "sh", "-c", call ? JSON.parse(call.function.arguments).command : "false").stdout.trim();
  out = await run("/tmp/tour.py", JSON.stringify({ model: "sonnet", tools: TOOLS, messages: [...asked, { role: "assistant", content: out.choices[0].message.content, tool_calls: [call] },
    { role: "tool", tool_call_id: call?.id, content: ran }] }));
  check("l'outil exécuté, la réponse finale arrive par Claude Code", ran === "bonjour" && out.choices?.[0]?.message?.content === "Fini : bonjour", JSON.stringify(out));
  const suivi = await run("/tmp/suivi.py");
  check("suivi : « Claude Code · sonnet · abonnement », 0 $, jetons rapportés par la CLI", Array.isArray(suivi) && suivi[0][0] === "Claude Code · sonnet · abonnement"
    && suivi[0][1] === 0 && suivi[0][2] === 120 && suivi[0][3] === 7, JSON.stringify(suivi));

  // 4. Ordinateur déconnecté : le fournisseur habituel, sans erreur visible.
  listening.stop();
  let horsLigne = false;
  for (let i = 0; i < 20 && !horsLigne; i += 1) {
    horsLigne = !((await agent("appareils")).appareils ?? []).find((d) => d.id === ready.appareil)?.en_ligne;
    if (!horsLigne) await sleep(5000);
  }
  const avant = openai.state.seen.length;
  out = await brain("Encore bonjour");
  check("ordinateur déconnecté : le fournisseur habituel (le secours de Claude Code) répond", horsLigne && out.choices?.[0]?.message?.content === "réponse du fournisseur habituel", JSON.stringify(out));
  check("et rien n'est parti vers OpenAI", openai.state.seen.length === avant);
  out = await agent("ordinateur", "confier", "Résume encore.", "--dossier", "Projet");
  check("ordinateur déconnecté : confier le dit à l'agent, qui fait la tâche lui-même", /toi-même/.test(out.erreur ?? ""), JSON.stringify(out));
  await finish(echecs.length ? 1 : 0);
}
