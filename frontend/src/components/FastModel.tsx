// Réglages > Modèles et budget > Cerveau : le modèle rapide, celui qui dit le premier mot le plus vite chez ce fournisseur.
// Il répond pendant que l'agent travaille, propose les réponses à toucher et résume en une phrase ; jamais il n'agit.
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { Button, ErrorText } from "./ui";
import { t } from "@/i18n";

type FastState = { modele: string; ms: number | null; en_cours: boolean; mesure: boolean };

/** « vif-small, premier mot en 420 ms », ou ce qui manque. */
export function fastLine(s: FastState) {
  if (s.en_cours) return t("Mesure en cours…");
  if (!s.mesure) return t("Pas encore mesuré.");
  if (!s.modele) return t("Aucun modèle léger n'a répondu juste : Noah garde son modèle de secours.");
  return s.ms === null ? s.modele : t("{modele}, premier mot en {ms} ms", { modele: s.modele, ms: s.ms });
}

export function FastModel() {
  const [state, setState] = useState<FastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => get<FastState>("/api/modele-rapide").then(setState).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const measure = async () => {
    setBusy(true);
    setError("");
    try {
      setState(await send<FastState>("/api/modele-rapide/mesurer", {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("Modèle rapide")} className="flex flex-col gap-2 rounded-2xl border border-border p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium">{t("Modèle rapide")}</p>
          <p className="text-muted-foreground">{state ? fastLine(state) : "…"}</p>
        </div>
        <Button variant="outline" size="sm" disabled={busy || state?.en_cours} onClick={measure}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {t("Remesurer")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("Il te répond pendant que l'agent travaille et propose les réponses à toucher. Il n'agit jamais.")}</p>
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
