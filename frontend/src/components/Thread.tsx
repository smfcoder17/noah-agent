import { memo } from "react";
// Fil de discussion construit sur les primitives d'assistant-ui.
import {
  ComposerPrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowUp, Paperclip, Square, ChevronDown, Plug, Plus } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { WhileBusyContext, AgentContext } from "@/lib/agentContext";
import { usePanelEnd } from "@/lib/chatMood";
import { get, mediaUrl, rawFileUrl } from "@/lib/api";
import { linkMessage, plainWidgets } from "@/lib/chatMedia";
import { useQuotes } from "@/lib/quotes";
import { ConversationRail } from "./ConversationRail";
import { giveFilesEvent } from "./Files";
import { NoahTile, type NoahHandle } from "./Noah";
import { cn } from "@/lib/utils";
import { Button } from "./ui";
import { AttachPosition } from "./PhoneSettings";
import { DictateButton, useDictation, VoiceMode, VoiceModeButton } from "./Voice";
import { readableModel } from "@/lib/modes";
import { demandesFor, usePresets } from "@/lib/presets";
import { returnMoment } from "@/lib/retour";
import { historyStep } from "@/lib/historique";
import { t } from "@/i18n";
import { LiveStatus } from "./thread/parts";
import { AttachmentChip, OlderMessages, UserMessage, useSentHistory, SelectionReply, QuoteChips, AssistantMessage } from "./thread/messages";

// Sur téléphone, le focus ouvrirait le clavier à chaque conversation, et par-dessus un appel.
const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;

export { AgentContext };



/** Le modèle de l'agent sous la saisie : un geste ouvre le choix. Seulement pour qui peut le changer. */
let generalModel: Promise<string> | null = null; // le modèle de tous, lu une fois
function ModelChip() {
  const { agentModel, canWatch, readOnly } = useContext(AgentContext);
  const [general, setGeneral] = useState("");
  useEffect(() => {
    if (agentModel) return;
    generalModel ??= get<{ model?: string } | null>("/api/model").then((m) => readableModel(m?.model ?? "")).catch(() => "");
    generalModel.then(setGeneral);
  }, [agentModel]);
  if (!canWatch || readOnly) return null;
  return (
    <button type="button" data-model-chip onClick={() => window.dispatchEvent(new Event("noah:choisir-modele"))} title={t("Changer de modèle")}
      className="flex h-9 max-w-40 shrink-0 cursor-pointer items-center gap-1 truncate max-sm:max-w-28 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
      <span className="truncate">{agentModel || general || t("Modèle")}</span><ChevronDown className="size-3.5 shrink-0" />
    </button>
  );
}

/** Ses outils sous la saisie, à côté du modèle : un geste ouvre ses connexions, comme le « + » de ChatGPT ou « Connect apps » de Grok Bot. */
const openTools = () => window.dispatchEvent(new CustomEvent("noah:ouvrir-panneau", { detail: "connections" }));
function ToolsChip() {
  const { canWatch, readOnly } = useContext(AgentContext);
  if (!canWatch || readOnly) return null;
  return (
    <button type="button" onClick={openTools} title={t("Connecter un outil")}
      className="flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground max-md:hidden">
      <Plug className="size-3.5 shrink-0" /><span>{t("Outils")}</span>
    </button>
  );
}

/** Téléphone : un seul « + » à gauche de la saisie, comme ChatGPT et Grok. Fichiers, outils et position s'y rangent, le texte garde la place. */
function PlusMenu() {
  const { canWatch, readOnly } = useContext(AgentContext);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const item = "flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-[15px] hover:bg-muted";
  return (
    <div ref={box} className="relative md:hidden">
      <Button type="button" variant="ghost" size="icon" aria-label={t("Ajouter")} aria-expanded={open} className="cible-tactile rounded-full text-muted-foreground" onClick={() => setOpen((o) => !o)}>
        <Plus className={cn("transition-transform", open && "rotate-45")} />
      </Button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-4 flex w-56 flex-col gap-0.5 rounded-2xl border border-border bg-surface p-1.5 shadow-lg" onClick={() => setOpen(false)}>
          <ComposerPrimitive.AddAttachment asChild multiple>
            <button type="button" role="menuitem" className={item}><Paperclip className="size-5 text-muted-foreground" />{t("Joindre des fichiers")}</button>
          </ComposerPrimitive.AddAttachment>
          {canWatch && !readOnly && (
            <button type="button" role="menuitem" className={item} onClick={openTools}><Plug className="size-5 text-muted-foreground" />{t("Outils")}</button>
          )}
          <AttachPosition />
        </div>
      )}
    </div>
  );
}



// --- Zone de saisie -----------------------------------------------------------------

