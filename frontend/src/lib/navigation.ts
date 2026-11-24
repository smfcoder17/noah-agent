import { useCallback, useState } from "react";
import type { NavTab } from "./navPrefs";
import type { PanelTab } from "@/components/SidePanel";
import type { SettingsTab } from "@/components/Settings";

export type Route = { kind: "tab"; tab: NavTab } | { kind: "panel"; tab: PanelTab } | { kind: "settings"; tab: SettingsTab } | { kind: "page"; page: Page } | { kind: "drawer" | "agent" | "customize" } | { kind: "thread"; id: string };
/** Les pages de la zone de travail ouvertes depuis la barre de gauche. */
export type Page = "inbox" | "activite" | "recherche";
export const PAGES = ["inbox", "activite", "recherche"] as const;
export type Navigation = { stack: Route[] };
export type NavigationAction = { type: "push" | "reset"; route: Route } | { type: "back" } | { type: "close"; kind: Route["kind"] };
export const initialNavigation: Navigation = { stack: [{ kind: "tab", tab: "chat" }] };
export function navigate(state: Navigation, action: NavigationAction): Navigation {
  if (action.type === "back") return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
  if (action.type === "reset") return { stack: [action.route] };
  if (action.type === "close") return { stack: state.stack.filter((r, i) => i === 0 || r.kind !== action.kind) };
  // Une seule page à la fois : « Pour toi », Activité, Recherche et Réglages se remplacent. Une discussion ou un panneau qu'on ouvre les ferme toutes.
  const exclusives: Route["kind"][] = ["settings", "page"];
  const ferme = exclusives.includes(action.route.kind) ? exclusives : ["thread", "panel"].includes(action.route.kind) ? exclusives : [action.route.kind];
  const stack = state.stack.filter((r, i) => i === 0 || (r.kind !== action.route.kind && !ferme.includes(r.kind)));
  return { stack: [...stack, action.route] };
}
// Rechargement automatique après une mise à jour du serveur (lib/rechargement.ts) : la pile courante et l'agent affiché sont gardés
// pour la page suivante, qui les reprend une fois (deux minutes au plus).
const PILE = "noah:pile-avant-rechargement";
let courante: Route[] = initialNavigation.stack;
let agentCourant: string | null = null;
let reprise: { stack: Route[]; agent: string | null } | null = null;
export function sauverPile() {
  try { sessionStorage.setItem(PILE, JSON.stringify({ at: Date.now(), stack: courante, agent: agentCourant })); } catch { /* stockage bloqué : on repart de l'accueil */ }
}
/** L'agent affiché, noté pour sauverPile. */
export function noterAgent(id: string | null) { agentCourant = id; }
function lireReprise(): { stack: Route[]; agent: string | null } | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PILE) ?? "null") as { at: number; stack: Route[]; agent?: string | null } | null;
    sessionStorage.removeItem(PILE);
    if (saved && Date.now() - saved.at < 120_000 && Array.isArray(saved.stack) && saved.stack.length && saved.stack.every((r) => typeof r?.kind === "string")) return { stack: saved.stack, agent: typeof saved.agent === "string" ? saved.agent : null };
  } catch { /* illisible : l'accueil */ }
  return null;
}
reprise = lireReprise();
/** L'agent que le rechargement vient de quitter (une fois), ou null. */
export const agentRepris = (): string | null => reprise?.agent ?? null;
/** Vrai si cette page reprend l'endroit où le rechargement l'a laissée : l'écran ne se referme pas quand l'agent arrive. */
export const repriseEnCours = (): boolean => reprise !== null;
export function finirReprise() { reprise = null; }
export function useNavigation() {
  const [state, set] = useState<Navigation>(() => (reprise ? { stack: reprise.stack } : initialNavigation));
  courante = state.stack;
  const dispatch = useCallback((action: NavigationAction) => set((s) => navigate(s, action)), []);
  return { ...state, dispatch };
}
