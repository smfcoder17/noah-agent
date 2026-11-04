// Score de Noah Agent par niveau de preuve : un critère ne compte que si sa preuve atteint le niveau qu'il exige.
//     node tools/eval/score.mjs            écrit docs/etat.md et affiche le bilan
//     node tools/eval/score.mjs --check    échoue si une preuve n'a pas de source ou si un test cité n'existe plus
//     node tools/eval/score.mjs --release  échoue tant qu'un parcours n'est pas tenu : c'est la porte de publication
// « Déclaré » compte tout ce qui a au moins un test ; « prouvé » seulement ce qui atteint son niveau. L'écart entre les
// deux est le travail qui reste à vérifier.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const round = (x) => Math.round(x * 10) / 10;

/** Score sur 10. `minimum` remplace le niveau exigé (1 pour le score déclaré). Un critère bloquant manquant met à 0. */
export function goalScore(goal, minimum) {
  let points = 0, got = 0;
  const bloquants = [];
  for (const c of goal.criteres) {
    const weight = c.b ? 2 : 1;
    points += weight;
    if (c.preuve >= (minimum ?? c.requis)) got += weight;
    else if (c.b) bloquants.push(c.id);
  }
  const brut = round((got / points) * 10);
  return { score: bloquants.length ? 0 : brut, brut, bloquants };
}

export function report(card) {
  const done = card.parcours.filter((j) => j.preuve >= j.requis);
  const lines = [`# État de Noah Agent (grille version ${card.version})`, "",
    "Fichier généré par `tools/eval/score.mjs`, à ne pas modifier à la main. Un critère ne compte que si sa preuve atteint le niveau exigé. Méthode : [evaluation.md](evaluation.md).", "",
    `**Promesse : ${done.length} parcours tenus sur ${card.parcours.length}.**`, "",
    "| Parcours | Exigé | Atteint | Tenu |", "|---|---|---|---|",
    ...card.parcours.map((j) => `| ${j.id}. ${j.t} | ${j.requis} | ${j.preuve} | ${done.includes(j) ? "oui" : "non"} |`), "",
    "| Objectif | Prouvé | Sans bloquants | Déclaré | Seuil | Bloquants manquants |", "|---|---|---|---|---|---|"];
  let passed = 0;
  for (const g of card.objectifs) {
    const s = goalScore(g), d = goalScore(g, 1);
    if (s.score >= g.seuil) passed++;
    lines.push(`| ${g.id} ${g.nom} | ${s.score} | ${s.brut} | ${d.brut} | ${g.seuil} | ${s.bloquants.join(", ") || "—"} |`);
  }
  lines.push("", `**Objectifs au seuil : ${passed} sur ${card.objectifs.length}.**`, "", "## Niveaux de preuve", "",
    ...Object.entries(card.niveaux).map(([k, v]) => `- **${k}** : ${v}`), "",
    "## Critères ajoutés (G10 à G15)", "", "Les critères G0 à G9 sont décrits dans [grille-validation.md](grille-validation.md).", "");
  for (const g of card.objectifs.filter((g) => g.criteres.some((c) => c.t))) {
    lines.push(`### ${g.id}. ${g.nom} (seuil ${g.seuil})`, "",
      ...g.criteres.map((c) => `- ${c.id}${c.b ? " [B]" : ""} (exige ${c.requis}, atteint ${c.preuve}) : ${c.t}`), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const card = JSON.parse(readFileSync(join(ROOT, "tools/eval/scorecard.json"), "utf8"));
  const errors = card.objectifs.flatMap((g) => g.criteres).flatMap((c) => {
    if (c.preuve >= 1 && !c.test && !c.artefact) return [`${c.id} : preuve de niveau ${c.preuve} sans test ni artefact`];
    return [c.test, c.artefact].filter((p) => p && !existsSync(join(ROOT, p))).map((p) => `${c.id} : ${p} n'existe pas`);
  });
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  if (process.argv.includes("--release")) {
    const open = card.parcours.filter((j) => j.preuve < j.requis).map((j) => j.id);
    if (open.length) {
      console.error(`Publication refusée, parcours non tenus : ${open.join(", ")}`);
      process.exit(1);
    }
  }
  if (!process.argv.includes("--check") && !process.argv.includes("--release")) {
    const text = report(card);
    writeFileSync(join(ROOT, "docs/etat.md"), text);
    console.log(text.split("## Niveaux")[0]);
  }
}
