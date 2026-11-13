// Le nombre de propositions en attente, pour le compteur de « À toi ». Relu avec les autres mises à jour (bus, secours 60 s).
import { useEffect, useState } from "react";
import { get, isProposition } from "./api";
import { subscribeUpdates } from "./events";

let count = 0;
const listeners = new Set<(n: number) => void>();
const publish = (n: number) => {
  count = n;
  listeners.forEach((fn) => fn(n));
};

export async function refreshPropositions() {
  const rows = await get<{ type?: string }[]>("/api/a-toi");
  publish(rows.filter(isProposition).length);
}

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
