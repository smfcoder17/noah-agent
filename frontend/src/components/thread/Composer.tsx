import { ComposerPrimitive, ThreadPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, ChevronDown, Paperclip, Plug, Plus, Square } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { WhileBusyContext, AgentContext } from "@/lib/agentContext";
import { get } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "../ui";
import { AttachPosition } from "../PhoneSettings";
import { DictateButton, useDictation, VoiceModeButton } from "../Voice";
import { readableModel } from "@/lib/modes";
import { historyStep } from "@/lib/historique";
import { t } from "@/i18n";
import { AttachmentChip, QuoteChips, useSentHistory } from "./messages";
import { WhileBusyPanel } from "../Thread"; // en attendant panneaux.tsx (commit suivant)

// Sur téléphone, le focus ouvrirait le clavier à chaque conversation, et par-dessus un appel.
const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;

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

export function Composer({ onVoiceMode, inCall }: { onVoiceMode: () => void; inCall: boolean }) {
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
