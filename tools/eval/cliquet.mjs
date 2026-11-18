// Le cliquet des budgets (socle.md, section 6) : lit tools/eval/budgets.json et juge une mesure.
//   - mesure au seuil ou mieux : VERT ;
//   - seuil pas encore atteint et budget non bloquant : « ROUGE attendu », l'étape réussit ;
//   - mesure pire que celle écrite dans budgets.json (plus la tolérance du budget) : ÉCHEC, aucune régression ne passe ;
//   - budget bloquant et seuil non atteint : ÉCHEC.
// Un lot qui fait baisser une mesure la baisse dans budgets.json, dans le même commit ; au seuil, il passe `bloquant` à vrai.
// Le sens est toujours « plus petit, c'est mieux » (requêtes, doublons, octets, millisecondes, débordements).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FICHIER = resolve(dirname(fileURLToPath(import.meta.url)), "budgets.json");
export const lire = () => JSON.parse(readFileSync(FICHIER, "utf8"));

/** Juge une valeur pour la clé `cle` de budgets.json. Rend { ok, ligne }. */
export function juger(cle, valeur, budgets = lire()) {
  const b = budgets.budgets[cle];
  if (!b) return { ok: false, ligne: `ÉCHEC  ${cle} : absent de tools/eval/budgets.json` };
  const unite = b.unite ? ` ${b.unite}` : "";
  const dit = `${cle} (${b.libelle}) : ${valeur}${unite} pour un seuil de ${b.seuil}${unite}`;
  if (valeur <= b.seuil) {
    const fige = b.bloquant ? "" : " : seuil atteint, passer `bloquant` à vrai";
    return { ok: true, ligne: `VERT   ${dit}${fige}` };
  }
  if (b.bloquant) return { ok: false, ligne: `ÉCHEC  ${dit} (bloquant)` };
  if (b.mesure == null) return { ok: true, ligne: `ROUGE attendu : ${dit} (aucune mesure gardée : l'écrire dans budgets.json)` };
  if (valeur > b.mesure + (b.tolerance ?? 0)) {
    return { ok: false, ligne: `ÉCHEC  régression sur ${dit} : pire que la mesure gardée (${b.mesure}${unite}, tolérance ${b.tolerance ?? 0})` };
  }
  const mieux = valeur < b.mesure ? ` ; mieux que la mesure gardée (${b.mesure}) : la baisser dans budgets.json` : "";
  return { ok: true, ligne: `ROUGE attendu : ${dit}${mieux}` };
}

/** Juge une liste de [cle, valeur], affiche, et rend vrai si tout passe. */
export function jugerTout(mesures) {
  const budgets = lire();
  let ok = true;
  for (const [cle, valeur] of mesures) {
    const r = juger(cle, valeur, budgets);
    console.log(r.ligne);
    ok = ok && r.ok;
  }
  return ok;
}

/** Playwright, quand il est là : variable NOAH_PLAYWRIGHT (dépôt, aujourd'hui), ou le paquet `playwright` (une fois ajouté à frontend). */
export async function playwright() {
  const { createRequire } = await import("node:module");
  const racine = resolve(dirname(FICHIER), "..", "..", "frontend", "package.json");
  for (const nom of [process.env.NOAH_PLAYWRIGHT, "playwright"].filter(Boolean)) {
    try { return createRequire(racine)(nom); } catch { /* suivant */ }
    try { return createRequire(import.meta.url)(nom); } catch { /* suivant */ }
  }
  return null;
}
