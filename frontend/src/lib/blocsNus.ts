// Un bloc que l'agent écrit mal, rendu quand même (0.4.0, L4 : X10). Il doit écrire un objet JSON dans un bloc ```noah ; en production il l'a aussi écrit
// nu (`{"type": "links", …}` au milieu de sa réponse), ou dans un bloc ```json. Ces deux formes deviennent le même bloc ```noah, donc la même carte :
// jamais de JSON brut à l'écran. Appelé sur le texte d'un message de l'agent avant l'analyse Markdown (components/thread/Markdown.tsx).
const FERMETURE = "```";

/** L'objet JSON qui commence à `debut` (un `{`), et l'indice qui suit sa dernière accolade ; null s'il n'est pas fermé ou n'est pas du JSON. */
function objetA(texte: string, debut: number): { fin: number; objet: Record<string, unknown> } | null {
  let profondeur = 0;
  let dansTexte = false;
  for (let i = debut; i < texte.length; i++) {
    const c = texte[i];
    if (dansTexte) {
      if (c === "\\") i++;
      else if (c === '"') dansTexte = false;
      continue;
    }
    if (c === '"') dansTexte = true;
    else if (c === "{") profondeur++;
    else if (c === "}" && --profondeur === 0) {
      try {
        const objet = JSON.parse(texte.slice(debut, i + 1));
        return objet && typeof objet === "object" && !Array.isArray(objet) && Object.keys(objet).length ? { fin: i + 1, objet } : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Vrai si le texte à partir de `debut` ressemble au début d'un objet JSON pas encore fermé (réponse en cours d'écriture). */
const commenceUnObjet = (texte: string, debut: number) => /^\{\s*("|$)/.test(texte.slice(debut, debut + 40));

/** Un bloc de code dont le contenu est un objet JSON de la forme d'un bloc `noah` (un champ `type`) : il devient un bloc ```noah. */
function dansUnBloc(texte: string): string {
  return texte.replace(/(^|\n)([ \t]*)```[ \t]*(?:json|jsonc|JSON)[ \t]*\n([\s\S]*?)\n[ \t]*```/g, (tout, avant: string, marge: string, code: string) => {
    const brut = code.trim();
    const trouve = brut.startsWith("{") ? objetA(brut, 0) : null;
    return trouve && trouve.fin === brut.length && typeof trouve.objet.type === "string" ? `${avant}${marge}${FERMETURE}noah\n${brut}\n${FERMETURE}` : tout;
  });
}

/** Un objet JSON nu, au début d'une ligne, hors de tout bloc de code : il devient un bloc ```noah. Pendant l'écriture, un objet pas encore fermé se tait. */
function nus(texte: string, enCours: boolean): string {
  const morceaux = texte.split(/(```[\s\S]*?(?:```|$))/);  // les morceaux impairs sont des blocs de code, laissés tels quels
  return morceaux.map((morceau, k) => {
    if (k % 2) return morceau;
    let sortie = "";
    let depuis = 0;
    for (const debut of [...morceau.matchAll(/(?:^|\n)[ \t]*(\{)/g)].map((m) => m.index! + m[0].length - 1)) {
      if (debut < depuis) continue;
      const trouve = objetA(morceau, debut);
      if (trouve) {
        const reste = morceau.slice(trouve.fin).split("\n", 1)[0];
        if (reste.trim() && !/^[\s.,;]*$/.test(reste)) continue; // du texte suit l'accolade sur sa ligne : une phrase, pas un bloc
        sortie += `${morceau.slice(depuis, debut).replace(/[ \t]+$/, "")}\n\n${FERMETURE}noah\n${morceau.slice(debut, trouve.fin)}\n${FERMETURE}\n\n`;
        depuis = trouve.fin;
      } else if (enCours && commenceUnObjet(morceau, debut) && !morceau.slice(debut).includes("\n\n```")) {
        sortie += morceau.slice(depuis, debut).replace(/[ \t]+$/, "");  // l'objet s'écrit encore : rien n'en paraît
        depuis = morceau.length;
        break;
      }
    }
    return sortie + morceau.slice(depuis);
  }).join("");
}

export function normaliserBlocs(texte: string, enCours = false): string {
  if (!texte.includes("{")) return texte;
  return nus(dansUnBloc(texte), enCours);
}
