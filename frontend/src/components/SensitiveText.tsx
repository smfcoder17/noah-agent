import { Children, cloneElement, isValidElement, createContext, useContext, useEffect, useState } from "react";
import { currentAuthEpoch, get, send } from "@/lib/api";
import { subscribeUpdates } from "@/lib/events";
import { sensitiveParts } from "@/lib/sensitive";
import { t } from "@/i18n";

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
  const save = async (patch: Partial<Preferences>) => { const epoch = currentAuthEpoch(); try { const p = await send<Preferences>("/api/me/interface", patch, "PUT"); if (epoch === currentAuthEpoch()) { setPreferences(p); setError(""); } } catch { setError(t("Réglage non enregistré. Réessaie.")); } };
  return <Privacy.Provider value={{ preferences, save, error }}><SensitiveContext.Provider value={preferences.masquer_sensibles}>{children}</SensitiveContext.Provider></Privacy.Provider>;
}
function Secret({ value, masked }: { value: string; masked: string }) {
  const [shown, reveal] = useState(false);
  useEffect(() => { const reset = () => reveal(false); window.addEventListener("noah:auth-epoch", reset); return () => window.removeEventListener("noah:auth-epoch", reset); }, []);
  return <span className="sensitive-value" onCopy={(e) => { if (!shown) e.preventDefault(); }}><button type="button" className={`sensitive-token ${shown ? "shown" : ""}`} aria-label={shown ? t("Recacher la donnée") : t("Révéler la donnée")} aria-pressed={shown} onClick={(e) => { e.stopPropagation(); reveal(!shown); }}>{shown ? value : masked}</button>{shown && <button className="sensitive-copy" aria-label={t("Copier la donnée révélée")} onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(value); }}>{t("Copier")}</button>}</span>;
}
export function SensitiveText({ text }: { text: string }) {
  const enabled = useContext(SensitiveContext);
  return !enabled ? <>{text}</> : <>{sensitiveParts(text).map((p, i) => p.sensitive ? <Secret key={`${i}:${p.value}`} value={p.value} masked={p.masked} /> : p.value)}</>;
}
/** Un lien automatique mailto: peut contenir lui-même la donnée masquée. */
export function SensitiveLink({ href, children, title, ...props }: React.ComponentProps<"a">) {
  const hidden = useContext(SensitiveContext);
  const [shown, reveal] = useState<string | null>(null);
  const secret = hidden && sensitiveParts(href || "").some((p) => p.sensitive);
  const safeTitle = hidden && title ? sensitiveParts(title).map((p) => p.masked).join("") : title;
  if (secret && shown !== href) return <span>{sensitiveChildren(children)}<button type="button" className="sensitive-copy" onClick={() => reveal(href || "")}>{t("Révéler le lien")}</button></span>;
  return <><a {...props} href={href} title={safeTitle}>{sensitiveChildren(children)}</a>{secret && <button type="button" className="sensitive-copy" onClick={() => reveal(null)}>{t("Recacher le lien")}</button>}</>;
}
export const sensitiveChildren = (children: React.ReactNode): React.ReactNode => Children.map(children, (child) => {
  if (typeof child === "string") return <SensitiveText text={child} />;
  if (!isValidElement<{ children?: React.ReactNode }>(child) || child.type === SensitiveText) return child;
  return child.props.children === undefined ? child : cloneElement(child, { children: sensitiveChildren(child.props.children) });
});
