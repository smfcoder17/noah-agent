import { useAui, useAuiState } from "@assistant-ui/react";
import { useContext, useEffect, useRef, useState } from "react";
import { WhileBusyContext, AgentContext } from "@/lib/agentContext";
import { usePanelEnd } from "@/lib/chatMood";
import { useOuverture } from "@/lib/ouverture";
import { NoahTile, type NoahHandle } from "../Noah";
import { demandesFor, usePresets } from "@/lib/presets";
import { returnMoment } from "@/lib/retour";
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

/** Au retour : 3 ou 4 demandes à toucher, au-dessus de la saisie. Un toucher remplit la saisie, rien ne part seul. */
export function ReturnCards({ agentId }: { agentId: string }) {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const empty = useAuiState((s) => s.composer.isEmpty);
  const lastUser = useAuiState((s) => {
    for (let i = s.thread.messages.length - 1; i >= 0; i--) if (s.thread.messages[i].role === "user") return s.thread.messages[i].createdAt?.getTime() ?? null;
    return null;
  });
  const lastAgent = useAuiState((s) => {
    const m = s.thread.messages[s.thread.messages.length - 1];
    return m?.role === "assistant" ? m.createdAt?.getTime() ?? null : null;
  });
  // Les routines actives viennent de l'ouverture de l'agent (lib/ouverture.ts), sans question à sa machine.
  const routines = (useOuverture(agentId)?.routines.actives ?? []).map((r) => r.nom);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setHidden(false);
  }, [agentId]);
  const moment = returnMoment(lastUser, lastAgent, Date.now());
  if (!moment || running || !empty || hidden) return null;
  const cards = [
    moment === "hier" ? t("Montre-moi tout ce que tu as fait depuis hier") : t("Montre-moi ce que tu as fait depuis mon dernier message"),
    ...routines.slice(0, 2).map((name) => t("Lance « {nom} » maintenant", { nom: name })),
    t("Qu'est-ce qui attend ma réponse ?"),
    t("Que me proposes-tu pour la suite ?"),
  ].slice(0, 4);
  return (
    <div data-return-cards className="flex w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:none] max-md:-mx-1 max-md:px-1 md:grid md:grid-cols-2">
      {cards.map((d) => (
        <button key={d} type="button" onClick={() => { aui.thread().composer().setText(d); setHidden(true); }}
          className="min-h-11 shrink-0 cursor-pointer rounded-xl border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-muted max-md:max-w-[70%]">
          {d}
        </button>
      ))}
    </div>
  );
}

/** Écran vide : 4 demandes à toucher, celles du modèle de l'agent ou des générales. Un toucher remplit la saisie, rien ne part seul. */
export function EmptySuggestions({ agentId }: { agentId: string }) {
  const aui = useAui();
  const demandes = demandesFor(usePresets(), agentId);
  if (!demandes.length) return null;
  return (
    <div className="mt-3 grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
      {demandes.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => aui.thread().composer().setText(d)}
          className="min-h-11 cursor-pointer rounded-xl border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
        >
          {d}
        </button>
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
