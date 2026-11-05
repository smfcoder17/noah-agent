// Sensibilité des tests : on abîme le code exprès, un défaut à la fois, sur une copie. Un test qui reste vert ne protège rien.
//     node tools/eval/sabotage.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PIP = "pip install -q -r /app/requirements.txt && ";
const BUDGET = PIP + "python /tests/budget/budget_test.py";
const WATCH = PIP + "python /tests/watch/watch_test.py";
const GUARD = "python /tests/skills/guard_test.py";
const PAIRING = PIP + "python /tests/pairing/pairing_test.py";
const MCP = PIP + "python /tests/tools/mcp_test.py";
const PENDANT = PIP + "python /tests/voice/pendant_test.py";
const APERCU = PIP + "python /tests/agents/apercu_test.py";

const SABOTAGES = [
  ["Plafond de dépense ignoré", "noah/relay.py", "if cap is None or day_cost(agent_id) < cap:", "if True:", BUDGET],
  ["Heures non retirées des pages surveillées", "noah/watch.py", String.raw`text = _STAMP.sub(r"\1", _VOLATILE.sub(" ", text))`, "pass", WATCH],
  ["Téléchargement puis exécution autorisés", "noah/agent_plugin/__init__.py", 'DOWNLOADER = r"(?:curl|wget|iwr|invoke-webrequest|fetch)"', 'DOWNLOADER = r"(?:zzzz)"', GUARD],
  ["Session d'appairage qui n'expire plus", "noah/auth.py", "UNCLAIMED = timedelta(minutes=10)", "UNCLAIMED = timedelta(days=3650)", PAIRING],
  ["Outil : adresse jugée sans la résolution DNS", "noah/mcp.py", '_judge(ipaddress.ip_address(a), "https" if for_source else scheme)', "pass", MCP],
  ["Veille : redirection suivie sans contrôle", "noah/watch.py", "target = await mcp.resolve(url, for_source=True)", 'target = mcp.Target(*(lambda p: (p.scheme, p.hostname, p.port or {"https": 443, "http": 80}[p.scheme], p.path or "/", p.hostname))(mcp.urlsplit(url)))', WATCH],
  ["Veille : réponse lue sans plafond", "noah/watch.py", "if len(body) >= MAX_BYTES:", "if False:", WATCH],
  ["Aperçu : session révoquée, le lien sert encore", "noah/main.py", "not auth.session_alive(session) or ", "", APERCU],
  ["Outil : jeton en clair en base", "noah/mcp.py", "db.seal(token) if token else None", "token", MCP],
  ["Outil : « confirmer » laisse passer sans accord", "noah/mcp.py", 'if _take_grant(row["agent_id"], name, _shown(tool, args if args is not None else {})):', "if True:", MCP],
  ["Outil : un accord sert plusieurs fois", "noah/mcp.py", "left.remove(match)", "pass", MCP],
  ["Outil : garde qui accepte par défaut", "noah/agent_plugin/__init__.py", 'droit = rights.get(server, "confirmer")', 'droit = rights.get(server, "agir")', MCP],
  ["Outil : une panne casse le tour de l'agent", "noah/mcp.py", 'return _tool_error(msg_id, _outage_text(name, erreur.rstrip(".")))', 'raise HTTPException(502, "panne")', MCP],
  ["Pendant le travail : même envoi compté deux fois", "noah/pendant.py", "INSERT OR IGNORE INTO pending_requests", "INSERT OR REPLACE INTO pending_requests", PENDANT],
  ["Pendant le travail : la file part par-dessus le travail", "noah/pendant.py", 'elif _h["busy"](agent_id, conv) or _h["paused"]():', "elif False:", PENDANT],
  ["Pendant le travail : accès retiré, la demande part quand même", "noah/pendant.py", 'if not _h["allowed"](row["user_id"], agent_id):', "if False:", PENDANT],
  ["Pendant le travail : une demande perdue au redémarrage", "noah/pendant.py", 'c.execute("UPDATE pending_requests SET status = ? WHERE status IN (?, ?)", (WAITING, TRI, RUNNING))', "pass", PENDANT],
  ["Pendant le travail : une demande retirée peut encore partir", "noah/main.py", 'if not pendant.move(request_id, (pendant.WAITING, pendant.ANSWERED), pendant.SENDING):', 'if not pendant.move(request_id, (pendant.WAITING, pendant.ANSWERED, pendant.CANCELLED, pendant.DONE), pendant.SENDING):', PENDANT],
  ["Pendant le travail : réponse perdue, la précision repart", "noah/main.py", "return STEER_UNSURE", "return STEER_REFUSED", PENDANT],
  ["Pendant le travail : droit retiré pendant le tri", "noah/main.py", 'if not access.allowed(user, agent.id, "usage"):  # le tri prend du temps', 'if False:  # le tri prend du temps', PENDANT],
  ["Activité : une clé affichée dans la ligne de travail", "noah/events.py", "label = mask(label)[:LABEL_MAX] if label else label", "pass", PENDANT],
  ["Aperçu : une page voit tout le dossier commun", "noah/main.py", "own_folder = bool(folder) and folder not in PREVIEW_SHARED_FOLDERS", "own_folder = bool(folder)", APERCU],
  ["Garde : un déplacement de patch ignoré", "noah/agent_plugin/__init__.py", "targets += [move.group(1).strip(), move.group(2).strip()]", "pass", GUARD],
  ["Outil : ajout sans contrôle d'accès", "noah/mcp.py", 'access.access(user, agent_id, "admin")\n    _scope(agent_id)\n    token = _clean_token(body)', "_scope(agent_id)\n    token = _clean_token(body)", MCP],
];

function run([sabotage, path, old, replacement, cmd]) {
  const tmp = mkdtempSync(join(tmpdir(), "noah-sabotage-"));
  try {
    const server = join(tmp, "server");
    cpSync(join(ROOT, "server"), server, { recursive: true, filter: (p) => !p.includes("__pycache__") });
    const target = join(server, path);
    const source = readFileSync(target, "utf8");
    if (old && source.split(old).length !== 2) return { sabotage, resultat: "cible introuvable" };
    if (old) writeFileSync(target, source.replace(old, () => replacement));
    const r = spawnSync("docker", ["run", "--rm", "-e", "PYTHONDONTWRITEBYTECODE=1", "-v", `${server}:/app`, "-v", `${join(ROOT, "tests")}:/tests`, "-v", `${join(ROOT, "launcher")}:/l:ro`,
      "-v", `${join(ROOT, "frontend/src/App.tsx")}:/front/App.tsx:ro`, "-v", `${join(ROOT, "mobile/www/app.js")}:/mobile/app.js:ro`,
      "python:3.12-slim", "sh", "-c", cmd], { timeout: 600000 });
    // Seule une assertion compte : une panne d'installation ou de Docker ne prouve rien.
    const seen = r.status && String(r.stderr).includes("AssertionError");
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU" };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

// Témoin : la même chaîne sans défaut doit rester verte, sinon un « vu » ne prouve rien.
const TEMOINS = [...new Set(SABOTAGES.map((s) => s[4]))].map((cmd) => run(["témoin", "noah/auth.py", "", "", cmd]));
if (TEMOINS.some((t) => t.resultat !== "NON VU")) {
  console.error("Un témoin échoue sans sabotage : les résultats ne valent rien.");
  process.exit(2);
}
const results = SABOTAGES.map(run);
console.log(JSON.stringify(results, null, 1));
const seen = results.filter((r) => r.resultat === "vu").length;
console.log(`Défauts vus : ${seen} sur ${results.length}`);
process.exit(seen === results.length ? 0 : 1);
