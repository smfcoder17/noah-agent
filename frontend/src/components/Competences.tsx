import { memo } from "react";
// Compétences : ce que la personne a enseigné à son agent, « voici comment je veux que tu fasses telle chose ». L'agent s'en sert seul.
// Dessous, tous ses skills : ceux qu'il a appris seul, ceux qu'on lui a enseignés, ceux fournis avec Noah — lisibles et modifiables.
import { Loader2, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { del, send } from "@/lib/api";
import { useAgentData } from "@/lib/useAgentData";
import { cn } from "@/lib/utils";
import { Button, ErrorText, Input, Textarea } from "./ui";
import { DictateButton, useCanDictate, useFieldDictation } from "./Voice";

export type Competence = { nom: string; titre: string; texte: string };
/** Un skill tel que l'agent le connaît : fourni avec Noah, enseigné par la personne, ou appris par l'agent. */
export type Skill = { nom: string; titre: string; resume: string; texte: string; origine: string; categorie: string; fourni: boolean; modifiable: boolean };

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

export const Competences = memo(function Competences({ agentId }: { agentId: string }) {
  const path = `/api/agents/${agentId}/competences`;
  const { data, error, setError, load } = useAgentData<{ competences: Competence[] }>(path, { freshOnReload: false });
  const list = data?.competences ?? null;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState("");
  // Les skills : tout ce que l'agent sait faire, y compris ce qu'il a appris seul (hors de « compétences »).
  const skillsPath = `/api/agents/${agentId}/skills`;
  const { data: skillsData, error: skillsError, setError: setSkillsError, load: loadSkills } = useAgentData<{ skills: Skill[] }>(skillsPath, { freshOnReload: false });
  const skills = skillsData?.skills ?? null;
  const [openSkill, setOpenSkill] = useState("");
  const [draft, setDraft] = useState({ titre: "", texte: "" });
  const [skillBusy, setSkillBusy] = useState(false);
  const removeSkill = async (s: Skill) => {
    if (!confirm(`Retirer « ${s.titre} » ? L'agent ne s'en servira plus.`)) return;
    setSkillsError("");
    try {
      await del(`/api/agents/${agentId}/skills/${s.nom}`);
      loadSkills();
    } catch (e) {
      setSkillsError((e as Error).message);
    }
  };
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
      {error && <ErrorText>{error}</ErrorText>}
      <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Ce que ton agent sait faire</h3>
          <span className="text-xs text-muted-foreground">{skills ? `${skills.length}` : ""}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Tout ce qui est dans son dossier de skills, y compris ce qu'il a appris seul : tu peux le relire, le corriger ou le retirer.
          Ceux fournis avec Noah reviennent à chaque mise à jour, d'où le cadenas.
        </p>
        {!skills && !skillsError && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
        {skills?.map((s) => (
          <article key={s.nom} className="flex flex-col gap-1 rounded-xl border border-border p-2.5">
            <div className="flex items-center gap-1">
              <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{s.titre}</h4>
              <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                s.origine === "enseigné par toi" ? "bg-accent-soft text-accent" : s.fourni ? "bg-muted text-muted-foreground" : "bg-warn-soft text-warn")}>{s.origine}</span>
              {s.modifiable ? (
                <>
                  <Button size="icon-sm" variant="ghost" onClick={() => { setOpenSkill(openSkill === s.nom ? "" : s.nom); setDraft({ titre: s.titre, texte: s.texte }); }} aria-label={`Relire « ${s.titre} »`}><Pencil /></Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => void removeSkill(s)} aria-label={`Retirer « ${s.titre} »`}><Trash2 /></Button>
                </>
              ) : <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Fourni avec Noah" />}
            </div>
            {s.resume && <p className="line-clamp-2 text-xs text-muted-foreground">{s.resume}</p>}
            {openSkill === s.nom && (
              <form className="flex flex-col gap-2 border-t border-border pt-2" onSubmit={async (e) => { e.preventDefault(); setSkillBusy(true); setSkillsError(""); try { await send(`/api/agents/${agentId}/skills/${s.nom}`, draft, "PUT"); setOpenSkill(""); loadSkills(); } catch (err) { setSkillsError((err as Error).message); } finally { setSkillBusy(false); } }}>
                <Input value={draft.titre} onChange={(e) => setDraft({ ...draft, titre: e.target.value })} maxLength={120} aria-label="Titre du skill" />
                <Textarea value={draft.texte} onChange={(e) => setDraft({ ...draft, texte: e.target.value })} rows={10} maxLength={20000} className="font-mono text-xs" aria-label="Contenu du skill" />
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOpenSkill("")}>Fermer</Button>
                  <Button type="submit" size="sm" disabled={skillBusy || !draft.titre.trim() || !draft.texte.trim()}>{skillBusy && <Loader2 className="animate-spin" />}Enregistrer</Button>
                </div>
              </form>
            )}
          </article>
        ))}
        <ErrorText>{skillsError}</ErrorText>
      </div>
    </section>
  );
});
