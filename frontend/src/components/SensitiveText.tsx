import { Children, createContext, useContext, useEffect, useState } from "react";
import { currentAuthEpoch, get, send } from "@/lib/api";
import { subscribeUpdates } from "@/lib/events";
import { sensitiveParts } from "@/lib/sensitive";

type Preferences = { masquer_sensibles: boolean; theme: "light" | "dark" | "system"; texte: "petit" | "normal" | "grand" };
const DEFAULT: Preferences = { masquer_sensibles: true, theme: "system", texte: "normal" };
const Privacy = createContext({ preferences: DEFAULT, error: "", save: async (_patch: Partial<Preferences>) => {} });
export const SensitiveContext = createContext(true);
export const usePrivacy = () => useContext(Privacy);
export function SensitiveProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState(DEFAULT), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => { const epoch = currentAuthEpoch(); try { const p = await get<Preferences>("/api/me/interface"); if (active && epoch === currentAuthEpoch()) setPreferences(p); } catch { /* défaut protecteur hors connexion */ } };
    const reset = () => { setPreferences(DEFAULT); void load(); };
    window.addEventListener("noah:auth-epoch", reset); void load(); const stop = subscribeUpdates(load);
    return () => { active = false; stop(); window.removeEventListener("noah:auth-epoch", reset); };
  }, []);
  useEffect(() => { if (preferences.theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = preferences.theme; document.documentElement.dataset.texte = preferences.texte; }, [preferences]);
  const save = async (patch: Partial<Preferences>) => { const epoch = currentAuthEpoch(); try { const p = await send<Preferences>("/api/me/interface", patch, "PUT"); if (epoch === currentAuthEpoch()) { setPreferences(p); setError(""); } } catch { setError("Réglage non enregistré. Réessaie."); } };
  return <Privacy.Provider value={{ preferences, save, error }}><SensitiveContext.Provider value={preferences.masquer_sensibles}>{children}</SensitiveContext.Provider></Privacy.Provider>;
}
function Secret({ value, masked }: { value: string; masked: string }) {
  const [shown, reveal] = useState(false);
  useEffect(() => { const reset = () => reveal(false); window.addEventListener("noah:auth-epoch", reset); return () => window.removeEventListener("noah:auth-epoch", reset); }, []);
  return <span className="sensitive-value" onCopy={(e) => { if (!shown) e.preventDefault(); }}><button type="button" className={`sensitive-token ${shown ? "shown" : ""}`} aria-label={shown ? "Recacher la donnée" : "Révéler la donnée"} aria-pressed={shown} onClick={(e) => { e.stopPropagation(); reveal(!shown); }}>{shown ? value : masked}</button>{shown && <button className="sensitive-copy" aria-label="Copier la donnée révélée" onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(value); }}>Copier</button>}</span>;
}
export function SensitiveText({ text }: { text: string }) {
  const enabled = useContext(SensitiveContext);
  return !enabled ? <>{text}</> : <>{sensitiveParts(text).map((p, i) => p.sensitive ? <Secret key={`${i}:${p.value}`} value={p.value} masked={p.masked} /> : p.value)}</>;
}
export const sensitiveChildren = (children: React.ReactNode) => Children.map(children, (child) => typeof child === "string" ? <SensitiveText text={child} /> : child);
