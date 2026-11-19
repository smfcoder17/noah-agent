import { useContext, useEffect, useRef } from "react";
import { WhileBusyContext, AgentContext } from "@/lib/agentContext";
import { usePanelEnd } from "@/lib/chatMood";
import { NoahTile, type NoahHandle } from "../Noah";
import { t } from "@/i18n";
import { LiveStatus } from "./parts";

/** Au-dessus de la saisie : ce que fait un travail lancé ailleurs, et les demandes qui attendent leur tour. */
export function WhileBusyPanel() {
  const busy = useContext(WhileBusyContext);
  const { agentColor, agentShape, agentDetail } = useContext(AgentContext);
  usePanelEnd(!!busy.activity);
  if (!busy.activity && !busy.waiting.length && !busy.sending.length) return null;
  return (
    <div className="mb-2 flex w-full flex-col gap-1 text-xs text-muted-foreground">
      {busy.activity && <div className="px-1"><LiveStatus face={<NoahTile color={agentColor} shape={agentShape} detail={agentDetail} state="working" className="size-11" />} label={`${busy.activity}…`} working /></div>}
      {busy.sending.map((item) => (
        <div key={item.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5">
          <span className="shrink-0">{item.late ? t("Réception à vérifier") : t("Envoi")}</span>
          <span className="min-w-0 flex-1 truncate">{item.text}</span>
          {item.late && (
            <button type="button" className="shrink-0 underline underline-offset-2 hover:text-foreground" onClick={() => busy.giveUp(item.id)}>
              {t("Abandonner")}
            </button>
          )}
        </div>
      ))}
      {busy.waiting.map((item) => (
        <div key={item.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1">
          <span className="shrink-0">{t("À la suite")}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{item.text}</span>
          {busy.active && (
            <button type="button" className="shrink-0 underline underline-offset-2 hover:text-foreground" onClick={() => void busy.now(item.id).catch(() => {})}>
              {t("Maintenant")}
            </button>
          )}
          <button type="button" className="shrink-0 underline underline-offset-2 hover:text-foreground" onClick={() => busy.cancel(item.id)}>
            {t("Retirer")}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Le fil qui se charge, sans rien en mémoire : des bulles grises à la place des messages, jamais l'écran vide « Que doit faire X ? ». */
export function OssatureFil() {
  return (
    <div role="status" aria-busy="true" aria-label={t("Chargement de la conversation…")} data-ossature className="flex w-full flex-1 flex-col gap-4">
      <div className="ml-auto h-10 w-2/5 animate-pulse rounded-2xl bg-muted/60" />
      <div className="h-20 w-3/4 animate-pulse rounded-2xl bg-muted/60" />
      <div className="ml-auto h-10 w-1/3 animate-pulse rounded-2xl bg-muted/60" />
      <div className="h-28 w-4/5 animate-pulse rounded-2xl bg-muted/60" />
    </div>
  );
}

export function EmptyNoah() {
  const { agentColor, agentShape, agentDetail } = useContext(AgentContext);
  const face = useRef<NoahHandle>(null);
  // Une conversation vide : l'agent salue d'un petit bond.
  useEffect(() => {
    face.current?.react("greet");
  }, []);
  return <NoahTile handle={face} color={agentColor} shape={agentShape} detail={agentDetail} className="mb-2 size-20" />;
}
