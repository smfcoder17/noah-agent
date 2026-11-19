import { Check, Hand, MonitorPlay, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { send } from "@/lib/api";
import { useOuverture } from "@/lib/ouverture";
import { t } from "@/i18n";

/**
 * L'agent a besoin de l'utilisateur (connexion, code, accord) : bandeau au-dessus de la conversation, et l'écran de
 * l'agent s'ouvre une fois par appel. L'agent attend la réponse au lieu de finir son tour.
 */
export function HandoffBanner({ agentId, onOpenScreen }: { agentId: string; onOpenScreen: () => void }) {
  // L'appel vient de l'ouverture de l'agent (lib/ouverture.ts) : lue à l'ouverture et relue à chaque événement, par un seul lecteur.
  const asked = useOuverture(agentId)?.appel ?? null;
  const [answered, setAnswered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opened = useRef<string | null>(null);
  const openScreen = useRef(onOpenScreen);
  openScreen.current = onOpenScreen;
  const call = asked && asked.id !== answered ? asked : null;

  // L'écran de l'agent s'ouvre une fois par appel.
  const askedId = asked?.id;
  useEffect(() => {
    if (askedId && opened.current !== askedId) {
      opened.current = askedId;
      openScreen.current();
    }
  }, [askedId]);

  if (!call) return null;
  const answer = async (reponse: "fait" | "impossible") => {
    setBusy(true);
    try {
      await send(`/api/agents/${agentId}/appel/${call.id}`, { reponse });
      setAnswered(call.id);
    } catch {
      setAnswered(call.id); // déjà terminé
    } finally {
      setBusy(false);
    }
  };
  // Noah Agent voit lui-même quand l'accord est donné : pas de « C'est fait » pour ses propres appels.
  const self = call.origine !== "agent";
  return (
    <div role="alert" className="mx-3 mt-2 flex flex-col gap-2 rounded-xl border-2 border-accent bg-accent-soft p-3 sm:flex-row sm:items-center">
      <Hand className="hidden size-5 shrink-0 text-accent sm:block" />
      <p className="min-w-0 flex-1 text-sm"><b>{self ? t("À toi : ") : t("L'agent a besoin de toi : ")}</b>{call.message}</p>
      <div className="flex shrink-0 gap-1.5">
        <Button size="sm" variant="outline" onClick={onOpenScreen}><MonitorPlay />{t("Voir l'écran")}</Button>
        {!self && <Button size="sm" onClick={() => answer("fait")} disabled={busy}><Check />{t("C'est fait")}</Button>}
        <Button size="sm" variant="ghost" onClick={() => answer("impossible")} disabled={busy} aria-label={self ? t("Annuler") : t("Je ne peux pas")} title={self ? t("Annuler") : t("Je ne peux pas")}><X /></Button>
      </div>
    </div>
  );
}
