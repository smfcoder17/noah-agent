// Inventaire des licences de ce qui est distribué : `node tools/eval/licences.mjs` écrit docs/licences.md.
// Lit ce qui est réellement installé (node_modules, image du serveur) : un paquet absent de ces dossiers n'y figure pas.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RESTRICTIVE = /(^|[^L])GPL|AGPL|SSPL|BUSL|Commons|CC-BY-NC|Elastic|proprietary|UNLICENSED|UNKNOWN/i;

function readNode(root, lock) {
  const found = new Map();
  const walk = (dir) => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) { walk(join(dir, name)); continue; }
      const file = join(dir, name, "package.json");
      if (!existsSync(file)) continue;
      const p = JSON.parse(readFileSync(file, "utf8"));
      const license = typeof p.license === "string" ? p.license : p.license?.type || (p.licenses || []).map((l) => l.type).join(" OR ") || "UNKNOWN";
      found.set(p.name, license);
      walk(join(dir, name, "node_modules"));
    }
  };
  walk(join(root, "node_modules"));
  // Dépendances de production seulement si le verrou le dit : les outils de construction ne sont pas distribués.
  const packages = JSON.parse(readFileSync(lock, "utf8")).packages || {};
  const dev = new Set(Object.entries(packages).filter(([, v]) => v.dev).map(([k]) => k.replace(/^.*node_modules\//, "")));
  return [...found].filter(([name]) => !dev.has(name)).sort();
}

const python = JSON.parse(execFileSync("docker", ["run", "--rm", "apollo-server", "python", "-c",
  "import json, importlib.metadata as m\nout = []\nfor d in m.distributions():\n    a = d.metadata\n    c = [x.split(' :: ')[-1] for x in (a.get_all('Classifier') or []) if x.startswith('License')]\n    out.append([a['Name'], a.get('License-Expression') or ' / '.join(c) or (a.get('License') or 'UNKNOWN')[:40]])\nprint(json.dumps(sorted(out, key=lambda x: x[0].lower())))"]).toString());

const groups = [
  ["Serveur (Python)", python],
  ["Interface web", readNode("frontend", "frontend/package-lock.json")],
  ["Application de bureau", readNode("desktop", "desktop/package-lock.json")],
  ["Application mobile", readNode("mobile", "mobile/package-lock.json")],
];
const images = [
  ["electron (dans l'installateur de bureau)", "MIT"],
  ["dépendances Gradle de l'APK", "non inventoriées ici : à lire dans le rapport Gradle"],
  ["nousresearch/hermes-agent", "MIT (à confirmer sur son dépôt)"],
  ["ghcr.io/jo-inc/camofox-browser", "à confirmer sur son dépôt, Camoufox et Firefox sont sous MPL-2.0"],
  ["caddy", "Apache-2.0"],
  ["uBlock Origin 1.75.4 (extension du navigateur, dans l'image du lanceur)", "GPL-3.0-only, programme séparé non lié au code de Noah ; sources : github.com/gorhill/uBlock"],
];

const lines = ["# Licences de ce qui est distribué", "", "Généré par `node tools/eval/licences.mjs`. Noah Agent est sous PolyForm Noncommercial 1.0.0 (voir LICENSE) : ce fichier vérifie que chaque dépendance le permet.", ""];
const flagged = [];
for (const [title, list] of groups) {
  const counts = {};
  for (const [name, license] of list) {
    counts[license] = (counts[license] || 0) + 1;
    if (RESTRICTIVE.test(license)) flagged.push([title, name, license]);
  }
  lines.push(`## ${title} : ${list.length} paquets`, "", "| Licence | Paquets |", "|---|---|",
    ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([l, n]) => `| ${l.replace(/\|/g, "/")} | ${n} |`), "");
}
lines.push("## Images tierces", "", "| Image | Licence |", "|---|---|", ...images.map(([i, l]) => `| ${i} | ${l} |`), "");
lines.push("## À regarder de près", "", flagged.length ? "Licence absente, restrictive ou à réciprocité. À vérifier une par une avant de choisir :" : "Aucune.", "");
if (flagged.length) lines.push("| Composant | Paquet | Licence |", "|---|---|---|", ...flagged.map((f) => `| ${f[0]} | ${f[1]} | ${f[2].replace(/\|/g, "/")} |`), "");
writeFileSync("docs/licences.md", lines.join("\n"));
console.log(groups.map(([t, l]) => `${t} : ${l.length}`).join(", "));
console.log(flagged.length ? flagged.map((f) => f.join(" : ")).join("\n") : "rien à signaler");
