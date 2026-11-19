import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { ChevronRight } from "lucide-react";
import { useContext, useId, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import type { TaskState, TraceDetail } from "@/lib/api";
import type { TacheDuFil } from "@/lib/ouverture";
import { cn } from "@/lib/utils";
import { StateShape } from "../Sidebar";
import { t } from "@/i18n";

// Une tâche dans le fil (0.4.0) : une ligne repliée (qui, quoi, état) qu'on déplie sur place, et dans laquelle on entre. C'est la même
// ligne dans le fil et dans l'onglet Tâches d'Activité : les deux lisent la même tâche (`GET /api/taches`, `ouverture.fil.taches`).
// Elle remplace la ligne de trace (TraceLine) : la trace d'un fil sans tâche connue se lit encore, par `TraceOutil`.

const FORME: Record<TacheDuFil["etat"], TaskState> = { encours: "work", attend: "approve", fini: "done", echec: "error" };

export const etatDit = (etat: TacheDuFil["etat"]): string => ({ encours: t("en cours"), attend: t("attend ta réponse"), fini: t("terminée"), echec: t("a échoué") })[etat];

/** L'adresse d'une tâche : son fil, que l'application ouvre (même adresse que les notifications). */
export const adresseDe = (agentId: string, conversationId: string) => `#agent=${agentId}&conversation=${conversationId}`;

export function TacheLigne({ tache, agentId, agentName, defaultOpen = false, onOpen }: {
  tache: TacheDuFil;
  agentId: string;
  /** Celui qui fait le travail. */
  agentName: string;
  defaultOpen?: boolean;
  /** Entrer dans la tâche, sans passer par l'adresse (l'onglet Tâches). */
  onOpen?: (conversationId: string) => void;
}) {
  const [asked, setAsked] = useState<boolean | null>(null);
  const open = asked ?? (defaultOpen || tache.etat === "attend");
  const id = useId();
  const meta = [agentName, etatDit(tache.etat)].filter(Boolean).join(" · ");
  const entrer = tache.conversation_id ? (
    onOpen ? (
      <button type="button" className="inline-flex w-fit cursor-pointer items-center gap-1 text-[13px] font-medium text-foreground underline-offset-2 hover:underline" onClick={() => onOpen(tache.conversation_id)}>
        {t("Ouvrir la tâche")}<ChevronRight className="size-3.5" aria-hidden />
      </button>
    ) : (
      <a href={adresseDe(agentId, tache.conversation_id)} className="inline-flex w-fit items-center gap-1 text-[13px] font-medium text-foreground underline-offset-2 hover:underline">
        {t("Ouvrir la tâche")}<ChevronRight className="size-3.5" aria-hidden />
      </a>
    )
  ) : null;
  return (
    <div data-tache={tache.id} data-etat={tache.etat} className="my-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        onClick={() => setAsked(!open)}
        className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-muted"
      >
        <StateShape state={FORME[tache.etat]} />
        <span className="flex min-w-0 grow flex-col">
          <span className="truncate text-[14px] font-medium">{tache.titre}</span>
          <span className={cn("truncate text-xs md:hidden", tache.etat === "attend" ? "font-semibold text-warn" : "text-muted-foreground")}>{meta}</span>
        </span>
        <span className={cn("hidden shrink-0 text-xs md:inline", tache.etat === "attend" ? "font-semibold text-warn" : "text-muted-foreground")}>{meta}</span>
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div id={`${id}-detail`} className="mb-1 ml-1 flex flex-col gap-2 border-l-2 border-border py-1 pl-4 text-[14px]">
          {tache.demandeur?.nom && <p className="text-xs text-muted-foreground">{t("Confiée par {nom}", { nom: tache.demandeur.nom })}</p>}
          <p className="whitespace-pre-wrap break-words">{tache.resume || (tache.etat === "encours" ? t("Le travail est en cours.") : tache.etat === "attend" ? t("Le travail attend ta réponse.") : t("Pas de compte rendu."))}</p>
          {entrer}
        </div>
      )}
    </div>
  );
}

/** La ligne d'une tâche, dans le fil : la partie « outil » que `useAgentChat` pose à la place du message de trace. */
export function TacheOutil({ args }: ToolCallMessagePartProps) {
  const { agentId, agentName } = useContext(AgentContext);
  const tache = (args as unknown as { tache: TacheDuFil }).tache;
  return <TacheLigne tache={tache} agentId={agentId} agentName={agentName} />;
}

/** Une trace de fil dont la tâche n'est pas (encore) connue de l'écran : la même ligne, faite de ce que la trace dit. */
export function TraceOutil({ args }: ToolCallMessagePartProps) {
  const { agentId, agentName } = useContext(AgentContext);
  const trace = args as unknown as TraceDetail;
  const tache: TacheDuFil = {
    id: `trace-${trace.fil}`, titre: trace.consigne, genre: "demande", demandeur: null,
    etat: trace.etat === "fini" ? "fini" : trace.etat === "echec" ? "echec" : "encours",
    resume: trace.issue ?? "", fichiers: [], ancre: 0, cree: 0, fini_a: null, conversation_id: trace.fil, question: null,
  };
  return <TacheLigne tache={tache} agentId={agentId} agentName={agentName} />;
}
