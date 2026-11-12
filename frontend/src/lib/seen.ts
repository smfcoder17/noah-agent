import { createContext } from "react";

/** Un onglet conservé en mémoire ne relit ses données qu'en redevenant visible. */
export const SeenActive = createContext(true);

// Dernière réponse de chaque écran, en mémoire seulement : rouvrir un panneau l'affiche tout de suite, puis il se met à jour.
export const SEEN = new Map<string, unknown>();

let generation = 0;
const forgetters = new Set<() => void>();

/** Une mémoire tenue ailleurs (messages, listes de conversations) s'inscrit ici : elle se vide avec le reste au changement de compte. */
export function onForget(clear: () => void) {
  forgetters.add(clear);
}

/** Le compte peut changer : tout s'oublie, et une réponse encore en route ne reviendra pas remplir la mémoire. */
export function forgetSeen() {
  generation += 1;
  SEEN.clear();
  for (const clear of forgetters) clear();
}

export const seenGeneration = () => generation;

/** Lit d'avance ce qu'un écran montrera, sans rien afficher : l'onglet s'ouvre alors déjà rempli, puis se met à jour.
 * Ce qui est déjà en mémoire n'est pas relu ; une réponse arrivée après un changement de compte est jetée. */
export function prefetchSeen(paths: string[], read: (path: string) => Promise<unknown>) {
  const at = generation;
  for (const path of paths) {
    if (SEEN.has(path)) continue;
    read(path).then((data) => {
      if (generation === at && !SEEN.has(path)) SEEN.set(path, data);
    }).catch(() => {});
  }
}
