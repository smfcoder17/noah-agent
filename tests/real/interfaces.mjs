// Vrai navigateur sur la vraie application, avec de vrais agents et un vrai modèle : profils, partage, outil au choix, droits
// de l'outil, panne de l'outil, sonnerie d'un rappel. Écrit ses captures dans le dossier donné et remet tout en ordre à la fin.
// Il faut les agents « Noah » et « Rita » démarrés (tests/real/parcours_agents.py crée Rita), et l'image noah-server.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/interfaces.mjs <dossier>
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = "http://localhost:8080";
const OUT = resolve(process.argv[2] || "captures");
mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";

const docker = (...args) => execFileSync("docker", args, { maxBuffer: 1 << 26 }).toString();
const py = (code) => docker("exec", "-w", "/app", "-e", "PYTHONPATH=/app", "noah-server", "python", "-c", code).trim();
const token = py(`from noah import auth, db
print(auth.new_session(db.owner_id(), "Parcours interfaces"))`);
const PROFILE = "essai-bruno";
const PASSWORD = "essai-" + Math.random().toString(36).slice(2, 12);

// Un vrai serveur MCP, hors du réseau interne de Noah, qui refuse à raison une adresse de son propre réseau.
// Il écrit ce qu'il reçoit : on vérifie ce qui est arrivé jusqu'à lui, pas ce que l'agent en dit.
const MCP = "noah-mcp-essai";
const MCP_URL = "http://192.168.65.254:9911/mcp";
const startTool = () => {
  try { docker("rm", "-f", MCP); } catch {}
  docker("run", "-d", "--name", MCP, "-p", "127.0.0.1:9911:9911", "-v", resolve("tests/tools") + ":/t:ro", "-w", "/t", "noah-server", "python", "-c",
    "import json, mcp_server, time\ns = mcp_server.Server(port=9911, session=False).start()\nwhile True:\n    open('/tmp/calls.json', 'w').write(json.dumps([c[0] for c in s.calls]))\n    time.sleep(0.5)");
};
const toolCalls = () => JSON.parse(docker("exec", MCP, "cat", "/tmp/calls.json"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok]);
  console.log(ok ? "OK   " : "ÉCHEC", name, detail);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e.message).split("\n").slice(0, 14).join(" | ").slice(0, 900));
  }
};

const api = async (page, method, path, body) =>
  page.evaluate(async ([method, path, body]) => {
    const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [method, path, body]);

/** Une phrase à l'agent, écrite, jusqu'à la fin du tour. Rend le texte final et le nombre d'accords demandés, tous refusés. */
const say = (page, agent, text, seconds = 120) =>
  page.evaluate(async ([agent, text, seconds]) => {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agent, text, attachments: [], details: false }) });
    if (!r.ok) return { status: r.status, output: "", approvals: 0 };
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    const stop = Date.now() + seconds * 1000;
    let buffer = "", output = "", approvals = 0, run = null;
    while (Date.now() < stop) {
      const { done, value } = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ done: true }), stop - Date.now()))]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        if (!frame.startsWith("data:")) continue;
        const e = JSON.parse(frame.slice(5));
        run = e.run_id || run;
        if (e.type === "approval") {
          approvals++;
          await fetch(`/api/agents/${agent}/runs/${run}/approval`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: e.request_id, generation: e.generation, approve: false }) });
        }
        if (e.type === "done") output = e.output || "";
      }
    }
    return { status: r.status, output, approvals };
  }, [agent, text, seconds]);

