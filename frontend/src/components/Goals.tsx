// Objectifs : ce que la personne veut atteindre. Ses agents les gardent en tête et cherchent comment l'aider (server/noah/proactif.py).
import { Check, ChevronRight, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type Agent, del, get, type Goal, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button, Dialog, DialogContent, ErrorText, Input } from "./ui";
import { DictateButton, NO_AGENT, useCanDictate, useFieldDictation } from "./Voice";

function GoalRow({ goal, agentName, onChange, onRemove }: { goal: Goal; agentName?: string; onChange: (id: string, body: Partial<Pick<Goal, "texte" | "etat">>) => void; onRemove: (g: Goal) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const finished = goal.etat === "fait";
  const save = () => {
    if (editing !== null && editing.trim() && editing.trim() !== goal.texte) onChange(goal.id, { texte: editing.trim() });
    setEditing(null);
  };
  return (
    <li className="flex items-start gap-2 rounded-xl border border-border p-2">
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={() => onChange(goal.id, { etat: finished ? "actif" : "fait" })}
        aria-label={finished ? `Reprendre : ${goal.texte}` : `Marquer comme fait : ${goal.texte}`}
        title={finished ? "Reprendre" : "C'est fait"}
      >
        {finished ? <RotateCcw /> : <span aria-hidden className="grid size-4 place-items-center rounded-full border-2 border-muted-foreground/60"><Check className="size-2.5 opacity-0" /></span>}
      </Button>
      <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center">
        {editing === null ? (
          <button type="button" onClick={() => setEditing(goal.texte)} className={cn("cursor-text text-left text-sm", finished && "text-muted-foreground line-through")} aria-label={`Modifier : ${goal.texte}`}>{goal.texte}</button>
        ) : (
          <Input
            autoFocus
            value={editing}
            maxLength={300}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(null);
              }
            }}
            className="h-8"
            aria-label="Modifier l'objectif"
          />
        )}
        {agentName && <span className="text-xs text-muted-foreground">Pour {agentName}</span>}
      </div>
      <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={() => onRemove(goal)} aria-label={`Retirer : ${goal.texte}`}><Trash2 /></Button>
    </li>
  );
}

export function Goals({ open, agents, agentId, onOpenChange }: { open: boolean; agents: Agent[]; agentId: string | null; onOpenChange: (open: boolean) => void }) {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const mine = agents.filter((a) => a.droit === "proprietaire");
  const speakFor = mine.find((a) => a.id === agentId)?.id ?? mine[0]?.id ?? NO_AGENT;
  const canDictate = useCanDictate();
  const dictation = useFieldDictation(speakFor, (said) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${said}` : said)));

  useEffect(() => {
    if (!open) return;
    setError("");
    get<{ objectifs: Goal[] }>("/api/goals").then((r) => setGoals(r.objectifs)).catch((e) => setError((e as Error).message));
  }, [open]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await dictation.finish(false);
      const made = await send<Goal>("/api/goals", { texte: text.trim(), agent_id: target || null });
      setGoals((cur) => [...(cur ?? []), made]);
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const change = async (id: string, body: Partial<Pick<Goal, "texte" | "etat">>) => {
    setError("");
    try {
      const fresh = await send<Goal>(`/api/goals/${id}`, body, "PATCH");
      setGoals((cur) => cur?.map((g) => (g.id === id ? fresh : g)) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (goal: Goal) => {
    setError("");
    try {
      await del(`/api/goals/${goal.id}`);
      setGoals((cur) => cur?.filter((g) => g.id !== goal.id) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const active = goals?.filter((g) => g.etat === "actif") ?? [];
  const done = goals?.filter((g) => g.etat === "fait") ?? [];
  const row = (g: Goal) => <GoalRow key={g.id} goal={g} agentName={agents.find((a) => a.id === g.agent_id)?.name} onChange={change} onRemove={remove} />;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent title="Objectifs" description="Ce que tu veux atteindre. Tes agents les gardent en tête et cherchent comment t'aider." className="max-w-lg max-sm:p-4">
          <form onSubmit={add} className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Poster chaque jour, répondre à ma communauté…" aria-label="Nouvel objectif" className="min-w-0 flex-1" />
              {canDictate && <DictateButton dictation={dictation} what="un objectif" field />}
              <Button type="submit" size="icon" disabled={!text.trim() || busy} aria-label="Ajouter l'objectif" className="shrink-0">{busy ? <Loader2 className="animate-spin" /> : <Plus />}</Button>
            </div>
            {mine.length > 1 && (
              <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Pour quel agent" className="h-9 w-full cursor-pointer rounded-lg border border-border bg-background px-2 text-sm">
                <option value="">Pour tous mes agents</option>
                {mine.map((a) => <option key={a.id} value={a.id}>Pour {a.name}</option>)}
              </select>
            )}
          </form>
          <ErrorText>{error}</ErrorText>
          {!goals && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
          {goals && !active.length && <p className="text-sm text-muted-foreground">Rien pour l'instant. Écris ce que tu veux atteindre : être régulier sur ta chaîne, finir un dossier, répondre plus vite. Une fois par jour, un agent te proposera comment avancer.</p>}
          {active.length > 0 && <ul aria-label="Objectifs en cours" className="flex flex-col gap-2">{active.map(row)}</ul>}
          {done.length > 0 && (
            <div className="flex flex-col gap-2">
              <button type="button" aria-expanded={showDone} onClick={() => setShowDone(!showDone)} className="flex cursor-pointer items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronRight className={cn("size-3.5 transition-transform", showDone && "rotate-90")} />Faits ({done.length})
              </button>
              {showDone && <ul aria-label="Objectifs faits" className="flex flex-col gap-2">{done.map(row)}</ul>}
            </div>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
