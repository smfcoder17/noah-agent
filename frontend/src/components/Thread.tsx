import { memo } from "react";
// Fil de discussion construit sur les primitives d'assistant-ui.
import {
  ComposerPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { WhileBusyContext, AgentContext } from "@/lib/agentContext";
import { usePanelEnd } from "@/lib/chatMood";
import { get, mediaUrl, rawFileUrl } from "@/lib/api";
import { linkMessage, plainWidgets } from "@/lib/chatMedia";
import { useQuotes } from "@/lib/quotes";
import { ConversationRail } from "./ConversationRail";
import { giveFilesEvent } from "./Files";
import { NoahTile, type NoahHandle } from "./Noah";
import { VoiceMode } from "./Voice";
import { demandesFor, usePresets } from "@/lib/presets";
import { returnMoment } from "@/lib/retour";
import { t } from "@/i18n";
import { LiveStatus } from "./thread/parts";
import { OlderMessages, UserMessage, SelectionReply, AssistantMessage } from "./thread/messages";
import { Composer } from "./thread/Composer";


export { AgentContext };







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
function ReturnCards({ agentId }: { agentId: string }) {
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
  const [routines, setRoutines] = useState<string[]>([]);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setHidden(false);
    get<{ routines: { name: string | null; enabled: boolean }[] }>(`/api/agents/${agentId}/routines`)
      .then((r) => setRoutines(r.routines.filter((x) => x.enabled && x.name).map((x) => x.name as string)))
      .catch(() => setRoutines([]));
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

function EmptyNoah() {
  const { agentColor, agentShape, agentDetail } = useContext(AgentContext);
  const face = useRef<NoahHandle>(null);
  // Une conversation vide : l'agent salue d'un petit bond.
  useEffect(() => {
    face.current?.react("greet");
  }, []);
  return <NoahTile handle={face} color={agentColor} shape={agentShape} detail={agentDetail} className="mb-2 size-20" />;
}

export const Thread = memo(function Thread({ report, onReportRead, onCall }: { report: { id: string; text: string } | null; onReportRead: () => void; onCall: (on: boolean) => void }) {
  const { agentId, agentName, hint, readOnly } = useContext(AgentContext);
  const [voice, setVoice] = useState(false);
  // Des fichiers choisis dans le panneau : joints au prochain message, comme un passage cité.
  const { add: addQuote } = useQuotes();
  const threadRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const give = (e: Event) => {
      const { agentId: to, label, text } = (e as CustomEvent<{ agentId: string; label: string; text: string }>).detail;
      // Un fil caché (un appel en cours ailleurs) reste monté : seul celui qu'on voit reçoit le don.
      if (to !== agentId || !threadRoot.current?.getClientRects().length) return;
      addQuote({ label, text });
      threadRoot.current.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
    };
    window.addEventListener(giveFilesEvent, give);
    return () => window.removeEventListener(giveFilesEvent, give);
  }, [addQuote, agentId]);
  // Pour l'appel : un aperçu intégré compte aussi comme un artefact à ouvrir.
  const link = useCallback(
    (text: string) =>
      plainWidgets(linkMessage(text, { fileUrl: (path) => rawFileUrl(agentId, path) }), (path) => rawFileUrl(agentId, path), (path) => mediaUrl(agentId, path)),
    [agentId],
  );
  // Rappel pris : le mode vocal s'ouvre et lit le compte rendu.
  const reportId = report?.id;
  useEffect(() => {
    if (reportId) setVoice(true);
  }, [reportId]);
  useEffect(() => {
    onCall(voice); // l'application garde cette conversation ouverte tant que l'appel dure
  }, [voice, onCall]);
  return (
    <ThreadPrimitive.Root ref={threadRoot} data-noah-thread className="relative flex h-full min-h-0 flex-col">
      <ConversationRail />
      <SelectionReply />
      <ComposerPrimitive.AttachmentDropzone className="flex min-h-0 flex-1 flex-col data-[dragging=true]:bg-accent-soft/40">
        <ThreadPrimitive.Viewport data-noah-viewport data-chat-scroll className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 [container-type:inline-size]">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col pt-6">
            <OlderMessages />
            <ThreadPrimitive.Empty>
              <div className="m-auto flex max-w-md flex-col items-center gap-2 text-center">
                <EmptyNoah />
                <p className="text-xl font-semibold">{t("Que doit faire {nom} ?", { nom: agentName })}</p>
                <p className="text-sm text-muted-foreground">{hint}</p>
                {!readOnly && <EmptySuggestions agentId={agentId} />}
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </div>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto flex w-full max-w-3xl flex-col items-center gap-2 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-[max(16px,env(safe-area-inset-bottom))]">
            {readOnly ? (
              <p className="w-full rounded-2xl border border-border bg-surface p-3 text-center text-sm text-muted-foreground">{t("Tu peux lire ici, pas écrire.")}</p>
            ) : (
              <>
                {voice && <VoiceMode onClose={() => setVoice(false)} report={report} onReportRead={onReportRead} link={link} />}
                {!voice && <ReturnCards agentId={agentId} />}
                <Composer onVoiceMode={() => setVoice(true)} inCall={voice} />
              </>
            )}
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ComposerPrimitive.AttachmentDropzone>
    </ThreadPrimitive.Root>
  );
});
