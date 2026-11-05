#!/usr/bin/env node
// Ce que la CI vérifierait, en local, avant tout déploiement : chaque étape « run » de tests.yml, puis le build de l'interface.
//   node scripts/verifier.mjs            tout, 6 étapes à la fois
//   node scripts/verifier.mjs voice      seulement les étapes dont le nom ou la commande contient « voice »
//   NOAH_VERIF_PARALLELE=1 node scripts/verifier.mjs     une à la fois
// Une étape qui échoue en parallèle est rejouée seule : deux étapes peuvent se gêner sans qu'il y ait de défaut.
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filter = process.argv[2] || "";
const windows = process.platform === "win32";
const AT_ONCE = Number(process.env.NOAH_VERIF_PARALLELE || 6);

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

function launch(step) {
  // Sous Windows, Docker veut le chemin D:/… ; un cache pip commun évite de tout retélécharger à chaque étape.
  const command = step.command
    .replaceAll("$PWD", here)
    .replaceAll("docker run --rm", "docker run --rm -v noah-pip-cache:/root/.cache/pip");
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("bash", ["-c", `set -e\n${command}`], {
      cwd: root,
      env: { ...process.env, ...(windows ? { MSYS_NO_PATHCONV: "1" } : {}) },
    });
    let output = "";
    child.stdout.on("data", (d) => (output = (output + d).slice(-20000)));
    child.stderr.on("data", (d) => (output = (output + d).slice(-20000)));
    child.on("close", (code) => done({ step, ok: code === 0, output, seconds: ((Date.now() - started) / 1000).toFixed(0) }));
  });
}

function report(r) {
  console.log(`${r.ok ? "OK    " : "ÉCHEC "} ${r.step.name} (${r.seconds} s)`);
  if (!r.ok) console.log(r.output.trim().split("\n").slice(-12).map((l) => `       ${l.slice(0, 220)}`).join("\n"));
}

const todo = steps(`${root}/.github/workflows/tests.yml`).filter((s) => !filter || `${s.name} ${s.command}`.includes(filter));
const queue = [...todo];
const toRetry = [];
const failed = [];
await Promise.all(
  Array.from({ length: AT_ONCE }, async () => {
    while (queue.length) {
      const r = await launch(queue.shift());
      if (r.ok || AT_ONCE === 1) report(r);
      else toRetry.push(r.step);
      if (!r.ok && AT_ONCE === 1) failed.push(r.step.name);
    }
  }),
);
for (const step of toRetry) {
  const r = await launch(step);
  report(r);
  if (!r.ok) failed.push(step.name);
}
if (!filter || filter === "interface") {
  const r = await launch({ name: "interface (npm run build)", command: "cd frontend && npm run build" });
  report(r);
  if (!r.ok) failed.push("interface");
}
console.log(`\n${todo.length} étape(s), ${failed.length} échec(s)${failed.length ? ` : ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
