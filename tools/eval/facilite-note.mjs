// La note de facilité sur 20, par action, appareil et état, à partir des mesures du banc (facilite.mjs) et des juges.
//   node tools/eval/facilite-note.mjs <fichier de lots.json>
// lots.json : {"etats": {"lot-1": {"ordinateur": [dossiers de mesures…], "telephone": […]}, …}, "juges": [fichiers JSON des juges]}
// Un dossier de mesures plus loin dans la liste remplace les actions d'un dossier plus haut (rejeu d'une action).
//
// Barème, par action (méthode : docs/facilite.md) :
//   gestes   6 pts : 6 au nombre de gestes de la référence, 2 de moins par geste en plus
//   entrée   2 pts : le point de départ se voit dès l'accueil, sans ouvrir de menu
//   juges   12 pts : clarté, retour et facilité, de 0 à 4 chacun, moyenne des juges
import { readFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const judges = spec.juges.map((f) => ({ name: f, data: JSON.parse(readFileSync(f, "utf8")) })).filter((j) => Array.isArray(j.data.notes));
const measures = (dirs) => Object.assign({}, ...dirs.map((d) => JSON.parse(readFileSync(`${d}/mesures.json`, "utf8"))));

const rows = [];
for (const [lot, devices] of Object.entries(spec.etats)) {
  for (const [device, dirs] of Object.entries(devices)) {
    for (const [action, m] of Object.entries(measures(dirs))) {
      const steps = m.erreur ? null : Math.max(0, 6 - 2 * Math.max(0, m.gestes - m.ref));
      const marks = judges.map((j) => j.data.notes.find((n) => n.lot === lot && n.appareil === device && n.action === action)).filter(Boolean);
      const judged = marks.length ? marks.reduce((s, n) => s + n.clarte + n.retour + n.facilite, 0) / marks.length : null;
      const total = steps === null || judged === null ? null : steps + (m.entree_visible ? 2 : 0) + judged;
      rows.push({ lot, device, action, gestes: m.gestes, ref: m.ref, steps, entree: m.entree_visible, judged, total, ecart: marks.length > 1 ? Math.max(...marks.map((n) => n.clarte + n.retour + n.facilite)) - Math.min(...marks.map((n) => n.clarte + n.retour + n.facilite)) : 0 });
    }
  }
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
// Intervalle par rééchantillonnage des actions : une action répétée ne vaut pas une action de plus.
const interval = (xs) => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const means = Array.from({ length: 2000 }, () => mean(xs.map(() => xs[Math.floor(rand() * xs.length)]))).sort((a, b) => a - b);
  return [means[100], means[1899]];
};
console.log(`Juges lus : ${judges.map((j) => j.name.split(/[\\/]/).pop()).join(", ")}\n`);
for (const device of ["ordinateur", "telephone"]) {
  console.log(`== ${device}`);
  const lots = Object.keys(spec.etats);
  const actions = [...new Set(rows.filter((r) => r.device === device).map((r) => r.action))];
  console.log(["action", ...lots.map((l) => `${l} /20`), "gestes (réf.)"].join("\t"));
  for (const a of actions) {
    const cells = lots.map((l) => rows.find((r) => r.lot === l && r.device === device && r.action === a));
    console.log([a, ...cells.map((c) => (c?.total == null ? "—" : c.total.toFixed(1) + (c.ecart >= 4 ? " (juges en désaccord)" : ""))), cells.map((c) => `${c?.gestes}(${c?.ref})`).join(" / ")].join("\t"));
  }
  for (const l of lots) {
    const xs = rows.filter((r) => r.lot === l && r.device === device && r.total != null).map((r) => r.total);
    const [lo, hi] = interval(xs);
    console.log(`${l} : ${mean(xs).toFixed(1)} / 20 (90 % : ${lo.toFixed(1)} à ${hi.toFixed(1)}, ${xs.length} actions)`);
  }
  if (lots.length === 2) {
    const diffs = actions.map((a) => lots.map((l) => rows.find((r) => r.lot === l && r.device === device && r.action === a)?.total)).filter(([x, y]) => x != null && y != null).map(([x, y]) => x - y);
    const [lo, hi] = interval(diffs);
    console.log(`écart ${lots[0]} − ${lots[1]} : ${mean(diffs).toFixed(1)} (90 % : ${lo.toFixed(1)} à ${hi.toFixed(1)})`);
  }
  console.log("");
}
