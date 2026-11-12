// --depuis <ref> : seulement les sabotages dont le fichier cible a changé depuis cette référence (git diff --name-only).
import { spawnSync } from "node:child_process";

// Un sabotage nomme son fichier comme le voit sa copie : « noah/… » vit dans server/, le reste part de la racine.
export function cheminDepot(path) {
  return path.startsWith("noah/") ? `server/${path}` : path;
}

export function filtrer(sabotages, changes) {
  const touches = new Set(changes.map((f) => f.trim().replaceAll("\\", "/")).filter(Boolean));
  return sabotages.filter((s) => touches.has(cheminDepot(s[1])));
}

// Fichiers changés entre la référence et l'arbre de travail. Une référence inconnue arrête tout : mieux vaut rien que faux.
export function fichiersChanges(ref, cwd) {
  const r = spawnSync("git", ["diff", "--name-only", ref, "--"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git diff --name-only ${ref} a échoué : ${String(r.stderr).trim()}`);
  return r.stdout.split("\n");
}

// Lit « --depuis X » ou « --depuis=X » ; null sans l'option, erreur si la valeur manque.
export function lireDepuis(argv) {
  const i = argv.findIndex((a) => a === "--depuis" || a.startsWith("--depuis="));
  if (i < 0) return null;
  const value = argv[i].includes("=") ? argv[i].slice("--depuis=".length) : argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error("--depuis attend une référence git (étiquette, branche ou commit).");
  return value;
}
