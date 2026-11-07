// Compétences : ce que la personne a enseigné à son agent, « voici comment je veux que tu fasses telle chose ». L'agent s'en sert seul.
// Ce qu'il apprend de lui-même reste interne : le serveur ne le montre pas ici.
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { del, get, send } from "@/lib/api";
import { Button, ErrorText, Input, Textarea } from "./ui";
import { DictateButton, useCanDictate, useFieldDictation } from "./Voice";

export type Competence = { nom: string; titre: string; texte: string };

function Editor({ agentId, start, onDone, onCancel }: { agentId: string; start?: Competence; onDone: () => void; onCancel: () => void }) {
  const [titre, setTitre] = useState(start?.titre ?? "");
  const [texte, setTexte] = useState(start?.texte ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canDictate = useCanDictate();
  const dictation = useFieldDictation(agentId, (said) => setTexte((cur) => (cur.trim() ? `${cur.trimEnd()} ${said}` : said)));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await dictation.finish(false);
      const body = { titre: titre.trim(), texte: texte.trim() };
      if (start) await send(`/api/agents/${agentId}/competences/${start.nom}`, body, "PUT");
      else await send(`/api/agents/${agentId}/competences`, body);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
      <Input value={titre} onChange={(e) => setTitre(e.target.value)} maxLength={80} placeholder="Répondre à mes clients" aria-label="De quoi s'agit-il ?" autoFocus />
      <div className="flex items-start gap-1.5">
        <Textarea value={texte} onChange={(e) => setTexte(e.target.value)} maxLength={20000} rows={5} className="min-w-0 flex-1"
          placeholder="Voici comment je veux que tu fasses : vouvoie-les, réponds en trois phrases, signe Franck." aria-label="Comment veux-tu qu'il fasse ?" />
        {canDictate && <DictateButton dictation={dictation} what="une compétence" field />}
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button type="submit" size="sm" disabled={!titre.trim() || !texte.trim() || busy}>{busy && <Loader2 className="animate-spin" />}Enregistrer</Button>
      </div>
    </form>
  );
}

export function Competences({ agentId }: { agentId: string }) {
  const [list, setList] = useState<Competence[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState("");
  const load = useCallback(() => {
    get<{ competences: Competence[] }>(`/api/agents/${agentId}/competences`).then((r) => {
      setList(r.competences);
      setError("");
    }).catch((e) => setError((e as Error).message));
  }, [agentId]);
  useEffect(load, [load]);
  const remove = async (c: Competence) => {
    if (!confirm(`Retirer « ${c.titre} » ? L'agent ne s'en servira plus.`)) return;
    try {
      await del(`/api/agents/${agentId}/competences/${c.nom}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section aria-label="Compétences" className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">Ce que tu lui as enseigné : comment tu veux qu'il fasse telle chose. Il s'en sert tout seul quand le sujet arrive.</p>
      {!list && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {list?.map((c) => editing === c.nom ? (
        <Editor key={c.nom} agentId={agentId} start={c} onCancel={() => setEditing("")} onDone={() => { setEditing(""); load(); }} />
      ) : (
        <article key={c.nom} className="flex flex-col gap-1 rounded-xl border border-border p-2.5">
          <div className="flex items-center gap-1">
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{c.titre}</h3>
            <Button size="icon-sm" variant="ghost" onClick={() => setEditing(c.nom)} aria-label={`Modifier « ${c.titre} »`}><Pencil /></Button>
            <Button size="icon-sm" variant="ghost" onClick={() => remove(c)} aria-label={`Retirer « ${c.titre} »`}><Trash2 /></Button>
          </div>
          <p className="line-clamp-4 text-sm whitespace-pre-wrap text-muted-foreground">{c.texte}</p>
        </article>
      ))}
      {list && !list.length && !adding && <p className="text-sm text-muted-foreground">Rien pour l'instant. Écris ou dicte ta première : tes réponses aux clients, ton format de compte rendu, ta façon de ranger.</p>}
      {adding ? (
        <Editor agentId={agentId} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />
      ) : list && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}><Plus />Enseigner quelque chose</Button>
      )}
      <ErrorText>{error}</ErrorText>
      {list && <p className="text-xs text-muted-foreground">Ce qu'il apprend seul reste interne. Pour le connaître, demande-le-lui.</p>}
    </section>
  );
}
