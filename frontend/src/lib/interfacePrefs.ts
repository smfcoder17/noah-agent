// Les préférences d'interface du compte (`/api/me/interface`), lues par un seul lecteur partagé : le thème et la taille du texte d'un
// côté (SensitiveText.tsx), l'ordre des onglets de l'autre (navPrefs.ts) lisaient la même route chacun pour soi, et chacun la
// relisait à chaque événement (socle.md, 1.5 et 5.2). Une lecture, un abonnement au flux, tous les lecteurs servis.
import { currentAuthEpoch, get, send } from "./api";
import { subscribeUpdates } from "./events";

export type PrefsServeur = { tabs?: unknown; masquer_sensibles?: boolean; theme?: "light" | "dark" | "system"; texte?: "petit" | "normal" | "grand" };
type Lecteur = { valeur: (p: PrefsServeur) => void; erreur: () => void };

const lecteurs = new Set<Lecteur>();
let arreter: (() => void) | null = null;
let enVol: { epoch: string; promesse: Promise<PrefsServeur> } | null = null;

/** Une lecture à la fois par compte : une lecture demandée pendant une autre la rejoint. */
export function lirePrefs(): Promise<PrefsServeur> {
  const epoch = currentAuthEpoch();
  if (enVol && enVol.epoch === epoch) return enVol.promesse;
  const vol = { epoch, promesse: null as unknown as Promise<PrefsServeur> };
  vol.promesse = get<PrefsServeur>("/api/me/interface").finally(() => {
    if (enVol === vol) enVol = null;
  });
  enVol = vol;
  return vol.promesse;
}

function diffuser(p: PrefsServeur) {
  for (const l of lecteurs) l.valeur(p);
}

async function relire() {
  const epoch = currentAuthEpoch();
  try {
    const p = await lirePrefs();
    if (epoch === currentAuthEpoch()) diffuser(p);
  } catch {
    if (epoch === currentAuthEpoch()) for (const l of lecteurs) l.erreur();
  }
}

/**
 * Suit les préférences : la valeur arrive après la première lecture (partagée avec les autres lecteurs), puis à chaque relecture ou
 * écriture. Un seul abonnement au flux pour tous les lecteurs. Rend la fonction qui arrête.
 */
export function suivrePrefs(valeur: (p: PrefsServeur) => void, erreur: () => void = () => {}): () => void {
  const lecteur = { valeur, erreur };
  lecteurs.add(lecteur);
  arreter ??= subscribeUpdates(relire);
  const epoch = currentAuthEpoch();
  lirePrefs().then(
    (p) => { if (lecteurs.has(lecteur) && epoch === currentAuthEpoch()) valeur(p); },
    () => { if (lecteurs.has(lecteur) && epoch === currentAuthEpoch()) erreur(); },
  );
  return () => {
    lecteurs.delete(lecteur);
    if (!lecteurs.size) { arreter?.(); arreter = null; }
  };
}

/** Relit tout de suite, par exemple après un changement de compte. */
export const relirePrefs = () => relire();

/** Enregistre un changement ; la réponse du serveur (les préférences entières) va à tous les lecteurs. */
export async function ecrirePrefs(patch: Partial<PrefsServeur>): Promise<PrefsServeur> {
  const epoch = currentAuthEpoch();
  const p = await send<PrefsServeur>("/api/me/interface", patch, "PUT");
  if (epoch === currentAuthEpoch()) diffuser(p);
  return p;
}
