import { memo } from "react";
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
import { ConversationRail } from "./ConversationRail";
import { giveFilesEvent } from "./Files";
import { VoiceMode } from "./Voice";
import { t } from "@/i18n";
import { OlderMessages, UserMessage, SelectionReply, AssistantMessage } from "./thread/messages";
import { Composer } from "./thread/Composer";
import { ReturnCards, EmptySuggestions, EmptyNoah, OssatureFil } from "./thread/panneaux";

export { AgentContext, EmptySuggestions };

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
              {skeleton ? <OssatureFil /> : (
              <div className="m-auto flex max-w-md flex-col items-center gap-2 text-center">
                <EmptyNoah />
                <p className="text-xl font-semibold">{t("Que doit faire {nom} ?", { nom: agentName })}</p>
                <p className="text-sm text-muted-foreground">{hint}</p>
                {!readOnly && <EmptySuggestions agentId={agentId} />}
              </div>
              )}
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
