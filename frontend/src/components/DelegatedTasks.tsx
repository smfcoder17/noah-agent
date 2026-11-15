import { Laptop, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { get, send } from "@/lib/api";
import { t } from "@/i18n";

export type DelegatedTask = {
  id: string;
  outil: string;
  etat: "en_cours" | "fini" | "arrete" | "echec";
  dossier: string;
  appareil: string;
  duree_s: number;
  progression: string[];
  offre: string;
  resultat?: { ok?: boolean; erreur?: string; arret?: string; limite?: boolean; fichiers?: string[] };
};

const minutes = (s: number) => (s < 60 ? t("{n} s", { n: s }) : t("{n} min", { n: Math.floor(s / 60) }));

function state(task: DelegatedTask): string {
  if (task.etat === "en_cours") return t("en cours depuis {duree}", { duree: minutes(task.duree_s) });
  if (task.etat === "fini") {
    const n = task.resultat?.fichiers?.length ?? 0;
    return n === 1 ? t("terminée, 1 fichier modifié") : t("terminée, {n} fichiers modifiés", { n });
  }
  if (task.resultat?.limite) return t("arrêtée : limite de l'abonnement atteinte");
  if (task.etat === "arrete") return t("arrêtée");
  return t("échouée");
}

/** Ligne de suivi dans la conversation : la tâche que l'agent a confiée à Claude Code sur l'ordinateur, sa progression, et Stop. */
export function DelegatedTasks({ agentId }: { agentId: string }) {
  const [tasks, setTasks] = useState<DelegatedTask[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      const r = await get<{ taches: DelegatedTask[] }>(`/api/agents/${agentId}/taches-confiees`).catch(() => null);
      if (alive && r) setTasks(r.taches);
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agentId]);
  if (!tasks.length) return null;
  const stop = (id: string) => send(`/api/desktop/taches/${id}/arreter`, {}).catch(() => {});
  return (
    <div className="mx-3 mt-2 flex flex-col gap-1.5">
      {tasks.map((task) => (
        <div key={task.id} role="status" className="rounded-xl border border-border bg-muted/40 p-2.5 text-sm" data-tache={task.etat}>
          <div className="flex items-center gap-2">
            <Laptop className="size-4 shrink-0 text-muted-foreground" />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === task.id ? null : task.id)} aria-expanded={open === task.id}>
              <span className="font-medium">{t("Tâche confiée à Claude Code sur {appareil}", { appareil: task.appareil })}</span>
              <span className="text-muted-foreground">{" · "}{task.offre ? t("abonnement {offre}", { offre: task.offre }) : t("abonnement")}{" · "}{task.dossier}{" · "}{state(task)}</span>
            </button>
            {task.etat === "en_cours" && <Button size="sm" variant="ghost" onClick={() => stop(task.id)} aria-label={t("Arrêter la tâche")} title={t("Arrêter la tâche")}><Square /></Button>}
          </div>
          {open === task.id && (
            <ul className="mt-1.5 flex flex-col gap-0.5 pl-6 text-xs text-muted-foreground">
              {task.progression.map((line, i) => <li key={i} className="truncate">{line}</li>)}
              {task.resultat?.erreur && <li className="text-danger">{task.resultat.erreur}</li>}
              {task.resultat?.fichiers?.map((f) => <li key={f} className="truncate">{f}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
