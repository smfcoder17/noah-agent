import { useEffect, useState } from "react";
import { currentAuthEpoch, get, send } from "./api";
import { subscribeUpdates } from "./events";

export const TAB_NAMES = { chat: "Discussion", activity: "Activité", tasks: "Tâches", files: "Fichiers", computer: "Ordinateur", connections: "Connexions", competences: "Compétences", memory: "Mémoire" } as const;
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
    let live = true;
    const load = async () => { const epoch = currentAuthEpoch(); try { const p = await get<{ tabs: unknown }>("/api/me/interface"); if (live && epoch === currentAuthEpoch()) { setTabs(validTabs(p.tabs)); setError(""); } } catch { if (live) setError("Ordre indisponible. Réessayer."); } };
    const reset = () => { setTabs([...DEFAULT_TABS]); void load(); };
    window.addEventListener("noah:auth-epoch", reset);
    void load(); const stop = subscribeUpdates(load);
    return () => { live = false; stop(); window.removeEventListener("noah:auth-epoch", reset); };
  }, []);
  const save = async (next: NavTab[]) => {
    const epoch = currentAuthEpoch();
    try { const p = await send<{ tabs: unknown }>("/api/me/interface", { tabs: validTabs(next) }, "PUT"); if (epoch === currentAuthEpoch()) { setTabs(validTabs(p.tabs)); setError(""); } return true; }
    catch { setError("Ordre non enregistré. Réessaie."); return false; }
  };
  return { tabs, save, error };
}
