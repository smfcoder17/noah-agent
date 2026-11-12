import { useEffect, useState } from "react";
import { get } from "./api";

/** Un modèle d'agent livré avec Noah (server/noah/presets.json) : une persona, une apparence, des demandes d'exemple. */
export type Preset = {
  id: string;
  nom: string;
  accroche: string;
  couleur: string;
  shape: string;
  detail: string;
  role: string;
  demandes: string[];
  routines: { nom: string; quand: string; consigne: string }[];
  connexions: string[];
};

export type Presets = {
  version: number;
  presets: Preset[];
  defaut: { demandes: string[] };
  /** Agent -> modèle dont il vient, pour les agents que ce compte voit. */
  agents: Record<string, string>;
};

// Lu une fois par page ; oublié après une création pour que l'écran vide du nouvel agent trouve son modèle.
let cache: Promise<Presets> | null = null;

export const loadPresets = (): Promise<Presets> => {
  if (!cache) cache = get<Presets>("/api/presets").catch((e) => {
    cache = null; // un échec réseau ne fige pas la liste vide
    throw e;
  });
  return cache;
};

export const forgetPresets = () => {
  cache = null;
};

/** Les modèles d'agent ; null tant qu'ils ne sont pas lus, ou si le serveur ne les donne pas (le choix « Partir de zéro » reste). */
export function usePresets(): Presets | null {
  const [data, setData] = useState<Presets | null>(null);
  useEffect(() => {
    let live = true;
    loadPresets().then((d) => live && setData(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return data;
}

/** Les 4 demandes à toucher sur l'écran vide : celles du modèle de l'agent, sinon les générales. */
export function demandesFor(data: Presets | null, agentId: string): string[] {
  if (!data) return [];
  const preset = data.presets.find((p) => p.id === data.agents[agentId]);
  return (preset?.demandes ?? data.defaut.demandes).slice(0, 4);
}
