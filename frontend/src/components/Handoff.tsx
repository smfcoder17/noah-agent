import { subscribeUpdates } from "@/lib/events";
import { Check, Hand, MonitorPlay, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { get, send } from "@/lib/api";

type Call = { id: string; message: string; depuis: number; origine: string };

/**
 * L'agent a besoin de l'utilisateur (connexion, code, accord) : bandeau au-dessus de la conversation, et l'écran de
 * l'agent s'ouvre une fois par appel. L'agent attend la réponse au lieu de finir son tour.
 */
export function HandoffBanner({ agentId, onOpenScreen }: { agentId: string; onOpenScreen: () => void }) {
  const [call, setCall] = useState<Call | null>(null);
  const [busy, setBusy] = useState(false);
  const opened = useRef<string | null>(null);
  const openScreen = useRef(onOpenScreen);
  openScreen.current = onOpenScreen;

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      const r = await get<{ appel: Call | null }>(`/api/agents/${agentId}/appel`).catch(() => null);
      if (!alive || !r) return;
      setCall((cur) => (cur?.id === r.appel?.id ? cur : r.appel));
      if (r.appel && opened.current !== r.appel.id) {
        opened.current = r.appel.id;
        openScreen.current();
      }
    };
    poll();
    const t = subscribeUpdates(poll);
    document.addEventListener("visibilitychange", poll);
    return () => {
      alive = false;
      t();
      document.removeEventListener("visibilitychange", poll);
    };
  }, [agentId]);

  if (!call) return null;
  const answer = async (reponse: "fait" | "impossible") => {
    setBusy(true);
    try {
      await send(`/api/agents/${agentId}/appel/${call.id}`, { reponse });
      setCall(null);
    } catch {
      setCall(null); // déjà terminé
    } finally {
      setBusy(false);
    }
  };
  // Noah Agent voit lui-même quand l'accord est donné : pas de « C'est fait » pour ses propres appels.
  const self = call.origine !== "agent";
  return (
    <div role="alert" className="mx-3 mt-2 flex flex-col gap-2 rounded-xl border-2 border-accent bg-accent-soft p-3 sm:flex-row sm:items-center">
      <Hand className="hidden size-5 shrink-0 text-accent sm:block" />
      <p className="min-w-0 flex-1 text-sm"><b>{self ? "À toi : " : "L'agent a besoin de toi : "}</b>{call.message}</p>
      <div className="flex shrink-0 gap-1.5">
        <Button size="sm" variant="outline" onClick={onOpenScreen}><MonitorPlay />Voir l'écran</Button>
        {!self && <Button size="sm" onClick={() => answer("fait")} disabled={busy}><Check />C'est fait</Button>}
        <Button size="sm" variant="ghost" onClick={() => answer("impossible")} disabled={busy} aria-label={self ? "Annuler" : "Je ne peux pas"} title={self ? "Annuler" : "Je ne peux pas"}><X /></Button>
      </div>
    </div>
  );
}
