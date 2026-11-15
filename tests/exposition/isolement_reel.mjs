// Audit 0.3.0, E1 et M5, sur de vrais conteneurs : une pile Noah entière dans un Docker jetable (docker:27-dind, projet
// -p noahtest), sans rien partager avec le Docker de l'ordinateur ni avec le projet noah. Faux modèle (tests/real/faux_services.py).
//   A. Pile d'avant (code des images) : un agent sur le réseau commun, avec ses capacités par défaut.
//   B. Code de cette branche : l'agent passe sur noah-agents, recréé en cap_drop ALL ; puis on prouve :
//      un agent et un navigateur ne joignent pas le lanceur, ni par son nom ni par son adresse, et n'ont pas la socket Docker ;
//      Caddy reçoit 403 du lanceur ; le chat, les fichiers et le navigateur marchent ; la clé renouvelée (M5) remplace l'ancienne.
//   MSYS_NO_PATHCONV=1 node tests/exposition/isolement_reel.mjs [--garder]
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEEP = process.argv.includes("--garder");
const DIND = "noahtest-dind";
const PORT = 18190;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "motdepasse-essai";
const HERMES = "9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d";
process.env.MSYS_NO_PATHCONV = "1";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 1 << 26, stdio: ["pipe", "pipe", "pipe"], ...opts }).toString();
const docker = (...a) => sh("docker", a);
const inner = (...a) => sh("docker", ["exec", DIND, "docker", ...a]);
const tryInner = (...a) => {
  try { return { code: 0, out: inner(...a) }; } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, Boolean(ok)]);
  console.log(ok ? "OK   " : "ÉCHEC", name, detail ? `: ${String(detail).slice(0, 400)}` : "");
};
const note = (t) => console.log("     " + t);

function cleanup() {
  try { docker("rm", "-f", DIND); } catch {}
  try { docker("volume", "rm", "-f", "noahtest-dind-data"); } catch {}
  for (const tag of ["noahtest/hermes:essai", "noahtest/browser:essai"]) try { docker("rmi", tag); } catch {} // l'étiquette seule
}

// --- Le Docker jetable ---------------------------------------------------------------------------------------------------
async function boot() {
  cleanup();
  docker("run", "-d", "--privileged", "--name", DIND, "-p", `127.0.0.1:${PORT}:8080`, "-v", "noahtest-dind-data:/var/lib/docker", "docker:27-dind");
  for (let i = 0; i < 60; i++) {
    if (tryInner("info").code === 0) break;
    await sleep(1000);
  }
  note("Docker jetable prêt ; chargement des images (quelques minutes)");
  docker("tag", HERMES.slice(0, 12), "noahtest/hermes:essai");
  docker("tag", "ghcr.io/smfcoder17/noah-browser:stable", "noahtest/browser:essai");
  const browserInfo = JSON.parse(docker("image", "inspect", "noahtest/browser:essai"))[0];
  note(`navigateur : ${browserInfo.Id.slice(7, 19)} ; Hermes : ${HERMES.slice(0, 12)}`);
  for (const images of [["noah-server:latest", "noah-launcher:latest", "caddy:2.10-alpine"], ["noahtest/hermes:essai"], ["noahtest/browser:essai"]]) {
    execFileSync("sh", ["-c", `docker save ${images.join(" ")} | docker exec -i ${DIND} docker load -q`], { stdio: ["ignore", "ignore", "inherit"] });
  }
  for (const [from, to] of [["deploy", "/essai/deploy"], ["server/noah", "/essai/server-noah"], ["launcher", "/essai/launcher"], ["tests/real", "/essai/t"]]) {
    docker("exec", DIND, "mkdir", "-p", dirname(to));
    docker("cp", resolve(ROOT, from), `${DIND}:${to}`);
  }
  docker("exec", DIND, "sh", "-c", "mkdir -p /essai/vide && cat > /essai/essai.yml <<'EOF'\n" + OVERRIDE + "EOF");
}

