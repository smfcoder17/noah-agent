import { lazy, memo, Suspense } from "react";
// Fil de discussion construit sur les primitives d'assistant-ui.
import {
  ComposerPrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AgentContext, HistoryContext } from "@/lib/agentContext";
import { mediaUrl, rawFileUrl } from "@/lib/api";
import { linkMessage, plainWidgets } from "@/lib/chatMedia";
import { useQuotes } from "@/lib/quotes";
import { MODE_VOCAL } from "@/lib/workPanel";
import { ConversationRail } from "./ConversationRail";
import { giveFilesEvent } from "./Files";
// Le mode vocal se charge au moment où la personne le lance (budget B2, 0.4.0).
const VoiceMode = lazy(() => import("./VoiceMode").then((m) => ({ default: m.VoiceMode })));
import { t } from "@/i18n";
import { CarteSansConsigne, OlderMessages, UserMessage, SelectionReply, AssistantMessage } from "./thread/messages";
import { Composer } from "./thread/Composer";
import { EmptyNoah, OssatureFil } from "./thread/panneaux";

export { AgentContext };

export const Thread = memo(function Thread({ report, onReportRead, onCall }: { report: { id: string; text: string } | null; onReportRead: () => void; onCall: (on: boolean) => void }) {
  const { agentId, agentName, hint, readOnly } = useContext(AgentContext);
  const [voice, setVoice] = useState(false);
  const { skeleton } = useContext(HistoryContext);
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
  useEffect(() => {
    const call = () => { if (threadRoot.current?.getClientRects().length && !readOnly) setVoice(true); };
    window.addEventListener(MODE_VOCAL, call);
    return () => window.removeEventListener(MODE_VOCAL, call);
  }, [readOnly]);
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
        <ThreadPrimitive.Viewport data-noah-viewport data-chat-scroll className="scroll-fil flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden [container-type:inline-size]">
          <div className="col thread flex-1">
            <OlderMessages />
            <ThreadPrimitive.Empty>
              {skeleton ? <OssatureFil /> : (
              <div className="m-auto flex max-w-md flex-col items-center gap-2 text-center">
                <EmptyNoah />
                <p className="text-xl font-semibold">{t("Que doit faire {nom} ?", { nom: agentName })}</p>
                <p className="text-sm text-muted-foreground">{hint}</p>
              </div>
              )}
            </ThreadPrimitive.Empty>
            <CarteSansConsigne />
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </div>
        </ThreadPrimitive.Viewport>
        {/* La saisie est sous le fil, jamais posée dessus : rien de ce qu'elle porte (demandes à toucher, mode vocal) ne cache un message. */}
        <div className="composer-zone">
          <div className="composer-wrap">
            {readOnly ? (
              <p className="rounded-2xl border border-border bg-surface p-3 text-center text-sm text-muted-foreground">{t("Tu peux lire ici, pas écrire.")}</p>
            ) : (
              <>
                {voice && <Suspense fallback={null}><VoiceMode onClose={() => setVoice(false)} report={report} onReportRead={onReportRead} link={link} /></Suspense>}
                <Composer inCall={voice} />
              </>
            )}
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ThreadPrimitive.Root>
  );
});
