// Le nombre de propositions en attente, pour le compteur de « À toi ». Relu avec les autres mises à jour (bus, secours 60 s).
import { useEffect, useState } from "react";
import { get, isProposition } from "./api";
import { subscribeUpdates } from "./events";
import { onForget, seenGeneration } from "./seen";

let count = 0;
const listeners = new Set<(n: number) => void>();
const publish = (n: number) => {
  count = n;
  listeners.forEach((fn) => fn(n));
};

// Une lecture à la fois : deux demandes au même instant (montage de l'écran, événement) n'en font qu'une.
let flying: { generation: number; read: Promise<void> } | null = null;
export function refreshPropositions(): Promise<void> {
  const generation = seenGeneration();
  if (flying && flying.generation === generation) return flying.read;
  const mine = { generation, read: null as unknown as Promise<void> };
  mine.read = get<{ type?: string }[]>("/api/a-toi")
    .then((rows) => { if (generation === seenGeneration()) publish(rows.filter(isProposition).length); })
    .finally(() => { if (flying === mine) flying = null; });
  flying = mine;
  return mine.read;
}
// Changement de compte : le compteur du précédent ne ressort pas.
onForget(() => { flying = null; publish(0); });

/** Après une réponse dans « À toi » : le compteur suit sans attendre la relecture. */
export const setPropositionCount = publish;

export function usePropositionCount(enabled: boolean) {
  const [n, setN] = useState(count);
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
