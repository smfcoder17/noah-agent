import { useCallback, useEffect, useState } from "react";
import { Activity, CheckSquare, FolderOpen, Layers, Monitor } from "lucide-react";
import type { PanelTab } from "@/components/SidePanel";
import { type Agent, canAdmin, canTalk } from "./api";
import { t } from "@/i18n";

/** Les icônes du haut de la conversation, dans l'ordre : chacune ouvre son contenu dans le panneau de droite. */
export const WORK_TABS = [
  { tab: "activity", label: t("Activité"), Icon: Activity },
  { tab: "routines", label: t("Tâches"), Icon: CheckSquare },
  { tab: "files", label: t("Fichiers"), Icon: FolderOpen },
  { tab: "computer", label: t("Ordinateur"), Icon: Monitor },
  { tab: "session", label: t("Session"), Icon: Layers },
] as const satisfies readonly { tab: PanelTab; label: string; Icon: typeof Activity }[];

/** Ce que ce profil peut ouvrir : l'activité et la session pour tous, l'ordinateur et les fichiers pour qui parle à l'agent, les tâches pour qui l'administre. */
export function workTabsFor(agent: Agent | null) {
  if (!agent) return [];
  return WORK_TABS.filter(({ tab }) => tab === "routines" ? canAdmin(agent) : tab === "files" || tab === "computer" ? canTalk(agent) : true);
}

export const PANEL_NAMES: Record<PanelTab, string> = {
  activity: t("Activité"), routines: t("Tâches"), files: t("Fichiers"), computer: t("Ordinateur"), session: t("Session"),
  connections: t("Connexions"), competences: t("Compétences"), memory: t("Mémoire"),
};

const WIDE = "(min-width:768px)";
/** Ordinateur ou téléphone : le panneau s'ouvre à côté de la conversation, ou en feuille plein écran. */
export function useWide() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const media = matchMedia(WIDE);
    const change = () => setWide(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return wide;
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* stockage bloqué : le choix vaut pour cette visite */ }
}

export const RAIL_KEY = "noah:barre-repliee";
/** La barre de gauche repliée en icônes : retenue d'une visite à l'autre, sur cet appareil. */
export function useRailFolded() {
  const [folded, setFolded] = useState(() => read(RAIL_KEY) === "1");
  const change = useCallback((next: boolean) => { setFolded(next); write(RAIL_KEY, next ? "1" : "0"); }, []);
  return [folded, change] as const;
}

export const PANEL_MIN = 320;
/** Largeur d'origine : l'ordinateur un peu plus large, pour que son écran se lise. */
export const panelDefault = (tab: PanelTab) => (tab === "computer" ? 680 : 420);
const widthKey = (tab: PanelTab) => (tab === "computer" ? "noah:panneau-ordinateur" : "noah:panneau");
/** La conversation garde toujours de quoi se lire à côté du panneau. */
export const panelMax = () => Math.max(PANEL_MIN, window.innerWidth - 560);
export const clampWidth = (w: number) => Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, w)));

/** Largeur du panneau, réglée en tirant son bord ou au clavier, retenue par sorte (ordinateur à part). */
export function usePanelWidth(tab: PanelTab) {
  const stored = () => { const n = Number(read(widthKey(tab))); return clampWidth(n > 0 ? n : panelDefault(tab)); };
  const [width, setWidth] = useState(stored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setWidth(stored()), [tab]);
  const change = useCallback((w: number) => { const next = clampWidth(w); setWidth(next); write(widthKey(tab), String(next)); }, [tab]);
  return [width, change] as const;
}
