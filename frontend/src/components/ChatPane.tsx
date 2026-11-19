import { ArrowLeft, Menu } from "lucide-react";
import { t } from "@/i18n";

/** Une tâche ouverte (0.4.0) : on y entre depuis le fil, un retour y ramène. L'en-tête dit qui l'a confiée à qui, et où elle en est (pastille colorée). */
export type TacheOuverte = { titre: string; sous: string; etat: string; genre: "work" | "wait" | "ok" | "err" | ""; retour: string; onRetour: () => void };

/** L'en-tête du fil, celui du prototype : le nom, le rôle, la pastille d'état ; à droite les seules icônes du prototype. */
export type EnteteAgent = { role: string; mot: string; genre: "work" | "wait" | "ok" | "err" | "" };

export function ChatPane({ title, entete, onAgent, onMenu, actions, children, tache }: { title: string; /** Sur téléphone, l'en-tête d'une tâche porte le menu : il remplace celui de l'agent. */ onMenu?: () => void; entete?: EnteteAgent | null; onAgent: () => void; actions?: React.ReactNode; children: React.ReactNode; tache?: TacheOuverte | null }) {
  return (
    <main className="chat-pane">
      <header className={tache ? "head tache-tete" : "head"}>
        {tache ? (
          <>
            {onMenu && <button type="button" onClick={onMenu} aria-label={t("Menu")} className="icon-btn tache-menu shrink-0"><Menu size={20} aria-hidden /></button>}
            <button type="button" onClick={tache.onRetour} aria-label={tache.retour} title={tache.retour} className="icon-btn shrink-0"><ArrowLeft size={18} aria-hidden /></button>
            <div className="head-title flex min-w-0 grow flex-col">
              <h1 className="cut">{tache.titre}</h1>
              {tache.sous && <span className="head-sub cut">{tache.sous}</span>}
            </div>
            {tache.etat && <span className={`pill shrink-0 ${tache.genre}`}>{tache.etat}</span>}
          </>
        ) : (
          <div className="head-title flex min-w-0 grow items-center gap-2">
            <h1 className="cut"><button type="button" onClick={onAgent}>{title}</button></h1>
            {entete?.role && <span className="head-role cut">{entete.role}</span>}
            {entete?.mot && <span className={`pill shrink-0 ${entete.genre}`}>{entete.mot}</span>}
          </div>
        )}
        {!tache && <div className="head-tools">{actions}</div>}
      </header>
      {children}
    </main>
  );
}

export const retourAu = (nom: string) => t("Revenir au fil de {nom}", { nom });
