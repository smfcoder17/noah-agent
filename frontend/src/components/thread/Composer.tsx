import { ComposerPrimitive, ThreadPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, Cpu, Paperclip, Square } from "lucide-react";
import { Suspense, lazy, useContext, useEffect, useRef, useState } from "react";
import { WhileBusyContext, AgentContext } from "@/lib/agentContext";
import { Button } from "../ui";
import { AttachPosition } from "../PhoneSettings";
import { DictateButton, useDictation } from "../Voice";
import { historyStep } from "@/lib/historique";
import { t } from "@/i18n";
import { AttachmentChip, QuoteChips, useSentHistory } from "./messages";
import { WhileBusyPanel } from "./panneaux";

// Citer avec @ et / : chargé au premier clic dans la saisie, pas avec le premier écran.
const MentionsLayer = lazy(() => import("./MentionsLayer"));

// Sur téléphone, le focus ouvrirait le clavier à chaque conversation, et par-dessus un appel.
const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;

/** Le modèle de l'agent sous la saisie : un geste ouvre le choix. Seulement pour qui peut le changer. */
function ModelChip() {
  // L'étiquette vient du cerveau que le serveur dit pour cet agent (le sien, sinon celui de tous) : jamais d'une valeur gardée de côté.
  const { agentModel, canWatch, readOnly } = useContext(AgentContext);
  if (!canWatch || readOnly) return null;
  return (
    <button type="button" data-model-chip className="model-chip" onClick={() => window.dispatchEvent(new Event("noah:choisir-modele"))} title={t("Changer de modèle")}>
      <Cpu aria-hidden /><span className="cut">{agentModel || t("Modèle")}</span>
    </button>
  );
}

// --- Zone de saisie -----------------------------------------------------------------

export function Composer({ inCall }: { inCall: boolean }) {
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
  const { agentId, agentName, tache } = useContext(AgentContext);
  // Le premier geste dans la saisie (focus, touche, toucher) charge la liste @ et / ; l'agent n'est pas lu avant.
  const [field, setField] = useState<HTMLDivElement | null>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (field && field.querySelector("textarea") === document.activeElement) setArmed(true); }, [field]);
  const arm = () => setArmed(true);
  const placeholder = dictating ? t("Parle, le texte arrive ici…") : running ? t("Précise, pose une question, ou ajoute une demande…") : tache ? t("Écrire à {nom} dans cette tâche", { nom: tache }) : t("Écrire à {nom}", { nom: agentName || t("ton agent") });
  return (
    <>
    <WhileBusyPanel />
    <ComposerPrimitive.Root data-noah-composer data-vide={empty && !dictating ? "" : undefined} className="composer relative">
      <QuoteChips />
      <div className="flex flex-wrap gap-1.5 empty:hidden">
        <ComposerPrimitive.Attachments components={{ Attachment: AttachmentChip }} />
      </div>
      <div ref={setField} className="composer-field" onFocusCapture={arm} onKeyDownCapture={arm} onPointerDownCapture={arm}>
      <ComposerPrimitive.Input
        data-composer-input
        aria-label={t("Message à ton agent")}
        rows={1}
        autoFocus={FINE_POINTER}
        placeholder={placeholder}
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
      </div>
      {armed && field && <Suspense fallback={null}><MentionsLayer field={field} agentId={agentId} /></Suspense>}
      {/* La barre du prototype : le trombone, la dictée, le modèle, puis l'envoi. Le mode vocal est le téléphone du haut de la conversation ; les outils, un onglet du panneau. */}
      <div className="composer-bar">
        <ComposerPrimitive.AddAttachment asChild multiple>
          <Button variant="ghost" size="icon" aria-label={t("Joindre des fichiers")} className="icon-btn cible-tactile"><Paperclip /></Button>
        </ComposerPrimitive.AddAttachment>
        <AttachPosition />
        {!inCall && <DictateButton dictation={dictation} />}
        {!tache && <ModelChip />}
        <span className="grow" />
        <ThreadPrimitive.If running={false}>
          {dictating ? (
            <Button
              type="button"
              size="icon"
              data-envoyer aria-label={t("Envoyer")}
              title={t("Termine la transcription puis envoie")}
              className="send cible-tactile"
              disabled={dictation.state === "finishing"}
              onClick={() => void dictation.finish(true)}
            >
              <ArrowUp />
            </Button>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button size="icon" data-envoyer aria-label={t("Envoyer")} className="send cible-tactile"><ArrowUp /></Button>
            </ComposerPrimitive.Send>
          )}
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel asChild>
            <Button size="icon" variant="outline" aria-label={t("Arrêter")} className="send-stop cible-tactile"><Square className="fill-current" /></Button>
          </ComposerPrimitive.Cancel>
          <Button type="button" size="icon" data-envoyer aria-label={t("Envoyer")} title={t("Il répond tout de suite ; le travail continue")} className="send cible-tactile" onClick={sendWhileBusy}>
            <ArrowUp />
          </Button>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
    </>
  );
}
