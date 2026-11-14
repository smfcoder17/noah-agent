// Le reçu d'une réponse : ce que l'agent dit avoir fait, comparé à ce que ses outils ont fait (server/noah/recu.py).
// Ce qui ne colle pas se voit sans clic. Ce qui colle reste replié : personne ne lit un reçu quand tout va bien.
import { useAui, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { Check, ChevronUp, CircleHelp, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { t, tr } from "@/i18n";
import type { Recu as Receipt } from "@/lib/api";
import { cn } from "@/lib/utils";

export function Recu({ args }: ToolCallMessagePartProps) {
  const receipt = args.recu as Receipt | undefined;
  const aui = useAui();
  const [open, setOpen] = useState(false);
  if (!receipt) return null;
  const { sans_trace: none = [], echec: failed = [], non_dit: unsaid = [], prouve: proven = [], incertain: unsure = [] } = receipt;
  const quiet = proven.length + unsure.length;
  const trouble = none.length + failed.length + unsaid.length;
  if (!trouble && !quiet) return null;
  const ask = () => {
    const lines = [...none.map((p) => t("« {phrase} » : aucune trace", { phrase: p })), ...failed.map((f) => t("« {phrase} » : l'outil a échoué", { phrase: f.dit })), ...unsaid.map((u) => t("Fait sans me le dire : il {action}", { action: u }))];
    aui.thread().composer().setText(t("Le reçu de Noah ne colle pas avec ta réponse :\n{lignes}\n\nQu'est-ce qui s'est vraiment passé ? Vérifie, puis dis-moi ce qui reste à faire.", { lignes: lines.join("\n") }));
  };
  return (
    <div className="not-prose my-1 flex flex-col gap-1.5 text-[13px]">
      {trouble > 0 && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-warn-soft px-3 py-2">
          {none.map((phrase) => <Line key={phrase} label={t("Noah n'en voit aucune trace")} text={t("« {phrase} »", { phrase })} />)}
          {failed.map((f) => <Line key={f.dit} label={t("L'outil a échoué ({outil})", { outil: f.par })} text={t("« {phrase} »", { phrase: f.dit })} />)}
          {unsaid.map((line) => <Line key={line} label={t("Fait sans le dire")} text={t("Il {action}.", { action: line })} />)}
          <button type="button" onClick={ask} className="ml-5 w-fit cursor-pointer text-xs font-medium underline underline-offset-2">{t("Lui demander ce qui s'est passé")}</button>
        </div>
      )}
      {quiet > 0 && (
        <div className="flex flex-col gap-1 text-muted-foreground">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-fit cursor-pointer items-center gap-1 rounded-md hover:text-foreground">
            <ChevronUp className={cn("size-3.5 transition-transform", !open && "rotate-180")} />
            {t("Reçu")}{proven.length > 0 && " · " + (proven.length > 1 ? t("{n} vérifiés", { n: proven.length }) : t("{n} vérifié", { n: proven.length }))}{unsure.length > 0 && " · " + (unsure.length > 1 ? t("{n} non vérifiables", { n: unsure.length }) : t("{n} non vérifiable", { n: unsure.length }))}
          </button>
          {open && (
            <ul className="flex flex-col gap-1 pl-5">
              {proven.map((p) => <li key={p.dit} className="flex items-start gap-1.5"><Check className="mt-0.5 size-3.5 shrink-0 text-ok" /><span>{t("« {phrase} » : vu passer par {outil}.", { phrase: p.dit, outil: p.par })}</span></li>)}
              {unsure.map((u) => <li key={u.dit} className="flex items-start gap-1.5"><CircleHelp className="mt-0.5 size-3.5 shrink-0" /><span>{t("« {phrase} » : passé par {outil}, Noah ne peut pas dire ce que ça a fait.", { phrase: u.dit, outil: u.par })}</span></li>)}
              <li className="text-xs">{t("Noah compare ce qui est écrit à ce que ses actions ont donné. Il ne sait pas ce qui est arrivé chez le destinataire.")}</li>
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Line({ label, text }: { label: string; text: string }) {
  return (
    <p className="flex items-start gap-1.5">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <span>{tr("{libelle} : {texte}", { libelle: <span className="font-medium">{label}</span>, texte: text })}</span>
    </p>
  );
}
