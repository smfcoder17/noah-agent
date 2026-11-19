import { type ToolCallMessagePartProps, useAui, useAuiState } from "@assistant-ui/react";
import { Check, ChevronUp, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useContext, useEffect, useState } from "react";
import { WhileBusyContext, AgentContext } from "@/lib/agentContext";
import { type LoginAsked, send } from "@/lib/api";
import { LoginCard, LoginDone, type LoginResult } from "../LoginCard";
import { Recu } from "../Recu";
import { TacheOutil, TraceOutil } from "./TacheLigne";
import { cn } from "@/lib/utils";
import { Button } from "../ui";
import { refreshAccords } from "@/lib/events";
import { fullCommand } from "@/lib/accordCarte";
import { t } from "@/i18n";

// --- Parties « outil » : activité, approbation, erreur, détails techniques -------------

/** La ligne de travail vit dans le statut de la mascotte (moodLabel) : ici, rien, pour ne pas la dire deux fois. */
function Activity(_: ToolCallMessagePartProps) {
  return null;
}

/** Depuis combien de temps il travaille : « 12 s », puis « 1 min 05 ». */
function useElapsed(on: boolean) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  const s = Math.max(0, Math.round((now - start) / 1000));
  return s < 60 ? t("{n} s", { n: s }) : t("{m} min {s}", { m: Math.floor(s / 60), s: String(s % 60).padStart(2, "0") });
}

/**
 * La seule mascotte de la conversation, sous le travail en cours : son visage dit son humeur, la ligne dit l'étape.
 * Pas de cercle qui tourne : le texte s'éclaire en vague tant qu'il travaille, et le temps passé s'affiche à côté.
 */
export function LiveStatus({ face, label, working }: { face: ReactNode; label: string; working: boolean }) {
  const elapsed = useElapsed(working);
  return (
    <div data-live-status className="flex items-center gap-3 pt-1" aria-live="polite">
      <span className="relative shrink-0">
        {working && <span aria-hidden className="live-halo absolute inset-0 rounded-full" />}
        {face}
      </span>
      <div className="flex min-w-0 flex-col">
        <span key={label} className={cn("live-step min-w-0 truncate text-[14px]", working ? "shimmer-text" : "text-muted-foreground")}>{label}</span>
        {working && <span className="text-xs tabular-nums text-muted-foreground/80">{elapsed}</span>}
      </div>
    </div>
  );
}

function Approval({ args, result, addResult }: ToolCallMessagePartProps) {
  const { agentId, details } = useContext(AgentContext);
  const [error, setError] = useState("");
  const preview = Array.isArray(args.apercu) ? (args.apercu as string[]) : [];
  const command = fullCommand(args.summary); // plusieurs lignes : toutes montrées, la personne accepte ce qu'elle voit
  const [open, setOpen] = useState(false);
  const answer = async (approve: boolean) => {
    try {
      await send(`/api/agents/${agentId}/runs/${args.run_id}/approval`, {
        request_id: args.request_id,
        generation: args.generation,
        approve,
      });
      await refreshAccords();
      addResult(approve ? "approved" : "denied");
      window.dispatchEvent(new Event("noah:accord-repondu"));
    } catch (e) {
      void refreshAccords().catch(() => {});
      setError((e as Error).message);
    }
  };
  if (result !== undefined) {
    return (
      <p className="my-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        {result === "approved" ? <Check className="size-3.5 text-ok" /> : <X className="size-3.5" />}
        <span className="min-w-0 truncate">{result === "approved" ? t("Autorisé") : t("Refusé")} · {String(args.action || args.demande || t("cette action")).replace(/^Ton agent veut /, "") /* i18n-ignore : motif qui lit le texte du serveur */}</span>
      </p>
    );
  }
  if (args.bureau) return <p className="my-2 rounded-xl border border-warn p-3 text-sm">{t("{demande} · À accepter sur ton ordinateur", { demande: String(args.demande) })}</p>;
  return (
    <div className="my-2 flex flex-col gap-3 rounded-xl border border-warn bg-warn-soft p-3.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-warn">{t("À valider")}</span>
      <p className="text-sm font-medium">{String(args.demande || t("Ton agent te demande de valider une action."))}</p>
      {typeof args.pourquoi === "string" && args.pourquoi && <p className="-mt-2 text-[13px] text-muted-foreground">{args.pourquoi}</p>}
      {command && <pre aria-label={t("Commande entière")} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-2 font-mono text-[11.5px]">{command}</pre>}
      {preview.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {preview.map((line) => <li key={line} className="whitespace-pre-wrap break-words">{t("« {texte} »", { texte: line })}</li>)}
        </ul>
      )}
      {!details && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="cursor-pointer self-start text-xs font-medium underline underline-offset-2">
          {open ? t("Masquer les détails") : t("Voir les détails")}
        </button>
      )}
      {(details || open) && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-2 font-mono text-[11.5px] text-muted-foreground">{String(args.summary).replace(/^Ton juge demande ton accord : [^\n]*\n/, "") /* la raison est déjà dite au-dessus, en clair */}</pre>}
      <div className="flex gap-2">
        <Button variant="warn" size="sm" onClick={() => answer(true)}>{t("Autoriser")}</Button>
        <Button variant="outline" size="sm" onClick={() => answer(false)}>{t("Refuser")}</Button>
      </div>
      {args.retenu === true && <p className="-mt-1 text-xs text-muted-foreground">{t("Si tu autorises, les actions de ce genre passeront ensuite sans te demander.")}</p>}
      {error && <p className="text-sm text-danger">{t("La réponse n'a pas été prise en compte : {erreur}", { erreur: error })}</p>}
    </div>
  );
}

