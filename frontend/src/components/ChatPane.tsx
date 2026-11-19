import { ArrowLeft } from "lucide-react";
import { t } from "@/i18n";

/** Une tâche ouverte (0.4.0) : on y entre depuis le fil, un retour y ramène. L'en-tête dit qui l'a confiée à qui, et où elle en est. */
export type TacheOuverte = { titre: string; sous: string; etat: string; retour: string; onRetour: () => void };

export function ChatPane({ title, onAgent, actions, children, tache }: { title: string; onAgent: () => void; actions?: React.ReactNode; children: React.ReactNode; tache?: TacheOuverte | null }) {
  return (
    <main className="chat-pane">
      <header className={tache ? "tache-tete" : undefined}>
        {tache ? (
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={tache.onRetour} aria-label={tache.retour} title={tache.retour} className="shell-icon grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg hover:bg-muted"><ArrowLeft size={20} aria-hidden /></button>
            <div className="flex min-w-0 flex-col">
              <h1 className="truncate text-[15px] font-semibold leading-tight">{tache.titre}</h1>
              {tache.sous && <span className="truncate text-xs leading-tight text-muted-foreground">{tache.sous}</span>}
            </div>
            {tache.etat && <span className="ml-2 hidden shrink-0 rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground sm:inline">{tache.etat}</span>}
          </div>
        ) : (
          <button onClick={onAgent} className="font-semibold text-[15px]">{title}</button>
        )}
        <div className="flex gap-1">{actions}</div>
      </header>
      {children}
    </main>
  );
}

export const retourAu = (nom: string) => t("Revenir au fil de {nom}", { nom });