function Composer({ onVoiceMode, inCall }: { onVoiceMode: () => void; inCall: boolean }) {
  const dictation = useDictation();
  const running = useAuiState((s) => s.thread.isRunning);
  const dictating = dictation.state !== "idle";
  const busy = useContext(WhileBusyContext);
  const aui = useAui();
  const empty = useAuiState((s) => s.composer.isEmpty);
  const sent = useSentHistory();
  const historyAt = useRef(-1); // -1 : le brouillon ; 0 : le dernier message envoyé ; 1 : l'avant-dernier…
  const draft = useRef("");
  useEffect(() => { historyAt.current = -1; }, [sent.length]); // un message vient de partir : on repart du plus récent
  const sendWhileBusy = () => {
    const composer = aui.thread().composer();
    const state = composer.getState();
    const text = state.text.trim();
    if (!text) return;
    const files = state.attachments.map((a) => a.file).filter((f): f is File => !!f);
    void composer.reset();
    busy.send(text, files);
  };
  return (
    <>
    <WhileBusyPanel />
    <ComposerPrimitive.Root data-noah-composer data-vide={empty && !dictating ? "" : undefined} className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-surface p-2 shadow-sm focus-within:border-accent">
      <QuoteChips />
      <div className="flex flex-wrap gap-1.5 empty:hidden">
        <ComposerPrimitive.Attachments components={{ Attachment: AttachmentChip }} />
      </div>
      {/* Le texte a toute la largeur et les boutons passent dessous, comme dans les apps de chat : les puces ne l'écrasent jamais. */}
      <div className="flex flex-wrap items-end gap-1.5">
        <PlusMenu />
        <ComposerPrimitive.AddAttachment asChild multiple>
          <Button variant="ghost" size="icon" aria-label={t("Joindre des fichiers")} className="mr-auto text-muted-foreground max-md:hidden">
            <Paperclip />
          </Button>
        </ComposerPrimitive.AddAttachment>
        <span className="contents max-md:hidden"><AttachPosition /></span>
        <ModelChip />
        <ToolsChip />
        <ComposerPrimitive.Input
          data-composer-input
          aria-label={t("Message à ton agent")}
          rows={1}
          autoFocus={FINE_POINTER}
          placeholder={dictating ? t("Parle, le texte arrive ici…") : running ? t("Précise, pose une question, ou ajoute une demande…") : t("Écris à ton agent…")}
          className="max-h-48 min-h-9 flex-1 resize-none bg-transparent py-2 text-[15px] outline-none placeholder:text-muted-foreground order-first basis-full px-2 max-sm:text-base"
          onKeyDown={(e) => {
            // Entrée pendant la dictée : on termine la transcription, puis le message part.
            if (dictating && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void dictation.finish(!running);
            } else if (running && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              // Pendant le travail, la saisie reste ouverte : le message est trié, jamais perdu.
              e.preventDefault();
              sendWhileBusy();
            } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
              const field = e.currentTarget;
              // Sur la première ligne (↑) ou la dernière (↓) : ailleurs, les flèches déplacent le curseur comme d'habitude.
              const atStart = !field.value.slice(0, field.selectionStart ?? 0).includes("\n");
              const atEnd = !field.value.slice(field.selectionEnd ?? 0).includes("\n");
              if ((e.key === "ArrowUp" && !atStart) || (e.key === "ArrowDown" && !atEnd)) return;
              if (historyAt.current < 0) draft.current = field.value;
              const step = historyStep(sent, historyAt.current, draft.current, e.key);
              if (!step) return;
              e.preventDefault();
              historyAt.current = step.index;
              aui.thread().composer().setText(step.text);
              // ↑ : curseur au début, pour remonter encore d'un coup ; ↓ : à la fin.
              requestAnimationFrame(() => { const at = e.key === "ArrowUp" ? 0 : step.text.length; field.setSelectionRange(at, at); });
            } else if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && !e.key.startsWith("Shift")) {
              historyAt.current = -1; // on tape : la navigation dans l'historique repart du plus récent
            }
          }}
        />
        {!inCall && <DictateButton dictation={dictation} />}
        {!inCall && <VoiceModeButton onClick={onVoiceMode} />}
        <ThreadPrimitive.If running={false}>
          {dictating ? (
            <Button
              type="button"
              size="icon"
              data-envoyer aria-label={t("Envoyer")}
              title={t("Termine la transcription puis envoie")}
              className="cible-tactile rounded-xl"
              disabled={dictation.state === "finishing"}
              onClick={() => void dictation.finish(true)}
            >
              <ArrowUp />
            </Button>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button size="icon" data-envoyer aria-label={t("Envoyer")} className="cible-tactile rounded-xl"><ArrowUp /></Button>
            </ComposerPrimitive.Send>
          )}
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <Button type="button" size="icon" data-envoyer aria-label={t("Envoyer")} title={t("Il répond tout de suite ; le travail continue")} className="cible-tactile rounded-xl" onClick={sendWhileBusy}>
            <ArrowUp />
          </Button>
          <ComposerPrimitive.Cancel asChild>
            <Button size="icon" variant="outline" aria-label={t("Arrêter")} className="cible-tactile rounded-xl"><Square className="fill-current" /></Button>
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
    </>
  );
}

/** Au-dessus de la saisie : ce que fait un travail lancé ailleurs, et les demandes qui attendent leur tour. */
function WhileBusyPanel() {
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
