#!/usr/bin/env node
// Ce que la CI vérifierait, en local, avant tout déploiement : chaque étape « run » de tests.yml, puis le build de l'interface.
//   node scripts/verifier.mjs            tout
//   node scripts/verifier.mjs voice      seulement les étapes dont le nom ou la commande contient « voice »
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filter = process.argv[2] || "";
const windows = process.platform === "win32";

/** Les étapes d'un fichier de CI : nom et commande. Lecture simple par indentation, suffisante pour ce fichier. */
function steps(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const out = [];
  let name = "";
  for (let i = 0; i < lines.length; i++) {
    const named = lines[i].match(/^\s*- name:\s*"?(.*?)"?\s*$/);
    if (named) name = named[1];
    const run = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!run) continue;
    if (run[2] && run[2] !== "|") {
      out.push({ name, command: run[2] });
      continue;
    }
    const block = [];
    let indent = null;
    for (i++; i < lines.length; i++) {
      if (lines[i].trim() === "") {
        block.push("");
        continue;
      }
      const depth = lines[i].match(/^\s*/)[0].length;
      if (indent === null) indent = depth;
      if (depth < indent) {
        i--;
        break;
      }
      block.push(lines[i].slice(indent));
    }
    out.push({ name, command: block.join("\n").trim() });
  }
  return out;
}

const here = windows ? execSync("pwd -W", { cwd: root, shell: "bash" }).toString().trim() : root;
const failed = [];
let count = 0;
for (const step of steps(`${root}/.github/workflows/tests.yml`)) {
  if (filter && !`${step.name} ${step.command}`.includes(filter)) continue;
  count++;
  // Sous Windows, Docker veut le chemin D:/… ; un cache pip commun évite de tout retélécharger à chaque étape.
  const command = step.command
    .replaceAll("$PWD", here)
    .replaceAll("docker run --rm", "docker run --rm -v noah-pip-cache:/root/.cache/pip");
  const started = Date.now();
  const r = spawnSync("bash", ["-c", `set -e\n${command}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: { ...process.env, ...(windows ? { MSYS_NO_PATHCONV: "1" } : {}) },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (r.status === 0) {
    console.log(`OK     ${step.name} (${seconds} s)`);
  } else {
    failed.push(step.name);
    console.log(`ÉCHEC  ${step.name} (${seconds} s)`);
    console.log(`${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-12).map((l) => `       ${l.slice(0, 220)}`).join("\n"));
  }
}
if (!filter || filter === "interface") {
  const r = spawnSync("npm", ["run", "build"], { cwd: `${root}/frontend`, encoding: "utf8", shell: true, maxBuffer: 1 << 28 });
  if (r.status === 0) console.log("OK     interface (npm run build)");
  else {
    failed.push("interface");
    console.log(`ÉCHEC  interface\n${r.stdout}${r.stderr}`.split("\n").slice(-12).join("\n"));
  }
}
console.log(`\n${count} étape(s), ${failed.length} échec(s)${failed.length ? ` : ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
