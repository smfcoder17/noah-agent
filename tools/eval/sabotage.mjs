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

const SABOTAGES = [
  ["Plafond de dépense ignoré", "apollo/relay.py", "if cap is not None and day_cost(agent_id) >= cap:", "if False:", BUDGET],
  ["Heures non retirées des pages surveillées", "apollo/watch.py", String.raw`text = _STAMP.sub(r"\1", _VOLATILE.sub(" ", text))`, "pass", WATCH],
  ["Téléchargement puis exécution autorisés", "apollo/agent_plugin/__init__.py", 'DOWNLOADER = r"(?:curl|wget|iwr|invoke-webrequest|fetch)"', 'DOWNLOADER = r"(?:zzzz)"', GUARD],
  ["Session d'appairage qui n'expire plus", "apollo/auth.py", "UNCLAIMED = timedelta(minutes=10)", "UNCLAIMED = timedelta(days=3650)", PAIRING],
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
    const r = spawnSync("docker", ["run", "--rm", "-v", `${server}:/app`, "-v", `${join(ROOT, "tests")}:/tests`,
      "-v", `${join(ROOT, "frontend/src/App.tsx")}:/front/App.tsx:ro`, "-v", `${join(ROOT, "mobile/www/app.js")}:/mobile/app.js:ro`,
      "python:3.12-slim", "sh", "-c", cmd], { timeout: 600000 });
    // Seule une assertion compte : une panne d'installation ou de Docker ne prouve rien.
    const seen = r.status && String(r.stderr).includes("AssertionError");
    return { sabotage, resultat: seen ? "vu" : r.status ? "panne" : "NON VU" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Témoin : la même chaîne sans défaut doit rester verte, sinon un « vu » ne prouve rien.
const TEMOINS = [...new Set(SABOTAGES.map((s) => s[4]))].map((cmd) => run(["témoin", "apollo/auth.py", "", "", cmd]));
if (TEMOINS.some((t) => t.resultat !== "NON VU")) {
  console.error("Un témoin échoue sans sabotage : les résultats ne valent rien.");
  process.exit(2);
}
const results = SABOTAGES.map(run);
console.log(JSON.stringify(results, null, 1));
const seen = results.filter((r) => r.resultat === "vu").length;
console.log(`Défauts vus : ${seen} sur ${results.length}`);
process.exit(seen === results.length ? 0 : 1);