// Par-dessus deploy/docker-compose.yml : images locales, code monté (phase B), faux modèle, serveur joignable depuis l'ordinateur.
const OVERRIDE = `services:
  server:
    image: noah-server:latest
    environment:
      NOAH_DOMAIN: noahtest.localhost
      NOAH_SETUP_CODE: ""
    ports: ["8080:8080"]
    volumes: ["\${CODE_SERVEUR:-/essai/vide}:\${CIBLE_SERVEUR:-/essai-vide}:ro"]
  launcher:
    image: noah-launcher:latest
    environment:
      AGENT_IMAGE: noahtest/hermes:essai
      BROWSER_IMAGE: noahtest/browser:essai
      AGENT_NETWORK: \${RESEAU_AGENTS:-noah-agents}
      NOAH_LANCEUR_CLIENTS: \${CLIENTS-noah-server}
    volumes: ["\${CODE_LANCEUR:-/essai/vide}:\${CIBLE_LANCEUR:-/essai-vide}"]
  faux:
    image: noah-server:latest
    container_name: noah-faux
    command: ["python", "/t/faux_services.py"]
    volumes: ["/essai/t:/t:ro"]
    networks: [noah]
`;
const compose = (env, ...a) => sh("docker", ["exec", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), DIND,
  "docker", "compose", "-p", "noahtest", "-f", "/essai/deploy/docker-compose.yml", "-f", "/essai/essai.yml", ...a]);
const OLD = { RESEAU_AGENTS: "noah-net", CLIENTS: "" };
const NEW = { RESEAU_AGENTS: "noah-net", CLIENTS: "noah-server", CODE_SERVEUR: "/essai/server-noah", CIBLE_SERVEUR: "/app/noah",
  CODE_LANCEUR: "/essai/launcher", CIBLE_LANCEUR: "/app" }; // RESEAU_AGENTS : la valeur des fichiers d'avant, gardée par une mise à jour

// --- API de Noah ---------------------------------------------------------------------------------------------------------
const api = async (token, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const session = /noah_session=([^;]+)/.exec(r.headers.get("set-cookie") || "")?.[1];
  if (session && json && !json.token) json.token = session;
  return { status: r.status, json, text };
};
const say = async (token, agent, text, seconds = 240) => {
  const r = await fetch(BASE + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_id: agent, text, attachments: [], details: true }) });
  if (!r.ok) return { output: "", error: `${r.status} ${await r.text()}` };
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const stop = Date.now() + seconds * 1000;
  let buffer = "", messages = "", run = null, final = null;
  while (Date.now() < stop && !final) {
    const { done, value } = await Promise.race([reader.read(), sleep(stop - Date.now()).then(() => ({ done: true }))]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      if (!frame.startsWith("data:")) continue;
      const e = JSON.parse(frame.slice(5));
      run = e.run_id || run;
      if (e.type === "message") messages += e.text;
      if (e.type === "approval") await api(token, "POST", `/api/agents/${agent}/runs/${run}/approval`, { request_id: e.request_id, generation: e.generation, approve: true });
      if (e.type === "done") final = e;
    }
  }
  reader.cancel().catch(() => {});
  return { output: messages || final?.reponse || final?.output || "", error: final?.error };
};
async function waitStatus(seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    try { const r = await fetch(BASE + "/api/status"); if (r.ok) return r.json(); } catch {}
    await sleep(1000);
  }
  throw new Error("le serveur ne répond pas");
}
async function waitOnline(token, id, seconds = 300) {
  for (let i = 0; i < seconds / 2; i++) {
    const a = ((await api(token, "GET", "/api/agents")).json || []).find((x) => x.id === id);
    if (a?.online) return;
    if (a?.step?.startsWith("Erreur")) await api(token, "POST", `/api/agents/${id}/repair`);
    await sleep(2000);
  }
  throw new Error(`agent ${id} pas prêt`);
}
const inspect = (name) => JSON.parse(inner("inspect", name))[0];
const caps = (name) => tryInner("exec", name, "sh", "-c", "grep -E '^(CapBnd|CapEff|NoNewPrivs)' /proc/1/status").out.trim().replace(/\s+/g, " ");
const probe = (name, url) => tryInner("exec", name, "curl", "-s", "-m", "6", "-o", "/dev/null", "-w", "%{http_code}", url);

