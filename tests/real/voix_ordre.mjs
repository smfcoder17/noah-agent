// J7 et G11.7 à la voix : une vraie synthèse vocale dans un faux micro, le vrai composant, de vrais agents, un vrai outil.
// Il faut Noah et Rita démarrés, et sur Noah l'outil de tests/real/interfaces.mjs avec le droit « confirmer ».
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/voix_ordre.mjs <dossier des captures>
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = "http://localhost:8080";
const OUT = resolve(process.argv[2] || "captures");
mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";
const py = (code) => execFileSync("docker", ["exec", "-w", "/app", "-e", "PYTHONPATH=/app", "apollo-server", "python", "-c", code], { maxBuffer: 1 << 28 }).toString().trim();
const count = (sql) => Number(py(`from apollo import db
with db.connect() as c: print(c.execute(${JSON.stringify(sql)}).fetchone()[0])`));
const speak = (agent, text) => py(`import asyncio, base64
from apollo import media
print(base64.b64encode(asyncio.run(media.speak(${JSON.stringify(agent)}, ${JSON.stringify(text)}))[0]).decode())`);
const token = py(`from apollo import auth, db
print(auth.new_session(db.owner_id(), "Parcours voix"))`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(ok ? "OK   " : "ÉCHEC", name, detail);
};
const until = async (fn, seconds) => {
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    if (await fn()) return (Date.now() - t0) / 1000;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
};

// Un vrai outil, hors du réseau de Noah, qui écrit ce qu'il reçoit.
const docker = (...args) => execFileSync("docker", args, { maxBuffer: 1 << 26 }).toString();
const MCP = "noah-mcp-essai";
try { docker("rm", "-f", MCP); } catch {}
docker("run", "-d", "--name", MCP, "-p", "127.0.0.1:9911:9911", "-v", resolve("tests/tools") + ":/t:ro", "-w", "/t", "apollo-server", "python", "-c",
  "import json, mcp_server, time\ns = mcp_server.Server(port=9911, session=False).start()\nwhile True:\n    open('/tmp/calls.json', 'w').write(json.dumps([c[0] for c in s.calls]))\n    time.sleep(0.5)");