function LoginPart({ args, result, addResult }: ToolCallMessagePartProps) {
  const { agentId } = useContext(AgentContext);
  const asked = args as unknown as LoginAsked;
  if (result !== undefined) return <LoginDone asked={asked} result={result as LoginResult} />;
  return (
    <LoginCard
      agentId={agentId}
      asked={asked}
      onDone={(done) => {
        addResult(done);
        window.dispatchEvent(new Event("noah:accord-repondu"));
      }}
    />
  );
}

/** Une erreur : la phrase d'abord. Les détails à côté, à copier ou à donner à l'agent pour qu'il la diagnostique. */
function ErrorPart({ args }: ToolCallMessagePartProps) {
  const aui = useAui();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const detail = String(args.detail ?? "");
  return (
    <div className="my-1 flex flex-col gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
        <span>{String(args.message)}</span>
      </div>
      {detail && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="ml-6 cursor-pointer self-start text-xs font-medium underline underline-offset-2">
          {open ? t("Masquer les détails") : t("Voir les détails")}
        </button>
      )}
      {open && (
        <div className="ml-6 flex flex-col gap-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-2.5 font-mono text-[11.5px]">{detail}</pre>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard.writeText(detail).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }, () => {})}
            >
              {copied ? t("Copié") : t("Copier")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => aui.thread().composer().setText(`${t("Aide-moi à diagnostiquer cette erreur de Noah Agent :")}\n\n${detail}`)}
            >
              {t("Demander à l'agent")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ args }: ToolCallMessagePartProps) {
  return (
    <pre className="my-1 max-w-full overflow-x-auto rounded-lg border border-dashed border-border bg-surface px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
      {JSON.stringify(args.data, null, 2)}
    </pre>
  );
}

/** Sous une réponse rapide : le tri peut se tromper, un clic la transmet quand même à l'agent. */
function SendAside({ args }: { args: { id: string } }) {
  const busy = useContext(WhileBusyContext);
  const [said, setSaid] = useState("");
  return (
    <div className="not-prose mt-1 text-xs text-muted-foreground">
      {said || (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            setSaid(t("Envoi…"));
            busy.now(args.id).then(
              (type) =>
                setSaid(
                  type === "precision" ? t("Transmis à l'agent.") : type === "tache" ? t("Il a fini : c'est mis à la suite.") : type === "incertain" ? t("Transmission non confirmée : regarde sa réponse.") : t("Déjà transmis."),
                ),
              () => setSaid(t("Pas transmis : le serveur ne répond pas.")),
            );
          }}
        >
          {t("Le transmettre aussi à l'agent")}
        </button>
      )}
    </div>
  );
}

/** Le récit du travail : replié, pour qui veut vérifier. Pendant le travail, sa dernière phrase reste lisible. */
function Steps({ args }: ToolCallMessagePartProps) {
  const steps = (args.steps as string[]) ?? [];
  const running = useAuiState((s) => s.message.status?.type === "running");
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  return (
    <div className="my-1 flex flex-col gap-1 text-[13px] text-muted-foreground">
      {running && !open && <p className="truncate">{steps[steps.length - 1]}</p>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-fit cursor-pointer items-center gap-1 rounded-md hover:text-foreground">
        <ChevronUp className={cn("size-3.5 transition-transform", !open && "rotate-180")} />
        {steps.length > 1 ? t("{n} étapes", { n: steps.length }) : t("{n} étape", { n: steps.length })}
      </button>
      {open && <ol className="flex list-decimal flex-col gap-1 pl-5">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
    </div>
  );
}

export const TOOLS = { by_name: { activity: Activity, approval: Approval, connexion: LoginPart, error: ErrorPart, detail: Detail, steps: Steps, recu: Recu, send_aside: SendAside, trace: TraceOutil, tache: TacheOutil } };
