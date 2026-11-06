// Dernière réponse de chaque écran, en mémoire seulement : rouvrir un panneau l'affiche tout de suite, puis il se met à jour.
export const SEEN = new Map<string, unknown>();

let generation = 0;

/** Le compte peut changer : tout s'oublie, et une réponse encore en route ne reviendra pas remplir la mémoire. */
export function forgetSeen() {
  generation += 1;
  SEEN.clear();
}

export const seenGeneration = () => generation;