const toolCalls = () => JSON.parse(docker("exec", MCP, "cat", "/tmp/calls.json"));
const TOOL = "outil-192-168-65-254";
const post = (page, method, path, body) => page.evaluate(async ([method, path, body]) => (await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).status, [method, path, body]);
let openPage, agentId;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
  await context.addCookies([{ name: "apollo_session", value: token, url: BASE }]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const ctx = new AudioContext();
    const mic = ctx.createMediaStreamDestination();
    window.__played = 0;
    navigator.mediaDevices.getUserMedia = async () => mic.stream.clone();
    const Native = window.Audio;
    window.Audio = function (src) {
      const a = new Native(src);
      a.addEventListener("playing", () => window.__played++);
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
  await page.goto(BASE);
  await page.evaluate(async () => {
    const { appels } = await (await fetch("/api/calls/pending")).json();
    for (const call of appels) await fetch(`/api/calls/${call.id}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  });
  await page.reload();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /^Noah/ }).first().click();
  const agent = py(`from apollo import db
with db.connect() as c: print(c.execute("SELECT id FROM agents WHERE name = 'Noah'").fetchone()[0])`);
  openPage = page;
  agentId = agent;
  await post(page, "PUT", "/api/mcp/reseaux", { reseaux: ["192.168.65.0/24"] });
  await post(page, "POST", `/api/agents/${agent}/connections/tools/${TOOL}/remove`, {});
  const added = await post(page, "POST", `/api/agents/${agent}/connections/tools`, { url: "http://192.168.65.254:9911/mcp", nom: "", auth: "aucune", jeton: "", droit: "confirmer" });
  if (added !== 200) throw new Error("outil non ajouté : " + added);
  await page.waitForTimeout(70000); // Hermes relit ses outils environ chaque minute
  await page.getByRole("button", { name: "Mode vocal" }).click({ timeout: 30000 });
  await page.getByText("Je t'écoute").waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);

  // J7 : dit à voix haute, sans bouton.
  const before = count("SELECT COUNT(*) FROM delegations");
  await page.evaluate((b64) => window.__say(b64), speak(agent, "Demande à Rita de calculer quinze fois sept, et d'écrire le résultat dans un fichier."));
  const sent = await until(() => count("SELECT COUNT(*) FROM delegations") > before, 150);
  check("J7 : à la voix, la demande part chez Rita", sent !== null, `${sent} s`);
  const done = sent !== null && await until(() => count("SELECT etat = 'fini' FROM delegations ORDER BY created_at DESC LIMIT 1") === 1, 150);
  check("J7 : Rita a fini", done !== false && done !== null, `${done} s`);
  console.log("consigne :", py(`from apollo import db
with db.connect() as c: print(c.execute("SELECT consigne FROM delegations ORDER BY created_at DESC LIMIT 1").fetchone()[0][:200])`));
  check("La voix a parlé pendant ce temps", (await page.evaluate(() => window.__played)) > 0, String(await page.evaluate(() => window.__played)));
  await page.screenshot({ path: `${OUT}/20-voix-demande.png` });
  await page.waitForTimeout(25000);

  // G11.7 : une action demandée à la voix attend l'accord donné à l'écran.
  await page.evaluate((b64) => window.__say(b64), speak(agent, "Avec l'outil que je t'ai connecté, crée une fiche qui s'appelle essai vocal."));
  const asked = await until(async () => (await page.getByRole("button", { name: "Autoriser" }).count()) > 0, 120);
  check("G11.7 : l'action attend, à l'écran", asked !== null, `${asked} s`);
  await page.screenshot({ path: `${OUT}/21-voix-accord.png` });
  if (asked !== null) {
    // Un « oui » parlé ne donne pas l'accord.
    await page.evaluate((b64) => window.__say(b64), speak(agent, "Oui, vas-y, je confirme."));
    await page.waitForTimeout(6000);
    check("G11.7 : un oui parlé ne suffit pas", (await page.getByRole("button", { name: "Autoriser" }).count()) > 0 && !toolCalls().includes("creer_fiche"), JSON.stringify(toolCalls()));
    await page.getByRole("button", { name: "Autoriser" }).first().click();
    await page.waitForTimeout(8000);
    await page.screenshot({ path: `${OUT}/22-voix-apres-accord.png` });
    check("G11.7 : la carte disparaît après l'accord", (await page.getByRole("button", { name: "Autoriser" }).count()) === 0);
    check("G11.7 : après l'accord, l'action arrive vraiment à l'outil", toolCalls().includes("creer_fiche"), JSON.stringify(toolCalls()));
  }
  // J6 : on appelle aussi l'autre agent, celui qu'on a créé.
  await page.getByRole("button", { name: /^Rita/ }).first().click();
  await page.waitForTimeout(1500);
  const heard = await page.evaluate(() => window.__played);
  await page.getByRole("button", { name: "Mode vocal" }).click({ timeout: 30000 });
  await page.getByText("Je t'écoute").waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await page.evaluate((b64) => window.__say(b64), speak(agent, "Bonjour Rita, tu m'entends ?"));
  const answered = await until(async () => (await page.evaluate(() => window.__played)) > heard, 40);
  check("J6 : l'autre agent répond à la voix", answered !== null, `${answered} s`);
  await page.screenshot({ path: `${OUT}/23-voix-rita.png` });
} finally {
  if (openPage) {
    await post(openPage, "POST", `/api/agents/${agentId}/connections/tools/${TOOL}/remove`, {}).catch(() => {});
    await post(openPage, "PUT", "/api/mcp/reseaux", { reseaux: [] }).catch(() => {});
  }
  try { docker("rm", "-f", MCP); } catch {}
  await browser.close();
  py(`from apollo import auth
auth.drop_session(${JSON.stringify(token)})`);
}
console.log(`${results.filter(Boolean).length} tenus, ${results.filter((r) => !r).length} ratés`);
process.exit(results.every(Boolean) ? 0 : 1);
