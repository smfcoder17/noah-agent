// Le reçu d'une réponse : ce que l'agent dit avoir fait, comparé à ce que ses outils ont fait (server/noah/recu.py).
// Ce qui ne colle pas se voit sans clic. Ce qui colle reste replié : personne ne lit un reçu quand tout va bien.
import { useAui, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { Check, ChevronUp, CircleHelp, TriangleAlert } from "lucide-react";
import { useState } from "react";
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
    const lines = [...none.map((p) => `« ${p} » : aucune trace`), ...failed.map((f) => `« ${f.dit} » : l'outil a échoué`), ...unsaid.map((u) => `Fait sans me le dire : il ${u}`)];
    aui.thread().composer().setText(`Le reçu de Noah ne colle pas avec ta réponse :\n${lines.join("\n")}\n\nQu'est-ce qui s'est vraiment passé ? Vérifie, puis dis-moi ce qui reste à faire.`);
  };
  return (
    <div className="not-prose my-1 flex flex-col gap-1.5 text-[13px]">
      {trouble > 0 && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-warn-soft px-3 py-2">
          {none.map((phrase) => <Line key={phrase} label="Noah n'en voit aucune trace" text={`« ${phrase} »`} />)}
          {failed.map((f) => <Line key={f.dit} label={`L'outil a échoué (${f.par})`} text={`« ${f.dit} »`} />)}
          {unsaid.map((line) => <Line key={line} label="Fait sans le dire" text={`Il ${line}.`} />)}
          <button type="button" onClick={ask} className="ml-5 w-fit cursor-pointer text-xs font-medium underline underline-offset-2">Lui demander ce qui s'est passé</button>
        </div>
      )}
      {quiet > 0 && (
        <div className="flex flex-col gap-1 text-muted-foreground">
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-fit cursor-pointer items-center gap-1 rounded-md hover:text-foreground">
            <ChevronUp className={cn("size-3.5 transition-transform", !open && "rotate-180")} />
            Reçu{proven.length > 0 && ` · ${proven.length} vérifié${proven.length > 1 ? "s" : ""}`}{unsure.length > 0 && ` · ${unsure.length} non vérifiable${unsure.length > 1 ? "s" : ""}`}
          </button>
          {open && (
            <ul className="flex flex-col gap-1 pl-5">
              {proven.map((p) => <li key={p.dit} className="flex items-start gap-1.5"><Check className="mt-0.5 size-3.5 shrink-0 text-ok" /><span>« {p.dit} » : vu passer par {p.par}.</span></li>)}
              {unsure.map((u) => <li key={u.dit} className="flex items-start gap-1.5"><CircleHelp className="mt-0.5 size-3.5 shrink-0" /><span>« {u.dit} » : passé par {u.par}, Noah ne peut pas dire ce que ça a fait.</span></li>)}
              <li className="text-xs">Noah compare ce qui est écrit à ce que ses actions ont donné. Il ne sait pas ce qui est arrivé chez le destinataire.</li>
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
      <span><span className="font-medium">{label} :</span> {text}</span>
    </p>
  );
}
