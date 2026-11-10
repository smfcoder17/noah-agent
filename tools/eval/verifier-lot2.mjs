// Vérifications locales autorisées du lot 2, avec sorties conservées. Aucune installation.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const commands = [
  ["tsc", "--noEmit"],
  ["tsc", "-p", "tsconfig.app.json", "--noEmit", "--incremental", "false"],
  ["tsc", "-p", "tsconfig.ui.json", "--noEmit", "--incremental", "false"],
  ["vitest", "run"],
  ["vite", "build"],
];
const rows = [];
for (const args of commands) {
  const started = Date.now();
  const result = spawnSync(process.platform === "win32" ? "cmd.exe" : npx, process.platform === "win32" ? ["/d", "/s", "/c", npx + " --no-install " + args.join(" ")] : ["--no-install", ...args], { cwd: resolve("frontend"), encoding: "utf8", maxBuffer: 4_000_000, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  const output = (result.stdout || "") + (result.stderr || "");
  const code = result.status ?? 1;
  rows.push({ commande: "npx --no-install " + args.join(" "), dossier: "frontend", code, secondes: (Date.now() - started) / 1000, sortie: output, erreur_execution: result.error?.message ?? null });
  console.log(`${code === 0 ? "OK" : "ÉCHEC"} : ${rows[rows.length - 1].commande}`);
  if (code) console.log(output);
}
const out = "docs/epics/0.1.6/mesures";
mkdirSync(out, { recursive: true });
writeFileSync(out + "/verification-locale.json", JSON.stringify({ date: new Date().toISOString(), commandes: rows }, null, 2));
process.exitCode = rows.some((r) => r.code) ? 1 : 0;