// --- Parcours ------------------------------------------------------------------------------------------------------------
try {
  await boot();
  // A. La pile d'avant : code des images, réseau commun.
  compose(OLD, "up", "-d");
  let status = await waitStatus();
  const login = await api(null, "POST", "/api/setup/account", { username: "alice", password: PASSWORD, installation: "" });
  const token = login.json?.token;
  check("A. compte créé", token, login.text);
  const model = await api(token, "POST", "/api/model", { provider: "custom", base_url: "http://noah-faux:11500/v1", model: "faux-modele", api_key: "CLE-ESSAI" });
  check("A. faux modèle branché", model.status === 200, model.text);
  await api(token, "POST", "/api/setup/done");
  const agent = ((await api(token, "GET", "/api/agents")).json || []).find((a) => a.name === "Noah")?.id;
  await waitOnline(token, agent);
  const name = `noah-agent-${agent}`;
  let box = inspect(name);
  check("A. agent d'avant : réseau commun, capacités par défaut", Object.keys(box.NetworkSettings.Networks).join() === "noah-net" && (box.HostConfig.CapDrop || []).join() !== "ALL",
    `${Object.keys(box.NetworkSettings.Networks)} ${box.HostConfig.CapDrop}`);
  let reply = await say(token, agent, "Réponds seulement : bonjour-avant");
  check("A. le chat marche avant", /bonjour-avant/.test(reply.output), reply.output || reply.error);

  // B. Le code de cette branche, avec les fichiers d'avant (AGENT_NETWORK=noah-net, comme après une mise à jour).
  compose(NEW, "up", "-d");
  status = await waitStatus();
  let isolated = false;
  for (let i = 0; i < 120 && !isolated; i++) {
    await sleep(2000);
    try {
      box = inspect(name);
      isolated = (box.HostConfig.CapDrop || []).join() === "ALL" && box.State.Running && Object.keys(box.NetworkSettings.Networks).join() === "noah-agents";
    } catch {}
  }
  check("B. agent recréé isolé : cap_drop ALL, réseau noah-agents seul", isolated, `${box.HostConfig.CapDrop} ${box.HostConfig.CapAdd} ${Object.keys(box.NetworkSettings.Networks)}`);
  check("B. capacités ajoutées : seulement celles prouvées", (box.HostConfig.CapAdd || []).slice().sort().join() === "CAP_CHOWN,CAP_DAC_OVERRIDE,CAP_KILL,CAP_SETGID,CAP_SETUID"
    || (box.HostConfig.CapAdd || []).slice().sort().join() === "CHOWN,DAC_OVERRIDE,KILL,SETGID,SETUID", box.HostConfig.CapAdd);
  check("B. no-new-privileges", (box.HostConfig.SecurityOpt || []).includes("no-new-privileges"), box.HostConfig.SecurityOpt);
  note(`agent, /proc/1/status : ${caps(name)}`);
  const server = inspect("noah-server");
  check("B. serveur branché sur noah-agents (et sur noah-net)", "noah-agents" in server.NetworkSettings.Networks && "noah-net" in server.NetworkSettings.Networks, Object.keys(server.NetworkSettings.Networks));
  const launcher = inspect("noah-launcher");
  const launcherIp = launcher.NetworkSettings.Networks["noah-net"]?.IPAddress;
  check("B. lanceur absent de noah-agents", !("noah-agents" in launcher.NetworkSettings.Networks), Object.keys(launcher.NetworkSettings.Networks));
  await waitOnline(token, agent);

  for (const [label, url] of [["par son nom", "http://noah-launcher:9000/health"], ["par son adresse", `http://${launcherIp}:9000/health`]]) {
    const r = probe(name, url);
    check(`B. un agent ne joint pas le lanceur ${label}`, r.out.trim() === "000", `curl ${url} -> ${r.out.trim()} (code ${r.code})`);
  }
  const sock = tryInner("exec", name, "sh", "-c", "test -e /var/run/docker.sock && echo present || echo absente");
  check("B. pas de socket Docker dans l'agent", sock.out.trim() === "absente", sock.out);
  const caddy = tryInner("exec", "noah-caddy", "wget", "-q", "-S", "-O", "-", "http://noah-launcher:9000/health");
  check("B. Caddy reçoit 403 du lanceur", /403/.test(caddy.out), caddy.out.split("\n").slice(0, 3).join(" | "));
  const fromServer = tryInner("exec", "noah-server", "python", "-c",
    "import json,urllib.request as u;k=json.load(open('/secrets/noah.json'))['LAUNCHER_KEY'];print(u.urlopen(u.Request('http://launcher:9000/agents',headers={'Authorization':'Bearer '+k})).status)");
  check("B. le serveur joint le lanceur", fromServer.out.trim() === "200", fromServer.out);

  reply = await say(token, agent, "Réponds seulement : bonjour-isole");
  check("B. le chat marche une fois isolé", /bonjour-isole/.test(reply.output), reply.output || reply.error);
  reply = await say(token, agent, 'OUTIL terminal {"command": "mkdir -p /opt/data/workspace && echo preuve-isolement > /opt/data/workspace/preuve.txt && cat /opt/data/workspace/preuve.txt"}');
  const files = await api(token, "GET", `/api/agents/${agent}/files`);
  const text = await api(token, "GET", `/api/agents/${agent}/files/raw/preuve.txt`);
  check("B. les fichiers marchent : écrit par l'outil, listé et lu par le serveur", /preuve\.txt/.test(files.text) && /preuve-isolement/.test(text.text),
    `${reply.output.slice(0, 120)} | ${files.status} ${files.text.slice(0, 160)} | ${text.status} ${text.text.slice(0, 80)}`);

  inner("network", "connect", "noah-agents", "noah-faux"); // la page d'essai, joignable du navigateur comme un site
  reply = await say(token, agent, 'OUTIL browser_navigate {"url": "http://noah-faux:11500/page-isolement"}', 300);
  check("B. le navigateur marche : la page est lue", /sans-cookie/.test(reply.output) && !/erreur|error/i.test(reply.error || ""), reply.output.slice(0, 300) || reply.error);
  const browser = `noah-browser-${agent}`;
  const b = inspect(browser);
  check("B. navigateur : cap_drop ALL, aucune capacité, noah-agents seul", (b.HostConfig.CapDrop || []).join() === "ALL" && !(b.HostConfig.CapAdd || []).length
    && Object.keys(b.NetworkSettings.Networks).join() === "noah-agents", `${b.HostConfig.CapDrop} ${b.HostConfig.CapAdd} ${Object.keys(b.NetworkSettings.Networks)}`);
  note(`navigateur, /proc/1/status : ${caps(browser)}`);
  for (const url of ["http://noah-launcher:9000/health", `http://${launcherIp}:9000/health`]) {
    const r = probe(browser, url);
    check(`B. le navigateur ne joint pas le lanceur (${url})`, r.out.trim() === "000", `${r.out.trim()} (code ${r.code})`);
  }

  // M5 : la commande renouvelle la clé ; le serveur redémarre et parle au lanceur avec la nouvelle, l'ancienne est refusée.
  const oldKey = inner("exec", "noah-server", "python", "-c", "import json;print(json.load(open('/secrets/noah.json'))['LAUNCHER_KEY'])").trim();
  tryInner("exec", "noah-server", "python", "-m", "noah.cle_lanceur");
  await sleep(3000);
  status = await waitStatus();
  const newKey = inner("exec", "noah-server", "python", "-c", "import json;print(json.load(open('/secrets/noah.json'))['LAUNCHER_KEY'])").trim();
  check("M5. nouvelle clé écrite", newKey && newKey !== oldKey);
  const ask = (key) => tryInner("exec", "noah-server", "python", "-c",
    `import urllib.request as u, urllib.error as e\ntry: print(u.urlopen(u.Request('http://launcher:9000/agents',headers={'Authorization':'Bearer ${key}'})).status)\nexcept e.HTTPError as x: print(x.code)`).out.trim();
  check("M5. l'ancienne clé est refusée, la nouvelle acceptée, sans redémarrer le lanceur", ask(oldKey) === "401" && ask(newKey) === "200", `${ask(oldKey)} ${ask(newKey)}`);
  check("M5. le lanceur n'a pas redémarré", inspect("noah-launcher").State.StartedAt === launcher.State.StartedAt);
  await waitOnline(token, agent);
  const after = await api(token, "GET", `/api/agents/${agent}/files`);
  check("M5. après le renouvellement, le serveur passe par le lanceur (fichiers)", after.status === 200 && /preuve\.txt/.test(after.text), `${after.status} ${after.text.slice(0, 120)}`);
} catch (e) {
  check("parcours", false, e.stack || e.message);
} finally {
  if (!KEEP) cleanup();
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} vérifications vertes`);
process.exit(failed.length ? 1 : 0);
