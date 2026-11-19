// Le nombre de « Pour toi » : ce que la page liste (propositions, questions, choix, connexions, appels), hors les accords que l'appelant
// ajoute. Un seul nombre pour la barre, l'en-tête du téléphone et la page. Relu avec les autres mises à jour (bus, secours 60 s).
import { useEffect, useState } from "react";
import { get, isProposition } from "./api";
import { subscribeUpdates } from "./events";
import { onForget, seenGeneration } from "./seen";

let count = 0; // les propositions
let others = 0; // le reste de la liste : questions, choix, connexions, appels
const listeners = new Set<(n: number) => void>();
const publish = (n: number, rest = others) => {
  count = n;
  others = rest;
  listeners.forEach((fn) => fn(n + rest));
};

// Une lecture à la fois : deux demandes au même instant (montage de l'écran, événement) n'en font qu'une.
let flying: { generation: number; read: Promise<void> } | null = null;
export function refreshPropositions(): Promise<void> {
  const generation = seenGeneration();
  if (flying && flying.generation === generation) return flying.read;
  const mine = { generation, read: null as unknown as Promise<void> };
  mine.read = get<{ type?: string; request_id?: string }[]>("/api/a-toi")
    .then((rows) => {
      if (generation !== seenGeneration()) return;
      publish(rows.filter(isProposition).length, rows.filter((r) => !isProposition(r) && !r.request_id).length); // les accords (request_id) viennent de useAccords
    })
    .finally(() => { if (flying === mine) flying = null; });
  flying = mine;
  return mine.read;
}
// Changement de compte : le compteur du précédent ne ressort pas.
onForget(() => { flying = null; publish(0, 0); });

/** Après une réponse dans « Pour toi » : le compteur suit sans attendre la relecture (propositions restantes). */
export const setPropositionCount = (n: number) => publish(n);
/** Après une question répondue : une ligne de moins dans le reste de la liste. */
export const setAutresCount = (n: number) => publish(count, n);

export function usePropositionCount(enabled: boolean) {
  const [n, setN] = useState(count + others);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setN);
    const read = () => refreshPropositions().catch(() => {});
    void read();
    const stop = subscribeUpdates(read);
    return () => { listeners.delete(setN); stop(); };
  }, [enabled]);
  return enabled ? n : 0;
}