const browser = await chromium.launch({
  channel: "chrome", headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const problems = [];
const watch = (page, who) => {
  page.on("pageerror", (e) => problems.push(`${who} : ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/status of 40[134]|navigator\.vibrate/.test(m.text()) && problems.push(`${who} : ${m.text().slice(0, 200)}`));
};
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
let page, noah, rita, toolName;

try {
  startTool();
  const owner = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
  await owner.addCookies([{ name: "noah_session", value: token, url: BASE }]);
  page = await owner.newPage();
  watch(page, "propriétaire");
  await page.addInitScript(() => {
    window.__played = 0;
    const Native = window.Audio;
    window.Audio = function (src) {
      const a = new Native(src);
      a.addEventListener("playing", () => window.__played++);
      return a;
    };
  });
  await page.goto(BASE);
  await page.waitForTimeout(500);
  // Rien d'un passage précédent : ni sonnerie, ni profil, ni outil.
  for (const call of (await api(page, "GET", "/api/calls/pending")).json.appels) await api(page, "POST", `/api/calls/${call.id}/decline`, {});
  const stale = (await api(page, "GET", "/api/profiles")).json.profils.find((p) => p.username === PROFILE);
  if (stale) await api(page, "DELETE", `/api/profiles/${stale.id}`);
  const agents = (await api(page, "GET", "/api/agents")).json;
  noah = agents.find((a) => a.name === "Noah").id;
  rita = agents.find((a) => a.name === "Rita").id;
  await api(page, "POST", `/api/agents/${noah}/connections/tools/outil-192-168-65-254/remove`, {});
  await page.reload();
  await page.waitForTimeout(2500);
  await shot(page, "01-accueil");

  await step("Réglages > Profils : créer un profil", async () => {
    await page.getByRole("button", { name: /Réglages/ }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole("tab", { name: "Profils" }).click();
    await page.waitForTimeout(500);
    await page.getByLabel("Nom d'utilisateur").fill(PROFILE);
    await page.getByLabel("Mot de passe initial").fill(PASSWORD);
    await page.getByRole("button", { name: "Créer le profil" }).click();
    await page.waitForTimeout(1200);
    await shot(page, "04-profil-cree");
    check("Le profil apparaît dans la liste", (await page.getByText(PROFILE).count()) > 0);
    await page.keyboard.press("Escape");
  });

  await step("Partager Noah depuis le panneau", async () => {
    await page.getByRole("button", { name: /^Noah/ }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Détails", exact: true }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Partager", exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.getByLabel("Nom d'utilisateur du profil").fill(PROFILE);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /Usage/ }).first().check();
    await dialog.getByRole("checkbox").first().check();
    await shot(page, "06-partage");
    await dialog.getByRole("button", { name: "Partager", exact: true }).click();
    await page.waitForTimeout(1000);
    await shot(page, "07-partage-fait");
    check("Le partage est enregistré", (await api(page, "GET", `/api/agents/${noah}/shares`)).json?.partages?.length === 1);
    await page.keyboard.press("Escape");
  });

  await step("Second profil, sur un autre appareil", async () => {
    const guest = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const g = await guest.newPage();
    watch(g, "profil partagé");
    await g.goto(BASE);
    await g.waitForTimeout(1500);
    await g.locator("#username").fill(PROFILE);
    await g.locator('input[type="password"]').first().fill(PASSWORD);
    await g.keyboard.press("Enter");
    await g.waitForTimeout(3000);
    await shot(g, "09-profil-partage-telephone");
    const seen = (await api(g, "GET", "/api/agents")).json.map((a) => a.name);
    check("Le profil voit Noah partagé, pas Rita", seen.includes("Noah") && !seen.includes("Rita"), seen.join(", "));
    for (const path of [`/api/agents/${rita}/conversations`, `/api/agents/${rita}/files`, `/api/agents/${rita}/screen-url`]) {
      const denied = await api(g, "GET", path);
      check(`Agent de l'autre fermé : ${path.split("/").pop()}`, [403, 404].includes(denied.status), String(denied.status));
    }
    const talk = await say(g, noah, "Réponds seulement : BONJOUR PARTAGE.");
    check("Droit usage : le profil parle vraiment à l'agent", talk.status === 200 && /PARTAGE/i.test(talk.output), talk.output.slice(0, 120));
    const private_ = (await api(g, "GET", `/api/agents/${noah}/conversations`)).json.find((c) => c.main).id;
    const convs = (await api(page, "GET", `/api/agents/${noah}/conversations`)).json;
    const read_ = await api(page, "GET", `/api/conversations/${private_}/messages`);
    check("Sa conversation reste invisible du propriétaire", !JSON.stringify(convs).includes(private_) && [403, 404].includes(read_.status), String(read_.status));

    const guestId = (await api(page, "GET", "/api/profiles")).json.profils.find((p) => p.username === PROFILE).id;
    await api(page, "PUT", `/api/agents/${noah}/shares`, { utilisateur: PROFILE, droit: "lecture", compris: true });
    const reading = await say(g, noah, "Réponds seulement : NON.");
    check("Droit lecture : parler est refusé", [403, 404].includes(reading.status), String(reading.status));
    await api(page, "PUT", `/api/agents/${noah}/shares`, { utilisateur: PROFILE, droit: "usage", compris: true });

    const t0 = Date.now();
    await api(page, "DELETE", `/api/agents/${noah}/shares/${guestId}`);
    const after = (await api(g, "GET", "/api/agents")).json.map((a) => a.name);
    const cut = await say(g, noah, "Réponds seulement : NON.");
    check("La révocation coupe tout en 5 s", !after.includes("Noah") && [403, 404].includes(cut.status) && Date.now() - t0 < 5000, `${Date.now() - t0} ms, chat ${cut.status}`);
    await g.reload();
    await g.waitForTimeout(1500);
    await shot(g, "10-apres-revocation-telephone");
    await guest.close();
  });

  await step("Ajouter un outil par son adresse", async () => {
    check("Noah refuse un outil sur son réseau interne", (await api(page, "PUT", "/api/mcp/reseaux", { reseaux: ["172.16.0.0/12"] })).status === 400);
    check("Réseau privé accepté par le propriétaire", (await api(page, "PUT", "/api/mcp/reseaux", { reseaux: ["192.168.65.0/24"] })).status === 200);
    await page.reload();
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "Détails", exact: true }).first().click();
    await page.waitForTimeout(800);
    await page.getByText("Connexions", { exact: true }).first().click();
    await page.waitForTimeout(400);
    const t0 = Date.now();
    await page.getByRole("button", { name: "Ajouter un outil" }).click();
    await page.locator('input[type="url"], input[placeholder*="http"]').first().fill(MCP_URL);
    await page.getByRole("button", { name: /Tester/ }).click();
    await page.getByRole("button", { name: "Enregistrer", exact: true }).waitFor({ timeout: 20000 });
    await shot(page, "12-outil-teste");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await page.getByText("arrive chez l'agent").waitFor({ timeout: 30000 });
    check("Outil ajouté en moins de 60 s", Date.now() - t0 < 60000, `${Date.now() - t0} ms`);
    await shot(page, "13-outil-ajoute");
    toolName = "outil-192-168-65-254";
    await page.waitForTimeout(70000); // Hermes relit ses outils environ chaque minute, sans redémarrer
  });

  await step("Droits de l'outil, sur le vrai agent", async () => {
    const setRight = (droit) => api(page, "PUT", `/api/agents/${noah}/connections/tools/${toolName}/droit`, { droit });

    // Le jeton d'un agent, sorti de sa machine, ne sert à rien depuis dehors.
    const leaked = py(`from noah import relay
print(relay.token_for(${JSON.stringify(noah)}))`);
    const outside = await fetch(BASE + "/agent-api/agents", { headers: { Authorization: "Bearer " + leaked } });
    check("Le jeton d'un agent est refusé depuis dehors", outside.status === 403, String(outside.status));

    // L'agent ne peut pas se donner un droit : son utilisateur n'écrit pas ce fichier, et le parent n'est pas à lui.
    const forged = () => { try { docker("exec", "-u", "hermes", "noah-agent-" + noah, "sh", "-c", `echo '{"${toolName}":"agir"}' > /etc/noah/mcp-droits.json`); return true; } catch { return false; } };
    check("L'agent ne peut pas réécrire ses droits", !forged());
    check("Ses droits sont bien ceux de Noah", JSON.parse(docker("exec", "noah-agent-" + noah, "cat", "/etc/noah/mcp-droits.json"))[toolName] === "confirmer");

    // Confirmer : l'appel attend, et un refus n'arrive jamais au serveur.
    let calls = toolCalls().length;
    const asked = await say(page, noah, "Avec l'outil que je t'ai connecté, crée une fiche nommée essai-refus.");
    check("Droit confirmer : l'accord est demandé", asked.approvals > 0, `${asked.approvals} accord(s)`);
    check("Droit confirmer : un refus n'atteint pas le serveur", !toolCalls().slice(calls).includes("creer_fiche"), JSON.stringify(toolCalls().slice(calls)));

    // Lire : ce qui lit passe sans accord, ce qui écrit n'arrive jamais au serveur.
    check("Droit changé en lire", (await setRight("lire")).status === 200);
    await page.waitForTimeout(3000);
    calls = toolCalls().length;
    const read = await say(page, noah, "Avec cet outil, lis la fiche 7.");
    check("Droit lire : la lecture arrive au serveur, sans accord", toolCalls().slice(calls).includes("lire_fiche") && read.approvals === 0, `${JSON.stringify(toolCalls().slice(calls))}, ${read.approvals} accord(s)`);
    calls = toolCalls().length;
    const refused = await say(page, noah, "Avec cet outil, crée une fiche nommée essai-lire.");
    check("Droit lire : l'écriture n'atteint pas le serveur", !toolCalls().slice(calls).includes("creer_fiche"), refused.output.slice(0, 160));

    // Agir : tout passe, sans accord.
    check("Droit changé en agir", (await setRight("agir")).status === 200);
    await page.waitForTimeout(3000);
    calls = toolCalls().length;
    const acted = await say(page, noah, "Avec cet outil, crée une fiche nommée essai-agir.");
    check("Droit agir : l'écriture arrive au serveur, sans accord", toolCalls().slice(calls).includes("creer_fiche") && acted.approvals === 0, `${JSON.stringify(toolCalls().slice(calls))}, ${acted.approvals} accord(s)`);

    // Panne : l'agent le dit et continue.
    docker("stop", "-t", "0", MCP);
    const broken = await say(page, noah, "Avec cet outil, lis la fiche 8, et dis-moi clairement si ça n'a pas marché.", 180);
    check("Panne : le tour finit et l'agent le dit", broken.status === 200 && broken.output.length > 0, broken.output.slice(0, 200));
    const alive = await say(page, noah, "Réponds seulement : TOUJOURS LA.");
    check("Panne : l'agent répond encore", /TOUJOURS/i.test(alive.output), alive.output.slice(0, 80));
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Détails", exact: true }).first().click();
    await page.waitForTimeout(23000); // relevé d'état au plus toutes les 20 s
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Détails", exact: true }).first().click();
    await page.getByText("Connexions", { exact: true }).first().click();
    await page.waitForTimeout(3000);
    await shot(page, "16-outil-en-panne");
  });

  await step("Un vrai rappel fait sonner l'écran", async () => {
    await page.reload();
    await page.waitForTimeout(1500);
    console.log("rappel :", docker("exec", "noah-agent-" + noah, "python3", "/opt/data/noah.py", "rappeler", "Le rapport est prêt : tout est en ordre.").replace(/\s+/g, " ").slice(0, 120));
    const t0 = Date.now();
    const heard = await page.evaluate(() => window.__played);
    const ring = page.getByRole("button", { name: "Répondre", exact: true });
    await ring.waitFor({ timeout: 30000 });
    check("La sonnerie s'affiche", true, `${Date.now() - t0} ms`);
    await shot(page, "14-sonnerie");
    await ring.click();
    await page.waitForTimeout(6000);
    await shot(page, "15-appel-decroche");
    const played = await page.evaluate(() => window.__played);
    check("Le compte rendu est vraiment lu à voix haute", played > heard, `${played - heard} lecture(s)`);
  });
} finally {
  if (page) {
    await api(page, "POST", `/api/agents/${noah}/connections/tools/outil-192-168-65-254/remove`, {}).catch(() => {});
    await api(page, "PUT", "/api/mcp/reseaux", { reseaux: [] }).catch(() => {});
    const left = (await api(page, "GET", "/api/profiles").catch(() => ({ json: { profils: [] } }))).json.profils.find((p) => p.username === PROFILE);
    if (left) await api(page, "DELETE", `/api/profiles/${left.id}`).catch(() => {});
  }
  await browser.close();
  try { docker("rm", "-f", MCP); } catch {}
  py(`from noah import auth
auth.drop_session(${JSON.stringify(token)})`);
}
console.log("\nErreurs de page :", problems.length ? problems.join("\n") : "aucune");
console.log(`${results.filter((r) => r[1]).length} tenus, ${results.filter((r) => !r[1]).length} ratés`);
process.exit(results.some((r) => !r[1]) ? 1 : 0);
