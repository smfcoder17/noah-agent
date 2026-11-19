import { useEffect, useState } from "react";
import { currentAuthEpoch } from "./api";
import { ecrirePrefs, relirePrefs, suivrePrefs } from "./interfacePrefs";
import { t } from "@/i18n";

export const TAB_NAMES = { chat: t("Discussion"), activity: t("Activité"), tasks: t("Tâches"), files: t("Fichiers"), computer: t("Ordinateur"), connections: t("Connexions"), competences: t("Compétences"), memory: t("Mémoire") } as const;
export type NavTab = keyof typeof TAB_NAMES;
export const DEFAULT_TABS: NavTab[] = ["chat", "activity", "tasks", "files", "computer"];
export function validTabs(raw: unknown): NavTab[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TABS];
  const tabs = [...new Set(raw.filter((t): t is NavTab => typeof t === "string" && Object.prototype.hasOwnProperty.call(TAB_NAMES, t)))];
  return tabs.includes("chat") ? tabs : ["chat", ...tabs];
}
export function moveTab(tabs: NavTab[], from: number, to: number): NavTab[] {
  const next = [...tabs];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [tab] = next.splice(from, 1); next.splice(to, 0, tab); return next;
}
export function useNavPrefs() {
  const [tabs, setTabs] = useState<NavTab[]>(DEFAULT_TABS);
  const [error, setError] = useState("");
  useEffect(() => {
    // Lue par le lecteur partagé (lib/interfacePrefs.ts), avec le thème et la taille du texte : une seule lecture pour les deux.
    const reset = () => { setTabs([...DEFAULT_TABS]); void relirePrefs(); };
    window.addEventListener("noah:auth-epoch", reset);
    const stop = suivrePrefs((p) => { setTabs(validTabs(p.tabs)); setError(""); }, () => setError(t("Ordre indisponible. Réessayer.")));
    return () => { stop(); window.removeEventListener("noah:auth-epoch", reset); };
  }, []);
  const save = async (next: NavTab[]) => {
    const epoch = currentAuthEpoch();
    try { const p = await ecrirePrefs({ tabs: validTabs(next) }); if (epoch === currentAuthEpoch()) { setTabs(validTabs(p.tabs)); setError(""); } return true; }
    catch { setError(t("Ordre non enregistré. Réessaie.")); return false; }
  };
  return { tabs, save, error };
}
